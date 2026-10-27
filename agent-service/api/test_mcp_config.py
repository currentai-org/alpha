"""CUR-3025: operator-configured MCP servers for agent mode.

Offline. Config parsing (mcp_config), what reaches `new_session` (acp_client._acp_run driven against a
fake ACP connection), which tasks get the servers (app._execute_attempt), the agent env, /healthz, and
the egress allowlist the entrypoint derives. The real-Hermes run is test_mcp_hermes_live.py.
"""
import asyncio
import contextlib
import json
import os
import subprocess as sp
import types
from pathlib import Path

import acp_client
import app
import mcp_config
import pytest

ROOT = Path(__file__).resolve().parent.parent
FOLKWAYS = {"name": "folkways", "url": "https://folkways.example/mcp",
            "headers": {"Authorization": "FOLKWAYS_MCP_AUTH"}}


def _cfg(entries, **kw):
    return mcp_config.parse(json.dumps(entries), **kw)


# --------------------------------------------------------------------------- parsing
def test_a_valid_entry_parses_with_its_header_held_as_an_env_var_name():
    cfg = _cfg([FOLKWAYS])
    assert cfg.error is None
    (s,) = cfg.servers
    assert (s.name, s.url, s.transport, s.headers) == (
        "folkways", "https://folkways.example/mcp", "http", {"Authorization": "FOLKWAYS_MCP_AUTH"})


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_unset_or_blank_means_no_servers_and_no_error(raw):
    cfg = mcp_config.parse(raw)
    assert cfg.servers == () and cfg.error is None


def test_malformed_json_fails_loud_with_no_servers_rather_than_raising():
    cfg = mcp_config.parse('[{"name": "folkways", "url": ')
    assert cfg.servers == ()
    assert cfg.error and "not valid JSON" in cfg.error


def test_one_bad_entry_drops_the_whole_list_so_a_partial_config_never_looks_healthy():
    cfg = _cfg([FOLKWAYS, {"name": "bad", "url": "http://evil.example/mcp"}])
    assert cfg.servers == ()
    assert "https" in (cfg.error or "")


@pytest.mark.parametrize("url", ["http://localhost:8000/mcp", "http://127.0.0.1:8000/mcp", "http://[::1]:8000/mcp"])
def test_localhost_is_refused_without_the_dev_flag(url):
    cfg = _cfg([{"name": "dev", "url": url}])
    assert cfg.servers == ()
    assert "AGENT_MCP_ALLOW_LOCALHOST" in (cfg.error or "")


def test_localhost_over_http_is_accepted_only_with_the_dev_flag():
    cfg = _cfg([{"name": "dev", "url": "http://localhost:8000/mcp"}], allow_localhost=True)
    assert cfg.error is None and cfg.servers[0].is_loopback


def test_the_dev_flag_does_not_admit_plain_http_to_a_remote_host():
    cfg = _cfg([{"name": "x", "url": "http://folkways.example/mcp"}], allow_localhost=True)
    assert cfg.servers == () and "https" in (cfg.error or "")


@pytest.mark.parametrize("entry,why", [
    ({"name": "x", "url": "https://10.0.0.5/mcp"}, "private"),
    ({"name": "x", "url": "https://169.254.169.254/mcp"}, "private"),
    ({"name": "x", "url": "https://user:pw@folkways.example/mcp"}, "credentials"),
    ({"name": "Has Space", "url": "https://folkways.example/mcp"}, "name"),
    ({"name": "x", "url": "https://folkways.example/mcp", "transport": "sse"}, "transport"),
    ({"name": "x", "url": "https://folkways.example/mcp", "headers": {"Authorization": "Bearer abc"}}, "env var"),
    ({"name": "x", "url": "https://folkways.example/mcp", "token": "abc"}, "unknown keys"),
])
def test_entries_that_would_widen_reach_or_carry_a_secret_are_refused(entry, why):
    cfg = _cfg([entry])
    assert cfg.servers == ()
    assert why in (cfg.error or ""), cfg.error


def test_duplicate_names_are_refused():
    cfg = _cfg([FOLKWAYS, FOLKWAYS])
    assert cfg.servers == () and "duplicate" in (cfg.error or "")


def test_a_list_is_required():
    assert "list" in (mcp_config.parse(json.dumps(FOLKWAYS)).error or "")


# --------------------------------------------------------------------------- building the ACP entries
def test_header_values_resolve_from_env_at_session_time():
    cfg = _cfg([FOLKWAYS])
    (srv,) = acp_client.build_mcp_servers(cfg, {"FOLKWAYS_MCP_AUTH": "Bearer t0k"})
    assert srv.type == "http" and srv.name == "folkways" and srv.url == FOLKWAYS["url"]
    assert [(h.name, h.value) for h in srv.headers] == [("Authorization", "Bearer t0k")]


