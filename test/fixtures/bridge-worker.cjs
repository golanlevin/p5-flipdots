const { EventEmitter } = require('node:events');
const { createBridge } = require('../../libs/javascript/server');

class FakeSerial extends EventEmitter {
  path = 'INTEGRATION-FAKE';
  open(callback) { setImmediate(callback); }
  write(buffer, callback) {
    if (buffer.toString('hex') === 'dead') return; // Simulate an unresponsive driver.
    setImmediate(callback);
  }
  drain(callback) { setImmediate(callback); }
}
const { app } = createBridge({
  serialPort: new FakeSerial(), timeoutMs: 150,
  onFatal: () => process.exit(17),
});
const server = app.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', port: server.address().port });
});
setInterval(() => process.send({ type: 'heartbeat' }), 20);
