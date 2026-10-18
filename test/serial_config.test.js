const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSelection, saveSelection, resolvePort, parseArgs, formatPorts } =
  require('../libs/javascript/serial_config');

const adapter = { path: '/dev/adapter-a', description: 'FTDI', serialNumber: 'ADAPTER-A', vendorId: '0403', productId: '6001' };
function temporaryConfig(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flipdot-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'flipdot_config.json');
}

test('serial selection honors CLI, environment, then file, with no hardcoded fallback', t => {
  const file = temporaryConfig(t);
  assert.equal(readSelection(undefined, {}, file), null);
  fs.writeFileSync(file, JSON.stringify({ serialPort: 'COM3', serialNumber: 'SAVED' }));
  assert.deepEqual(readSelection(undefined, {}, file), { serialPort: 'COM3', serialNumber: 'SAVED' });
  assert.deepEqual(readSelection(undefined, { FLIPDOT_SERIAL_PATH: 'COM4' }, file), { serialPort: 'COM4' });
  assert.deepEqual(readSelection('COM5', { FLIPDOT_SERIAL_PATH: 'COM4' }, file), { serialPort: 'COM5' });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readSelection(undefined, {}, file), /Invalid/);
  assert.deepEqual(readSelection('COM5', {}, file), { serialPort: 'COM5' });
});

test('invalid saved selections fail before any device can be opened', t => {
  const file = temporaryConfig(t);
  for (const value of [null, [], { serialPort: 3 }, { serialPort: ' ' },
    { serialPort: 'COM3', serialNumber: '' }, { serialPort: 'COM3', vendorId: 'bad' }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readSelection(undefined, {}, file), /Invalid/);
  }
});

test('chooser preserves installation settings while replacing the complete adapter identity', t => {
  const file = temporaryConfig(t);
  fs.writeFileSync(file, JSON.stringify({ webPort: 8099, httpPort: 3456, transmitEnabled: false, serialPort: 'OLD', serialNumber: 'OLD' }));
  saveSelection({ path: 'COM8' }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { webPort: 8099, httpPort: 3456, transmitEnabled: false, serialPort: 'COM8' });
});

test('chooser saves a portable selection and identity when available', t => {
  const file = temporaryConfig(t);
  const saved = saveSelection(adapter, file);
  assert.deepEqual(readSelection(undefined, {}, file), saved);
  assert.deepEqual(saved, { serialPort: adapter.path, serialNumber: 'ADAPTER-A', vendorId: '0403', productId: '6001' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    ...saved, webPort: 8081, httpPort: 3000, transmitEnabled: true,
  });
  saveSelection({ path: 'COM8', description: 'Unidentified adapter' }, file);
  assert.deepEqual(readSelection(undefined, {}, file), { serialPort: 'COM8' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    serialPort: 'COM8', webPort: 8081, httpPort: 3000, transmitEnabled: true,
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['flipdot_config.json']);
});

test('chooser fills partial settings without changing disabled transmission or custom ports', t => {
  const file = temporaryConfig(t);
  fs.writeFileSync(file, JSON.stringify({ httpPort: 3456, transmitEnabled: false }));
  saveSelection(adapter, file);
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.webPort, 8081);
  assert.equal(config.httpPort, 3456);
  assert.equal(config.transmitEnabled, false);
});

test('explicit paths are used without guessing or enumerating', async () => {
  assert.equal(await resolvePort({ serialPort: '/dev/custom' }, () => {
    throw new Error('Must not enumerate');
  }), '/dev/custom');
});

test('saved USB identity follows a renamed port and rejects wrong or ambiguous adapters', async () => {
  const selection = { serialPort: '/dev/old-path', serialNumber: 'ADAPTER-A', vendorId: '0403', productId: '6001' };
  assert.equal(await resolvePort(selection, async () => [adapter]), adapter.path);
  await assert.rejects(resolvePort(selection, async () => [{ ...adapter, serialNumber: 'OTHER' }]), /unavailable/);
  await assert.rejects(resolvePort(selection, async () => [{ ...adapter, vendorId: 'ffff' }]), /unavailable/);
  await assert.rejects(resolvePort(selection, async () => [adapter, { ...adapter, path: '/dev/alias' }]), /ambiguous/);
  assert.equal(await resolvePort({ ...selection, serialPort: adapter.path }, async () => [adapter, { ...adapter, path: '/dev/alias' }]), adapter.path);
  // Never trust a reused path whose attached adapter has a different serial number.
  await assert.rejects(resolvePort({ ...selection, serialPort: adapter.path }, async () => [{ ...adapter, serialNumber: 'OTHER' }]), /unavailable/);
});

test('CLI modes are explicit and mutually exclusive', () => {
  assert.equal(parseArgs(['--port', 'COM3', '-v']).port, 'COM3');
  assert.equal(parseArgs(['--port=COM3']).port, 'COM3');
  assert.equal(parseArgs(['--list-ports']).list, true);
  assert.equal(parseArgs(['--configure']).configure, true);
  assert.equal(parseArgs(['--help']).help, true);
  for (const args of [['--port'], ['--port', '-v'], ['--port', '--verbose'], ['--unknown'], ['--list-ports', '--configure'], ['--configure', '--port=COM3']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.match(formatPorts([adapter]), /0:.*adapter-a.*ADAPTER-A/);
  assert.match(formatPorts([]), /No serial interfaces/);
});

test('saved identities work across macOS tty/cu enumeration and optional USB metadata', async () => {
  const selection = { serialPort: '/dev/cu.usbserial-A', serialNumber: 'ADAPTER-A', vendorId: '0403', productId: '6001' };
  const ports = [{ path: '/dev/tty.usbserial-A', serialNumber: 'ADAPTER-A' },
    { path: '/dev/tty.usbserial-alias', serialNumber: 'ADAPTER-A' }];
  assert.equal(await resolvePort(selection, async () => ports), '/dev/tty.usbserial-A');
});
