"""The Kilo config each agent attempt will run under (api/kilo_config.py): which gateway and model it talks to,
which tools it may run, what it is kept away from, and which permission option it answers with. Pure functions
plus one file write, so these need no Kilo binary and no ACP package."""

import json
import types

import kilo_config
import pytest

POLICIES = ("allow", "confirm", "deny_writes")


@pytest.mark.parametrize("policy", ["allow", "confirm"])
def test_an_unknown_tool_asks_never_allows(policy):
    """A tool our mapping doesn't name (a new Kilo built-in, an MCP tool) falls to the catch-all, which asks, so
    it reaches request_permission and a person's approval card rather than running unasked."""
    perms = kilo_config.kilo_permissions(policy)
    assert perms["*"] == "ask"
    assert "allow" not in {v for k, v in perms.items() if k not in kilo_config._KILO_READ_ONLY}


def test_a_policy_name_this_mapping_does_not_know_asks_rather_than_allows():
    perms = kilo_config.kilo_permissions("something-new")
    assert perms["*"] == perms["bash"] == perms["edit"] == "ask"


def test_deny_writes_denies_shell_edits_and_unknown_tools_in_kilos_own_config():
    """Denied in config, Kilo removes the tool from what the model is offered, so the guard holds even if the
    client never sees a request (the previous engine never asked about its shell)."""
    perms = kilo_config.kilo_permissions("deny_writes")
    for tool in ("*", "bash", "edit", "external_directory", "notebook_edit", "notebook_execute"):
        assert perms[tool] == "deny", tool


@pytest.mark.parametrize("policy", POLICIES)
def test_shell_and_edits_ask_under_allow_and_confirm(policy):
    perms = kilo_config.kilo_permissions(policy)
    want = "deny" if policy == "deny_writes" else "ask"
    assert perms["bash"] == perms["edit"] == perms["external_directory"] == want


@pytest.mark.parametrize("policy", POLICIES)
def test_reads_run_unasked_under_every_policy(policy):
    perms = kilo_config.kilo_permissions(policy)
    for tool in ("read", "glob", "grep", "list"):
        assert perms[tool] == "allow", tool


@pytest.mark.parametrize("policy", POLICIES)
def test_web_subagents_skills_and_kilo_services_are_denied_under_every_policy(policy):
    """The sandbox has no egress but our gateway, and each of these either reaches the network, spawns a second
    agent outside our accounting, or reads instructions we didn't write."""
    perms = kilo_config.kilo_permissions(policy)
    for tool in ("webfetch", "websearch", "codesearch", "task", "skill", "question", "kilo_memory_save",
                 "repo_clone", "plan_enter", "suggest"):
        assert perms[tool] == "deny", tool


def test_the_catch_all_comes_first_so_named_rules_win():
    """Kilo evaluates rules in order and the last match wins, so "*" must precede every named tool."""
    assert next(iter(kilo_config.kilo_permissions("allow"))) == "*"


def test_the_config_names_only_our_gateway_as_provider():
    cfg = kilo_config.kilo_config("mistral-large-2610", "https://gw.example/v1", "allow")
    assert cfg["enabled_providers"] == ["potluck"]
    assert list(cfg["provider"]) == ["potluck"]
    assert cfg["provider"]["potluck"]["options"] == {"baseURL": "https://gw.example/v1", "apiKey": "{env:HF_TOKEN}"}
    assert cfg["model"] == cfg["small_model"] == "potluck/mistral-large-2610"
    assert "mistral-large-2610" in cfg["provider"]["potluck"]["models"]


def test_the_config_turns_off_every_kilo_service_that_would_leave_the_box():
    cfg = kilo_config.kilo_config("m", "https://gw.example/v1", "allow")
    assert cfg["share"] == "disabled"
    assert cfg["autoupdate"] is False and cfg["remote_control"] is False
    assert cfg["lsp"] is False and cfg["formatter"] is False and cfg["snapshot"] is False
    assert cfg["agent"]["title"]["disable"] is True, "no separate title call per session"


@pytest.mark.parametrize("model,base_url,match", [("", "https://gw/v1", "model"), ("m", "", "base URL")])
def test_a_config_without_a_model_or_a_gateway_fails_loud(model, base_url, match):
    """Left blank, Kilo would pick a provider and model of its own (its gateway, a free model)."""
    with pytest.raises(ValueError, match=match):
        kilo_config.kilo_config(model, base_url, "allow")


