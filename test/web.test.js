const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createWebApp } = require('../libs/javascript/web');
const { validateSettings } = require('../libs/javascript/settings');

test('JavaScript web server serves all three sketches and current assets without Python', async t => {
  const server = createWebApp(validateSettings({ httpPort: 3456, transmitEnabled: false })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  function get(path) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path }, response => {
        let body = '';
        response.on('data', data => { body += data; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      }).on('error', reject);
    });
  }
  for (const route of ['/', '/ptixy/', '/canvas/', '/ptixy_player/', '/ptixy/sketch.js', '/canvas/sketch.js', '/ptixy_player/sketch.js', '/libs/javascript/flipdot.js', '/libs/javascript/ptixy.js', '/static/style.css']) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers['cache-control'], /no-store/, route);
    assert.ok(response.body.length > 0);
  }
  for (const route of ['/libs/javascript/server.js', '/libs/python/server.py', '/ptixy_player/mySketch.js', '/ptixy_player/flipdot.js', '/.git/config', '/node_modules/express/package.json']) {
    assert.equal((await get(route)).status, 404, route);
  }
  const settings = JSON.parse((await get('/flipdot_config.json')).body);
  assert.equal(settings.httpPort, 3456);
  assert.equal(settings.transmitEnabled, false);
  assert.deepEqual(Object.keys(settings).sort(), ['httpPort', 'transmitEnabled', 'webPort']);
  assert.equal(settings.serialPort, undefined);
});
