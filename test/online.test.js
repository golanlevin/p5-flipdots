const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
const ok = { ok: true, text: async () => 'sent' };

function hosted({ app = 'ptixy_online', order = ['sketch.js', 'flipdot.js'], preview = false, serverURL, permission, policy } = {}) {
  const requests = [], notices = [], timers = new Map();
  let now = 1000, timerId = 0;
  function element() {
    let value = '';
    return { elt: { textContent: '' }, id() {}, size() {}, style() {}, attribute() {}, position() {},
      mousePressed(callback) { this.click = callback; }, hide() {}, show() {},
      value(next) { if (next !== undefined) value = next; return value; } };
  }
  const context = vm.createContext({
    navigator: permission ? { permissions: { query: permission.query || (async () => permission) } } : {},
    document: policy ? { featurePolicy: policy } : {},
    AbortController, Date: class extends Date { static now() { return now; } },
    sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, PI: Math.PI,
    abs: Math.abs, atan2: Math.atan2, noise: () => 0.5, random: () => 0.25,
    dist: (x, y, a, b) => Math.hypot(x - a, y - b), millis: () => now,
    createElement: element, createButton: element,
    createCanvas(width, height) {
      context.width = width; context.height = height;
      return { position: () => ({ x: 0, y: 0 }) };
    },
    frameRate() {}, textFont() {}, background() {}, noStroke() {}, fill() {},
    textSize() {}, text() {}, circle() {}, push() {}, pop() {}, textAlign() {}, RIGHT: 'right', RIGHT_ARROW: 'ArrowRight', LEFT_ARROW: 'ArrowLeft',
    console: { warn: (...args) => notices.push(args), error: (...args) => notices.push(args) },
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        requests.push({ url, options, command: JSON.parse(options.body).command, resolve, reject });
        options.signal.addEventListener('abort', () => reject(new Error('Request aborted')));
      });
    },
  });
  const run = code => vm.runInContext(code, context);
  for (const name of order) {
    let source = fs.readFileSync(path.join(__dirname, '..', app, name), 'utf8');
    if (preview) source = source.replace('const ENABLE_TX = true;', 'const ENABLE_TX = false;');
    if (serverURL) source = source.replace(/['"]http:\/\/localhost:3000['"]/, JSON.stringify(serverURL));
    run(source);
  }
  run('setup(); draw();');
  return { run, requests, notices, timers,
    edit(source) { run(`function_field.value(${JSON.stringify(source)}); draw();`); },
    connect() { run('connect_button.click();'); },
    advance(ms) { now += ms; },
    key(value) { context.key = value; return run('keyPressed();'); },
    fire(ms) {
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms);
      timers.delete(id); timer.callback();
    },
  };
}

for (const order of [['sketch.js', 'flipdot.js'], ['flipdot.js', 'sketch.js']]) {
  test(`Online editor loads ${order.join(' then ')} without extra libraries or HTML changes`, async () => {
    const h = hosted({ order });
    h.edit('1');
    assert.equal(h.requests.length, 0, 'No network request before the Connect click');
    assert.equal(h.run('flipdot_connection_status()'), 'connecting');
    h.connect();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, 'http://localhost:3000/send-signal');
    assert.equal(h.requests[0].options.mode, 'cors');
    assert.equal(h.requests[0].command, `808400${'7f'.repeat(28)}8F80843F${'7f'.repeat(28)}8F80828F`);
    h.requests[0].resolve(ok);
    await settle();
    assert.equal(h.run('flipdot_connection_status()'), 'connected');
    assert.deepEqual(h.notices, []);
  });
}

test('hosted editor preserves the last valid frame through faulty formulas and resumes after correction', async () => {
  const h = hosted();
  h.edit('1');
  for (const source of ['sin(', 'i === 29 ? i1 : 0', '(P[i] = 0, 1)', 'null', 'Promise.reject(new Error("async typo"))']) {
    assert.doesNotThrow(() => h.edit(source));
    await settle();
    assert.equal(h.run('f_str'), '1');
    assert.equal(h.run('pixs.every(bit => bit === 1)'), true);
    assert.notEqual(h.run('expression_error'), '');
  }
  h.edit('t < 2 ? 0 : missing_later');
  h.run('draw(); draw();');
  assert.equal(h.run('expression_paused'), true);
  assert.match(h.run('expression_error'), /missing_later.*t=2/);
  h.edit('sin(PI/2) + P[-1] + P[392] // trailing comment');
  assert.equal(h.run('expression_error'), '');
  assert.equal(h.run('expression_paused'), false);
  h.edit('1 - P[i]');
  assert.equal(h.run('pixs.every(bit => bit === 1)'), true);
  h.run('draw();');
  assert.equal(h.run('pixs.every(bit => bit === 0)'), true);
  assert.equal(h.requests.length, 0);
});

