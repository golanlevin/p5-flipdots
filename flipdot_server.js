/**
 * JavaScript-only entry point: select an adapter, then supervise two Node workers.
 * web.js serves p5 sketches; server.js owns the serial port and frame HTTP API.
 * This parent never opens the device, so it can replace a stalled serial worker.
 */
const path = require('node:path');
const readline = require('node:readline');
const { supervise } = require('./libs/javascript/supervisor');
const { readSettings } = require('./libs/javascript/settings');
const { CONFIG_PATH, parseArgs, readSelection, listPorts, formatPorts, saveSelection } =
  require('./libs/javascript/serial_config');

const HELP = `Usage: node flipdot_server.js [options]
  --list-ports       List serial interfaces and exit
  --port PATH        Use this device path or COM port for this run
  --configure        Choose an interface and save flipdot_config.json
  -v, --verbose      Show worker output
  -h, --help         Show this help

Selection: --port > FLIPDOT_SERIAL_PATH > flipdot_config.json
The repository includes the author's configuration; revise or delete it for your machine.`;

/** Save one explicit choice without opening a device or starting either worker. */
async function configure() {
  // Services must start without prompts; interactive setup is a separate CLI mode.
  if (!process.stdin.isTTY) throw new Error('--configure requires an interactive terminal; use --port PATH instead.');
  const ports = await listPorts();
  console.log(formatPorts(ports));
  if (!ports.length) throw new Error('Connect your serial adapter and run --configure again.');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise((resolve, reject) => {
        // Reject an unfinished prompt on EOF instead of leaving startup suspended.
        const closed = () => reject(new Error('Serial selection cancelled.'));
        terminal.once('close', closed);
        terminal.question('Choose an interface number: ', value => {
          terminal.removeListener('close', closed);
          resolve(value.trim());
        });
      });
      const index = /^\d+$/.test(answer) ? Number(answer) : -1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= ports.length) {
        console.error('Enter one of the interface numbers shown above.');
        continue;
      }
      // The number belongs to this listing only. Persist its path and USB identity.
      const selection = saveSelection(ports[index]);
      console.log(`Saved ${selection.serialPort} to ${CONFIG_PATH}. Run node flipdot_server.js to start.`);
      return;
    }
  } finally { terminal.close(); }
}

/** Handle setup commands first; only a valid selection may start supervision. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (options.list) { console.log(formatPorts(await listPorts())); return; }
  if (options.configure) { await configure(); return; }
  // Resolve CLI > environment > JSON once; changes to the file need a new launch.
  const settings = readSettings();
  const selection = readSelection(options.port);
  if (!selection && settings.transmitEnabled) {
    console.error('No serial interface configured. Run --configure, use --port PATH, or revise flipdot_config.json.');
    console.log(formatPorts(await listPorts()));
    process.exitCode = 2;
    return;
  }

  // Separate workers keep the web server available during serial-device recovery.
  const webPort = settings.webPort;
  const common = { cwd: __dirname, verbose: options.verbose,
    env: { ...process.env, FLIPDOT_SETTINGS: JSON.stringify(settings) } };
  const web = supervise({
    ...common, name: 'Web server', command: process.execPath,
    args: [path.join(__dirname, 'libs/javascript/web.js'), webPort], heartbeat: true,
  });
  const serial = supervise({
    ...common, name: 'Serial bridge', command: process.execPath,
    args: [path.join(__dirname, 'libs/javascript/server.js')], heartbeat: true,
    // Carry the resolved override and identity into every replacement worker.
    env: { ...common.env, FLIPDOT_SERIAL_SELECTION: JSON.stringify(selection) },
  });
  console.log(`Configured serial interface: ${selection?.serialPort || '(none)'}`);
  console.log(`Serial API: http://localhost:${settings.httpPort}; transmission ${settings.transmitEnabled ? 'enabled' : 'DISABLED (preview only)'}`);
  console.log(`Hosting sketches at http://localhost:${webPort}`);
  console.log('Serial bridge watchdog enabled. Press Ctrl+C to stop both servers.');

  let stopping = false;
  async function shutdown() {
    // Stop both supervisors before exiting; intentional shutdown must not respawn.
    if (stopping) return;
    stopping = true;
    await Promise.all([web.stop(), serial.stop()]);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Importing this file for tooling or tests must not start the installation.
if (require.main === module) {
  main().catch(error => {
    console.error(`${error.message}\nRun node flipdot_server.js --help for usage.`);
    process.exitCode = 1;
  });
}
