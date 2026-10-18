/**
 * Serial selection shared by the launcher and each replacement serial worker.
 * Keep JSON fields and precedence consistent with libs/python/serial_config.py.
 * Enumeration reads OS metadata only; discovery never probes or writes to devices.
 */
const fs = require('node:fs');
const { SerialPort } = require('serialport');
// Resolve from the source tree so invocation from another directory finds the
// same intentionally versioned configuration beside the two launchers.
const { CONFIG_PATH, readConfig, validateSettings } = require('./settings');

/** Return just the supported selection fields, rejecting malformed identities. */
function validateSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.serialPort !== 'string' || !value.serialPort.trim()) {
    throw new Error('Serial selection requires a nonempty serialPort string.');
  }
  const selection = { serialPort: value.serialPort.trim() };
  if (value.serialNumber !== undefined) {
    if (typeof value.serialNumber !== 'string' || !value.serialNumber.trim()) {
      throw new Error('serialNumber must be a nonempty string.');
    }
    selection.serialNumber = value.serialNumber.trim();
  }
  for (const field of ['vendorId', 'productId']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'string' || !/^[0-9a-fA-F]{4}$/.test(value[field])) {
        throw new Error(`${field} must be a four-digit hexadecimal string.`);
      }
      selection[field] = value[field].toLowerCase();
    }
  }
  return selection;
}

/** Read CLI > environment > JSON; null means the file and explicit choice are absent. */
function readSelection(port, env = process.env, configPath = CONFIG_PATH) {
  // Explicit paths discard saved USB identity: an override must actually override.
  if (port !== undefined) return validateSelection({ serialPort: port });
  if (env.FLIPDOT_SERIAL_PATH) return validateSelection({ serialPort: env.FLIPDOT_SERIAL_PATH });
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); }
  catch (error) {
    // A missing file invites configuration; unreadable or malformed files are errors.
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }
  try {
    const value = JSON.parse(text);
    // A settings-only file is valid; adapter selection still requires user input.
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'serialPort')) return null;
    return validateSelection(value);
  }
  catch (error) { throw new Error(`Invalid ${configPath}: ${error.message}`); }
}

/** Normalize library metadata for display and the cross-language JSON format. */
async function listPorts() {
  const ports = await SerialPort.list();
  return ports.map(port => ({
    path: port.path,
    description: port.friendlyName || port.manufacturer || 'Unknown interface',
    serialNumber: port.serialNumber,
    vendorId: port.vendorId?.toLowerCase(),
    productId: port.productId?.toLowerCase(),
  })).sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
}

/** Number the current listing for interactive setup; these indices are not identities. */
function formatPorts(ports) {
  if (!ports.length) return 'No serial interfaces found.';
  return ports.map((port, index) => {
    const identity = [];
    if (port.vendorId && port.productId) identity.push(`USB ${port.vendorId}:${port.productId}`);
    if (port.serialNumber) identity.push(`serial ${port.serialNumber}`);
    return `  ${index}: ${port.path} — ${port.description}${identity.length ? ` [${identity.join('; ')}]` : ''}`;
  }).join('\n');
}

/** Atomically replace the configuration with an explicitly selected interface. */
function saveSelection(port, configPath = CONFIG_PATH) {
  const value = { serialPort: port.path };
  // A USB serial number identifies the selected adapter; VID/PID alone do not.
  if (port.serialNumber) {
    value.serialNumber = port.serialNumber;
    if (port.vendorId) value.vendorId = port.vendorId;
    if (port.productId) value.productId = port.productId;
  }
  const selection = validateSelection(value);
  const config = readConfig(configPath);
  // Make defaults visible in newly created or incomplete files. Use saved
  // settings, not environment overrides, and retain all explicit values.
  Object.assign(config, validateSettings(config));
  // Choosing a new adapter must preserve the installation's ports and TX setting.
  for (const key of ['serialPort', 'serialNumber', 'vendorId', 'productId']) delete config[key];
  Object.assign(config, selection);
  // Write next to the destination and rename only after the complete JSON exists.
  // Failed writes therefore leave the previous selection available for next launch.
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return selection;
}

/** Resolve a saved adapter identity to today's path, never choosing an arbitrary port. */
async function resolvePort(selection, enumerate = listPorts) {
  selection = validateSelection(selection);
  if (!selection.serialNumber) return selection.serialPort;
  // The serial number is required for identity matching. VID/PID must agree when
  // supplied by both sides; some OS bindings omit these optional USB fields.
  const matches = (await enumerate()).filter(port =>
    port.serialNumber === selection.serialNumber &&
    (!selection.vendorId || !port.vendorId || port.vendorId.toLowerCase() === selection.vendorId) &&
    (!selection.productId || !port.productId || port.productId.toLowerCase() === selection.productId));
  // Prefer the selected path when an adapter is reported under multiple aliases.
  const exact = matches.find(port => port.path === selection.serialPort);
  if (exact) return exact.path;
  // macOS exposes the same interface as tty.* or cu.*; libraries enumerate different forms.
  const alternate = selection.serialPort.replace(/^\/dev\/(tty|cu)\./,
    (_, prefix) => prefix === 'tty' ? '/dev/cu.' : '/dev/tty.');
  const counterpart = matches.find(port => port.path === alternate);
  if (counterpart) return counterpart.path;
  // A unique identity can move to another path after reconnecting. Missing or
  // ambiguous identities fail this worker; the supervisor retries without guessing.
  if (matches.length === 1) return matches[0].path;
  throw new Error(matches.length ?
    'Saved adapter identity is ambiguous; run --configure to select its interface again.' :
    'Saved serial adapter is unavailable; waiting for that adapter to reconnect.');
}

/** Parse the deliberately small CLI, including --port PATH and --port=PATH. */
function parseArgs(args) {
  const result = { verbose: false, list: false, configure: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-v' || arg === '--verbose') result.verbose = true;
    else if (arg === '-h' || arg === '--help') result.help = true;
    else if (arg === '--list-ports') result.list = true;
    else if (arg === '--configure') result.configure = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? args[++i] : arg.slice('--port='.length);
      if (!value || value.startsWith('-')) throw new Error('--port requires a device path or COM port.');
      if (result.port !== undefined) throw new Error('Specify --port only once.');
      result.port = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if ([result.list, result.configure, result.port !== undefined].filter(Boolean).length > 1) {
    // Listing, saving a choice and running with an override are separate modes.
    throw new Error('Choose only one of --list-ports, --configure, or --port.');
  }
  return result;
}

module.exports = { CONFIG_PATH, validateSelection, readSelection, listPorts, formatPorts,
  saveSelection, resolvePort, parseArgs };
