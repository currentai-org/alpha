"""The self-host gateway reads Open WebUI's env names exactly as the web app does.

The cases are shared with web/src/lib/chat/server/env/openWebUiAliases.spec.ts through
testdata/openwebui-env-cases.json, so a change to either resolver that the other lacks fails one of them."""

import json
import pathlib

import pytest
from openwebui_env import gateway_env, resolve_openai_env

_FIXTURE = pathlib.Path(__file__).parent / "testdata" / "openwebui-env-cases.json"
_CASES = json.loads(_FIXTURE.read_text())["cases"]


def test_the_shared_case_list_is_read_and_not_empty():
    assert len(_CASES) > 10


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_resolve_openai_env_matches_the_shared_case(case):
    if case.get("throws"):
        with pytest.raises(ValueError):
            resolve_openai_env(case["env"])
        return
    got = resolve_openai_env(case["env"])
    for key, want in case.get("expect", {}).items():
        assert got.get(key, "<missing>") == want, key
    for key in case.get("absent", []):
        assert key not in got, key


def test_gateway_starts_on_open_webuis_first_endpoint_when_openai_base_url_is_unset():
    values, notes = gateway_env({"OPENAI_API_BASE_URLS": "http://llama:8080/v1;http://b/v1", "OPENAI_API_KEYS": "k1;k2"})
    assert values == {"PROVIDER_STACK_BASE": "http://llama:8080/v1", "PROVIDER_STACK_TOKEN": "k1"}
    assert any("OPENAI_API_BASE_URLS" in n for n in notes)
    assert any("1 more endpoint" in n for n in notes)


def test_gateway_keeps_openai_base_url_when_both_are_set_and_says_the_other_is_ignored():
    values, notes = gateway_env({"OPENAI_BASE_URL": "https://own/v1", "OPENAI_API_KEY": "own-key",
                                 "OPENAI_API_BASE_URLS": "http://other/v1", "OPENAI_API_KEYS": "other"})
    assert values == {"PROVIDER_STACK_BASE": "https://own/v1", "PROVIDER_STACK_TOKEN": "own-key"}
    assert any("ignored" in n for n in notes)


def test_gateway_sends_the_none_placeholder_for_a_keyless_endpoint_since_an_empty_token_drops_the_provider():
    values, _ = gateway_env({"OPENAI_API_BASE_URLS": "http://llama:8080/v1"})
    assert values["PROVIDER_STACK_TOKEN"] == "none"
    values, _ = gateway_env({"OPENAI_BASE_URL": "http://llama:8080/v1"})
    assert values["PROVIDER_STACK_TOKEN"] == "none"


def test_gateway_refuses_to_start_with_no_endpoint_named():
    with pytest.raises(ValueError, match="OPENAI_BASE_URL"):
        gateway_env({})
    with pytest.raises(ValueError, match="empty URL"):
        gateway_env({"OPENAI_API_BASE_URLS": ";http://b/v1"})
