"""Run the web server, serial bridge, and watchdog using Python only."""

import argparse
import importlib.util
import multiprocessing
import os
import signal
import time

from libs.python.server import run_bridge
from libs.python.supervisor import Supervisor
from libs.python.web import run_web
from libs.python.serial_config import CONFIG_PATH, read_selection, list_ports, format_ports, save_selection
from libs.python.settings import read_settings


def main():
    """Resolve CLI/setup modes, then monitor independent web and serial processes."""
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Selection: --port > FLIPDOT_SERIAL_PATH > flipdot_config.json. "
        "The repository includes the author's configuration; revise or delete it for your machine."))
    parser.add_argument("-v", "--verbose", action="store_true")
    # Discovery and setup exit without workers; --port selects a normal server run.
    selection_args = parser.add_mutually_exclusive_group()
    selection_args.add_argument("--list-ports", action="store_true", help="List serial interfaces and exit")
    selection_args.add_argument("--port", metavar="PATH", help="Use this device path or COM port for this run")
    selection_args.add_argument("--configure", action="store_true", help="Choose an interface and save flipdot_config.json")
    args = parser.parse_args()
    # Report a missing installation dependency once, before entering a restart loop.
    if importlib.util.find_spec("serial") is None:
        parser.exit(1, "pySerial is missing. Run python -m pip install -r libs/python/requirements.txt from the repository directory.\n")
    try:
        if args.list_ports:
            print(format_ports(list_ports()))
            return
        if args.configure:
            import sys
            # A service cannot answer prompts; configure separately or pass --port.
            if not sys.stdin.isatty():
                parser.error("--configure requires an interactive terminal; use --port PATH instead.")
            ports = list_ports()
            print(format_ports(ports))
            if not ports:
                parser.error("Connect your serial adapter and run --configure again.")
            while True:
                answer = input("Choose an interface number: ").strip()
                if not answer.isascii() or not answer.isdigit() or not 0 <= int(answer) < len(ports):
                    print("Enter one of the interface numbers shown above.")
                    continue
                # Never save the list index: enumeration order can change later.
                selection = save_selection(ports[int(answer)])
                print(f"Saved {selection['serialPort']} to {CONFIG_PATH}. Run python flipdot_server.py to start.")
                return
        # CLI > environment > JSON. Replacements receive this same selection;
        # editing the JSON during a run therefore requires restarting the launcher.
        settings = read_settings()
        selection = read_selection(args.port)
        if selection is None and settings["transmitEnabled"]:
            print(format_ports(list_ports()))
            parser.error("No serial interface configured. Run --configure, use --port PATH, or revise flipdot_config.json.")
    except (EOFError, KeyboardInterrupt):
        parser.exit(130, "Serial selection cancelled.\n")
    except (ValueError, OSError) as error:
        parser.error(str(error))
    web_port, http_port = settings["webPort"], settings["httpPort"]
    # Device ownership belongs to the serial child, leaving this parent free to
    # terminate a blocked driver without disrupting the separate sketch web server.
    workers = [
        Supervisor("Web server", run_web, (web_port, args.verbose, settings)),
        Supervisor("Serial bridge", run_bridge, (http_port, selection, args.verbose, settings)),
    ]
    stopping = False

    def shutdown(*_args):
        # Keep signal handlers small; the main loop's finally block owns cleanup.
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    print(f"Configured serial interface: {selection['serialPort'] if selection else '(none)'}", flush=True)
    print(f"Serial API: http://localhost:{http_port}; transmission "
          f"{'enabled' if settings['transmitEnabled'] else 'DISABLED (preview only)'}", flush=True)
    print(f"Hosting sketches at http://localhost:{web_port}", flush=True)
    print("Python watchdog enabled. Press Ctrl+C to stop both servers.", flush=True)
    try:
        while not stopping:
            # tick() checks heartbeats/exits and schedules restarts without
            # blocking on healthy workers or waiting through restart backoff.
            for worker in workers:
                worker.tick()
            time.sleep(0.1)
    finally:
        # Disable automatic restarts and reap children on Ctrl+C or other exits.
        for worker in workers:
            worker.stop()


if __name__ == "__main__":
    # Required for multiprocessing launchers packaged as Windows executables.
    multiprocessing.freeze_support()
    main()
