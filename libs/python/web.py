"""Serve the same sketch files and URLs as libs/javascript/web.js, without Node."""

import functools
import http.server
import io
import json
import posixpath
from pathlib import Path
from urllib.parse import unquote, urlsplit
from .settings import read_settings, public_settings

# Resolve assets from the repository, independent of the launcher's working directory.
ROOT = Path(__file__).resolve().parents[2]


class WatchdogHTTPServer(http.server.ThreadingHTTPServer):
    """Keep request handling in threads while proving the serving loop is responsive.

    Both the asset server and serial API use this class. In the serial API, a
    request can wait on its queued write without preventing serving-loop heartbeats.
    """
    def __init__(self, *args, heartbeat=None, **kwargs):
        self.heartbeat = heartbeat
        super().__init__(*args, **kwargs)

    def service_actions(self):
        # Heartbeat follows the serving loop, so a stuck loop loses its heartbeat.
        if self.heartbeat is not None:
            self.heartbeat()


class WebHandler(http.server.SimpleHTTPRequestHandler):
    """Serve only browser assets, excluding backend modules and local configuration."""
    def __init__(self, *args, verbose=False, settings=None, **kwargs):
        self.verbose = verbose
        self.settings = settings if settings is not None else read_settings()
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # A reload should fetch current sketches and shared transport code.
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def send_head(self):
        """Apply the same route allowlist to GET and HEAD before serving any file."""
        # Decode and normalize first, so directory traversal cannot broaden which
        # top-level paths are allowed. Only shared browser libraries are public in libs/.
        route = posixpath.normpath(unquote(urlsplit(self.path).path))
        if route == "/flipdot_config.json":
            # Public subset only; the private serial-device identity stays local.
            data = json.dumps(public_settings(self.settings)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return io.BytesIO(data)
        allowed = route in ("/", "/libs/javascript/flipdot.js", "/libs/javascript/ptixy.js") or any(
            route == f"/{name}" or route.startswith(f"/{name}/")
            for name in ("canvas", "ptixy", "ptixy_player", "static"))
        if not allowed:
            self.send_error(404)
            return None
        # Disable conditional 304 responses so a refresh loads the current transport.
        if "If-Modified-Since" in self.headers:
            del self.headers["If-Modified-Since"]
        return super().send_head()

    def log_message(self, message, *args):
        # Ordinary file requests are quiet unless the launcher was given -v.
        if self.verbose:
            super().log_message(message, *args)


def make_server(port, verbose=False, host="", heartbeat=None, settings=None):
    """Create a reusable listener with the optional parent-watchdog heartbeat hook."""
    return WatchdogHTTPServer(
        (host, port), functools.partial(WebHandler, verbose=verbose, settings=settings), heartbeat=heartbeat)


def run_web(port=8081, verbose=False, settings=None, heartbeat=None):
    """Worker entry point: host the sketches independently of serial-device recovery."""
    with make_server(port, verbose, heartbeat=heartbeat, settings=settings) as server:
        print(f"Hosting sketches on port {server.server_port}", flush=True)
        server.serve_forever()
