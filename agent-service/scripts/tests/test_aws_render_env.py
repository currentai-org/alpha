"""The AWS hosts' env render (deploy/aws/agent/render_env.py): which Doppler keys reach which role, and what stops it."""
import importlib.util
import tomllib
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[2] / "deploy" / "aws" / "agent"
spec = importlib.util.spec_from_file_location("render_env", HERE / "render_env.py")
render_env = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render_env)

DEPLOY = {
    "gateway_private": "http://10.20.0.11:8732",
    "gateway_url": "https://gw.example",
    "e2b_api_url": "http://e2b.example:3000",
    "e2b_sandbox_url": "http://e2b.example:3002",
}


def _keys(role):
    return render_env.read_keys(HERE / f"{role}.keys")


def _toml(role):
    return tomllib.loads(render_env.TOML[role].read_text()).get("env", {})


def _all_secrets():
    names = set()
    for role in ("agent", "gateway"):
        names |= set(_keys(role)[0])
    return {n: f"value-of-{n}" for n in names}


def test_the_agent_never_receives_a_model_or_provider_token():
    keys, optional = _keys("agent")
    env = render_env.render("agent", _toml("agent"), _all_secrets(), keys, optional, DEPLOY)
    leaked = [k for k in env if k.startswith(("MODEL_UPSTREAM", "PROVIDER_", "MODEL_VERIFIER_TOKEN"))]
    assert leaked == []


def test_the_agent_dials_the_gateway_and_e2b_at_this_stacks_addresses_not_the_tomls_placeholders():
    keys, optional = _keys("agent")
    env = render_env.render("agent", _toml("agent"), _all_secrets(), keys, optional, DEPLOY)
    assert env["AGENT_MODEL_PROXY_URL"] == DEPLOY["gateway_private"]
    assert env["E2B_API_URL"] == DEPLOY["e2b_api_url"] and env["E2B_SANDBOX_URL"] == DEPLOY["e2b_sandbox_url"]
    assert env["AGENT_GATEWAY_PUBLIC_URL"] == DEPLOY["gateway_url"]
    assert env["AGENT_MODEL"] == _toml("agent")["AGENT_MODEL"]  # the tracked toml still decides the model


def test_the_gateway_gets_its_tokens_and_an_ipv4_private_bind():
    keys, optional = _keys("gateway")
    env = render_env.render("gateway", _toml("gateway"), _all_secrets(), keys, optional, DEPLOY)
    assert env["PROVIDER_MISTRAL_TOKEN"] == _all_secrets()["PROVIDER_MISTRAL_TOKEN"]
    assert env["GATEWAY_PRIVATE_HOST"] == "0.0.0.0"
    assert "E2B_API_KEY" not in env


def test_a_required_key_missing_from_doppler_stops_the_render_and_names_only_the_key():
    keys, optional = _keys("agent")
    secrets = _all_secrets()
    del secrets["E2B_API_KEY"]
    with pytest.raises(SystemExit) as e:
        render_env.render("agent", _toml("agent"), secrets, keys, optional, DEPLOY)
    assert "E2B_API_KEY" in str(e.value) and "value-of" not in str(e.value)


def test_a_value_spanning_lines_is_refused_since_the_env_file_would_cut_it():
    keys, optional = _keys("gateway")
    secrets = _all_secrets() | {"AXIOM_TOKEN": "a\nb"}
    with pytest.raises(SystemExit, match="AXIOM_TOKEN"):
        render_env.render("gateway", _toml("gateway"), secrets, keys, optional, DEPLOY)


def test_a_toml_placeholder_with_no_doppler_value_is_refused():
    with pytest.raises(SystemExit, match="AGENT_METRICS_TOKEN"):
        render_env.render("agent", _toml("agent"), {}, [], set(), DEPLOY)
