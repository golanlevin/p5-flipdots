const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ptixy/sketch.js'), 'utf8');

function sketch() {
  const transmissions = [];
  function element() {
    let value = '';
    return {
      elt: { textContent: '' }, attributes: {},
      id() {}, size() {}, style() {}, position() {},
      attribute(key, next) { this.attributes[key] = next; },
      value(next) { if (next !== undefined) value = next; return value; },
    };
  }
  const context = vm.createContext({
    sin: Math.sin, sqrt: Math.sqrt, cos: Math.cos, round: Math.round,
    random: () => 0.75, PI: Math.PI,
    createElement: element,
    createCanvas(width, height) {
      context.width = width;
      context.height = height;
      return { position: () => ({ x: 0, y: 0 }) };
    },
    frameRate() {}, textFont() {}, background() {}, noStroke() {},
    fill() {}, textSize() {}, text() {}, circle() {},
    push() {}, pop() {}, textAlign() {}, RIGHT: 'right',
    flipdot_connection_status: () => 'disconnected',
    ptixy2display() {
      transmissions.push(JSON.parse(vm.runInContext('JSON.stringify([panel_0_bits, panel_1_bits])', context)));
    },
  });
  vm.runInContext('const NUM_COLS = 28; const NUM_ROWS = 14; let panel_0_bits = []; let panel_1_bits = [];', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../libs/javascript/ptixy.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run('setup(); draw();');
  return {
    run, transmissions,
    edit(text) { run(`function_field.value(${JSON.stringify(text)});`); },
    draw() { run('draw();'); },
    state() {
      return JSON.parse(run('JSON.stringify({ pixels: pixs, frames: frames_since, applied: f_str, paused: expression_paused, error: expression_error, text: error_field.elt.textContent, invalid: function_field.attributes["aria-invalid"] })'));
    },
  };
}

test('late-cell ReferenceError never escapes draw or transmits a partial frame', () => {
  const s = sketch();
  s.edit('1'); s.draw();
  const good = s.transmissions.at(-1);
  s.edit('i === 29 ? i1 : 0');
  assert.doesNotThrow(() => s.draw());
  assert.match(s.state().error, /i1 is not defined.*x=1, y=1, i=29, t=0/);
  assert.equal(s.state().applied, '1');
  assert.equal(s.state().invalid, 'true');
  assert.deepEqual(s.transmissions.at(-1), good);
  assert.ok(s.state().pixels.every(bit => bit === 1));
  s.edit('i % 2'); s.draw();
  assert.equal(s.state().error, '');
  assert.equal(s.state().invalid, 'false');
  assert.equal(s.state().frames, 1);
  assert.deepEqual(s.state().pixels, Array.from({ length: 392 }, (_, i) => i % 2));
});

test('syntax errors and empty edits preserve previous-frame feedback and keep animating', () => {
  const s = sketch();
  s.edit('1 - P[i]'); s.draw();
  assert.ok(s.state().pixels.every(bit => bit === 1));
  for (const source of ['sin(', '', '   ', 'x +']) {
    const before = s.state();
    s.edit(source);
    assert.doesNotThrow(() => s.draw());
    const after = s.state();
    assert.equal(after.applied, '1 - P[i]');
    assert.equal(after.frames, before.frames + 1);
    assert.deepEqual(after.pixels, before.pixels.map(bit => 1 - bit));
    assert.match(after.error, /SyntaxError/);
  }
  const before = s.state();
  s.draw();
  assert.deepEqual(s.state().pixels, before.pixels.map(bit => 1 - bit));
});

test('time-dependent failures hold the last complete frame and resume after editing', () => {
  const s = sketch();
  s.edit('t < 2 ? 1 : later_missing');
  s.draw(); s.draw();
  assert.equal(s.state().frames, 2);
  const good = s.transmissions.at(-1);
  assert.doesNotThrow(() => s.draw());
  assert.equal(s.state().paused, true);
  assert.match(s.state().error, /later_missing.*t=2/);
  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() => s.draw());
    assert.deepEqual(s.transmissions.at(-1), good);
  }
  s.edit('x < 14'); s.draw();
  assert.equal(s.state().paused, false);
  assert.equal(s.state().error, '');
  assert.equal(s.state().frames, 1);
});

test('PI, arrays, zero-padded previous pixels and trailing comments retain valid JS meaning', () => {
  const s = sketch();
  for (const text of ['sin(PI / 2)', '[0, 1][i % 2]', 'P[-1] + P[392] + 1', 'getP(-1) + getP(392) + 1', '1 // P[0] remains a comment']) {
    s.edit(text); s.draw();
    assert.equal(s.state().error, '', text);
    assert.equal(s.state().applied, text);
  }
  s.edit('1 / t'); s.draw();
  assert.equal(s.state().error, '');
  assert.ok(s.state().pixels.every(bit => bit === 1));
  s.edit('0 / 0'); s.draw();
  assert.equal(s.state().error, '');
  assert.ok(s.state().pixels.every(bit => bit === 0));
});

test('unsupported return types and writes to previous pixels leave committed state intact', () => {
  const s = sketch();
  s.edit('1'); s.draw();
  const good = s.transmissions.at(-1);
  for (const text of ['undefined', 'null', '"white"', '({})', '(P[i] = 0, 1)']) {
    s.edit(text); s.draw();
    assert.notEqual(s.state().error, '', text);
    assert.equal(s.state().applied, '1');
    assert.deepEqual(s.transmissions.at(-1), good);
  }
});

test('returned rejected promises are consumed and reported as unsupported async expressions', async () => {
  const s = sketch();
  s.edit('1'); s.draw();
  s.edit('i === 29 ? Promise.reject(new Error("async typo")) : 0');
  assert.doesNotThrow(() => s.draw());
  await new Promise(resolve => setImmediate(resolve));
  assert.match(s.state().error, /Async expressions are not supported/);
  assert.equal(s.state().applied, '1');
});

test('runtime error text is rendered literally, even when it contains HTML', () => {
  const s = sketch();
  s.edit('(()=>{throw new Error("<img src=x onerror=alert(1)>")})()');
  s.draw();
  assert.match(s.state().text, /<img src=x onerror=alert\(1\)>/);
  assert.equal(s.state().text, s.state().error);
});
