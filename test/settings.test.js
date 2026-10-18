const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, readSettings, validateSettings } = require('../libs/javascript/settings');

test('missing configuration and omitted fields use independent code defaults', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flipdot-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'missing.json');
  assert.deepEqual(readSettings({}, file), DEFAULTS);
  const settings = validateSettings({ transmitEnabled: false });
  assert.equal(settings.webPort, 8081);
  assert.equal(settings.httpPort, 3000);
  assert.equal(settings.transmitEnabled, false);
  settings.httpPort = 3456;
  assert.equal(validateSettings({}).httpPort, 3000);
  fs.writeFileSync(file, JSON.stringify({ webPort: 8082, httpPort: 3001 }));
  assert.equal(readSettings({ FLIPDOT_HTTP_PORT: '3010' }, file).httpPort, 3010);
  assert.equal(readSettings({}, file).webPort, 8082);
});

test('invalid ports and transmission settings fail early', () => {
  for (const value of [null, [], { httpPort: true }, { httpPort: 0 }, { webPort: 65536 },
    { webPort: 3000 }, { transmitEnabled: 'false' }]) {
    assert.throws(() => validateSettings(value), JSON.stringify(value));
  }
});
