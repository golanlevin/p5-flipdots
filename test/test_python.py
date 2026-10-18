"""Run with python3 -m unittest discover -s test -p 'test_python.py'. No hardware required."""

import http.client
import json
import os
import queue
import signal
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import flipdot_server

from libs.python.server import Bridge, make_server
from libs.python.supervisor import Supervisor
from libs.python.web import make_server as make_web_server
from libs.python.serial_config import read_selection, save_selection, resolve_port, format_ports
from libs.python.settings import DEFAULTS, read_settings, validate_settings
from pathlib import Path


def wait_for(predicate, timeout=5, tick=lambda: None):
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= end:
            raise AssertionError("Timed out waiting for worker")
        tick()
        time.sleep(0.01)


def request(port, route, command=None, method=None, raw=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    body = raw if raw is not None else json.dumps({"command": command}) if method == "POST" else None
    try:
        connection.request(method or "GET", route, body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


class FakeSerial:
    def __init__(self, stall=None):
        self.stall = stall
        self.buffers = []
        self.release = threading.Event()

    def write(self, data):
        self.buffers.append(data)
        if self.stall == "write":
            self.release.wait()
        if self.stall == "error":
            raise OSError("Adapter disconnected")
        return len(data)

    def flush(self):
        if self.stall == "drain":
            self.release.wait()

    def close(self):
        pass


def supervised_worker(mode, heartbeat):
    if mode == "crash":
        os._exit(17)
    if mode == "hang":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            time.sleep(0.01)
    while True:
        heartbeat()
        time.sleep(0.01)


def supervised_bridge(port, heartbeat):
    class Serial(FakeSerial):
        def write(self, data):
            if data == bytes.fromhex("dead"):
                self.release.wait()
            return super().write(data)
    bridge = Bridge(Serial, lambda error: os._exit(17), timeout=0.15).start()
    with make_server(bridge, port, host="127.0.0.1", heartbeat=heartbeat) as server:
        server.serve_forever(poll_interval=0.02)


class SerialConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="flipdot-config-")
        self.addCleanup(temporary.cleanup)
        self.file = Path(temporary.name) / "flipdot_config.json"
        self.adapter = {"path": "/dev/adapter-a", "description": "FTDI", "serialNumber": "ADAPTER-A",
                        "vendorId": "0403", "productId": "6001"}

    def test_precedence_and_no_fallback(self):
        self.assertIsNone(read_selection(env={}, config_path=self.file))
        self.file.write_text(json.dumps({"serialPort": "COM3", "serialNumber": "SAVED"}))
        self.assertEqual(read_selection(env={}, config_path=self.file), {"serialPort": "COM3", "serialNumber": "SAVED"})
        self.assertEqual(read_selection(env={"FLIPDOT_SERIAL_PATH": "COM4"}, config_path=self.file), {"serialPort": "COM4"})
        self.assertEqual(read_selection("COM5", {"FLIPDOT_SERIAL_PATH": "COM4"}, self.file), {"serialPort": "COM5"})
        self.file.write_text("{broken")
        with self.assertRaisesRegex(ValueError, "Invalid"):
            read_selection(env={}, config_path=self.file)
        self.assertEqual(read_selection("COM5", {}, self.file), {"serialPort": "COM5"})

    def test_invalid_selections(self):
        for value in [None, [], {"serialPort": 3}, {"serialPort": " "},
                      {"serialPort": "COM3", "serialNumber": ""}, {"serialPort": "COM3", "vendorId": "bad"}]:
            self.file.write_text(json.dumps(value))
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "Invalid"):
                read_selection(env={}, config_path=self.file)

    def test_save_port_and_optional_identity(self):
        saved = save_selection(self.adapter, self.file)
        self.assertEqual(read_selection(env={}, config_path=self.file), saved)
        self.assertEqual(saved, {"serialPort": "/dev/adapter-a", "serialNumber": "ADAPTER-A", "vendorId": "0403", "productId": "6001"})
        self.assertEqual(json.loads(self.file.read_text()), {
            **saved, "webPort": 8081, "httpPort": 3000, "transmitEnabled": True})
        save_selection({"path": "COM8"}, self.file)
        self.assertEqual(read_selection(env={}, config_path=self.file), {"serialPort": "COM8"})
        self.assertEqual(json.loads(self.file.read_text()), {
            "serialPort": "COM8", "webPort": 8081, "httpPort": 3000, "transmitEnabled": True})
        self.assertEqual([file.name for file in self.file.parent.iterdir()], ["flipdot_config.json"])

    def test_settings_defaults_validation_and_saved_settings(self):
        self.assertEqual(read_settings({}, self.file), DEFAULTS)
        self.file.write_text(json.dumps({"webPort": 8099, "httpPort": 3456, "transmitEnabled": False,
                                         "serialPort": "OLD", "serialNumber": "OLD"}))
        save_selection({"path": "COM8"}, self.file)
        self.assertEqual(json.loads(self.file.read_text()), {"webPort": 8099, "httpPort": 3456, "transmitEnabled": False, "serialPort": "COM8"})
        self.assertEqual(read_settings({}, self.file)["httpPort"], 3456)
        self.assertEqual(read_settings({"FLIPDOT_HTTP_PORT": "3010"}, self.file)["httpPort"], 3010)
        self.assertTrue(validate_settings({})["transmitEnabled"])
        for value in [None, [], {"httpPort": True}, {"httpPort": 0}, {"webPort": 65536},
                      {"webPort": 3000}, {"transmitEnabled": "false"}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_settings(value)

    def test_save_partial_settings_preserves_disabled_transmission(self):
        self.file.write_text(json.dumps({"httpPort": 3456, "transmitEnabled": False}))
        save_selection(self.adapter, self.file)
        config = json.loads(self.file.read_text())
        self.assertEqual(config["webPort"], 8081)
        self.assertEqual(config["httpPort"], 3456)
        self.assertFalse(config["transmitEnabled"])

    def test_explicit_path_does_not_guess(self):
        def must_not_enumerate():
            self.fail("Explicit path should not require enumeration")
        self.assertEqual(resolve_port({"serialPort": "/dev/custom"}, must_not_enumerate), "/dev/custom")

    def test_identity_reconnect_rejects_wrong_or_ambiguous_adapters(self):
        selection = {"serialPort": "/dev/old-path", "serialNumber": "ADAPTER-A", "vendorId": "0403", "productId": "6001"}
        self.assertEqual(resolve_port(selection, lambda: [self.adapter]), self.adapter["path"])
        for changes in [{"serialNumber": "OTHER"}, {"vendorId": "ffff"}]:
            with self.assertRaisesRegex(ValueError, "unavailable"):
                resolve_port(selection, lambda: [{**self.adapter, **changes}])
        aliases = [self.adapter, {**self.adapter, "path": "/dev/alias"}]
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            resolve_port(selection, lambda: aliases)
        self.assertEqual(resolve_port({**selection, "serialPort": self.adapter["path"]}, lambda: aliases), self.adapter["path"])
        with self.assertRaisesRegex(ValueError, "unavailable"):
            resolve_port({**selection, "serialPort": self.adapter["path"]}, lambda: [{**self.adapter, "serialNumber": "OTHER"}])
        self.assertIn("0: /dev/adapter-a", format_ports([self.adapter]))
        self.assertIn("No serial interfaces", format_ports([]))

    def test_macos_aliases_and_optional_usb_metadata(self):
        selection = {"serialPort": "/dev/tty.usbserial-A", "serialNumber": "ADAPTER-A", "vendorId": "0403", "productId": "6001"}
        ports = [{"path": "/dev/cu.usbserial-A", "serialNumber": "ADAPTER-A"},
                 {"path": "/dev/cu.usbserial-alias", "serialNumber": "ADAPTER-A"}]
        self.assertEqual(resolve_port(selection, lambda: ports), "/dev/cu.usbserial-A")

    def test_launcher_modes_do_not_start_workers(self):
        with patch("flipdot_server.importlib.util.find_spec", return_value=object()), \
             patch("flipdot_server.list_ports", return_value=[self.adapter]), \
             patch("flipdot_server.Supervisor") as workers, \
             patch("builtins.print"), patch("sys.argv", ["flipdot_server.py", "--list-ports"]):
            flipdot_server.main()
            workers.assert_not_called()
        with patch("flipdot_server.importlib.util.find_spec", return_value=object()), \
             patch("flipdot_server.list_ports", return_value=[self.adapter]), \
             patch("flipdot_server.save_selection", side_effect=lambda port: save_selection(port, self.file)), \
             patch("flipdot_server.Supervisor") as workers, \
             patch("sys.stdin.isatty", return_value=True), patch("builtins.input", return_value="0"), \
             patch("builtins.print"), patch("sys.argv", ["flipdot_server.py", "--configure"]):
            flipdot_server.main()
            workers.assert_not_called()
        self.assertEqual(read_selection(env={}, config_path=self.file)["serialPort"], self.adapter["path"])
        with patch("flipdot_server.importlib.util.find_spec", return_value=object()), \
             patch("flipdot_server.read_selection", return_value=None), \
             patch("flipdot_server.list_ports", return_value=[self.adapter]), \
             patch("flipdot_server.Supervisor") as workers, patch("sys.stderr"), \
             patch("builtins.print"), patch("sys.argv", ["flipdot_server.py"]):
            with self.assertRaises(SystemExit) as exit_status:
                flipdot_server.main()
            self.assertEqual(exit_status.exception.code, 2)
            workers.assert_not_called()


class BridgeTests(unittest.TestCase):
    def start(self, serial=None, factory=None, **options):
        self.failures = []
        serial = serial or FakeSerial()
        bridge = Bridge(factory or (lambda: serial), self.failures.append, **options).start()
        self.addCleanup(bridge.stop)
        self.addCleanup(serial.release.set)
        server = make_server(bridge, 0, host="127.0.0.1")
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.02), daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        if factory is None and options.get("transmit_enabled", True):
            wait_for(lambda: bridge.status()["ready"])
        return bridge, serial, server.server_port

    def test_frame_and_health(self):
        bridge, serial, port = self.start()
        frame = "808400" + "7f" * 28 + "8f80843f" + "00" * 28 + "8f80828f"
        status, headers, _ = request(port, "/send-signal", frame, "POST")
        self.assertEqual(status, 200)
        self.assertEqual(serial.buffers, [bytes.fromhex(frame)])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        status, _, data = request(port, "/health")
        health = json.loads(data)
        self.assertEqual(status, 200)
        self.assertTrue(health["ready"])
        self.assertIsNotNone(health["lastWriteAt"])
        self.assertEqual(request(port, "/send-signal", method="OPTIONS")[0], 204)

    def test_disabled_transmission_does_not_open_or_write(self):
        def must_not_open():
            self.fail("Preview must not open device")
        bridge, serial, port = self.start(factory=must_not_open, transmit_enabled=False)
        self.assertEqual(request(port, "/send-signal", "80828f", "POST")[0], 200)
        status, _, data = request(port, "/health")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(data)["transmitEnabled"])
        self.assertFalse(bridge.ready)
        self.assertEqual(serial.buffers, [])
        self.assertEqual(self.failures, [])

    def test_invalid_commands_and_preview(self):
        _, serial, port = self.start()
        for command in [None, 123, "", "0", "zz", "00" * 257]:
            with self.subTest(command=command):
                self.assertEqual(request(port, "/send-signal", command, "POST")[0], 400)
        self.assertEqual(request(port, "/send-signal", "TX_OFF", "POST")[0], 200)
        self.assertEqual(request(port, "/send-signal", method="POST", raw="{")[0], 400)
        self.assertEqual(request(port, "/send-signal", method="POST", raw="x" * 2049)[0], 413)
        self.assertEqual(serial.buffers, [])

    def test_stalled_open(self):
        serial = FakeSerial()
        def factory():
            serial.release.wait()
            return serial
        bridge, _, _ = self.start(serial, factory, timeout=0.1)
        wait_for(lambda: self.failures)
        self.assertIn("open timed out", str(self.failures[0]))
        self.assertFalse(bridge.status()["ready"])

    def test_stalled_write_and_drain(self):
        for operation in ["write", "drain", "error"]:
            with self.subTest(operation=operation):
                bridge, _, port = self.start(FakeSerial(operation), timeout=0.1)
                self.assertEqual(request(port, "/send-signal", "80828f", "POST")[0], 503)
                self.assertFalse(bridge.status()["ready"])
                wait_for(lambda: self.failures)
                self.assertEqual(len(self.failures), 1)

    def test_queue_is_bounded_and_writes_wait_for_drain(self):
        serial = FakeSerial("drain")
        bridge, _, _ = self.start(serial, timeout=1, max_pending=1)
        first = bridge.submit(b"\x80")
        wait_for(lambda: serial.buffers)
        second = bridge.submit(b"\x81")
        with self.assertRaises(queue.Full):
            bridge.submit(b"\x82")
        self.assertFalse(first.done.is_set())
        self.assertEqual(serial.buffers, [b"\x80"])
        serial.release.set()
        self.assertTrue(second.done.wait(1))
        self.assertEqual(first.status, 200)
        self.assertEqual(second.status, 200)
        self.assertEqual(serial.buffers, [b"\x80", b"\x81"])


