// Ptixy for OpenProcessing: previous-frame memory P[] added to tixy.land.
// Created by Yon Maor and Golan Levin at the CMU STUDIO for Creative Inquiry.
// Inspired by https://tixy.land/ by Martin Kleppe.
// Repository: https://github.com/yonmaor1/p5-flipdots
//
// OpenProcessing setup:
// 1. Select p5.js 2.3.4 in the sketch settings.
// 2. Remove the old p5.serialport.js added library; no added libraries are needed.
// 3. Replace the two code tabs with this mySketch.js and its companion flipdot.js.
// 4. Run either local flipdot_server, then click Connect in this sketch.
//    Allow local/loopback access if your browser asks.
//
// The evaluator below is bundled from libs/javascript/ptixy.js so that only two
// editable files are needed. The editor below follows ptixy/sketch.js.
// Golan's students: there is no need to fork this sketch.

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

const ENABLE_TX = true; // Set to false for a browser-only preview.

let f_str = "sin(t-sqrt((x-7.5)**2+(y-6)**2))";
let color_func = null;
let function_field;
let error_field;
let canvas;
let frames_since = 0;
let pixs = [];
let last_input = null;
let pending_expression = null;
let expression_paused = false;
let expression_error = "";
let expressionEvaluator;
let connect_button;

//------------------------------------------------------------
function setup() {
  // OpenProcessing may load mySketch.js before flipdot.js. Read its globals here.
  expressionEvaluator = new PtixyEvaluator(NUM_COLS, NUM_ROWS);
  canvas = createCanvas(800, 600);
  frameRate(15);
  textFont("monospace");

  function_field = createElement("textarea");
  function_field.id("ptixy-expression");
  function_field.size(750, 85);
  function_field.style("font-size", "16px");
  function_field.style("box-sizing", "border-box");
  function_field.attribute("aria-label", "Pixel expression");
  function_field.attribute("aria-describedby", "ptixy-error");
  function_field.value(f_str);

  error_field = createElement("div");
  error_field.id("ptixy-error");
  error_field.attribute("role", "status");
  error_field.attribute("aria-live", "polite");
  error_field.style("color", "#ffb3b3");
  error_field.style("font-family", "monospace");
  error_field.style("font-size", "12px");
  error_field.style("line-height", "14px");
  error_field.style("width", "750px");
  error_field.style("max-height", "32px");
  error_field.style("overflow", "auto");

  connect_button = createButton("Connect");
  connect_button.id("ptixy-connect");
  connect_button.attribute(
    "title",
    "Connect to the local flipdot server; allow local access if your browser asks."
  );
  connect_button.mousePressed(start_flipdot_connection);

  pixs = Array(NUM_COLS * NUM_ROWS).fill(0);
  update_panel_bits();
  set_expression_error("");
  windowResized();
  initialise_flipdot_permissions();
}

//------------------------------------------------------------
function draw() {
  background(64);
  noStroke();

  func_input();
  update_expression_frame();
  // Formula errors take priority; connection diagnostics use the same feedback
  // area without marking a valid expression as invalid.
  error_field.elt.textContent =
    expression_error || flipdot_connection_message();
  if (flipdot_connected()) connect_button.hide();
  else connect_button.show();
  draw_info();
  draw_ptixy_grid();
  // Only complete, successfully evaluated frames reach the panel buffers.
  // Resending a held frame also lets the transport recover after an outage.
  ptixy2display();
}

//------------------------------------------------------------
/** Compile syntax only; execution is checked across the whole grid each frame. */
function compile_expression(source) {
  return expressionEvaluator.compile(source);
}

/** Check changed editor text once, keeping the active animation on invalid edits. */
function func_input() {
  const source = function_field.value();
  if (source === last_input) return;
  last_input = source;
  pending_expression = null;
  try {
    pending_expression = { source, f: compile_expression(source) };
  } catch (error) {
    set_expression_error(
      error_message(error) + " Previous frame/expression kept."
    );
  }
}

/** Format thrown values as plain text, including errors thrown by user code. */
function error_message(error) {
  return PtixyEvaluator.errorMessage(error);
}

/** Show feedback without alerts, console flooding, or interpreting user text as HTML. */
function set_expression_error(message) {
  expression_error = message;
  if (!error_field) return;
  error_field.elt.textContent = message;
  function_field.attribute("aria-invalid", message ? "true" : "false");
  function_field.style("border", `1px solid ${message ? "#ff8888" : "#999"}`);
}

/** Retain the existing helper for expressions that explicitly call getP(i). */
function getP(i) {
  return expressionEvaluator.getP(i, pixs);
}

/**
 * Evaluate into a temporary frame. A fault at any cell discards the entire result.
 * This catches errors hidden behind x/y/i/t-dependent branches, not just at (0,0).
 */
function evaluate_expression_frame(f, t, previous) {
  return expressionEvaluator.evaluate(f, t, previous);
}

/** Commit a candidate only after its first full frame succeeds. */
function update_expression_frame() {
  if (pending_expression) {
    const candidate = pending_expression;
    pending_expression = null;
    try {
      const next = evaluate_expression_frame(
        candidate.f,
        0,
        Array(NUM_COLS * NUM_ROWS).fill(0)
      );
      color_func = candidate.f;
      f_str = candidate.source;
      pixs = next;
      frames_since = 1;
      expression_paused = false;
      set_expression_error("");
      update_panel_bits();
      return;
    } catch (error) {
      set_expression_error(
        error_message(error) + " Previous frame/expression kept."
      );
    }
  }

  if (!color_func || expression_paused) return;
  try {
    const next = evaluate_expression_frame(color_func, frames_since, pixs);
    pixs = next;
    frames_since += 1;
    update_panel_bits();
  } catch (error) {
    // A formerly working expression can fail at a later time. Hold its last
    // complete frame until the user edits it, instead of throwing out of draw().
    expression_paused = true;
    set_expression_error(
      error_message(error) + " Frame held; edit expression to resume."
    );
  }
}

/** Pack the committed frame using the existing column/panel ordering. */
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

//------------------------------------------------------------
function windowResized() {
  if (!canvas || !function_field || !error_field) return;
  const canvasX = canvas.position().x;
  const canvasY = canvas.position().y;
  function_field.position(canvasX + 20, canvasY + height - 130);
  error_field.position(canvasX + 20, canvasY + height - 38);
  if (connect_button)
    connect_button.position(canvasX + width - 100, canvasY + height - 153);
}

function draw_info() {
  noStroke();
  fill("white");
  textSize(16);
  text(
    "// input must be a valid javascript expression\n// available variables: P,t,i,x,y",
    20,
    height - 160
  );
  push();
  textAlign(RIGHT);
  const connectionEmoji = {
    connecting: "🟡",
    connected: "🟢",
    disconnected: "🔴",
  };
  text(
    `tx: ${connectionEmoji[flipdot_connection_status()]}`,
    width - 30,
    height - 160
  );
  pop();
}

/** Draw only committed bits; user expressions never run inside rendering calls. */
function draw_ptixy_grid() {
  for (let x = 0; x < NUM_COLS; x++) {
    for (let y = 0; y < NUM_ROWS; y++) {
      draw_ptixy_cell(x, y, pixs[x + y * NUM_COLS]);
    }
  }
}

function draw_ptixy_cell(x, y, bit) {
  const margin = 30;
  const cellSize = (width - 2 * margin) / NUM_COLS;
  const px = x * cellSize + cellSize / 2 + margin;
  const py = y * cellSize + cellSize / 2 + margin;
  fill(bit ? "white" : "black");
  noStroke();
  circle(px, py, 0.9 * cellSize);
}