def test_write_config_writes_the_global_config_and_never_the_key(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "nonce-123")
    path = kilo_config.write_config(str(tmp_path), "m", "https://gw.example/v1", "deny_writes")
    assert path == tmp_path / "config" / "kilo" / "kilo.json"
    text = path.read_text()
    assert "nonce-123" not in text
    assert json.loads(text)["permission"]["bash"] == "deny"
    assert path.stat().st_mode & 0o077 == 0, "readable by the service user only"


def test_write_config_reads_the_token_limits_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_MODEL_CONTEXT_TOKENS", "64000")
    monkeypatch.setenv("AGENT_MODEL_OUTPUT_TOKENS", "not-a-number")
    cfg = json.loads(kilo_config.write_config(str(tmp_path), "m", "https://gw/v1", "allow").read_text())
    assert cfg["provider"]["potluck"]["models"]["m"]["limit"] == {"context": 64000, "output": 16_384}


def test_kilo_env_keeps_every_kilo_path_inside_the_attempt_home():
    env = kilo_config.kilo_env("/w/hermes-home-t-1/")
    assert env["HOME"] == "/w/hermes-home-t-1"
    for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
        assert env[var].startswith("/w/hermes-home-t-1/"), var


def test_kilo_env_ignores_project_config_the_agent_could_write_and_turns_off_telemetry():
    """A kilo.json, .kilo/ or instructions file the agent writes into the session folder would otherwise be read on the
    next turn and could rewrite its own permissions."""
    env = kilo_config.kilo_env("/w/h")
    assert env["KILO_DISABLE_PROJECT_CONFIG"] == "1"
    assert env["KILO_TELEMETRY_LEVEL"] == "off"
    for flag in ("AUTOUPDATE", "MODELS_FETCH", "LSP_DOWNLOAD", "DEFAULT_PLUGINS", "CLAUDE_CODE", "EXTERNAL_SKILLS"):
        assert env[f"KILO_DISABLE_{flag}"] == "1", flag


def test_kilo_env_gives_each_launch_a_fresh_server_password():
    """`kilo acp` serves its session on 127.0.0.1; without a password any local process could answer this
    session's permission requests."""
    a, b = kilo_config.kilo_env("/w/h")["KILO_SERVER_PASSWORD"], kilo_config.kilo_env("/w/h")["KILO_SERVER_PASSWORD"]
    assert a and b and a != b and len(a) >= 32


# Kilo's permission options as `kilo acp` offers them (packages/opencode/src/acp/permission.ts, the options
# list), in its order. Recorded rather than imported so a change upstream shows up as a decision here.
KILO_OPTIONS = [types.SimpleNamespace(option_id="once", kind="allow_once", name="Allow once"),
                types.SimpleNamespace(option_id="always", kind="allow_always", name="Always allow"),
                types.SimpleNamespace(option_id="reject", kind="reject_once", name="Reject")]


def test_an_approved_call_is_answered_allow_once_never_always():
    """An "always" reply becomes a Kilo session rule, and every later matching call would then run without
    reaching an approval card."""
    assert kilo_config.pick_option(KILO_OPTIONS, allow=True) == "once"
    assert kilo_config.pick_option(list(reversed(KILO_OPTIONS)), allow=True) == "once"


def test_a_refused_call_is_answered_reject():
    assert kilo_config.pick_option(KILO_OPTIONS, allow=False) == "reject"


def test_an_option_list_with_no_allow_once_fails_closed():
    only_always = [o for o in KILO_OPTIONS if o.kind != "allow_once"]
    assert kilo_config.pick_option(only_always, allow=True) == "reject"
    assert kilo_config.pick_option([], allow=True) == "reject"
    assert kilo_config.pick_option(None, allow=True) == "reject"


def test_kilo_runs_acp_without_plugins_behind_the_sandbox_launcher():
    assert kilo_config.kilo_argv([], "/usr/local/bin/kilo") == ("/usr/local/bin/kilo", ["acp", "--pure"])
    assert kilo_config.kilo_argv(["bwrap", "--die-with-parent", "--"], "kilo") == (
        "bwrap", ["--die-with-parent", "--", "kilo", "acp", "--pure"])
