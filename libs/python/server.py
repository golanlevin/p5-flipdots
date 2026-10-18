"""Python serial bridge with bounded writes and process-watchdog integration."""

import functools
import http.server
import json
import os
import queue
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .web import WatchdogHTTPServer
from .serial_config import read_selection, resolve_port
from .settings import read_settings


@dataclass
class Job:
    """One serial write and the event its HTTP handler waits on for completion.

    A failed or cancelled job keeps the default 503 status. Only successful
    write-and-flush completion changes it to 200 before waking the handler.
    """
    data: bytes
    done: threading.Event = field(default_factory=threading.Event)
    status: int = 503


class Bridge:
    """Serialize HTTP work through one device-owning thread and monitor its deadlines.

    Request threads never write directly to the port. The lock protects connection
    state and the active job; Queue bounds the remaining work. A monitor thread can
    fail an operation whose driver callback never returns, while the separate parent
    watchdog can replace this entire process if Python itself becomes unresponsive.
    """
    def __init__(self, serial_factory, on_fatal, timeout=2, max_pending=32, transmit_enabled=True):
        self.serial_factory, self.on_fatal = serial_factory, on_fatal
        self.transmit_enabled = transmit_enabled
        self.timeout = timeout
        self.pending = queue.Queue(maxsize=max_pending)
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        # Readiness means an open serial connection, not feedback from moving dots.
        self.ready = self.failed = False
        self.active = self.serial = None
        # Include adapter discovery and construction in the initial open deadline.
        self.operation, self.operation_started = "open" if transmit_enabled else None, time.monotonic()
        self.last_write_at = None
        self.io_thread = threading.Thread(target=self._io, daemon=True)
        self.monitor = threading.Thread(target=self._monitor, daemon=True)

    def start(self):
        """Start deadline monitoring before attempting any potentially blocking I/O."""
        if self.transmit_enabled:
            self.monitor.start()
            self.io_thread.start()
        return self

    def status(self):
        """Take a consistent connection/queue snapshot for the /health response."""
        with self.lock:
            return {"ready": self.ready, "transmitEnabled": self.transmit_enabled, "pid": os.getpid(),
                    "writing": self.active is not None, "pending": self.pending.qsize(),
                    "lastWriteAt": self.last_write_at}

    def submit(self, data):
        """Enqueue bytes without waiting; unavailable/full queues are HTTP 503 cases."""
        job = Job(data)
        with self.lock:
            if not self.transmit_enabled:
                job.status = 200
                job.done.set()
                return job
            if not self.ready:
                raise RuntimeError("Serial port unavailable")
            self.pending.put_nowait(job)
        return job

    def fail(self, error, notify=True):
        """Fail once, wake all waiting handlers, then invoke the worker's exit hook."""
        with self.lock:
            if self.failed:
                return
            self.failed, self.ready, self.operation = True, False, None
            if self.active is not None:
                self.active.done.set()
                self.active = None
            while True:
                try:
                    self.pending.get_nowait().done.set()
                except queue.Empty:
                    break
        # Call outside the lock: production exits, whereas tests may inspect state.
        if notify:
            self.on_fatal(error)

    def _monitor(self):
        """Watch an active open/write/flush deadline; idle connections have no deadline."""
        while not self.stopped.wait(min(0.1, self.timeout / 4)):
            with self.lock:
                expired = self.operation and time.monotonic() - self.operation_started > self.timeout
                operation = self.operation
            if expired:
                self.fail(TimeoutError(f"Serial {operation} timed out after {self.timeout:g} seconds"))
                return

    def _io(self):
        """Open the adapter and process complete request buffers in FIFO order."""
        try:
            self.serial = self.serial_factory()
            with self.lock:
                if self.failed:
                    return
                self.ready, self.operation = True, None
            while not self.stopped.is_set():
                try:
                    job = self.pending.get(timeout=0.1)
                except queue.Empty:
                    continue
                with self.lock:
                    # A request removed from Queue can race with monitor failure;
                    # do not start its write after the bridge has already failed.
                    if self.failed:
                        job.done.set()
                        return
                    self.active = job
                    self.operation, self.operation_started = "write/drain", time.monotonic()
                written = self.serial.write(job.data)
                if written != len(job.data):
                    raise IOError(f"Incomplete serial write: {written}/{len(job.data)} bytes")
                # pySerial flush waits for outgoing transmission. This is an OS/
                # adapter completion check, not an acknowledgement from the panel.
                self.serial.flush()
                with self.lock:
                    if self.failed:
                        return
                    self.last_write_at = datetime.now(timezone.utc).isoformat(
                        timespec="milliseconds").replace("+00:00", "Z")
                    self.operation, self.active = None, None
                    # Set the result before waking the thread that owns the socket.
                    job.status = 200
                    job.done.set()
        except Exception as error:
            self.fail(error)

    def stop(self):
        """Wake callers and request thread shutdown without indefinitely joining hung I/O."""
        self.stopped.set()
        self.fail(RuntimeError("Serial bridge stopping"), notify=False)
        if self.transmit_enabled:
            self.io_thread.join(0.2)
            self.monitor.join(0.2)
        if self.serial is not None and not self.io_thread.is_alive():
            self.serial.close()


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    """Expose the same /send-signal and /health contract as the JavaScript bridge."""
    def __init__(self, *args, bridge, verbose=False, **kwargs):
        self.bridge, self.verbose = bridge, verbose
        super().__init__(*args, **kwargs)

    def end_headers(self):
        # Sketches use another local port or a separate editor server; permit CORS
        # and prevent a cached health response from hiding a connection failure.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def respond(self, status, text, content_type="text/plain; charset=utf-8"):
        """Send a bounded UTF-8 response, tolerating browsers that abandoned old frames."""
        data = text.encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Browser aborted an old request; the serial worker remains healthy.

    def do_OPTIONS(self):
        """Answer browser preflight requests for cross-origin JSON POSTs."""
        self.respond(204, "")

    def do_GET(self):
        """Report serial state only; supervisor heartbeats travel over a separate pipe."""
        if self.path.split("?", 1)[0] != "/health":
            return self.respond(404, "Not found")
        status = self.bridge.status()
        self.respond(200 if status["ready"] or not status["transmitEnabled"] else 503, json.dumps(status), "application/json")

    def do_POST(self):
        """Validate hex input, enqueue one buffer, and acknowledge after transmission."""
        if self.path.split("?", 1)[0] != "/send-signal":
            return self.respond(404, "Not found")
        try:
            # Limit the body before reading/decoding it; command bytes have their
            # own smaller bound below. We validate hex pairs, not XY5 packet content.
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 2048:
                return self.respond(413, "JSON body must contain 1–2048 bytes")
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            return self.respond(400, "Invalid JSON body")
        command = body.get("command") if isinstance(body, dict) else None
        if command == "TX_OFF":
            # Preview notification only; this does not disable other transmitting clients.
            return self.respond(200, "Transmission disabled; set ENABLE_TX to true in your sketch to transmit")
        if not isinstance(command, str) or len(command) > 512 or not re.fullmatch(
                r"(?:[0-9a-fA-F]{2})+", command):
            return self.respond(400, "command must contain 1–256 bytes of hexadecimal data")
        if not self.bridge.transmit_enabled:
            return self.respond(200, "Transmission disabled by flipdot_config.json")
        try:
            job = self.bridge.submit(bytes.fromhex(command))
        except (RuntimeError, queue.Full):
            return self.respond(503, "Serial port unavailable or queue full; retry with the latest frame")
        # ThreadingHTTPServer gives this handler its own thread. Waiting here
        # leaves the HTTP serving loop, heartbeats and other requests responsive.
        job.done.wait()
        self.respond(job.status, "Signal sent to serial port" if job.status == 200 else "Serial bridge restarting")

    def log_message(self, message, *args):
        # Avoid per-frame logs; report failures and lifecycle events instead.
        pass


