// Formula presentation for the Alfa-Zeta XY5 flipdot display.
// Created by Yon Maor and Golan Levin at the CMU STUDIO for Creative Inquiry.
// Inspired by https://tixy.land/ by Martin Kleppe.
// Online edition for the p5.js Web Editor; requires p5.js 2.3.4 and flipdot.js.
// Copy sketch.js and flipdot.js into the editor; no additional libraries are needed.
// Run either local flipdot_server, then click Connect and allow local access.
// Edit makePrograms() below to change the playlist. Time t counts frames at 15 fps.
// Left/right arrows select adjacent programs; digits 0–9 select a program directly.

/** Expression evaluation shared by the editor and unattended formula player. */
class PtixyEvaluator {
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.previous = null;
  }

  compile(source) {
    if (!source.trim()) throw new SyntaxError("Enter an expression.");
    // Preserve identifiers/array syntax and permit a trailing // comment.
    return new Function(
      "x",
      "y",
      "i",
      "t",
      "P",
      `"use strict"; return (\n${source}\n);`
    );
  }

  static errorMessage(error) {
    try {
      const message =
        error && typeof error.message === "string"
          ? `${error.name || "Error"}: ${error.message}`
          : String(error);
      return message.slice(0, 200);
    } catch {
      return "Expression failed.";
    }
  }

  /** Retain getP(i) compatibility, including zero outside the grid. */
  getP(i, pixels) {
    if (!Number.isInteger(i) || i < 0 || i >= this.columns * this.rows)
      return 0;
    return (this.previous || pixels)[i];
  }

  evaluate(f, t, previous) {
    // All cells see one protected snapshot, even when a formula tries to write P.
    const P = new Proxy(Object.freeze(previous.slice()), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^-?\d+$/.test(property)) {
          return target[property] === undefined ? 0 : target[property];
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const next = Array(this.columns * this.rows);
    this.previous = P;
    try {
      // Preserve the original column-first order for random/noise expressions.
      for (let x = 0; x < this.columns; x++) {
        for (let y = 0; y < this.rows; y++) {
          const i = x + y * this.columns;
          try {
            const value = f(x, y, i, t, P);
            if (value && typeof value.then === "function") {
              Promise.resolve(value).catch(() => {});
              throw new TypeError("Async expressions are not supported.");
            }
            if (typeof value !== "number" && typeof value !== "boolean") {
              throw new TypeError(
                "Expression must return a number or boolean."
              );
            }
            // Match JS comparison semantics: NaN is off, +Infinity is on.
            next[i] = value > 0 ? 1 : 0;
          } catch (error) {
            throw new Error(
              `${PtixyEvaluator.errorMessage(
                error
              )} (x=${x}, y=${y}, i=${i}, t=${t})`
            );
          }
        }
      }
    } finally {
      this.previous = null;
    }
    // A failed cell throws before returning: callers can only commit whole frames.
    return next;
  }
}

const ENABLE_TX = true; // Also requires transmitEnabled in flipdot_config.json.
const nSecondsToRunProgram = 30; // Default duration for each program in the playlist.

