/** Supervise one worker without owning its HTTP sockets or serial device. */
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

/**
 * Start a child and replace it after exits or missed IPC heartbeats.
 * Repeated failures back off up to maxRestartDelayMs; stableMs resets that delay.
 * stop() cancels restarts and resolves only after the child has closed.
 */
function supervise({
  name, command, args = [], cwd, env = process.env, verbose = false,
  heartbeat = false, heartbeatTimeoutMs = 5000, killTimeoutMs = 1000,
  restartDelayMs = 1000, maxRestartDelayMs = 10000, stableMs = 30000,
  log = message => console.error(`[${new Date().toISOString()}] ${message}`),
}) {
  let child;
  let stopping = false;
  let restartTimer;
  let watchdog;
  let killTimer;
  let delay = restartDelayMs;
  let stopPromise;
  let finishStop;

  function terminate(reason) {
    // Request termination once, then force it if a blocked event loop or signal
    // handler prevents shutdown. Keep the old child until its close event arrives.
    if (!child || killTimer) return;
    log(`${name}: ${reason}; terminating PID ${child.pid}`);
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child?.kill('SIGKILL'), killTimeoutMs);
  }

  function start() {
    if (stopping) return;
    // Monotonic time avoids false hangs if the computer's wall clock changes.
    const startedAt = performance.now();
    let lastHeartbeat = startedAt;
    child = spawn(command, args, {
      cwd, env,
      // Spawn directly (no shell). IPC is independent of stdout/stderr logging.
      stdio: heartbeat ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    // Continuously consume output without exec's accumulating maxBuffer.
    child.stdout.on('data', data => {
      if (verbose) process.stdout.write(`[${name}] ${data}`);
    });
    child.stderr.on('data', data => process.stderr.write(`[${name}] ${data}`));
    child.on('spawn', () => log(`${name}: started PID ${child.pid}`));
    child.on('error', error => log(`${name}: ${error.message}`));
    if (heartbeat) {
      // Silence, rather than lack of incoming frames, indicates a worker stall.
      // An idle installation should keep running without unnecessary restarts.
      child.on('message', message => {
        if (message?.type === 'heartbeat') lastHeartbeat = performance.now();
      });
      watchdog = setInterval(() => {
        if (performance.now() - lastHeartbeat > heartbeatTimeoutMs) {
          terminate(`no heartbeat for ${heartbeatTimeoutMs} ms`);
        }
      }, Math.min(1000, heartbeatTimeoutMs / 2));
    }
    child.once('close', (code, signal) => {
      // Wait for process/stdio closure before starting a replacement so workers
      // do not compete for the same listener port or serial-device handle.
      clearInterval(watchdog);
      clearTimeout(killTimer);
      killTimer = undefined;
      child = undefined;
      if (stopping) {
        finishStop?.();
        return;
      }
      if (performance.now() - startedAt >= stableMs) delay = restartDelayMs;
      // Unplugged adapters and port conflicts retry indefinitely at a capped rate.
      log(`${name}: exited (${signal || code}); restarting in ${delay} ms`);
      restartTimer = setTimeout(start, delay);
      delay = Math.min(delay * 2, maxRestartDelayMs);
    });
  }

  start();
  return {
    get child() { return child; },
    stop() {
      // Reuse the same promise for repeated signals; a planned stop never respawns.
      if (stopPromise) return stopPromise;
      stopping = true;
      clearTimeout(restartTimer);
      clearInterval(watchdog);
      stopPromise = new Promise(resolve => {
        finishStop = resolve;
        if (child) terminate('shutting down');
        else resolve();
      });
      return stopPromise;
    },
  };
}

module.exports = { supervise };
