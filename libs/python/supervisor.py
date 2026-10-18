"""Python-only process supervision; never launches Node or a shell."""

import multiprocessing
import os
import signal
import time
from datetime import datetime, timezone


def log(message):
    """Emit UTC lifecycle diagnostics without buffering them between restarts."""
    print(f"[{datetime.now(timezone.utc).isoformat()}] {message}", flush=True)


def _entry(target, args, sender, heartbeat_interval):
    """Bootstrap one spawned child and give its serving loop a heartbeat callback."""
    # Ctrl+C belongs to the parent; it will stop/reap children in an orderly sequence.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    last_sent = 0

    def heartbeat():
        # Called by the HTTP serving loop, not a background liveness thread:
        # a frozen serving loop must stop proving health to the parent.
        nonlocal last_sent
        if time.monotonic() - last_sent < heartbeat_interval:
            return
        try:
            sender.send("heartbeat")
        except (BrokenPipeError, EOFError, OSError):
            os._exit(1)  # The supervisor disappeared; release the device.
        last_sent = time.monotonic()

    # Allow startup time before the target begins calling service_actions().
    heartbeat()
    target(*args, heartbeat=heartbeat)


class Supervisor:
    """Monitor one child using a private heartbeat pipe and monotonic deadlines.

    tick() is driven by the launcher's loop. It starts/restarts workers, detects
    unexpected exits, and escalates termination for hung processes. Missing devices
    retry with capped exponential backoff; an intentional stop disables all retries.
    """
    def __init__(self, name, target, args=(), heartbeat_timeout=5, kill_timeout=1,
                 restart_delay=1, max_restart_delay=10, stable_time=30,
                 heartbeat_interval=1, logger=log):
        self.name, self.target, self.args = name, target, args
        self.heartbeat_timeout, self.kill_timeout = heartbeat_timeout, kill_timeout
        self.restart_delay, self.max_restart_delay = restart_delay, max_restart_delay
        self.stable_time, self.heartbeat_interval = stable_time, heartbeat_interval
        self.log = logger
        # Each replacement gets fresh Process/Pipe objects; no damaged channel is reused.
        self.process = self.receiver = None
        self.delay = restart_delay
        self.restart_at = 0
        self.stopping = False
        self.kill_at = None
        self.started_at = self.last_heartbeat = 0

    def _start(self):
        """Spawn a fresh interpreter rather than inheriting live threads or device handles."""
        context = multiprocessing.get_context("spawn")
        # Only the parent reads; the child owns the sending end.
        self.receiver, sender = context.Pipe(duplex=False)
        self.process = context.Process(target=_entry, args=(
            self.target, self.args, sender, self.heartbeat_interval), daemon=True)
        self.started_at = self.last_heartbeat = time.monotonic()
        self.process.start()
        # Only the child should hold a writer, so its exit produces EOF in the parent.
        sender.close()
        self.log(f"{self.name}: started PID {self.process.pid}")

    def tick(self):
        """Perform one supervision pass without sleeping through restart backoff."""
        if self.stopping:
            return
        # Clock corrections must not look like long stalls or negative durations.
        now = time.monotonic()
        if self.process is None:
            if now >= self.restart_at:
                self._start()
            return
        try:
            # Drain all available heartbeats without blocking the other supervisor.
            while self.receiver.poll():
                if self.receiver.recv() == "heartbeat":
                    self.last_heartbeat = now
        except (EOFError, OSError):
            # An exiting child closes its pipe; the exit/timeout checks below handle it.
            pass
        if not self.process.is_alive():
            # Reap the old child and close its pipe before reopening the same ports.
            self.process.join()
            code = self.process.exitcode
            self.process.close()
            self.receiver.close()
            self.process = self.receiver = None
            self.kill_at = None
            if now - self.started_at >= self.stable_time:
                # A recovered installation should not retain an old, long backoff.
                self.delay = self.restart_delay
            self.log(f"{self.name}: exited ({code}); restarting in {self.delay:g} seconds")
            self.restart_at = now + self.delay
            self.delay = min(self.delay * 2, self.max_restart_delay)
        elif self.kill_at is not None:
            # A worker may ignore termination or be blocked inside a device driver.
            if now >= self.kill_at:
                self.process.kill()
        elif now - self.last_heartbeat > self.heartbeat_timeout:
            self.log(f"{self.name}: no heartbeat; terminating PID {self.process.pid}")
            self.process.terminate()
            self.kill_at = now + self.kill_timeout

    def stop(self):
        """Cancel restarts, terminate the child, then reap all process/pipe resources."""
        self.stopping = True
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(self.kill_timeout)
                if self.process.is_alive():
                    self.process.kill()
            self.process.join()
            self.process.close()
            self.receiver.close()
            self.process = self.receiver = None