let f_str = '0';
let programs = [];
function makePrograms(){
	programs = [];
	programs.push('sin(((t*0.5+x)^y))%noise(abs(sin(t*0.5/10.0)), abs(sin(t*0.5/10.0)), abs(sin(t*0.5/10.0))) - 0.2;');
	programs.push('Math.sin(3*tan((t/23) * (x*cos(t/100) - y*sin(t/100)) / (10+5*sin(t/50)))/t);');
	programs.push('cos((x*0.3+y*0.3)%(3/2)+t*0.2)*sin((x-y)*0.1+t*0.15)-cos((x+y)*0.05+P[i]*0.3);');
	programs.push('sin(2*atan2(x-14- 12*(sin(t/20)),y-7) - Math.hypot(x-14- 12*(sin(t/20)), y-7) + t/2 )');
	programs.push('sin((t)-sqrt((x-14)**2+(y-7)**2) - P[i-1]-P[i+1]-P[i-2]-P[i+2]);');
	programs.push('cos(t/10 + atan2(y-7,x-14))*sin(dist(x,y, 14,7)/2-t/4);');
	programs.push('(t==0)?(random()<0.1):P[(i+1)%(NUM_COLS * NUM_ROWS)];');
	programs.push('x==(y^((t*(.25-sin(t)/t)/4)%32));');
	programs.push('sin(t-sqrt((x-7.5)**2+(y-6)**2));');
	programs.push('sin(t * (x+y))*sqrt(sin(x));');
	programs.push('sin((x+y)/(cos(t/100.0)));');

	let fA = '(t == 0 ? 1 : \
  (P[i] == (t % 100 >= 50) ? P[i] : \
    ((P[i] == (t % 100 < 50) && \
      ((x > 0 && P[i - 1] == (t % 100 >= 50)) || \
       (x < 27 && P[i + 1] == (t % 100 >= 50)) || \
       (y > 0 && P[i - 28] == (t % 100 >= 50)) || \
       (y < 13 && P[i + 28] == (t % 100 >= 50)))) \
    ? (t % 100 >= 50) : (Math.random() < 0.0004 ? (t % 100 >= 50) : P[i]) \
    )))';
	programs.push(fA);

	let fB = '((t % 100 < 10) && Math.abs(y - 7) > \
	(5 - (5 - Math.abs(5 - (t % 10))) * 2)) ? 0 \
			: (Math.pow(x - 14, 2) + Math.pow(y - 7, 2) <= Math.pow(6.5, 2)) \
					? ((Math.pow(x - (14 + 3 * Math.cos(t * 0.1)), 2) + Math.pow(y - (7 + \
							Math.sin(t * 0.2)), 2) < Math.pow(3, 2)) \
							? 0 : 1) : 0;';
	programs.push(fB);
}

// Initialize in setup so either JavaScript file can load first.
let expressionEvaluator;
let color_func = null;
let programStartTimeMs = 0;
let currentProgramIndex = 0;
let frames_since = 0;
let pixs = [];
let program_just_started = false;
let program_error = '';
let canvas;
let formula_field;
let error_field;
let connect_button;

function setup() {
    expressionEvaluator = new PtixyEvaluator(NUM_COLS, NUM_ROWS);
    canvas = createCanvas(800, 600);
    frameRate(15);
    textFont('monospace');

    // A scrollable, read-only formula display keeps long programs legible.
    formula_field = createElement('textarea');
    formula_field.id('player-formula');
    formula_field.size(750, 85);
    formula_field.style('font-size', '16px');
    formula_field.style('box-sizing', 'border-box');
    formula_field.attribute('readonly', '');
    formula_field.attribute('aria-label', 'Current formula');
    formula_field.attribute('aria-describedby', 'player-error');
    error_field = createElement('div');
    error_field.id('player-error');
    error_field.attribute('role', 'status');
    error_field.attribute('aria-live', 'polite');
    error_field.style('color', '#ffb3b3');
    error_field.style('font-family', 'monospace');
    error_field.style('font-size', '12px');
    error_field.style('line-height', '14px');
    error_field.style('width', '750px');
    error_field.style('max-height', '32px');
    error_field.style('overflow', 'auto');

    connect_button = createButton('Connect');
    connect_button.id('ptixy-connect');
    connect_button.attribute('title', 'Connect to the local flipdot server; allow local access if your browser asks.');
    connect_button.mousePressed(start_flipdot_connection);

    pixs = Array(NUM_COLS * NUM_ROWS).fill(0);
    update_panel_bits();
    makePrograms();
    selectProgram(0);
    windowResized();
    initialise_flipdot_permissions();
}

function draw() {
    background(64);
    noStroke();
    updateProgram();
    if (!program_just_started) update_expression_frame();
    program_just_started = false;
    // Program errors take priority over connection diagnostics.
    error_field.elt.textContent = program_error || flipdot_connection_message();
    if (flipdot_connected()) connect_button.hide();
    else connect_button.show();
    draw_info();
    draw_ptixy_grid();
    // Resending the last complete frame also permits recovery after a bridge outage.
    ptixy2display();
}

function set_program_error(message) {
    program_error = message;
    if (error_field) error_field.elt.textContent = message;
}

