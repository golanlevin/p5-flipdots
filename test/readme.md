# Project tests

This directory contains automated checks for the servers, shared browser code, and Ptixy apps. These source files belong in the Git repository; generated caches and coverage output are ignored separately.

The suites use fake serial devices, temporary configuration files, and temporary local HTTP ports. They do not open the physical display's serial interface or require a running flipdot server. Recovery tests intentionally crash or hang their own child processes to check the watchdog.

## Running the tests

Run commands from the **repository root**.

For the JavaScript suite, use Node.js 20 or newer with the project's npm dependencies installed:

```sh
npm install
npm test
```

To run one JavaScript file:

```sh
node --test test/server.test.js
```

For the Python suite, use Python 3.9 or newer:

```sh
python3 -m unittest discover -s test -p 'test_python.py' -v
```

The Python tests use the standard library and fake serial devices; installing pySerial is not required for these tests. The two suites run independently: JavaScript tests do not require Python, and Python tests do not require Node.js.

## JavaScript test files

| File | What it checks |
| --- | --- |
| [cli.test.js](cli.test.js) | Serial-port listing and interactive selection, saved adapter identity, startup without a selection, and rejection of unknown command-line options. Runs the real launcher against fake port listings in a temporary project directory. |
| [client.test.js](client.test.js) | Shared browser transport: configuration loading, configured ports, fixed panel addresses, preview mode, connection colors, complete frame packing, one request at a time, replacement of stale pending frames, and recovery from network errors, HTTP errors, and timeouts. |
| [online.test.js](online.test.js) | Self-contained online editor and player: both script load orders, connection only after a click, visible permission/policy denials, pausing retries while blocked, resuming after permission changes, expression safeguards, complete frames, latest-frame retries, configurable bridge URL, and preview requests. Also checks all 13 player formulas, timed looping, keyboard selection, feedback resets, faulty-program skipping, and playback during outages. |
| [ptixy.test.js](ptixy.test.js) | Editor expression safeguards: syntax errors, errors at later cells or times, previous-frame feedback, protected `P[]` memory, unsupported return types, rejected promises, literal error text, and recovery after correcting a formula. Checks that partial frames are never transmitted. |
| [ptixy_player.test.js](ptixy_player.test.js) | All 13 supplied formulas, the configured schedule and looping, keyboard selection, timer and memory resets, faulty-program skipping, and holding the last complete frame when the playlist is empty or entirely faulty. Uses a simulated clock rather than waiting through each formula. |
| [recovery.test.js](recovery.test.js) | Integration between the real JavaScript supervisor and HTTP bridge: a simulated serial write hangs, the worker is replaced, and subsequent requests succeed. |
| [serial_config.test.js](serial_config.test.js) | Serial-selection precedence, validation, configuration saving without losing other settings, CLI parsing, USB identity matching, macOS tty/cu aliases, and refusal to choose an unavailable or ambiguous adapter. |
| [server.test.js](server.test.js) | Serial HTTP bridge behavior: complete frame writes, responses waiting for drain, command validation, disabled transmission without opening an adapter, bounded queues, operation deadlines, and error/disconnection handling. |
| [settings.test.js](settings.test.js) | Defaults when configuration is missing or incomplete, environment overrides, independent default values, and rejection of invalid ports or transmission settings. |
| [supervisor.test.js](supervisor.test.js) | Watchdog behavior: large worker output, restart after a crash, forced replacement after lost heartbeats, capped retry delays, missing executables, and intentional shutdown without restarting. |
| [web.test.js](web.test.js) | Hosting all three apps and shared browser libraries, cache prevention, public configuration responses, and refusal to serve private backend files or obsolete player scripts. |

Browser transport and sketch tests run JavaScript in Node's isolated VM contexts with simulated browser/p5 functions. They do not launch a real browser or test the display's mechanical behavior.

## Python test file

[test_python.py](test_python.py) contains four groups:

| Group | What it checks |
| --- | --- |
| `SerialConfigTests` | Serial-selection precedence, validation and saving, installation defaults, USB identity matching, macOS aliases, and launcher setup modes that must not start workers. |
| `BridgeTests` | Frame bytes and health responses, disabled transmission, command validation, queue limits, write/flush completion, and recovery deadlines for stalled serial operations. |
| `WebTests` | Hosting all three apps and shared browser assets, cache prevention, public settings, and keeping backend files private. |
| `SupervisorTests` | Healthy workers, shutdown, crash recovery, capped restart delays, forced replacement after lost heartbeats, and successful transmission after replacing a stalled bridge. |

## Fixtures

These helpers are launched or loaded by the JavaScript tests:

| File | Purpose |
| --- | --- |
| [fixtures/port-list.cjs](fixtures/port-list.cjs) | Supplies two fake serial adapters and simulates an interactive terminal for CLI tests. It never opens a serial device. |
| [fixtures/worker.cjs](fixtures/worker.cjs) | Emits 2 MiB of output and regular heartbeats. It can be instructed to crash or block its event loop, exercising supervisor recovery. |
| [fixtures/bridge-worker.cjs](fixtures/bridge-worker.cjs) | Runs the real HTTP bridge with a fake serial adapter. A special test command stalls a write so the recovery integration test can verify worker replacement. |
