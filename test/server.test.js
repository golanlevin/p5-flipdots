const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { createBridge } = require('../libs/javascript/server');

class FakeSerial extends EventEmitter {
  path = 'FAKE';
  buffers = [];
  open(callback) { setImmediate(() => callback()); }
  write(buffer, callback) { this.buffers.push(buffer); setImmediate(() => callback()); }
  drain(callback) { setImmediate(() => callback()); }
}

async function start(t, serialPort = new FakeSerial(), options = {}) {
  const failures = [];
  const bridge = createBridge({ serialPort, onFatal: error => failures.push(error), ...options });
  const server = bridge.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    bridge.dispose();
    return new Promise(resolve => server.close(resolve));
  });
  const request = (body, route = '/send-signal') => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: route,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let text = '';
      res.on('data', data => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Wait for asynchronous serial open before issuing writes.
  await new Promise(resolve => setImmediate(resolve));
  return { request, serialPort, failures };
}

test('complete frame bytes stay together and responses wait for drain', async t => {
  const serial = new FakeSerial();
  let finishDrain;
  serial.drain = callback => { finishDrain = callback; };
  const { request } = await start(t, serial);
  const frame = `808400${'7f'.repeat(28)}8f80843f${'00'.repeat(28)}8f80828f`;
  let responded = false;
  const result = request({ command: frame }).then(response => { responded = true; return response; });
  while (!finishDrain) await new Promise(resolve => setImmediate(resolve));
  assert.equal(responded, false);
  assert.equal(serial.buffers[0].toString('hex'), frame);
  finishDrain();
  assert.equal((await result).status, 200);
});

test('invalid commands are rejected without touching serial', async t => {
  const { request, serialPort } = await start(t);
  for (const command of [undefined, null, 123, '', '0', 'zz', '00'.repeat(257)]) {
    assert.equal((await request({ command })).status, 400);
  }
  assert.equal((await request({ command: 'TX_OFF' })).status, 200);
  assert.equal(serialPort.buffers.length, 0);
});

test('server-wide transmission disable accepts preview frames without opening any adapter', async t => {
  const serial = new FakeSerial();
  serial.open = () => { throw new Error('Must not open device'); };
  const { request, failures } = await start(t, serial, { transmitEnabled: false });
  assert.equal((await request({ command: '80828f' })).status, 200);
  const health = await request(undefined, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).transmitEnabled, false);
  assert.equal(JSON.parse(health.text).ready, false);
  assert.equal((await request({ command: 'zz' })).status, 400);
  assert.equal(serial.buffers.length, 0);
  assert.equal(failures.length, 0);
});

for (const operation of ['open', 'write', 'drain']) {
  test(`stalled serial ${operation} triggers recovery`, async t => {
    const serial = new FakeSerial();
    serial[operation] = () => {};
    const { request, failures } = await start(t, serial, { timeoutMs: 100 });
    if (operation !== 'open') assert.equal((await request({ command: '80828f' })).status, 503);
    else await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /timed out/);
    assert.equal((await request(undefined, '/health')).status, 503);
  });
}

test('pending queue is bounded and writes remain serial', async t => {
  const serial = new FakeSerial();
  const callbacks = [];
  serial.write = (buffer, callback) => { serial.buffers.push(buffer); callbacks.push(callback); };
  const { request } = await start(t, serial, { maxPending: 1 });
  const first = request({ command: '80' });
  while (callbacks.length < 1) await new Promise(resolve => setImmediate(resolve));
  const second = request({ command: '81' });
  while (JSON.parse((await request(undefined, '/health')).text).pending < 1) {}
  assert.equal((await request({ command: '82' })).status, 503);
  assert.equal(serial.buffers.length, 1);
  callbacks[0]();
  assert.equal((await first).status, 200);
  while (callbacks.length < 2) await new Promise(resolve => setImmediate(resolve));
  callbacks[1]();
  assert.equal((await second).status, 200);
  assert.deepEqual(serial.buffers.map(buffer => buffer.toString('hex')), ['80', '81']);
});

for (const event of ['error', 'close']) {
  test(`serial ${event} event fails active and queued requests once`, async t => {
    const serial = new FakeSerial();
    serial.write = () => {};
    const { request, failures } = await start(t, serial);
    const first = request({ command: '80' });
    const second = request({ command: '81' });
    while (JSON.parse((await request(undefined, '/health')).text).pending < 1) {}
    serial.emit(event, new Error('Disconnected'));
    serial.emit(event, new Error('Disconnected again'));
    assert.equal((await first).status, 503);
    assert.equal((await second).status, 503);
    assert.equal(failures.length, 1);
  });
}
