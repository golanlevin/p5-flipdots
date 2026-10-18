"""Configuration and read-only serial discovery shared by the Python launcher and worker."""

import json
import os
import re
from pathlib import Path
# Find the same versioned file regardless of the caller's working directory.
# JSON field names intentionally match libs/javascript/serial_config.js.
from .settings import CONFIG_PATH, read_config, validate_settings


def validate_selection(value):
    """Normalize supported fields and reject malformed paths or USB identity values."""
    if not isinstance(value, dict) or not isinstance(value.get("serialPort"), str) or not value["serialPort"].strip():
        raise ValueError("Serial selection requires a nonempty serialPort string.")
    selection = {"serialPort": value["serialPort"].strip()}
    if "serialNumber" in value:
        if not isinstance(value["serialNumber"], str) or not value["serialNumber"].strip():
            raise ValueError("serialNumber must be a nonempty string.")
        selection["serialNumber"] = value["serialNumber"].strip()
    for key in ("vendorId", "productId"):
        if key in value:
            if not isinstance(value[key], str) or not re.fullmatch(r"[0-9a-fA-F]{4}", value[key]):
                raise ValueError(f"{key} must be a four-digit hexadecimal string.")
            selection[key] = value[key].lower()
    return selection


def read_selection(port=None, env=None, config_path=CONFIG_PATH):
    """Apply CLI > environment > JSON; return None only when no selection is supplied."""
    env = os.environ if env is None else env
    # Explicit paths replace the entire saved identity, not just its path field.
    if port is not None:
        return validate_selection({"serialPort": port})
    if env.get("FLIPDOT_SERIAL_PATH"):
        return validate_selection({"serialPort": env["FLIPDOT_SERIAL_PATH"]})
    try:
        text = Path(config_path).read_text(encoding="utf-8")
    except FileNotFoundError:
        # Missing configuration invites setup; invalid or unreadable files are errors.
        return None
    except OSError as error:
        raise ValueError(f"Cannot read {config_path}: {error}") from error
    try:
        value = json.loads(text)
        if isinstance(value, dict) and "serialPort" not in value:
            return None
        return validate_selection(value)
    except ValueError as error:
        raise ValueError(f"Invalid {config_path}: {error}") from error


def list_ports():
    """Read OS port metadata without opening devices; return cross-language field names."""
    from serial.tools.list_ports import comports
    # USB identifiers can be absent for non-USB ports or unsupported OS metadata.
    return sorted([{
        "path": port.device,
        "description": port.description or port.manufacturer or "Unknown interface",
        "serialNumber": port.serial_number,
        "vendorId": f"{port.vid:04x}" if port.vid is not None else None,
        "productId": f"{port.pid:04x}" if port.pid is not None else None,
    } for port in comports()], key=lambda port: port["path"])


def format_ports(ports):
    """Number this listing for the chooser; indices are temporary, never saved identities."""
    if not ports:
        return "No serial interfaces found."
    lines = []
    for index, port in enumerate(ports):
        identity = []
        if port.get("vendorId") and port.get("productId"):
            identity.append(f"USB {port['vendorId']}:{port['productId']}")
        if port.get("serialNumber"):
            identity.append(f"serial {port['serialNumber']}")
        suffix = f" [{'; '.join(identity)}]" if identity else ""
        lines.append(f"  {index}: {port['path']} — {port['description']}{suffix}")
    return "\n".join(lines)


def save_selection(port, config_path=CONFIG_PATH):
    """Replace the tracked JSON atomically with the user's explicit adapter choice."""
    value = {"serialPort": port["path"]}
    # VID/PID identify a device model, so only persist identity matching when the
    # adapter also supplies a serial number identifying the selected unit.
    if port.get("serialNumber"):
        value["serialNumber"] = port["serialNumber"]
        for key in ("vendorId", "productId"):
            if port.get(key):
                value[key] = port[key]
    selection = validate_selection(value)
    config = read_config(config_path)
    # Materialize missing defaults without saving environment overrides or
    # replacing explicit installation settings.
    config.update(validate_settings(config))
    # Updating an adapter must not erase unrelated installation settings.
    for key in ("serialPort", "serialNumber", "vendorId", "productId"):
        config.pop(key, None)
    config.update(selection)
    config_path = Path(config_path)
    # Write beside the destination, then rename: interrupted writes should not
    # leave a partially written configuration in place of the previous selection.
    temporary = config_path.with_name(f"{config_path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        temporary.replace(config_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return selection


def resolve_port(selection, enumerate_ports=None):
    """Find a saved USB identity's current path, refusing missing or ambiguous matches."""
    selection = validate_selection(selection)
    if not selection.get("serialNumber"):
        # Path-only configurations and explicit overrides require no guesswork.
        return selection["serialPort"]
    # Serial number must match. Check VID/PID when both configuration and OS
    # supply them; the JavaScript and Python bindings can expose different metadata.
    matches = [port for port in (enumerate_ports or list_ports)()
               if port.get("serialNumber") == selection["serialNumber"] and all(
                   not selection.get(key) or not port.get(key) or port[key].lower() == selection[key]
                   for key in ("vendorId", "productId"))]
    # A reused path is trusted only after its identity has passed the filter above.
    exact = next((port for port in matches if port["path"] == selection["serialPort"]), None)
    if exact:
        return exact["path"]
    # macOS provides tty/cu names for the same interface. Prefer that counterpart
    # before treating other aliases of a matching adapter as ambiguous.
    alternate = re.sub(r"^/dev/(tty|cu)\.",
                       lambda match: "/dev/cu." if match[1] == "tty" else "/dev/tty.", selection["serialPort"])
    counterpart = next((port for port in matches if port["path"] == alternate), None)
    if counterpart:
        return counterpart["path"]
    if len(matches) == 1:
        # Follow a changed path only when there is one identifiable candidate.
        return matches[0]["path"]
    # The caller's supervisor retries an unavailable adapter instead of switching
    # to unrelated hardware. Ambiguity needs a fresh explicit selection.
    raise ValueError("Saved adapter identity is ambiguous; run --configure to select its interface again."
                     if matches else "Saved serial adapter is unavailable; waiting for that adapter to reconnect.")
