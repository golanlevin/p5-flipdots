// p5 Control software for the Alfa-Zeta XY5 Flipdot display
// Created by Yon Maor for Golan Levin's Creative Coding
// course (60-212) at Carnegie Mellon University, Fall 2024
// Updated by Golan Levin, Fall 2026
//
// More info: https://github.com/yonmaor1/p5-flipdots 
// https://flipdots.com/en/products-services/flip-dot-boards-xy5/
// Requires the file: flipdot.js: 
// https://github.com/yonmaor1/p5-flipdots/blob/main/libs/javascript/flipdot.js
// Requires p5.js 2.3.4:
// https://cdn.jsdelivr.net/npm/p5@2.3.4/lib/p5.js
// Serial communication uses the local HTTP bridge; no browser serial add-on is needed.
//
// Instructions: 
// 1. Follow node package installation instructions at 
//    https://github.com/yonmaor1/p5-flipdots/blob/main/README.md
// 2. Connect powered XY5 to serial port via USB-to-RS485 connector
// 3. Launch serial communications server: `node flipdot_server.js` or `python flipdot_server.py`
// 4. Ensure ENABLE_TX is true in flipdot.js
// 5. Run this sketch in the browser, fiddle with the f_str expression!
//
// Developed with support from the Frank-Ratchye Further Fund 
// at the Frank-Ratchye STUDIO for Creative Inquiry at CMU
// Inspired by https://tixy.land/ by Martin Kleppe


const ENABLE_TX = true; // Set to false for a browser-only preview.

let f_str = 'sin(t-sqrt((x-7.5)**2+(y-6)**2))';
let color_func = null;
let function_field;
let error_field;
let canvas;
let frames_since = 0;
let pixs = [];
let last_input = null;
let pending_expression = null;
let expression_paused = false;
let expression_error = '';
const expressionEvaluator = new TixyEvaluator(NUM_COLS, NUM_ROWS);

//------------------------------------------------------------
function setup() {
    canvas = createCanvas(800, 600);
    frameRate(15);
    textFont('monospace');

    function_field = createElement('textarea');
    function_field.id('tixy-expression');
    function_field.size(750, 85);
    function_field.style('font-size', '16px');
    function_field.style('box-sizing', 'border-box');
    function_field.attribute('aria-label', 'Pixel expression');
    function_field.attribute('aria-describedby', 'tixy-error');
    function_field.value(f_str);

    error_field = createElement('div');
    error_field.id('tixy-error');
    error_field.attribute('role', 'status');
    error_field.attribute('aria-live', 'polite');
    error_field.style('color', '#ffb3b3');
    error_field.style('font-family', 'monospace');
    error_field.style('font-size', '12px');
    error_field.style('line-height', '14px');
    error_field.style('width', '750px');
    error_field.style('max-height', '32px');
    error_field.style('overflow', 'auto');

    pixs = Array(NUM_COLS * NUM_ROWS).fill(0);
    update_panel_bits();
    set_expression_error('');
    windowResized();
}

//------------------------------------------------------------
function draw() {
    background(64);
    noStroke();

    func_input();
    update_expression_frame();
    draw_info();
    draw_tixy_grid();
    // Only complete, successfully evaluated frames reach the panel buffers.
    // Resending a held frame also lets the transport recover after an outage.
    tixy2display();
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
        set_expression_error(error_message(error) + ' Previous frame/expression kept.');
    }
}

/** Format thrown values as plain text, including errors thrown by user code. */
function error_message(error) {
    return TixyEvaluator.errorMessage(error);
}

/** Show feedback without alerts, console flooding, or interpreting user text as HTML. */
function set_expression_error(message) {
    expression_error = message;
    if (!error_field) return;
    error_field.elt.textContent = message;
    function_field.attribute('aria-invalid', message ? 'true' : 'false');
    function_field.style('border', `1px solid ${message ? '#ff8888' : '#999'}`);
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
            const next = evaluate_expression_frame(candidate.f, 0, Array(NUM_COLS * NUM_ROWS).fill(0));
            color_func = candidate.f;
            f_str = candidate.source;
            pixs = next;
            frames_since = 1;
            expression_paused = false;
            set_expression_error('');
            update_panel_bits();
            return;
        } catch (error) {
            set_expression_error(error_message(error) + ' Previous frame/expression kept.');
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
        set_expression_error(error_message(error) + ' Frame held; edit expression to resume.');
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
}

function draw_info() {
    noStroke();
    fill('white');
    textSize(16);
    text('// input must be a valid javascript expression\n// available variables: P,t,i,x,y', 20, height - 160);
    push();
    textAlign(RIGHT);
    const connectionEmoji = { connecting: '🟡', connected: '🟢', disconnected: '🔴' };
    text(`tx: ${connectionEmoji[flipdot_connection_status()]}`, width - 30, height - 160);
    pop();
}

/** Draw only committed bits; user expressions never run inside rendering calls. */
function draw_tixy_grid() {
    for (let x = 0; x < NUM_COLS; x++) {
        for (let y = 0; y < NUM_ROWS; y++) {
            draw_tixy_cell(x, y, pixs[x + y * NUM_COLS]);
        }
    }
}

function draw_tixy_cell(x, y, bit) {
    const margin = 30;
    const cellSize = (width - 2 * margin) / NUM_COLS;
    const px = x * cellSize + cellSize / 2 + margin;
    const py = y * cellSize + cellSize / 2 + margin;
    fill(bit ? 'white' : 'black');
    noStroke();
    circle(px, py, 0.9 * cellSize);
}
