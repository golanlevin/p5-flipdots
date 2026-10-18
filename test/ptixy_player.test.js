const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function player() {
  let now = 7000;
  const transmissions = [];
  function element() {
    let value = '';
    return { elt: { textContent: '' }, id() {}, size() {}, style() {}, attribute() {}, position() {},
      value(next) { if (next !== undefined) value = next; return value; } };
  }
  const context = vm.createContext({
    sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt,
    abs: Math.abs, atan2: Math.atan2, PI: Math.PI,
    noise: () => 0.5, random: () => 0.25,
    dist: (x, y, a, b) => Math.hypot(x - a, y - b),
    millis: () => now, createElement: element,
    createCanvas(width, height) {
      context.width = width; context.height = height;
      return { position: () => ({ x: 0, y: 0 }) };
    },
    frameRate() {}, textFont() {}, background() {}, noStroke() {},
    fill() {}, textSize() {}, text() {}, circle() {}, push() {}, pop() {}, textAlign() {},
    RIGHT: 'right', RIGHT_ARROW: 'ArrowRight', LEFT_ARROW: 'ArrowLeft',
    flipdot_connection_status: () => 'disconnected',
    ptixy2display() { transmissions.push(JSON.parse(run('JSON.stringify([panel_0_bits, panel_1_bits])'))); },
  });
  const run = code => vm.runInContext(code, context);
  run('const NUM_COLS = 28; const NUM_ROWS = 14; let panel_0_bits = []; let panel_1_bits = [];');
  for (const name of ['libs/javascript/ptixy.js', 'ptixy_player/sketch.js']) {
    run(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
  }
  run('setup();');
  return { run, transmissions, draw() { run('draw();'); },
    advance(ms) { now += ms; },
    key(key, code = 0) { context.key = key; context.keyCode = code; return run('keyPressed();'); },
    state() { return JSON.parse(run('JSON.stringify({ index: currentProgramIndex, frames: frames_since, pixels: pixs, error: program_error })')); },
  };
}

test('all 13 supplied programs evaluate successfully, including feedback and time-dependent branches', () => {
  const p = player();
  assert.equal(p.run('programs.length'), 13);
  for (let index = 0; index < 13; index++) {
    p.run(`selectProgram(${index});`);
    assert.equal(p.state().index, index);
    assert.equal(p.state().error, '', `Program ${index}`);
    for (const time of [0, 1, 9, 10, 49, 50, 99, 100, 150, 899]) {
      p.run(`pixs = expressionEvaluator.evaluate(color_func, ${time}, pixs);`);
    }
    p.draw();
    assert.equal(p.state().error, '');
    assert.equal(p.transmissions.at(-1)[0].length, 196);
    assert.equal(p.transmissions.at(-1)[1].length, 196);
  }
});

test('programs run for the configured duration and wrap even while the bridge is disconnected', () => {
  const p = player();
  p.draw();
  p.advance(p.run('nSecondsToRunProgram * 1000') - 1); p.draw();
  assert.equal(p.state().index, 0);
  p.advance(1); p.draw();
  assert.equal(p.state().index, 1);
  assert.equal(p.state().frames, 1);
  p.run('selectProgram(programs.length - 1);');
  p.advance(p.run('nSecondsToRunProgram * 1000')); p.draw();
  assert.equal(p.state().index, 0);
});

test('keyboard selection resets the timer, index, frame count and previous-frame memory', () => {
  const p = player();
  p.run("programs = ['1 - P[i]', '1 - P[i]']; selectProgram(0);");
  p.draw(); p.draw();
  assert.ok(p.state().pixels.every(value => value === 0));
  p.advance(p.run('nSecondsToRunProgram * 1000') - 1000);
  assert.equal(p.key('1'), false);
  assert.equal(p.state().index, 1);
  assert.equal(p.state().frames, 1);
  assert.ok(p.state().pixels.every(value => value === 1));
  p.advance(1000); p.draw();
  assert.equal(p.state().index, 1);
  p.key('ArrowRight', 39);
  assert.equal(p.state().index, 0);
  p.key('ArrowLeft', 37);
  assert.equal(p.state().index, 1);
  p.key('9');
  assert.equal(p.state().index, 1);
});

test('syntax, late-cell and later-time failures are skipped without committing a partial frame', () => {
  const p = player();
  p.run("programs = ['1', 'sin(', 'i === 29 ? missing : 0', 't < 2 ? 0 : missing_later', '1']; selectProgram(0);");
  p.draw();
  p.run('advanceProgram(1);');
  assert.equal(p.state().index, 3);
  assert.match(p.state().error, /Program #2.*missing.*i=29/);
  p.draw(); p.draw(); p.draw();
  assert.equal(p.state().index, 4);
  assert.match(p.state().error, /missing_later.*t=2/);
  assert.ok(p.transmissions.at(-1).flat().every(value => value === 1));
});

test('an entirely faulty or empty playlist holds the frame and permits later recovery', async () => {
  const p = player();
  p.run("programs = ['1']; selectProgram(0);");
  p.draw();
  const good = p.transmissions.at(-1);
  p.run("programs = ['sin(', '(P[i] = 0, 1)', 'Promise.reject(new Error(\"async typo\"))']; selectProgram(0);");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.state().error, /No valid programs/);
  p.draw();
  assert.deepEqual(p.transmissions.at(-1), good);
  p.run('programs = []; selectProgram(0);');
  p.advance(p.run('nSecondsToRunProgram * 1000')); p.draw(); p.key('ArrowRight', 39);
  assert.deepEqual(p.transmissions.at(-1), good);
  p.run("programs = ['0']; selectProgram(0);");
  p.draw();
  assert.equal(p.state().error, '');
  assert.ok(p.state().pixels.every(value => value === 0));
});
