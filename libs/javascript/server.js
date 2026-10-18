/**
 * Serial HTTP worker. POSTed hexadecimal bytes are written in order to one device.
 * A single write/drain operation is active at a time, with a bounded pending FIFO.
 * Fatal I/O errors exit this process so the external supervisor can reopen the port.
 */
const express = require('express');
const cors = require('cors');
const { SerialPort } = require('serialport');
const { readSelection, validateSelection, resolvePort } = require('./serial_config');
const { readSettings, validateSettings } = require('./settings');

/**
 * Build the HTTP API around an unopened SerialPort-compatible object.
 * timeoutMs covers each open or write+drain operation; maxPending excludes the
 * active write. Injecting the port and onFatal permits hardware-free failure tests.
 */
function createBridge({ serialPort, timeoutMs = 2000, maxPending = 32, onFatal, transmitEnabled = true }) {
  const app = express();
  // The sketch and API normally use different local ports, so browsers need CORS.
  app.use(cors());
  app.use(express.json({ limit: '2kb' }));

  // "ready" describes the serial connection, never completion of physical flips.
  let ready = false;
  let failed = false;
  let active;
  let timer;
  let lastWriteAt = null;
  const pending = [];

  function reject(job) {
    // Browser retries can close sockets before device recovery finishes.
    if (job && !job.res.destroyed) job.res.status(503).send('Serial bridge restarting');
  }

  function fail(error) {
    // Error events, close events and callbacks may report the same failure.
    // Notify the supervisor once and release any HTTP responses waiting on I/O.
    if (failed) return;
    failed = true;
    ready = false;
    clearTimeout(timer);
    reject(active);
    active = undefined;
    pending.splice(0).forEach(reject);
    onFatal(error);
  }

  function deadline(operation) {
    // Open and writes cannot overlap, so one timer covers the current operation.
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error(`Serial ${operation} timed out after ${timeoutMs} ms`)), timeoutMs);
  }

  function writeNext() {
    // Do not interleave requests. The browser normally supplies both panel stores
    // and the refresh command together as one complete 67-byte frame.
    if (failed || active || pending.length === 0) return;
    active = pending.shift();
    deadline('write/drain');
    try {
      serialPort.write(active.buffer, error => {
        if (failed) return;
        if (error) return fail(error);
        // Wait for OS-level serial transmission before acknowledging the HTTP
        // request. drain() does not report whether the panel received or flipped it.
        try {
          serialPort.drain(error => {
            if (failed) return;
            if (error) return fail(error);
            clearTimeout(timer);
            lastWriteAt = new Date().toISOString();
            if (!active.res.destroyed) active.res.send('Signal sent to serial port');
            active = undefined;
            writeNext();
          });
        } catch (error) { fail(error); }
      });
    } catch (error) { fail(error); }
  }

  app.get('/health', (req, res) => {
    // Operational diagnostics for humans/tooling; heartbeats use a separate IPC link.
    res.set('Cache-Control', 'no-store');
    res.status(ready || !transmitEnabled ? 200 : 503).json({
      ready, transmitEnabled, pid: process.pid, writing: Boolean(active), pending: pending.length, lastWriteAt,
    });
  });

  app.post('/send-signal', (req, res) => {
    const command = req.body?.command;
    if (command === 'TX_OFF') {
      // A preview notification from one sketch, not a server-wide output switch.
      return res.send('Transmission disabled; set ENABLE_TX to true in your sketch to transmit');
    }
    // JSON carries pairs of hexadecimal digits. Reject malformed or oversized
    // data before Buffer.from() can silently truncate it; frame headers stay opaque.
    if (typeof command !== 'string' || command.length > 512 ||
        !/^(?:[0-9a-fA-F]{2})+$/.test(command)) {
      return res.status(400).send('command must contain 1–256 bytes of hexadecimal data');
    }
    if (!transmitEnabled) return res.send('Transmission disabled by flipdot_config.json');
    if (!ready) return res.status(503).send('Serial port unavailable');
    if (pending.length >= maxPending) {
      // Refuse excess work rather than accumulating stale animation frames.
      return res.status(503).send('Serial queue full; retry with the latest frame');
    }
    pending.push({ buffer: Buffer.from(command, 'hex'), res });
    writeNext();
  });

  // Opening failures, unplugging and stream errors share the same recovery path.
  const onError = error => fail(error);
  const onClose = () => fail(new Error('Serial port disconnected'));
  if (transmitEnabled) {
    serialPort.on('error', onError);
    serialPort.on('close', onClose);
    deadline('open');
    try {
      serialPort.open(error => {
        if (failed) return;
        if (error) return fail(error);
        clearTimeout(timer);
        ready = true;
        console.log(`Serial port open: ${serialPort.path}`);
      });
    } catch (error) { fail(error); }
  }

  return {
    app,
    dispose() {
      // Test/embedding cleanup only: detach listeners and timers without calling
      // onFatal. The production process releases the device when it exits.
      failed = true;
      ready = false;
      clearTimeout(timer);
      reject(active);
      active = undefined;
      pending.splice(0).forEach(reject);
      serialPort?.removeListener('error', onError);
      serialPort?.removeListener('close', onClose);
    },
  };
}

/** Open the launcher's selected device and report liveness over its IPC channel. */
async function main() {
  const settings = process.env.FLIPDOT_SETTINGS ? validateSettings(JSON.parse(process.env.FLIPDOT_SETTINGS)) : readSettings();
  const port = settings.httpPort;
  // An internal environment value preserves CLI overrides across restarts.
  // When run directly, the worker instead reads the usual environment/JSON choice.
  const savedSelection = process.env.FLIPDOT_SERIAL_SELECTION ? JSON.parse(process.env.FLIPDOT_SERIAL_SELECTION) : undefined;
  const selection = savedSelection === undefined ? readSelection() :
    savedSelection === null ? null : validateSelection(savedSelection);
  if (!selection && settings.transmitEnabled) throw new Error('No serial interface configured. Run flipdot_server.js --configure first.');
  const serialPort = settings.transmitEnabled ? new SerialPort({
    // Re-enumerate saved identities on every new worker, allowing path changes.
    path: await resolvePort(selection),
    baudRate: 57600, // XY5 baud DIP switches: 1 OFF, 2 ON, 3 ON on both controllers.
    autoOpen: false,
  }) : null;
  const fatal = error => {
    console.error(`[${new Date().toISOString()}] Serial bridge failure: ${error.stack || error}`);
    // Exiting releases the device; flipdot_server.js opens it again in a fresh process.
    process.exit(1);
  };
  const { app } = createBridge({ serialPort, onFatal: fatal, transmitEnabled: settings.transmitEnabled });
  const server = app.listen(port, () => console.log(`Serial HTTP bridge listening on port ${port}`));
  server.on('error', fatal);

  if (process.send) {
    // This timer runs on the worker's event loop. If that loop blocks, the parent
    // stops receiving heartbeats and can kill the worker from outside the stall.
    setInterval(() => {
      if (process.connected) process.send({ type: 'heartbeat' }, () => {});
    }, 1000);
    // Release the device if the supervisor goes away.
    process.on('disconnect', () => process.exit(1));
  }
  // Unexpected exceptions use Node's normal crash behavior, allowing a clean restart.
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { createBridge };