class WebTests(unittest.TestCase):
    def test_assets_and_no_cache(self):
        with make_web_server(0, host="127.0.0.1", settings=validate_settings({"httpPort": 3456, "transmitEnabled": False})) as server:
            thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.02), daemon=True)
            thread.start()
            try:
                for route in ["/", "/ptixy/", "/canvas/", "/ptixy_player/", "/ptixy/sketch.js", "/canvas/sketch.js", "/ptixy_player/sketch.js", "/libs/javascript/flipdot.js", "/libs/javascript/ptixy.js", "/static/style.css"]:
                    status, headers, body = request(server.server_port, route)
                    self.assertEqual(status, 200, route)
                    self.assertIn("no-store", headers["Cache-Control"])
                    self.assertTrue(body)
                for route in ["/libs/python/server.py", "/libs/javascript/server.js", "/ptixy_player/mySketch.js", "/ptixy_player/flipdot.js", "/.git/config", "/node_modules/express/package.json"]:
                    self.assertEqual(request(server.server_port, route)[0], 404, route)
                status, _, body = request(server.server_port, "/flipdot_config.json")
                settings = json.loads(body)
                self.assertEqual(status, 200)
                self.assertEqual(settings["httpPort"], 3456)
                self.assertFalse(settings["transmitEnabled"])
                self.assertEqual(set(settings), {"webPort", "httpPort", "transmitEnabled"})
                self.assertNotIn("serialPort", settings)
            finally:
                server.shutdown()