def make_server(bridge, port, verbose=False, host="", heartbeat=None):
    """Attach one shared bridge to threaded handlers and the serving-loop heartbeat."""
    handler = functools.partial(BridgeHandler, bridge=bridge, verbose=verbose)
    return WatchdogHTTPServer((host, port), handler, heartbeat=heartbeat)


def run_bridge(port=3000, selection=None, verbose=False, settings=None, heartbeat=None):
    """Worker entry point: own the selected device and exit on fatal serial failure."""
    import serial
    settings = read_settings() if settings is None else settings

    def fatal(error):
        print(f"[{datetime.now(timezone.utc).isoformat()}] Serial bridge failure: {error}",
              file=sys.stderr, flush=True)
        os._exit(1)  # Also escapes blocked serial threads; the supervisor reopens the device.

    # The launcher passes its resolved selection. Direct callers may load the
    # normal configuration, but there is deliberately no device-name fallback.
    if selection is None and settings["transmitEnabled"]:
        selection = read_selection()
    if selection is None and settings["transmitEnabled"]:
        raise ValueError("No serial interface configured. Run flipdot_server.py --configure first.")
    bridge = Bridge(
        # Resolution runs inside the monitored open operation on every new worker,
        # so a saved USB identity can follow the adapter to a changed device path.
        # Fixed XY5 link speed: baud DIP switches 1 OFF, 2 ON, 3 ON on both controllers.
        lambda: serial.Serial(resolve_port(selection), baudrate=57600, timeout=0, write_timeout=2),
        fatal, transmit_enabled=settings["transmitEnabled"]).start()
    try:
        with make_server(bridge, port, verbose, heartbeat=heartbeat) as server:
            print(f"Serial HTTP bridge listening on port {server.server_port}", flush=True)
            server.serve_forever()
    finally:
        bridge.stop()