def test_a_server_whose_header_env_var_is_unset_is_left_out_rather_than_sent_unauthenticated(monkeypatch):
    logged = []
    monkeypatch.setattr(acp_client.logsink, "emit", logged.append)
    monkeypatch.setattr(acp_client, "_LOG", True)
    assert acp_client.build_mcp_servers(_cfg([FOLKWAYS]), {}, "t1") == []
    assert logged and logged[0]["event"] == "mcp.server_skipped"
    assert logged[0]["missing_header_env"] == ["FOLKWAYS_MCP_AUTH"]


# --------------------------------------------------------------------------- what reaches new_session
class _FakeConn:
    def __init__(self):
        self.new_session_kwargs: dict | None = None

    async def initialize(self, **kw):
        return None

    async def new_session(self, **kw):
        self.new_session_kwargs = kw
        return types.SimpleNamespace(session_id="s1")

    async def prompt(self, **kw):
        return types.SimpleNamespace(stop_reason="end_turn")

    async def cancel(self, **kw):
        return None


def _drive_acp_run(monkeypatch, tmp_path, mcp_servers):
    conn = _FakeConn()

    @contextlib.asynccontextmanager
    async def _spawn(client, command, *args, env=None, cwd=None):
        proc = types.SimpleNamespace(stderr=None, returncode=0)
        yield conn, proc

    monkeypatch.setattr(acp_client.acp, "spawn_agent_process", _spawn)
    task = types.SimpleNamespace(id="t", _canceled=False, _acp_cancel=None, _acp_confirm=None,
                                 _confirm_wait_secs=0.0, unrun_detail=None)
    asyncio.run(acp_client._acp_run(
        str(tmp_path), str(tmp_path), "hi", None, 30.0, None, task, sandbox_prefix=[], hermes_bin="hermes",
        model_env={}, model="", provider="", attempt=1, mcp_servers=mcp_servers))
    return conn.new_session_kwargs


def test_configured_servers_reach_new_session(monkeypatch, tmp_path):
    servers = acp_client.build_mcp_servers(_cfg([FOLKWAYS]), {"FOLKWAYS_MCP_AUTH": "Bearer t0k"})
    kw = _drive_acp_run(monkeypatch, tmp_path, servers)
    assert kw is not None
    assert [s.name for s in kw.get("mcp_servers") or []] == ["folkways"], kw


@pytest.mark.parametrize("empty", [None, []])
def test_with_no_servers_new_session_is_called_exactly_as_before(monkeypatch, tmp_path, empty):
    assert _drive_acp_run(monkeypatch, tmp_path, empty) == {"cwd": str(tmp_path)}


# --------------------------------------------------------------------------- which tasks get them
@pytest.fixture
def folkways_configured(monkeypatch):
    monkeypatch.setattr(app, "MCP_CONFIG", _cfg([FOLKWAYS]))
    monkeypatch.setenv("FOLKWAYS_MCP_AUTH", "Bearer t0k")


def _servers_passed_by_execute_attempt(monkeypatch, tmp_path, policy):
    seen = {}

    async def _fake_acp_run(*a, **kw):
        seen["mcp_servers"] = kw.get("mcp_servers")
        return "", None, 0

    monkeypatch.setattr(acp_client, "_acp_run", _fake_acp_run)
    t = app.Task(id=f"mcp-{policy}", prompt="hi", user="dev-bypass-user")
    app._execute_attempt(t, work=str(tmp_path), attempt_home=str(tmp_path), attempt_prompt="hi", attempts=1,
                         nonce=None, timeout_secs=30.0, buf=None, sandbox=[], use_acp=True,
                         decision={"policy": policy, "tier": "uniform"}, verify_check=None, repair_check=None,
                         tool_kinds=set(), tool_failures=set())
    return seen["mcp_servers"]


def test_an_allow_task_gets_the_configured_servers(monkeypatch, tmp_path, folkways_configured):
    assert [s.name for s in _servers_passed_by_execute_attempt(monkeypatch, tmp_path, "allow")] == ["folkways"]


@pytest.mark.parametrize("policy", ["deny_writes", "confirm"])
def test_mcp_tools_are_withheld_under_deny_writes_and_confirm_because_no_gate_sees_them(
        monkeypatch, tmp_path, folkways_configured, policy):
    assert _servers_passed_by_execute_attempt(monkeypatch, tmp_path, policy) == []


def test_unset_config_passes_no_servers(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "MCP_CONFIG", mcp_config.McpConfig())
    assert _servers_passed_by_execute_attempt(monkeypatch, tmp_path, "allow") == []


def test_the_agent_env_does_not_carry_the_header_value(monkeypatch, folkways_configured, tmp_path):
    env = app._model_env(None, str(tmp_path), "allow")
    assert "FOLKWAYS_MCP_AUTH" not in env
    assert "Bearer t0k" not in json.dumps(env)