/** Try at most one pass through the playlist, so bad programs cannot trap draw(). */
function selectProgram(index, direction = 1, clearError = true) {
    if (clearError) set_program_error('');
    programStartTimeMs = millis();
    program_just_started = false;
    color_func = null;
    if (!programs.length) {
        currentProgramIndex = -1;
        f_str = '';
        formula_field.value('');
        set_program_error('No programs in the playlist. Last complete frame held.');
        return;
    }
    const programCount = programs.length;
    for (let attempt = 0; attempt < programCount; attempt++) {
        currentProgramIndex = ((index + direction * attempt) % programCount + programCount) % programCount;
        f_str = programs[currentProgramIndex];
        formula_field.value(String(f_str));
        try {
            // Older playlists include a final semicolon. The expression itself
            // still uses the editor's strict, synchronous evaluation rules.
            const source = f_str.trim().replace(/;\s*$/, '');
            const candidate = expressionEvaluator.compile(source);
            const next = expressionEvaluator.evaluate(candidate, 0, Array(NUM_COLS * NUM_ROWS).fill(0));
            color_func = candidate;
            pixs = next;
            frames_since = 1;
            program_just_started = true;
            update_panel_bits();
            return;
        } catch (error) {
            set_program_error(`Program #${currentProgramIndex} skipped: ${PtixyEvaluator.errorMessage(error)}`);
        }
    }
    set_program_error(program_error + ' No valid programs; last complete frame held.');
}

function update_expression_frame() {
    if (!color_func) return;
    try {
        const next = expressionEvaluator.evaluate(color_func, frames_since, pixs);
        pixs = next;
        frames_since++;
        update_panel_bits();
    } catch (error) {
        set_program_error(`Program #${currentProgramIndex} skipped: ${PtixyEvaluator.errorMessage(error)}`);
        selectProgram(currentProgramIndex + 1, 1, false);
    }
}

// Use elapsed wall time, independent of frame rate or serial availability.
function updateProgram() {
    if (programs.length && millis() - programStartTimeMs >= nSecondsToRunProgram * 1000) advanceProgram(1);
}

function advanceProgram(delta) {
    selectProgram(currentProgramIndex + delta, delta < 0 ? -1 : 1);
}

function keyPressed() {
    // p5 2.x arrow constants are strings; keyCode remains a legacy number.
    if (key === RIGHT_ARROW) { advanceProgram(1); return false; }
    if (key === LEFT_ARROW) { advanceProgram(-1); return false; }
    if (/^[0-9]$/.test(key) && Number(key) < programs.length) {
        selectProgram(Number(key));
        return false;
    }
}

// Compatibility with playlist expressions that explicitly call getP(i).
function getP(i) {
    return expressionEvaluator.getP(i, pixs);
}

function update_panel_bits() {
    panel_0_bits = [];
    panel_1_bits = [];
    for (let x = 0; x < NUM_COLS; x++) {
        for (let y = 0; y < NUM_ROWS; y++) {
            const bit = pixs[x + y * NUM_COLS];
            if (y < 7) panel_1_bits.push(bit);
            else panel_0_bits.push(bit);
        }
    }
}

function windowResized() {
    if (!canvas || !formula_field || !error_field) return;
    const { x, y } = canvas.position();
    formula_field.position(x + 20, y + height - 130);
    error_field.position(x + 20, y + height - 38);
    if (connect_button) connect_button.position(x + width - 100, y + height - 153);
}

function draw_info() {
    fill('white');
    textSize(16);
    const seconds = Math.floor((millis() - programStartTimeMs) / 1000);
    const heading = programs.length ? `Program #${currentProgramIndex} (${currentProgramIndex + 1}/${programs.length}): ${seconds}/${nSecondsToRunProgram}s` : 'No programs';
    text(heading + '\nLeft/right: previous/next; 0–9: select program', 20, height - 160);
    push();
    textAlign(RIGHT);
    const connectionEmoji = { connecting: '🟡', connected: '🟢', disconnected: '🔴' };
    text(`tx: ${connectionEmoji[flipdot_connection_status()]}`, width - 30, height - 160);
    pop();
}

function draw_ptixy_grid() {
    const margin = 30;
    const cellSize = (width - 2 * margin) / NUM_COLS;
    for (let x = 0; x < NUM_COLS; x++) {
        for (let y = 0; y < NUM_ROWS; y++) {
            fill(pixs[x + y * NUM_COLS] ? 'white' : 'black');
            circle(margin + (x + 0.5) * cellSize, margin + (y + 0.5) * cellSize, 0.9 * cellSize);
        }
    }
}
