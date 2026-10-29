"""Plain-assert tests for the settings allowlist. Run: /tmp/crm-console-standard-venv/bin/python console-standard/bot/test_settings.py"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from settings import DEFAULTS, SCHEMA, SettingsError, from_body, validate  # noqa: E402


def refused(fn, *args):
    try:
        fn(*args)
    except SettingsError:
        return True
    return False


good = {"sttModel": "nova-2-general", "replyDeployment": "gpt-5.4-mini", "voice": "aura-2-andromeda-en", "endpointingMs": 500, "vadStopSecs": 0.4}
assert validate(good) == {**DEFAULTS, **good}
assert validate({"id": "x", "name": "n", "note": "m", **good}) == {**DEFAULTS, **good}
assert from_body(None) == DEFAULTS and from_body({}) == DEFAULTS and from_body({"other": 1}) == DEFAULTS
assert from_body({"config": good}) == {**DEFAULTS, **good}
# Present but not an object: refused, never defaults.
for bad_body in ([], "text", 5, [1]):
    assert refused(from_body, bad_body), bad_body
for bad_config in (None, [], "x", 3, [good]):
    assert refused(from_body, {"config": bad_config}), bad_config
# Values outside the allowlist.
for patch in ({"sttModel": "other"}, {"replyDeployment": "gpt-x"}, {"voice": "aura-2-../x-en"}, {"endpointingMs": 99}, {"endpointingMs": 300.5},
              {"endpointingMs": True}, {"vadStopSecs": 1.5}, {"vadStopSecs": "0.2"}, {"extra": 1}, {"name": 5}, {"note": "x" * 201},
              {"voicePath": "azure_speech_to_speech"}, {"voicePath": 1}, {"orchestration": "other"}, {"orchestration": None},
              {"promptSetup": "Bad Setup"}, {"promptSetup": "../x"}, {"promptSetup": ""}, {"promptSetup": "a" * 41}, {"promptSetup": 3},
              {"lead": "lead-9"}, {"lead": ["lead-1"]}, {"direction": "sideways"}, {"direction": True}):
    assert refused(validate, {**good, **patch}), patch
# New fields: accepted values, and defaults when absent.
full = {"voicePath": "cascaded_deepgram", "orchestration": "pipecat_flows", "promptSetup": "setup-2", "lead": "lead-3", "direction": "outbound"}
assert validate({**good, **full}) == {**good, **full}
assert validate(good)["orchestration"] == "single_prompt" and validate(good)["promptSetup"] == "default"
assert validate({}) == DEFAULTS
# The defaults come from the schema file and satisfy the allowlist.
assert DEFAULTS == SCHEMA["defaults"] and validate(DEFAULTS) == DEFAULTS
# Every seeded configuration passes.
seed = json.load(open(os.path.join(os.path.dirname(__file__), "..", "configs.seed.json")))
for entry in seed:
    validate(entry)
print("settings tests passed")
