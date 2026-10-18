// OpenProcessing sidecar for either the JavaScript or Python flipdot server.
// No p5.serialport library, HTML changes, or additional code tabs are required.
// This URL points to the computer running the browser, not to OpenProcessing.
// If httpPort differs in flipdot_config.json, change the port here to match.
const FLIPDOT_SERVER_URL = "http://localhost:3000";

const NUM_COLS = 28;
const NUM_ROWS = 14;
const START_BYTE = "80";
const END_BYTE = "8F";
const CAST_AND_STORE = "84";
const UPDATE_ALL_PANELS = "82";
const PANEL_ADDRS = ["00", "3F"]; // Lower/upper panels; see README hardware setup.

let panel_0_bits = [];
let panel_1_bits = [];
let connection_requested = false;
let signal_pending = null;
let signal_in_flight = false;
let signal_retry_timer = null;
let signal_connection_failed = false;
let signal_last_response_at = null;
let last_preview_signal_at = null;
let loopback_permission = null;
let signal_permission_blocked = false;
let signal_connection_feedback = "";

/** Inspect browser policy separately from the user's stored permission choice. */
function flipdot_access_block_reason() {
  if (typeof document !== "undefined") {
    const policy = document.permissionsPolicy || document.featurePolicy;
    // Check only recognized names; older browsers may implement the legacy alias.
    const features =
      policy && typeof policy.features === "function" ? policy.features() : [];
    const feature = ["loopback-network", "local-network-access"].find((name) =>
      features.includes(name)
    );
    if (feature && !policy.allowsFeature(feature)) {
      return "OpenProcessing iframe policy blocks local-server access. The hosting page must allow loopback-network.";
    }
  }
  if (loopback_permission && loopback_permission.state === "denied") {
    return "Browser denied local-server access. Allow local/loopback access in site settings, then click Connect.";
  }
  return "";
}

function refresh_flipdot_access() {
  const reason = flipdot_access_block_reason();
  const wasBlocked = signal_permission_blocked;
  signal_permission_blocked = Boolean(reason);
  if (reason) {
    signal_connection_failed = true;
    signal_connection_feedback = reason;
    clearTimeout(signal_retry_timer);
    signal_retry_timer = null;
  } else if (wasBlocked) {
    signal_connection_feedback = "";
    // Resume a previously requested connection when the user grants permission.
    if (loopback_permission && loopback_permission.state === "granted")
      flush_signal();
  }
  return !signal_permission_blocked;
}

/** Queries do not request access or send traffic; Connect still initiates access. */
async function initialise_flipdot_permissions() {
  try {
    if (typeof navigator !== "undefined" && navigator.permissions) {
      for (const name of ["loopback-network", "local-network-access"]) {
        try {
          loopback_permission = await navigator.permissions.query({ name });
          break;
        } catch {
          /* Unsupported permission name: try the legacy alias. */
        }
      }
      if (loopback_permission)
        loopback_permission.addEventListener("change", refresh_flipdot_access);
    }
  } catch {
    /* Browsers without this API still use ordinary connection attempts. */
  }
  refresh_flipdot_access();
}

function flipdot_connection_message() {
  return signal_connection_feedback;
}

/** Called from the Connect button so browser permission requests follow a click. */
function start_flipdot_connection() {
  connection_requested = true;
  if (!refresh_flipdot_access()) return;
  if (signal_retry_timer !== null) {
    clearTimeout(signal_retry_timer);
    signal_retry_timer = null;
  }
  flush_signal();
}

function bit_arr_to_hex_str(bits) {
  let result = "";
  for (let i = 0; i < bits.length; i += 7) {
    let byte = 0;
    for (let j = 0; j < 7; j++) byte += bits[i + j] * 2 ** j;
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function ptixy2display() {
  if (ENABLE_TX) {
    const command0 =
      START_BYTE +
      CAST_AND_STORE +
      PANEL_ADDRS[0] +
      bit_arr_to_hex_str(panel_0_bits) +
      END_BYTE;
    const command1 =
      START_BYTE +
      CAST_AND_STORE +
      PANEL_ADDRS[1] +
      bit_arr_to_hex_str(panel_1_bits) +
      END_BYTE;
    // Both panel stores and refresh stay together as a single 67-byte request.
    send_signal(
      command0 + command1 + START_BYTE + UPDATE_ALL_PANELS + END_BYTE
    );
  } else if (
    last_preview_signal_at === null ||
    Date.now() - last_preview_signal_at >= 1000
  ) {
    // Preview status checks never write serial bytes; the server also enforces
    // its own transmitEnabled setting, even for already-open hosted sketches.
    send_signal("TX_OFF");
    last_preview_signal_at = Date.now();
  }
}

/** Green means a recent HTTP response, not an acknowledgement from the dots. */
function flipdot_connected() {
  return (
    !signal_permission_blocked &&
    !signal_connection_failed &&
    signal_last_response_at !== null &&
    Date.now() - signal_last_response_at < 5000
  );
}

function flipdot_connection_status() {
  if (signal_permission_blocked) return "disconnected";
  if (flipdot_connected()) return "connected";
  if (
    signal_in_flight ||
    (signal_last_response_at === null && !signal_connection_failed)
  )
    return "connecting";
  return "disconnected";
}

function send_signal(command) {
  // Drawing runs independently of network access. Only the newest frame waits.
  signal_pending = command;
  flush_signal();
}

async function flush_signal() {
  if (
    !connection_requested ||
    signal_permission_blocked ||
    signal_in_flight ||
    signal_retry_timer !== null ||
    signal_pending === null
  )
    return;
  const command = signal_pending;
  signal_pending = null;
  signal_in_flight = true;
  const controller = new AbortController();
  // Leave time to answer the first browser permission prompt. Once permission
  // is granted, normal requests retain the same four-second transport deadline.
  const timeoutMs =
    loopback_permission && loopback_permission.state === "prompt"
      ? 30000
      : 4000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let succeeded = false;
  try {
    const response = await fetch(
      FLIPDOT_SERVER_URL.replace(/\/+$/, "") + "/send-signal",
      {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal: controller.signal,
      }
    );
    if (!response.ok)
      throw new Error(`Serial bridge returned HTTP ${response.status}`);
    await response.text();
    succeeded = true;
    signal_connection_failed = false;
    signal_connection_feedback = "";
    signal_last_response_at = Date.now();
  } catch (error) {
    // Connection failures are shown on the canvas. Browsers may still log
    // their own network diagnostics; this code adds no console messages.
    signal_connection_failed = true;
    if (refresh_flipdot_access()) {
      signal_connection_feedback =
        "Cannot reach the local flipdot server. Check that it is running and browser access is allowed.";
    }
    if (signal_pending === null) signal_pending = command;
  } finally {
    clearTimeout(timeout);
    signal_in_flight = false;
    if (succeeded) {
      flush_signal();
    } else if (!signal_permission_blocked) {
      signal_retry_timer = setTimeout(() => {
        signal_retry_timer = null;
        flush_signal();
      }, 1000);
    }
  }
}
