"""The settings a browser may choose for a call, checked against configs-schema.json.

The page sends these in the /start request. Anything not in the allowlist is refused, so the
browser cannot inject arbitrary models, voices or numbers. No credentials ever pass through here.
"""
import json
import os
import re

SCHEMA = json.load(open(os.path.join(os.path.dirname(__file__), "..", "configs-schema.json")))
VOICE = re.compile(SCHEMA["voicePattern"])
PROMPT_SETUP = re.compile(SCHEMA["promptSetupPattern"])

DEFAULTS = dict(SCHEMA["defaults"])


class SettingsError(ValueError):
    pass


def _number(value, rule, name, integer):
    if isinstance(value, bool) or not isinstance(value, (int,) if integer else (int, float)):
        raise SettingsError(name)
    if not rule["min"] <= value <= rule["max"]:
        raise SettingsError(name)
    return value


def validate(raw):
    """Returns clean settings from a configuration object; anything that is not an object is refused."""
    if not isinstance(raw, dict):
        raise SettingsError("config")
    out = dict(DEFAULTS)
    for key, value in raw.items():
        if key in ("id", "name", "note"):
            if not isinstance(value, str) or len(value) > 200:
                raise SettingsError(key)
            continue
        if key == "sttModel" and value in SCHEMA["sttModels"]:
            out[key] = value
        elif key == "replyDeployment" and value in SCHEMA["replyDeployments"]:
            out[key] = value
        elif key == "voice" and isinstance(value, str) and VOICE.fullmatch(value):
            out[key] = value
        elif key == "voicePath" and isinstance(value, str) and value in SCHEMA["voicePaths"]:
            out[key] = value
        elif key == "orchestration" and isinstance(value, str) and value in SCHEMA["orchestrations"]:
            out[key] = value
        elif key == "promptSetup" and isinstance(value, str) and PROMPT_SETUP.fullmatch(value):
            out[key] = value
        elif key == "lead" and isinstance(value, str) and value in SCHEMA["leads"]:
            out[key] = value
        elif key == "direction" and isinstance(value, str) and value in SCHEMA["directions"]:
            out[key] = value
        elif key == "endpointingMs":
            out[key] = _number(value, SCHEMA["endpointingMs"], key, True)
        elif key == "vadStopSecs":
            out[key] = _number(value, SCHEMA["vadStopSecs"], key, False)
        else:
            raise SettingsError(key)
    return out


def from_body(body):
    """Settings for a start request body. No config key (or an empty body) means the defaults; a config
    that is present but not an object (null, a list, text) is refused, as is a body that is not an object."""
    if body is None or body == {}:
        return dict(DEFAULTS)
    if not isinstance(body, dict):
        raise SettingsError("body")
    if "config" not in body:
        return dict(DEFAULTS)
    return validate(body["config"])


# The defaults must themselves satisfy the allowlist, or a schema edit could leave the bot outside it.
_checked = validate(DEFAULTS)
assert _checked == DEFAULTS, "defaults in configs-schema.json are outside the allowlist"
