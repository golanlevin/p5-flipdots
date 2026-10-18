const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { supervise } = require('../libs/javascript/supervisor');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'Timed out waiting for worker');
    await pause(10);
  }
}

function start(t, overrides = {}) {
  const logs = [];
  const supervisor = supervise({
    name: 'Test worker', command: process.execPath,
    args: [path.join(__dirname, 'fixtures/worker.cjs')],
    heartbeat: true, heartbeatTimeoutMs: 600, killTimeoutMs: 60,
    restartDelayMs: 30, maxRestartDelayMs: 120,
    log: message => logs.push(message), ...overrides,
  });
  t.after(() => supervisor.stop());
  return { supervisor, logs };
}

test('large output is streamed without killing the worker', async t => {
  const { supervisor } = start(t);
  const original = supervisor.child;
  let bytes = 0;
  original.stdout.on('data', data => { bytes += data.length; });
  await waitFor(() => bytes >= 2 * 1024 * 1024);
  await pause(700);
  assert.equal(supervisor.child, original);
});

test('crashed worker restarts; intentional shutdown does not restart', async t => {
  const { supervisor } = start(t);
  const original = supervisor.child;
  await new Promise(resolve => original.once('message', resolve));
  original.send('crash');
  await waitFor(() => supervisor.child && supervisor.child !== original);
  const replacement = supervisor.child;
  await supervisor.stop();
  await pause(150);
  assert.equal(supervisor.child, undefined);
  assert.ok(replacement.exitCode !== null || replacement.signalCode !== null);
});

test('blocked worker loses heartbeat and is forcibly killed and restarted', async t => {
  const { supervisor, logs } = start(t);
  const original = supervisor.child;
  await new Promise(resolve => original.once('message', resolve));
  original.send('hang');
  await waitFor(() => supervisor.child && supervisor.child !== original);
  assert.equal(original.signalCode, 'SIGKILL');
  assert.ok(logs.some(message => message.includes('no heartbeat')));
});

test('missing executable retries with capped backoff; stop cancels retries', async t => {
  const { supervisor, logs } = start(t, { command: '/missing-flipdot-test-executable' });
  await waitFor(() => logs.filter(message => message.includes('restarting')).length >= 4);
  assert.ok(logs.some(message => message.includes('restarting in 120 ms')));
  await supervisor.stop();
  const count = logs.length;
  await pause(150);
  assert.equal(logs.length, count);
});