test('iframe policy denial is visible and sends no requests despite repeated Connect clicks', async () => {
  const h = hosted({ policy: { features: () => ['loopback-network'], allowsFeature: () => false } });
  await settle();
  for (let i = 0; i < 30; i++) { h.connect(); h.run('draw();'); }
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.run('flipdot_connection_status()'), 'disconnected');
  assert.match(h.run('error_field.elt.textContent'), /iframe policy.*loopback-network/);
  assert.equal(h.run('expression_error'), '');
  h.edit('i1');
  assert.match(h.run('error_field.elt.textContent'), /i1 is not defined/);
});

test('stored browser denial pauses transmission and granting permission resumes the latest frame', async () => {
  let onChange;
  const permission = { state: 'denied', addEventListener: (event, callback) => { onChange = callback; } };
  const h = hosted({ permission });
  await settle();
  h.connect(); h.edit('1');
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  assert.match(h.run('error_field.elt.textContent'), /Browser denied/);
  permission.state = 'granted'; onChange();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].command, /^8084007f/);
  h.requests[0].resolve(ok);
  await settle();
  h.run('draw();');
  assert.equal(h.run('flipdot_connection_status()'), 'connected');
  assert.equal(h.run('error_field.elt.textContent'), '');
});

test('denying permission during an attempt prevents retry flooding', async () => {
  let onChange;
  const permission = { state: 'prompt', addEventListener: (event, callback) => { onChange = callback; } };
  const h = hosted({ permission });
  await settle();
  h.connect();
  assert.equal([...h.timers.values()][0].ms, 30000, 'Allow time to answer the initial permission prompt');
  permission.state = 'denied'; onChange();
  h.requests[0].reject(new Error('Permission denied'));
  await settle();
  for (let i = 0; i < 100; i++) h.run('draw();');
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
  assert.match(h.run('error_field.elt.textContent'), /Browser denied/);
});

test('legacy permission name and unsupported permission queries retain connection support', async () => {
  for (const supported of [true, false]) {
    const queried = [];
    const permission = { query: async ({ name }) => {
      queried.push(name);
      if (!supported || name !== 'local-network-access') throw new TypeError('Unsupported permission');
      return { state: 'granted', addEventListener() {} };
    } };
    const h = hosted({ permission });
    await settle();
    assert.deepEqual(queried, ['loopback-network', 'local-network-access']);
    assert.equal(h.requests.length, 0);
    h.connect();
    assert.equal([...h.timers.values()][0].ms, 4000);
    h.requests[0].resolve(ok);
    await settle();
    assert.equal(h.run('flipdot_connection_status()'), 'connected');
  }
});

for (const failure of ['network', 'HTTP', 'timeout']) {
  test(`hosted transport retries ${failure} failure with the newest complete frame`, async () => {
    const h = hosted();
    h.edit('1'); h.connect();
    if (failure === 'network') h.requests[0].reject(new Error('Offline'));
    if (failure === 'HTTP') h.requests[0].resolve({ ok: false, status: 503 });
    if (failure === 'timeout') h.fire(4000);
    await settle();
    assert.equal(h.run('flipdot_connection_status()'), 'disconnected');
    for (let i = 0; i < 20; i++) h.edit(i % 2 ? '0' : '1');
    assert.equal(h.requests.length, 1);
    h.fire(1000);
    assert.equal(h.run('flipdot_connection_status()'), 'connecting');
    assert.equal(h.requests[1].command, `808400${'00'.repeat(28)}8F80843F${'00'.repeat(28)}8F80828F`);
    h.requests[1].resolve(ok);
    await settle();
    assert.equal(h.run('flipdot_connection_status()'), 'connected');
    assert.deepEqual(h.notices, []);
  });
}

test('hosted preview checks the configured bridge without sending dot bytes', async () => {
  const h = hosted({ preview: true, serverURL: 'http://localhost:3456/' });
  h.connect();
  assert.equal(h.requests[0].url, 'http://localhost:3456/send-signal');
  assert.equal(h.requests[0].command, 'TX_OFF');
  h.requests[0].resolve(ok);
  await settle();
  h.advance(1000); h.run('draw();');
  assert.equal(h.requests[1].command, 'TX_OFF');
  h.requests[1].resolve(ok);
  await settle();
  assert.equal(h.run('flipdot_connection_status()'), 'connected');
});

for (const order of [['sketch.js', 'flipdot.js'], ['flipdot.js', 'sketch.js']]) {
  test(`online player loads ${order.join(' then ')} and evaluates all 13 formulas`, () => {
    const h = hosted({ app: 'ptixy_player_online', order });
    assert.equal(h.run('programs.length'), 13);
    for (let index = 0; index < 13; index++) {
      h.run(`selectProgram(${index});`);
      assert.equal(h.run('program_error'), '', `Program ${index}`);
      for (const time of [0, 1, 9, 10, 49, 50, 99, 100, 150, 899]) {
        h.run(`pixs = expressionEvaluator.evaluate(color_func, ${time}, pixs);`);
      }
      h.run('draw();');
      assert.equal(h.run('program_error'), '');
    }
    assert.equal(h.requests.length, 0, 'Playback does not require a connection');
    h.connect();
    assert.equal(h.requests[0].command.length, 134);
  });
}

