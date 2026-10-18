const NUM_COLS = 28;
const NUM_ROWS = 14;

const START_BYTE = '80';
const END_BYTE = '8F';
const CAST_AND_UPDATE = '83';
const CAST_AND_STORE = '84';
const UPDATE_ALL_PANELS = '82';
// Fixed lower/upper panel addresses; set the physical DIP banks as shown in README.
const PANEL_ADDRS = ['00', '3F'];
const ADDR_ALL_PANELS = 'FF';

// Standalone editor servers (e.g. Live Server) serve the JSON file directly;
// our own web servers serve its public subset at the same relative URL.
let bridge_http_port = 3000;
let server_transmit_enabled = true;
let configuration_ready = typeof document === 'undefined';
let configuration_failed = false;
const configuration_url = typeof document === 'undefined' ? null :
    new URL('../../flipdot_config.json', document.currentScript.src);

async function load_flipdot_settings() {
    configuration_failed = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(configuration_url, { cache: 'no-store', signal: controller.signal });
        // A deleted file uses code defaults. Other failures must not silently
        // enable transmission or select the wrong bridge port.
        if (!response.ok && response.status !== 404) throw new Error(`Settings returned HTTP ${response.status}`);
        const settings = response.status === 404 ? {} : await response.json();
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object');
        const port = settings.httpPort === undefined ? 3000 : settings.httpPort;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid httpPort');
        const enabled = settings.transmitEnabled === undefined ? true : settings.transmitEnabled;
        if (typeof enabled !== 'boolean') throw new Error('Invalid transmitEnabled');
        bridge_http_port = port;
        server_transmit_enabled = enabled;
        // Discard any frames assembled before transport settings were known.
        signal_pending = null;
        configuration_ready = true;
    } catch (error) {
        // The sketch displays connection state; retry without console warnings.
        configuration_ready = false;
        configuration_failed = true;
        setTimeout(load_flipdot_settings, 1000);
    } finally {
        clearTimeout(timeout);
    }
}

let panel_0_bits = [];
let panel_1_bits = [];

/**
 * @brief convert a bit array to a hex string
 * 
 * @param {[number]} bit_arr array of bits
 * @returns {string} hex string
 */
function bit_arr_to_hex_str(bit_arr) {
    let hex_str = '';
    for (let i = 0; i < bit_arr.length; i += 7) {
        let byte = 0;
        for (let j = 0; j < 7; j++) {
            byte += bit_arr[i + j] * Math.pow(2, j);
        }
        hex_str += byte.toString(16).padStart(2, '0');
    }
    return hex_str;
}

/**
 * @brief convert a hex string to a command for the flipdot display
 * 
 * @param {string} hex_str hex string
 * @param {number} panel_num panel number (not the address)
 * @param {boolean} immidiate boolean, if true the panel will update as soon as the command is received
 * 
 * @returns {string} command string
 * 
 */
function hex_str_to_command(hex_str, panel_num, immidiate) {
    let command = START_BYTE;
    command += immidiate ? CAST_AND_UPDATE : CAST_AND_STORE;
    command += PANEL_ADDRS[panel_num];
    command += hex_str;
    command += END_BYTE;
    return command;
}

/**
 * @brief command to update all the panels to what is stored in their buffers
 * 
 *  @returns {str} command
 */
function update_command() {
    return START_BYTE + UPDATE_ALL_PANELS + END_BYTE;
}

let last_preview_signal_at = null;
function process_and_send_signal() {
    if (!configuration_ready) return;
    let hexStr0 = bit_arr_to_hex_str(panel_0_bits);
    let hexStr1 = bit_arr_to_hex_str(panel_1_bits);

    let command0 = hex_str_to_command(hexStr0, 0, false);
    let command1 = hex_str_to_command(hexStr1, 1, false);

    if (ENABLE_TX && server_transmit_enabled) {
        // Keep both stored panels and their update together, in protocol order.
        send_signal(command0 + command1 + update_command());
    } else if (last_preview_signal_at === null || Date.now() - last_preview_signal_at >= 1000) {
        // A lightweight preview request keeps status current even with TX disabled.
        // TX_OFF never opens or writes to the serial device.
        send_signal('TX_OFF');
        last_preview_signal_at = Date.now();
    }
}

/**
 * @brief cast the ptixy grid to the flipdot display
 */
function ptixy2display() {
    process_and_send_signal();
}

/**
 * @brief cast the canvas contents to the flipdot display
 */
function canvas2display() {

    let rasterized_brightnesses = rasterize(width, height, NUM_COLS, NUM_ROWS);

    panel_0_bits = [];
    panel_1_bits = [];
    for (let x = 0; x < NUM_COLS; x++) {
        for (let y = 0; y < NUM_ROWS; y++) {
            let i = x + y * NUM_COLS;

            let bit = rasterized_brightnesses[i];

            if (y < 7) {
                panel_1_bits.push(bit);
            } else {
                panel_0_bits.push(bit);
            }
        }
    }
    
    process_and_send_signal();
}

