"""The E2B host's load reading and the alerts that read it (CUR-4553)."""

import importlib.util
from pathlib import Path

import app

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "axiom_alert.py"


def _alert_module():
    spec = importlib.util.spec_from_file_location("axiom_alert_under_test", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run_alert(monkeypatch, capsys, counts):
    """`main()` in dry-run with each check's query answered from `counts`, keyed by the event the query reads."""
    mod = _alert_module()

    def fake_query(_token, apl, _window):
        for event, n in counts.items():
            if f"'{event}'" in apl:
                return n
        return 0

    monkeypatch.setattr(mod, "run_query", fake_query)
    monkeypatch.setenv("AXIOM_QUERY_TOKEN", "t")
    monkeypatch.delenv("AGENT_HEALTHZ_URL", raising=False)
    monkeypatch.setattr("sys.argv", ["axiom_alert.py", "--dry-run"])
    mod.main()
    return capsys.readouterr().out


def test_a_host_at_four_fifths_of_its_capacity_for_several_readings_posts_the_near_full_alert(monkeypatch, capsys):
    out = _run_alert(monkeypatch, capsys, {"sandbox.pool": 5})
    assert "sandbox-host-near-full: 5" in out and "ALERT" in out
    assert "[dry-run] would post: 🔴 agent-service — E2B sandbox host readings at 80% or more of its capacity: 5" in out


def test_a_single_passing_reading_at_four_fifths_does_not_post_the_near_full_alert(monkeypatch, capsys):
    out = _run_alert(monkeypatch, capsys, {"sandbox.pool": 1})
    assert "sandbox-host-near-full: 1 in" in out and "ok" in out.split("sandbox-host-near-full:")[1].splitlines()[0]
    assert "would post" not in out


def test_refused_creates_post_the_host_refusing_alert_without_any_capacity_setting(monkeypatch, capsys):
    out = _run_alert(monkeypatch, capsys, {"sandbox.host_busy": 7})
    assert "code sandboxes refused because the E2B host is full: 7" in out


def test_a_quiet_dataset_posts_neither_sandbox_alert(monkeypatch, capsys):
    out = _run_alert(monkeypatch, capsys, {})
    assert "would post" not in out


def test_the_pool_reading_logs_one_line_per_answering_host_with_the_capacity_the_alert_compares_against(monkeypatch):
    events: list = []
    monkeypatch.setattr(app, "_log_event", lambda event, **f: events.append((event, f)))
    monkeypatch.setattr(app, "E2B_SLOT_CAPACITY", 10)
    monkeypatch.setattr(app, "SANDBOX_BACKEND", type("B", (), {"pool_load": staticmethod(lambda: {1: 9, 2: 3})})())
    assert app._sandbox_pool_tick() == {1: 9, 2: 3}
    assert [(e, f["slot"], f["running"], f["capacity"]) for e, f in events] == [
        ("sandbox.pool", 1, 9, 10), ("sandbox.pool", 2, 3, 10)]


def test_a_host_that_cannot_be_read_logs_a_failure_not_a_reading_of_zero(monkeypatch):
    events: list = []
    monkeypatch.setattr(app, "_log_event", lambda event, **f: events.append((event, f)))

    def down():
        raise ConnectionError("link down")

    monkeypatch.setattr(app, "SANDBOX_BACKEND", type("B", (), {"pool_load": staticmethod(down)})())
    assert app._sandbox_pool_tick() == {}
    assert [e for e, _ in events] == ["sandbox.pool_failed"]


def test_the_bwrap_backend_has_no_hosts_to_read(monkeypatch):
    events: list = []
    monkeypatch.setattr(app, "_log_event", lambda event, **f: events.append((event, f)))
    assert app.SANDBOX_BACKEND.name == "bwrap" and app._sandbox_pool_tick() == {}
    assert events == []


def test_healthz_names_the_per_account_sandbox_cap():
    assert app.healthz()["sandbox_account_max_live"] == (app.E2B_ACCOUNT_MAX_LIVE or "off")


def test_healthz_names_the_hosts_this_machine_has_auto_off_and_none_for_a_backend_without_hosts(monkeypatch):
    assert app.SANDBOX_BACKEND.name == "bwrap" and app.healthz()["sandbox_slots_auto_off"] == []
    backend = type("B", (), {"name": "e2b", "auto_off_slots": staticmethod(lambda: [2])})()
    monkeypatch.setattr(app, "SANDBOX_BACKEND", backend)
    assert app.healthz()["sandbox_slots_auto_off"] == [2]


def test_the_thread_pool_holds_more_calls_in_flight_than_anyios_default_forty():
    """Sandbox MCP calls and sync endpoints block a worker thread on the E2B host each; at anyio's default of 40 the
    41st waited for a thread while the host had room. The lifespan raises the limit to THREADPOOL_TOKENS."""
    import asyncio

    import anyio.to_thread

    async def widened() -> float:
        app._widen_thread_pool()
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    assert app.THREADPOOL_TOKENS > 40
    assert asyncio.run(widened()) == app.THREADPOOL_TOKENS


def test_healthz_names_the_run_code_pause_window_chat_must_match():
    assert app.healthz()["sandbox_run_code_idle_s"] == app.E2B_RUN_CODE_IDLE_SECS
