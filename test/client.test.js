const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../libs/javascript/flipdot.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function browser(settingsResponse) {
  const requests = [];
  const timers = new Map();
  const notices = [];
  let id = 0;
  let now = 1000;
  const context = vm.createContext({
    AbortController,
    URL,
    Date: class extends Date { static now() { return now; } },
    ...(settingsResponse ? { document: { currentScript: { src: 'http://127.0.0.1:5501/libs/javascript/flipdot.js' } } } : {}),
    console: { warn: (...args) => notices.push(['warn', ...args]), info: (...args) => notices.push(['info', ...args]) },
    setTimeout(callback, ms) { timers.set(++id, { callback, ms }); return id; },
    clearTimeout(key) { timers.delete(key); },
    fetch(url, options) {
      if (!options.body) {
        assert.equal(String(url), 'http://127.0.0.1:5501/flipdot_config.json');
        return Promise.resolve(settingsResponse);
      }
      return new Promise((resolve, reject) => {
        requests.push({ url, command: JSON.parse(options.body).command, resolve, reject });
        options.signal.addEventListener('abort', () => reject(new Error('Request aborted')));
      });
    },
  });
  vm.runInContext('const ENABLE_TX = true;\n' + source, context);
  return {
    requests, timers, notices,
    run: code => vm.runInContext(code, context),
    advance(ms) { now += ms; },
    fire(ms) {
      const [key, timer] = [...timers].find(([, timer]) => timer.ms === ms);
      timers.delete(key);
      timer.callback();
    },
  };
}
const ok = { ok: true, text: async () => 'sent' };

test('browser waits for settings then uses configured HTTP port and fixed panel addresses', async () => {
  const b = browser({ ok: true, json: async () => ({ httpPort: 3456 }) });
  b.run('panel_0_bits = Array(196).fill(1); panel_1_bits = Array(196).fill(0); process_and_send_signal();');
  assert.equal(b.requests.length, 0);
  await settle();
  b.run('process_and_send_signal();');
  assert.equal(b.requests[0].url, 'http://localhost:3456/send-signal');
  assert.equal(b.requests[0].command, `808400${'7f'.repeat(28)}8F80843F${'00'.repeat(28)}8F80828F`);
  b.requests[0].resolve(ok);
  await settle();
});

test('browser honors disabled transmission and defaults when the JSON file is missing', async () => {
  const preview = browser({ ok: true, json: async () => ({ transmitEnabled: false }) });
  await settle();
  preview.run('process_and_send_signal(); process_and_send_signal();');
  assert.equal(preview.requests.length, 1);
  assert.equal(preview.requests[0].command, 'TX_OFF');
  preview.requests[0].resolve(ok);
  await settle();
  const b = browser({ ok: false, status: 404 });
  await settle();
  b.run('panel_0_bits = Array(196).fill(1); panel_1_bits = Array(196).fill(0); process_and_send_signal();');
  assert.equal(b.requests[0].url, 'http://localhost:3000/send-signal');
  assert.match(b.requests[0].command, /^808400/);
  b.requests[0].resolve(ok);
  await settle();
});

test('invalid browser settings pause transmission and retry without falling back to enabled output', async () => {
  const b = browser({ ok: true, json: async () => ({ transmitEnabled: 'false' }) });
  await settle();
  b.run('process_and_send_signal();');
  assert.equal(b.requests.length, 0);
  assert.ok([...b.timers.values()].some(timer => timer.ms === 1000));
  assert.equal(b.run('flipdot_connected()'), false);
  assert.equal(b.run('flipdot_connection_status()'), 'disconnected');
  b.fire(1000);
  assert.equal(b.run('flipdot_connection_status()'), 'connecting');
  await settle();
  assert.equal(b.run('flipdot_connection_status()'), 'disconnected');
  assert.deepEqual(b.notices, []);
});

test('connection starts yellow, stays green during healthy traffic and expires without fresh responses', async () => {
  const b = browser();
  assert.equal(b.run('flipdot_connected()'), false);
  assert.equal(b.run('flipdot_connection_status()'), 'connecting');
  b.run("send_signal('80828f');");
  assert.equal(b.run('flipdot_connected()'), false);
  assert.equal(b.run('flipdot_connection_status()'), 'connecting');
  b.requests[0].resolve(ok);
  await settle();
  assert.equal(b.run('flipdot_connected()'), true);
  assert.equal(b.run('flipdot_connection_status()'), 'connected');
  b.run("send_signal('80828f');");
  assert.equal(b.run('flipdot_connection_status()'), 'connected');
  b.requests[1].resolve(ok);
  await settle();
  b.advance(5000);
  assert.equal(b.run('flipdot_connected()'), false);
  assert.equal(b.run('flipdot_connection_status()'), 'disconnected');
});

test('preview requests keep connection status current without transmitting dot commands', async () => {
  const b = browser({ ok: true, json: async () => ({ transmitEnabled: false }) });
  await settle();
  b.run('process_and_send_signal();');
  b.requests[0].resolve(ok);
  await settle();
  assert.equal(b.run('flipdot_connected()'), true);
  b.advance(1000);
  b.run('process_and_send_signal();');
  assert.equal(b.requests[1].command, 'TX_OFF');
  b.requests[1].reject(new Error('Offline'));
  await settle();
  assert.equal(b.run('flipdot_connected()'), false);
  assert.deepEqual(b.notices, []);
});

test('one complete frame per request; slow bridge keeps only the latest pending frame', async () => {
  const b = browser();
  b.run('panel_0_bits = Array(196).fill(1); panel_1_bits = Array(196).fill(0); process_and_send_signal();');
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].command, `808400${'7f'.repeat(28)}8F80843F${'00'.repeat(28)}8F80828F`);
  for (let i = 0; i < 100; i++) b.run(`send_signal('${i}');`);
  assert.equal(b.requests.length, 1);
  b.requests[0].resolve(ok);
  await settle();
  assert.equal(b.requests.length, 2);
  assert.equal(b.requests[1].command, '99');
  b.requests[1].resolve(ok);
  await settle();
  assert.equal(b.timers.size, 0);
});

for (const failure of ['network', 'HTTP', 'timeout']) {
  test(`browser recovers from ${failure} failure and sends the latest frame`, async () => {
    const b = browser();
    // Establish a connection before testing its failure and recovery.
    b.run("send_signal('initial');");
    b.requests[0].resolve(ok);
    await settle();
    assert.equal(b.run('flipdot_connected()'), true);
    b.requests.length = 0;
    b.run("send_signal('old');");
    if (failure === 'network') b.requests[0].reject(new Error('Offline'));
    if (failure === 'HTTP') b.requests[0].resolve({ ok: false, status: 503 });
    if (failure === 'timeout') b.fire(4000);
    await settle();
    assert.equal(b.run('flipdot_connected()'), false);
    assert.equal(b.run('flipdot_connection_status()'), 'disconnected');
    assert.deepEqual(b.notices, []);
    for (let i = 0; i < 100; i++) b.run(`send_signal('${i}');`);
    assert.equal(b.requests.length, 1);
    b.fire(1000);
    assert.equal(b.run('flipdot_connection_status()'), 'connecting');
    assert.equal(b.requests[1].command, '99');
    b.requests[1].resolve(ok);
    await settle();
    assert.equal(b.run('flipdot_connected()'), true);
    assert.equal(b.run('flipdot_connection_status()'), 'connected');
    assert.deepEqual(b.notices, []);
    assert.equal(b.timers.size, 0);
  });
}