/**
 * @brief send a signal to the node server display
 * 
 * @param {string} command command to send
 */
let signal_pending = null;
let signal_in_flight = false;
let signal_retry_timer = null;
let signal_connection_failed = false;
let signal_last_response_at = null;

/** Connection to the HTTP bridge, not an acknowledgement from the physical dots. */
function flipdot_connected() {
    return configuration_ready && !signal_connection_failed && signal_last_response_at !== null &&
        Date.now() - signal_last_response_at < 5000;
}

/** Keep healthy frame traffic green; yellow is only for establishing a connection. */
function flipdot_connection_status() {
    if (!configuration_ready) return configuration_failed ? 'disconnected' : 'connecting';
    if (flipdot_connected()) return 'connected';
    if (signal_in_flight || (signal_last_response_at === null && !signal_connection_failed)) return 'connecting';
    return 'disconnected';
}

function send_signal(command) {
    // Keep only the latest animation frame while the bridge is busy or offline.
    signal_pending = command;
    flush_signal();
}

async function flush_signal() {
    if (!configuration_ready || signal_in_flight || signal_retry_timer !== null || signal_pending === null) return;
    const command = signal_pending;
    signal_pending = null;
    signal_in_flight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let succeeded = false;
    try {
        const response = await fetch(`http://localhost:${bridge_http_port}/send-signal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command }),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Serial bridge returned HTTP ${response.status}`);
        await response.text();
        succeeded = true;
        signal_connection_failed = false;
        signal_last_response_at = Date.now();
    } catch (error) {
        signal_connection_failed = true;
        if (signal_pending === null) signal_pending = command;
    } finally {
        clearTimeout(timeout);
        signal_in_flight = false;
        if (succeeded) {
            flush_signal();
        } else {
            signal_retry_timer = setTimeout(() => {
                signal_retry_timer = null;
                flush_signal();
            }, 1000);
        }
    }
}

if (configuration_url !== null) load_flipdot_settings();

// canvas functions //

/**
 * @brief calculate the avarage brightness in each section of the canvas
 * 
 * @param {number} width_in width of canvas
 * @param {number} height_in height of the canvas
 * @param {number} width_out width of the output image (ncols in the flip dot display)
 * 
 * @return {[number]} brightnesses
 */
function rasterize(width_in, height_in, width_out, height_out = Infinity) {

	let pixels_per_col_out = int(width_in / width_out);
	height_out = min(height_out, int(height_in / pixels_per_col_out));

	loadPixels();
	let pd = pixelDensity();

	// create an array to store the brightnesses
	let rasterized_brightnesses = []
	for (let i = 0; i < height_out * width_out; i++) {
		rasterized_brightnesses.push(0);
	}

	// calculate the 'total' brightness
	noStroke();
	for (let y_out = 0; y_out < height_out; y_out++) {
		for (let x_out = 0; x_out < width_out; x_out++) {
			// fill(0, 0, 0, 254)
			// ellipse(x_out * pixels_per_col_out, y_out * pixels_per_col_out, 1);
			for (let x = 0; x < pixels_per_col_out; x ++) {
				for (let y = 0; y < pixels_per_col_out; y ++) {
					let index = (x + x_out * pixels_per_col_out + (y + y_out * pixels_per_col_out) * width_in * pd) * 4 * pd;
					let r = pixels[index] / 255;
					let g = pixels[index + 1] / 255;
					let b = pixels[index + 2] / 255;
					let a = pixels[index + 3] / 255;

					// fill(r*255, g*255, b*255, 254)
					// ellipse(x + x_out * pixels_per_col_out, y + y_out * pixels_per_col_out, 1);

					let brightness = (0.2126*r + 0.7152*g + 0.0722*b);

					rasterized_brightnesses[y_out * width_out + x_out] += brightness;
				}
			}
		}
	}

	// calculate the average brightness
	for (let i = 0; i < height_out * width_out; i++) {
		rasterized_brightnesses[i] = round(rasterized_brightnesses[i] / (pixels_per_col_out * pixels_per_col_out));
	}

	return rasterized_brightnesses;

}

/**
 * @brief draw the rasterized image
 * 
 * @param {[number]} rasterized_brightnesses brightnesses
 * @param {number} width_out width of the output image (ncols in the flip dot display)
 * 
 */
function draw_rasterized_image(rasterized_brightnesses, width_out) {

	let pixels_per_col_out = int(width / width_out);

	for (let i = 0; i < rasterized_brightnesses.length; i++) {
		let row = int(i / width_out);
		let col = i % width_out;
		fill(rasterized_brightnesses[i] * 255, 200);
		rect(col * pixels_per_col_out, row * pixels_per_col_out, pixels_per_col_out);
	}
}

// end canvas functions //
