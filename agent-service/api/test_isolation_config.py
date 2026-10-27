"""What isolates the agent's work, as config and /healthz state it. Every Fly deploy runs the E2B backend while
the image still bakes AGENT_SANDBOX=bwrap, so /healthz must report the backend in use, not `"sandbox": "bwrap"`."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import app

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Remote:
    name = "e2b"


def test_healthz_under_e2b_does_not_report_bwrap_isolation(monkeypatch):
    # The deployed state: the image's AGENT_SANDBOX=bwrap left in place, the work on E2B.
    monkeypatch.setattr(app, "SANDBOX", "bwrap")
    monkeypatch.setattr(app, "SANDBOX_BACKEND", _Remote())
    h = app.healthz()
    assert h["sandbox"] == "e2b" and h["sandbox_backend"] == "e2b"
    for field in ("sandbox", "sandbox_seccomp", "rlimits"):
        assert "bwrap" not in str(h[field]) and "nproc=" not in str(h[field]), (field, h[field])


def test_healthz_under_bwrap_still_reports_the_profile(monkeypatch):
    monkeypatch.setattr(app, "SANDBOX", "bwrap")
    h = app.healthz()
    assert app.SANDBOX_BACKEND.name == "bwrap"
    assert h["sandbox"] == "bwrap" and h["rlimits"].startswith(("nproc=", "OFF"))
    monkeypatch.setattr(app, "SANDBOX", "off")
    assert app.healthz()["sandbox"] == "OFF(no fs isolation)"


def test_run_code_stays_on_under_e2b_with_the_bwrap_profile_unset(monkeypatch):
    """The run-code tools were gated on AGENT_SANDBOX == "bwrap", so dropping that knob from an E2B deploy
    would have refused every run_code call with "the sandbox is off" while a microVM sat ready."""
    monkeypatch.setattr(app, "SANDBOX", "off")
    monkeypatch.setattr(app, "SANDBOX_BACKEND", _Remote())
    assert app._work_isolated()


def test_run_code_refused_on_the_host_runner_without_the_bwrap_profile(monkeypatch):
    monkeypatch.setattr(app, "SANDBOX", "off")
    assert app.SANDBOX_BACKEND.name == "bwrap" and not app._work_isolated()
    monkeypatch.setattr(app, "SANDBOX", "bwrap")
    assert app._work_isolated()


def test_an_unset_backend_boots_as_e2b_and_refuses_without_its_config():
    env = {k: v for k, v in os.environ.items()
           if k != "AGENT_SANDBOX_BACKEND" and not k.startswith("E2B_") and k != "AGENT_GATEWAY_PUBLIC_URL"}
    env.update(AGENT_DB_PATH=":memory:", AGENT_WATCHDOG_SECS="0")
    r = subprocess.run([sys.executable, "-c", "import app"], cwd=Path(__file__).resolve().parent, env=env,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode != 0
    assert "AGENT_SANDBOX_BACKEND=e2b needs" in r.stderr, r.stderr[-2000:]


def test_the_fly_template_sets_no_bwrap_profile_knob():
    import tomllib
    env = tomllib.loads((ROOT / "fly" / "agent-app.toml").read_text())["env"]
    drift = _load("check_toml_drift", ROOT / "scripts" / "check-toml-drift.py")
    assert not drift.RETIRED & set(env), drift.RETIRED & set(env)


def test_a_retired_key_left_in_the_deployed_copy_is_a_note_not_a_deploy_blocking_finding(tmp_path, monkeypatch):
    """CI rebuilds the deployed copies from repo secrets nobody can read back, so a key removed from the tracked
    toml stays in them until someone rewrites the secret. That must not fail every deploy in the meantime."""
    drift = _load("check_toml_drift", ROOT / "scripts" / "check-toml-drift.py")
    (tmp_path / "agent-app.toml").write_text('[env]\n  AGENT_BEST_OF = "3"\n')
    (tmp_path / "agent-app.local.toml").write_text('[env]\n  AGENT_BEST_OF = "3"\n  AGENT_SANDBOX = "bwrap"\n')
    monkeypatch.setattr(drift, "FLY_DIR", tmp_path)
    findings, _ = drift.check_pair("agent-app.toml", "agent-app.local.toml")
    assert findings == []
    notes = drift.retired_leftovers("agent-app.local.toml")
    assert len(notes) == 1 and "AGENT_SANDBOX" in notes[0]
    # An unknown leftover is still a finding: only the retired list is allowed through.
    (tmp_path / "agent-app.local.toml").write_text('[env]\n  AGENT_BEST_OF = "3"\n  AGENT_SOMETHING = "1"\n')
    findings, _ = drift.check_pair("agent-app.toml", "agent-app.local.toml")
    assert len(findings) == 1 and "AGENT_SOMETHING" in findings[0]


def test_prodcheck_requires_the_bwrap_profile_only_where_bwrap_runs():
    pc = _load("prodcheck", ROOT / "eval" / "prodcheck.py")
    closed = {"AGENT_EGRESS": "allowlist", "AGENT_EGRESS_REQUIRED": "1", "AGENT_DNS": "hosts",
              "AGENT_DNS_REQUIRED": "1", "AGENT_MODERATION_DISABLED": "0"}
    assert pc._closed_problems(closed) == [], "an e2b surface (the default) needs no AGENT_SANDBOX"
    problems = pc._closed_problems({**closed, "AGENT_SANDBOX_BACKEND": "bwrap"})
    assert any("AGENT_SANDBOX is ABSENT" in p for p in problems)
    assert any("AGENT_SANDBOX_REQUIRED is ABSENT" in p for p in problems)
    # Under e2b the egress half is still required: it guards the machine the service runs on.
    assert any("AGENT_EGRESS" in p for p in pc._closed_problems({**closed, "AGENT_EGRESS": "off"}))