class SupervisorTests(unittest.TestCase):
    def start(self, mode=None, target=supervised_worker, args=None):
        logs = []
        supervisor = Supervisor("Test worker", target, args if args is not None else (mode,),
                                heartbeat_timeout=0.5, kill_timeout=0.1,
                                restart_delay=0.03, max_restart_delay=0.12,
                                heartbeat_interval=0.02, logger=logs.append)
        self.addCleanup(supervisor.stop)
        supervisor.tick()
        return supervisor, logs

    def test_healthy_worker_and_shutdown(self):
        supervisor, _ = self.start("healthy")
        pid = supervisor.process.pid
        end = time.monotonic() + 0.7
        while time.monotonic() < end:
            supervisor.tick()
            time.sleep(0.01)
        self.assertEqual(supervisor.process.pid, pid)
        supervisor.stop()
        supervisor.tick()
        self.assertIsNone(supervisor.process)

    def test_crash_restarts_and_backoff_is_capped(self):
        supervisor, logs = self.start("crash")
        wait_for(lambda: len([line for line in logs if "restarting" in line]) >= 4, tick=supervisor.tick)
        self.assertTrue(any("restarting in 0.12 seconds" in line for line in logs))

    def test_missing_heartbeat_forcibly_replaces_hung_worker(self):
        supervisor, logs = self.start("hang")
        pid = supervisor.process.pid
        wait_for(lambda: supervisor.process is not None and supervisor.process.pid != pid, tick=supervisor.tick)
        self.assertTrue(any("no heartbeat" in line for line in logs))

    def test_serial_timeout_restarts_worker_and_transmission_resumes(self):
        # Reserve a temporary port before handing it to supervised worker processes.
        with make_web_server(0, host="127.0.0.1") as reservation:
            port = reservation.server_port
        supervisor, _ = self.start(target=supervised_bridge, args=(port,))
        def ready():
            try:
                return request(port, "/health")[0] == 200
            except (OSError, http.client.HTTPException):
                return False
        wait_for(ready, tick=supervisor.tick)
        self.assertEqual(request(port, "/send-signal", "80828f", "POST")[0], 200)
        pid = supervisor.process.pid
        try:
            request(port, "/send-signal", "dead", "POST")
        except (OSError, http.client.HTTPException):
            pass
        wait_for(lambda: supervisor.process is not None and supervisor.process.pid != pid, tick=supervisor.tick)
        wait_for(ready, tick=supervisor.tick)
        self.assertEqual(request(port, "/send-signal", "80828f", "POST")[0], 200)


if __name__ == "__main__":
    unittest.main()