# --------------------------------------------------------------------------- /healthz
def test_healthz_names_servers_and_never_the_url_or_header_value(monkeypatch, folkways_configured):
    h = app.healthz()["mcp"]
    assert h["servers"] == ["folkways"] and h["error"] is None and h["missing_header_env"] == []
    body = json.dumps(app.healthz())
    assert "folkways.example" not in body and "Bearer t0k" not in body


def test_healthz_reports_a_malformed_config(monkeypatch):
    monkeypatch.setattr(app, "MCP_CONFIG", mcp_config.parse("[{"))
    h = app.healthz()["mcp"]
    assert h["servers"] == [] and "not valid JSON" in h["error"]


def test_healthz_with_nothing_configured_has_no_mcp_field_at_all(monkeypatch):
    """Unset must look exactly like the service before CUR-3025: no new field, not an empty one."""
    monkeypatch.setattr(app, "MCP_CONFIG", mcp_config.McpConfig())
    assert "mcp" not in app.healthz()


# --------------------------------------------------------------------------- egress (deploy/entrypoint.sh)
def _allow_names(extra_env: dict) -> set[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_MCP")}
    env.update({"AGENT_ENTRYPOINT_LIB": "1", "AGENT_EGRESS_ALLOW_HOSTS": "api.axiom.co",
                "AGENT_MCP_CONFIG_PY": str(ROOT / "api" / "mcp_config.py"), **extra_env})
    r = sp.run(["sh", "-c", f". {ROOT / 'deploy' / 'entrypoint.sh'}\nallow_names"],
               capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return set(r.stdout.split())


def test_a_configured_mcp_host_joins_the_egress_allowlist():
    assert _allow_names({"AGENT_MCP_SERVERS": json.dumps([FOLKWAYS])}) == {"api.axiom.co", "folkways.example"}


def test_unset_mcp_config_leaves_the_egress_allowlist_unchanged():
    assert _allow_names({}) == {"api.axiom.co"}


@pytest.mark.parametrize("raw", [
    '[{"name": "x", "url": ',                                                  # malformed
    json.dumps([{"name": "x", "url": "http://evil.example/mcp"}]),              # refused by the app's parser
    json.dumps([{"name": "x", "url": "https://evil.example/mcp", "transport": "sse"}]),
])
def test_a_host_the_app_would_refuse_never_gets_an_egress_hole(raw):
    assert _allow_names({"AGENT_MCP_SERVERS": raw}) == {"api.axiom.co"}


def test_a_loopback_dev_server_adds_nothing_to_egress():
    raw = json.dumps([{"name": "dev", "url": "http://127.0.0.1:8000/mcp"}])
    assert _allow_names({"AGENT_MCP_SERVERS": raw, "AGENT_MCP_ALLOW_LOCALHOST": "1"}) == {"api.axiom.co"}


def _render_ruleset(tmp_path, extra_env: dict) -> str:
    """The nftables ruleset entrypoint.sh would install, rendered from a seeded name table."""
    cache, out = tmp_path / "dns.tsv", tmp_path / "egress.nft"
    # Every name has an address, including one nobody configured: the table is not the policy.
    cache.write_text("9.9.9.9\tapi.axiom.co\n1.2.3.4\tfolkways.example\n5.6.7.8\tother.example\n")
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_MCP")}
    env.update({"AGENT_ENTRYPOINT_LIB": "1", "AGENT_EGRESS_ALLOW_HOSTS": "api.axiom.co",
                "AGENT_DNS_CACHE": str(cache), "AGENT_MCP_CONFIG_PY": str(ROOT / "api" / "mcp_config.py"),
                **extra_env})
    r = sp.run(["sh", "-c", f". {ROOT / 'deploy' / 'entrypoint.sh'}\nrender_rules {out}"],
               capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return out.read_text()


def test_the_connect_filter_admits_the_configured_mcp_host_and_refuses_a_host_not_listed(tmp_path):
    rules = _render_ruleset(tmp_path, {"AGENT_MCP_SERVERS": json.dumps([FOLKWAYS])})
    assert "1.2.3.4" in rules, "the configured MCP host must be reachable"
    assert "5.6.7.8" not in rules, "a host nobody configured must stay outside the allowlist"
    assert "9.9.9.9" in rules


def test_with_mcp_unset_the_ruleset_is_byte_identical_to_one_that_never_heard_of_mcp(tmp_path):
    """No new exit at all when AGENT_MCP_SERVERS is unset or empty."""
    (tmp_path / "a").mkdir(); (tmp_path / "b").mkdir()
    baseline = _render_ruleset(tmp_path / "a", {})
    assert _render_ruleset(tmp_path / "b", {"AGENT_MCP_SERVERS": ""}) == baseline
    assert "1.2.3.4" not in baseline and "5.6.7.8" not in baseline
