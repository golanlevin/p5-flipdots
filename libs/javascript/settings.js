/** Shared installation settings. Keep defaults/validation in sync with Python. */
const fs = require('node:fs');
const path = require('node:path');
const CONFIG_PATH = path.resolve(__dirname, '../../flipdot_config.json');
const DEFAULTS = {
  webPort: 8081,
  httpPort: 3000,
  transmitEnabled: true,
};

/** Missing fields use defaults; malformed fields fail before workers start. */
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object.');
  const settings = { ...DEFAULTS };
  for (const key of ['webPort', 'httpPort']) {
    if (value[key] !== undefined) settings[key] = value[key];
    if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 65535) {
      throw new Error(`${key} must be an integer from 1 to 65535.`);
    }
  }
  if (settings.webPort === settings.httpPort) throw new Error('webPort and httpPort must be different.');
  if (value.transmitEnabled !== undefined) settings.transmitEnabled = value.transmitEnabled;
  if (typeof settings.transmitEnabled !== 'boolean') throw new Error('transmitEnabled must be true or false.');
  return settings;
}

function readConfig(configPath = CONFIG_PATH) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    validateSettings(value);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Invalid ${configPath}: ${error.message}`);
  }
}

function readSettings(env = process.env, configPath = CONFIG_PATH) {
  const value = readConfig(configPath);
  for (const [key, name] of [['webPort', 'FLIPDOT_WEB_PORT'], ['httpPort', 'FLIPDOT_HTTP_PORT']]) {
    if (env[name] !== undefined) value[key] = /^\d+$/.test(env[name]) ? Number(env[name]) : NaN;
  }
  return validateSettings(value);
}

// Browser-safe subset: no serial paths or USB identities are exposed by our web server.
function publicSettings(settings) {
  return { webPort: settings.webPort, httpPort: settings.httpPort, transmitEnabled: settings.transmitEnabled };
}

module.exports = { CONFIG_PATH, DEFAULTS, validateSettings, readConfig, readSettings, publicSettings };