test('online player timing, wrapping and keyboard selection reset feedback independently of connection', () => {
  const h = hosted({ app: 'ptixy_player_online' });
  const duration = h.run('nSecondsToRunProgram * 1000');
  h.advance(duration - 1); h.run('draw();');
  assert.equal(h.run('currentProgramIndex'), 0);
  h.advance(1); h.run('draw();');
  assert.equal(h.run('currentProgramIndex'), 1);
  assert.equal(h.run('frames_since'), 1);
  h.run('selectProgram(programs.length - 1);');
  h.advance(duration); h.run('draw();');
  assert.equal(h.run('currentProgramIndex'), 0);
  h.run("programs = ['1 - P[i]', '1 - P[i]']; selectProgram(0); draw(); draw();");
  assert.equal(h.run('pixs.every(bit => bit === 0)'), true);
  h.advance(duration - 1);
  assert.equal(h.key('1'), false);
  assert.equal(h.run('currentProgramIndex'), 1);
  assert.equal(h.run('frames_since'), 1);
  assert.equal(h.run('pixs.every(bit => bit === 1)'), true);
  h.advance(1); h.run('draw();');
  assert.equal(h.run('currentProgramIndex'), 1, 'Manual selection restarts the clock');
  h.key('ArrowRight');
  assert.equal(h.run('currentProgramIndex'), 0);
  h.key('ArrowLeft');
  assert.equal(h.run('currentProgramIndex'), 1);
});

test('online player skips faulty formulas and holds complete frames for an invalid or empty playlist', async () => {
  const h = hosted({ app: 'ptixy_player_online' });
  h.run("programs = ['1', 'sin(', 'i === 29 ? missing : 0', 't < 2 ? 0 : missing_later', '1']; selectProgram(0); draw(); advanceProgram(1);");
  assert.equal(h.run('currentProgramIndex'), 3);
  assert.match(h.run('program_error'), /missing.*i=29/);
  h.run('draw(); draw(); draw();');
  assert.equal(h.run('currentProgramIndex'), 4);
  assert.match(h.run('program_error'), /missing_later.*t=2/);
  h.connect();
  assert.equal(h.requests[0].command, `808400${'7f'.repeat(28)}8F80843F${'7f'.repeat(28)}8F80828F`);
  h.requests[0].resolve(ok); await settle();
  h.run("programs = ['sin(', '(P[i] = 0, 1)', 'Promise.reject(new Error(\"async typo\"))']; selectProgram(0); draw();");
  await settle();
  assert.match(h.run('program_error'), /No valid programs/);
  assert.equal(h.run('pixs.every(bit => bit === 1)'), true);
  h.run('programs = []; selectProgram(0); draw();');
  assert.match(h.run('program_error'), /No programs/);
  assert.equal(h.run('pixs.every(bit => bit === 1)'), true);
  h.run("programs = ['0']; selectProgram(0); draw();");
  assert.equal(h.run('program_error'), '');
  assert.equal(h.run('pixs.every(bit => bit === 0)'), true);
});

test('online player keeps playing through an outage and recovers with the latest whole frame', async () => {
  const h = hosted({ app: 'ptixy_player_online' });
  h.run("programs = ['1', '0']; selectProgram(0); draw();");
  h.connect();
  h.requests[0].reject(new Error('Offline')); await settle();
  assert.equal(h.run('flipdot_connection_status()'), 'disconnected');
  h.advance(h.run('nSecondsToRunProgram * 1000')); h.run('draw();');
  assert.equal(h.run('currentProgramIndex'), 1);
  assert.match(h.run('error_field.elt.textContent'), /Cannot reach/);
  assert.equal(h.requests.length, 1);
  h.fire(1000);
  assert.equal(h.requests[1].command, `808400${'00'.repeat(28)}8F80843F${'00'.repeat(28)}8F80828F`);
  h.requests[1].resolve(ok); await settle();
  h.run('draw();');
  assert.equal(h.run('flipdot_connection_status()'), 'connected');
  assert.equal(h.run('error_field.elt.textContent'), '');
});

test('online player shows policy denial while continuing playback without retrying', async () => {
  const h = hosted({ app: 'ptixy_player_online',
    policy: { features: () => ['loopback-network'], allowsFeature: () => false } });
  await settle();
  h.connect();
  h.advance(h.run('nSecondsToRunProgram * 1000')); h.run('draw();');
  assert.equal(h.run('currentProgramIndex'), 1);
  assert.match(h.run('error_field.elt.textContent'), /Hosting iframe policy/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
});
