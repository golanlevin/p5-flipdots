const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('launcher lists, configures, and explains a missing selection before starting workers', t => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flipdot-cli-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, 'libs/javascript'), { recursive: true });
  for (const name of ['flipdot_server.js', 'libs/javascript/supervisor.js', 'libs/javascript/serial_config.js', 'libs/javascript/settings.js']) {
    fs.copyFileSync(path.join(root, name), path.join(temporary, name));
  }
  function run(args, input) {
    const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules') };
    delete env.FLIPDOT_SERIAL_PATH;
    delete env.FLIPDOT_SERIAL_SELECTION;
    return spawnSync(process.execPath, ['-r', path.join(__dirname, 'fixtures/port-list.cjs'),
      path.join(temporary, 'flipdot_server.js'), ...args], { cwd: temporary, env, input, encoding: 'utf8', timeout: 4000 });
  }
  let result = run(['--list-ports']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /COM3.*FIRST/);
  assert.doesNotMatch(result.stdout, /watchdog enabled/);
  result = run([]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /No serial interface configured/);
  assert.match(result.stdout, /COM3/);
  result = run(['--configure'], '1\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'flipdot_config.json'))), {
    serialPort: 'COM4', serialNumber: 'SECOND', vendorId: '0403', productId: '6001',
    webPort: 8081, httpPort: 3000, transmitEnabled: true,
  });
  result = run(['--not-a-real-option']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument/);
});
