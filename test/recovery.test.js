const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { supervise } = require('../libs/javascript/supervisor');

function send(port, command) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/send-signal', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ command }));
  });
}

test('serial hang causes a fresh worker and subsequent frames resume', { timeout: 6000 }, async t => {
  const ports = [];
  const supervisor = supervise({
    name: 'Integration bridge', command: process.execPath,
    args: [path.join(__dirname, 'fixtures/bridge-worker.cjs')],
    heartbeat: true, restartDelayMs: 50,
    log(message) {
      if (message.includes('started PID')) {
        supervisor.child.on('message', message => {
          if (message.type === 'ready') ports.push(message.port);
        });
      }
    },
  });
  t.after(() => supervisor.stop());
  while (ports.length < 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await send(ports[0], '80828f'), 200);
  const original = supervisor.child;
  const exit = once(original, 'exit');
  const failedWrite = await send(ports[0], 'dead').catch(() => 'connection closed');
  assert.ok(failedWrite === 503 || failedWrite === 'connection closed');
  await exit;
  while (ports.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(supervisor.child.pid, original.pid);
  assert.equal(await send(ports[1], '80828f'), 200);
});
