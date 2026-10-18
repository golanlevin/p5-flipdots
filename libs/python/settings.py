"""Installation defaults and validation, matching libs/javascript/settings.js."""
import json
import os
import re
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[2] / "flipdot_config.json"
DEFAULTS = {
    "webPort": 8081,
    "httpPort": 3000,
    "transmitEnabled": True,
}


def validate_settings(value):
    """Apply defaults to omitted fields, rejecting invalid ports and types."""
    if not isinstance(value, dict):
        raise ValueError("Configuration must be a JSON object.")
    settings = DEFAULTS.copy()
    for key in ("webPort", "httpPort"):
        settings[key] = value.get(key, settings[key])
        if type(settings[key]) is not int or not 1 <= settings[key] <= 65535:
            raise ValueError(f"{key} must be an integer from 1 to 65535.")
    if settings["webPort"] == settings["httpPort"]:
        raise ValueError("webPort and httpPort must be different.")
    settings["transmitEnabled"] = value.get("transmitEnabled", True)
    if type(settings["transmitEnabled"]) is not bool:
        raise ValueError("transmitEnabled must be true or false.")
    return settings


def read_config(config_path=CONFIG_PATH):
    try:
        value = json.loads(Path(config_path).read_text(encoding="utf-8"))
        validate_settings(value)
        return value
    except FileNotFoundError:
        return {}
    except (ValueError, OSError) as error:
        raise ValueError(f"Invalid {config_path}: {error}") from error


def read_settings(env=None, config_path=CONFIG_PATH):
    env = os.environ if env is None else env
    value = read_config(config_path)
    for key, name in (("webPort", "FLIPDOT_WEB_PORT"), ("httpPort", "FLIPDOT_HTTP_PORT")):
        if name in env:
            value[key] = int(env[name]) if re.fullmatch(r"[0-9]+", env[name]) else None
    return validate_settings(value)


def public_settings(settings):
    """Only nonprivate settings are served to browsers."""
    return {key: settings[key] for key in DEFAULTS}
