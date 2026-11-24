"""What isolates the agent's work, as config and /healthz state it. Every deploy runs the E2B backend while
the image still bakes AGENT_SANDBOX=bwrap, and /healthz reports the backend in use, not the baked value."""
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



def test_the_docker_backend_refuses_to_boot_without_its_config_or_on_the_raw_socket():
    """The docker backend reaches Docker only through the socket proxy, so a DOCKER_HOST naming the
    socket itself is a refusal at start, as is any missing setting."""
    base = {k: v for k, v in os.environ.items() if not k.startswith(("DOCKER_", "AGENT_SANDBOX"))}
    base.update(AGENT_DB_PATH=":memory:", AGENT_WATCHDOG_SECS="0", AGENT_SANDBOX_BACKEND="docker")
    cases = [({}, "AGENT_SANDBOX_BACKEND=docker needs"),
             ({"DOCKER_HOST": "unix:///var/run/docker.sock", "AGENT_SANDBOX_IMAGE": "x@sha256:" + "a" * 64,
               "AGENT_GATEWAY_PUBLIC_URL": "http://gateway:8732", "AGENT_SANDBOX_GATEWAY_CONTAINER": "gw",
               "PROXY_ADMIN_KEY": "k"}, "never a socket")]
    for extra, said in cases:
        r = subprocess.run([sys.executable, "-c", "import app"], cwd=Path(__file__).resolve().parent,
                           env={**base, **extra}, capture_output=True, text=True, timeout=120)
        assert r.returncode != 0
        assert said in r.stderr, r.stderr[-2000:]

# The bwrap profile's knobs. They configure nothing under E2B, so the tracked env leaves them out.
BWRAP_PROFILE_KEYS = {"AGENT_SANDBOX", "AGENT_SANDBOX_REQUIRED", "AGENT_RLIMITS", "AGENT_RLIMIT_NPROC",
                      "AGENT_RLIMIT_FSIZE", "AGENT_TMPFS_BYTES"}


def test_the_tracked_agent_env_sets_no_bwrap_profile_knob():
    import tomllib
    env = tomllib.loads((ROOT / "deploy" / "env" / "agent.toml").read_text())["env"]
    assert not BWRAP_PROFILE_KEYS & set(env), BWRAP_PROFILE_KEYS & set(env)


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


def test_session_workdirs_and_the_task_db_live_on_the_persistent_volume_so_a_restarted_host_keeps_them():
    """On the container's own filesystem a restart or deploy drops every session workdir, and the next
    follow-up is told its session expired. The host mounts its /data volume into the agent container, and the
    scratch root and the task DB have to sit under that mount."""
    import re
    import tomllib
    env = tomllib.loads((ROOT / "deploy" / "env" / "agent.toml").read_text())["env"]
    host_setup = (ROOT / "deploy" / "aws" / "agent" / "host-setup.sh.tftpl").read_text()
    agent_run = host_setup[host_setup.index('%{ if role == "agent"'):]
    agent_run = agent_run[:agent_run.index("%{ else")]
    mounts = re.findall(r"-v\s+(/\S+?):(/\S+?)(?::\S+)?\s", agent_run)
    assert mounts, "the agent container runs with no bind mount, so nothing survives a restart"
    # Each mount's host side must be a volume the host mounts at boot (fstab), not the root disk's dir.
    fstab_mounts = set(re.findall(r"LABEL=\S+ (/\S+) ", host_setup))
    dests = [dest.rstrip("/") for src, dest in mounts if src.rstrip("/") in fstab_mounts]
    assert dests, (mounts, fstab_mounts)
    scratch = env.get("AGENT_SCRATCH_ROOT", "").rstrip("/")
    assert any(scratch == d or scratch.startswith(d + "/") for d in dests), (scratch, dests)
    db_dir = os.path.dirname(env["AGENT_DB_PATH"])
    assert any(db_dir == d or db_dir.startswith(d + "/") for d in dests), (db_dir, dests)
    assert scratch == db_dir or scratch.startswith(db_dir + "/"), \
        "entrypoint.sh chowns only the DB dir to the server's uid, so the scratch root must sit inside it"
