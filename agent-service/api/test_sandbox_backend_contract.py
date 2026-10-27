"""What every sandbox backend must do, whichever one runs it (CUR-4438).

The same cases run against each backend: bwrap here and in CI, the other backends against a live account
with `SANDBOX_CONTRACT_BACKEND=e2b|agentsandbox` (CUR-4434). A backend that passes them can serve chat's
run-code tools; the stdio cases are what agent mode's ACP session to Hermes needs (CUR-4450).
"""

import asyncio
import os
import shutil
import tempfile
import uuid

import app
import pytest
from sandbox_backend import BwrapBackend, SandboxError, Tier

BACKEND = os.environ.get("SANDBOX_CONTRACT_BACKEND", "bwrap")
SECRET = "contract-secret-should-never-reach-the-box"


def _bwrap(tmp_path, monkeypatch):
    if shutil.which("bwrap") is None:
        pytest.skip("bwrap not installed")
    # The same allowances test_sandbox_mcp.py makes for a developer desktop.
    monkeypatch.setattr(app, "SANDBOX", "bwrap")
    monkeypatch.setattr(app, "RLIMIT_ENABLED", False)
    monkeypatch.setattr(app, "HERMES_BIN", shutil.which("python3") or "/usr/bin/python3")
    dirs: dict[tuple[str, str], str] = {}

    def workdir_for(principal: str, conversation: str) -> str:
        work = dirs.get((principal, conversation))
        if work is None or not os.path.isdir(work):
            work = dirs[(principal, conversation)] = tempfile.mkdtemp(dir=tmp_path)
        return work

    def existing_workdir(principal: str, conversation: str) -> str | None:
        work = dirs.get((principal, conversation))
        return work if work and os.path.isdir(work) else None

    return BwrapBackend(sandbox_prefix=app._sandbox_prefix, workdir_for=workdir_for,
                        existing_workdir=existing_workdir)


def _e2b():
    """A live E2B install (CUR-4451): E2B_API_URL, E2B_SANDBOX_URL and E2B_API_KEY name it, reached through a
    private link or port forward, not a public address. Each run's conversations are new keys,
    so a rerun never resumes an earlier run's sandboxes."""
    from sandbox_e2b import E2BBackend, E2BConfig

    url, key = os.environ.get("E2B_API_URL"), os.environ.get("E2B_API_KEY")
    if not (url and key):
        pytest.skip("E2B_API_URL and E2B_API_KEY name the install to test")
    cfg = E2BConfig(api_url=url, api_key=key, sandbox_url=os.environ.get("E2B_SANDBOX_URL", ""),
                    template=os.environ.get("E2B_TEMPLATE") or E2BConfig.template)
    return _FreshKeys(E2BBackend(cfg), uuid.uuid4().hex[:8])


class _FreshKeys:
    """Prefixes every principal with this run's id, so a live backend's sandboxes from an earlier run stay apart."""

    def __init__(self, inner, run: str):
        self._inner, self._run, self._made = inner, run, []

    def connect(self, principal, conversation, tier):
        h = self._inner.connect(f"{self._run}-{principal}", conversation, tier)
        self._made.append(h)
        return h

    def find(self, principal, conversation, tier):
        return self._inner.find(f"{self._run}-{principal}", conversation, tier)

    def close(self):
        """Kill every sandbox the test made: a live install's memory pool holds only a few at a time."""
        for h in self._made:
            try:
                self._inner.kill(h)
            except Exception:  # noqa: BLE001 — teardown tries every handle; one the test killed raises
                pass

    def __getattr__(self, name):
        return getattr(self._inner, name)


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", SECRET)
    if BACKEND == "bwrap":
        yield _bwrap(tmp_path, monkeypatch)
        return
    if BACKEND == "e2b":
        b = _e2b()
        yield b
        b.close()
        return
    pytest.skip(f"no contract fixture for backend {BACKEND!r} yet")
    yield  # unreachable: skip raises; keeps this a generator fixture


def sh(backend, h, command, timeout=10.0):
    return backend.exec(h, ["bash", "-c", command], timeout)


def test_a_file_written_in_one_call_is_there_in_the_next(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    assert sh(backend, h, "echo 16 days > answer.txt").code == 0
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    assert sh(backend, h, "cat answer.txt").stdout == "16 days\n"
    assert backend.read(h, "answer.txt", 100) == b"16 days\n"
    assert ("answer.txt", 8) in backend.list(h, 50)


def test_find_on_a_conversation_never_used_makes_nothing(backend):
    """CUR-4502: listing or reading in a fresh conversation must not start a sandbox to say it is empty."""
    assert backend.find("alice", "conv-unseen", Tier.RUN_CODE) is None
    assert backend.find("alice", "conv-unseen", Tier.RUN_CODE) is None, "the first find created one"


def test_find_returns_the_workspace_a_connect_made(backend):
    h = backend.connect("alice", "conv-found", Tier.RUN_CODE)
    backend.write(h, "kept.txt", b"here")
    found = backend.find("alice", "conv-found", Tier.RUN_CODE)
    assert found is not None and backend.read(found, "kept.txt", 100) == b"here"


def test_two_conversations_never_see_each_others_files(backend):
    a = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    b = backend.connect("alice", "conv-2", Tier.RUN_CODE)
    c = backend.connect("bob", "conv-1", Tier.RUN_CODE)
    backend.write(a, "mine.txt", b"alice's")
    assert backend.list(b, 50) == [] and backend.list(c, 50) == []
    assert sh(backend, b, "cat mine.txt").code != 0
    assert a.key not in (b.key, c.key)


def test_run_code_tier_reaches_no_network(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    # Reached means an answer came back, any status included: E2B's egress proxy completes the TCP handshake and
    # then closes a denied connection, so a bare connect proves nothing. For cloud metadata, reached means a credential
    # path answered 200 after the IMDSv2 token dance. Inside Firecracker 169.254.169.254 is the VMM's own MMDS,
    # which issues a token but has no such path.
    code = (
        "import urllib.error, urllib.request as u\n"
        "try:\n"
        "    u.urlopen('http://1.1.1.1/', timeout=3); print('REACHED web')\n"
        "except urllib.error.HTTPError:\n"
        "    print('REACHED web')\n"
        "except Exception:\n"
        "    print('BLOCKED web')\n"
        "md = 'http://169.254.169.254/latest/'\n"
        "try:\n"
        "    t = u.urlopen(u.Request(md + 'api/token', method='PUT',\n"
        "                  headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'}), timeout=3).read().decode()\n"
        "    u.urlopen(u.Request(md + 'meta-data/iam/security-credentials/',\n"
        "              headers={'X-aws-ec2-metadata-token': t}), timeout=3); print('REACHED metadata')\n"
        "except Exception:\n"
        "    print('BLOCKED metadata')\n"
    )
    res = backend.exec(h, ["python3", "-"], 15, stdin=code)
    assert "REACHED" not in res.stdout and res.stdout.count("BLOCKED") == 2, res


def test_the_code_environment_holds_no_secret(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    res = sh(backend, h, "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'")
    assert SECRET not in res.stdout and "AGENT_SERVICE_TOKEN" not in res.stdout
    names = {line.split("=", 1)[0] for line in res.stdout.splitlines() if "=" in line}
    assert not any(n.endswith(("_KEY", "_TOKEN", "_SECRET")) for n in names), names


def test_a_path_outside_the_workspace_is_refused(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    for path in ("../escape.txt", "/etc/passwd", ""):
        with pytest.raises(SandboxError):
            backend.read(h, path, 100)
        with pytest.raises(SandboxError):
            backend.write(h, path or "", b"x")


def test_a_planted_symlink_is_not_followed_out(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    sh(backend, h, "ln -s /etc/passwd out; ln -s / root")
    for path in ("out", "root/etc/passwd"):
        with pytest.raises(SandboxError):
            backend.read(h, path, 100)
    with pytest.raises(SandboxError):
        backend.write(h, "root/tmp/planted", b"x")
    assert all(rel not in ("out", "root") for rel, _ in backend.list(h, 50))


def test_a_command_past_its_timeout_is_stopped(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    res = sh(backend, h, "echo started; sleep 30", timeout=1.5)
    assert res.timed_out and res.ms < 10_000


def test_files_survive_a_pause(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    backend.write(h, "kept.txt", b"kept")
    backend.pause(h)
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    assert backend.read(h, "kept.txt", 100) == b"kept"


def test_kill_leaves_an_empty_workspace_for_the_next_connect(backend):
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    backend.write(h, "gone.txt", b"gone")
    backend.kill(h)
    h = backend.connect("alice", "conv-1", Tier.RUN_CODE)
    assert backend.list(h, 50) == []


def _stdio_roundtrip(backend, h, argv, send: bytes):
    async def go():
        async with backend.open_stdio(h, argv, {}) as (reader, writer, proc):
            writer.write(send)
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), 10)
            return line, proc

    return asyncio.run(go())


def test_a_stdio_process_answers_what_it_is_sent(backend):
    """CUR-4450: agent mode's ACP session to Hermes runs over these two streams."""
    h = backend.connect("alice", "stdio-echo", Tier.AGENT)
    line, _ = _stdio_roundtrip(
        backend, h, ["python3", "-c", "import sys; print(sys.stdin.readline().upper(), end='', flush=True)"], b"ping\n"
    )
    assert line == b"PING\n"


def test_a_stdio_process_runs_in_the_conversation_workspace(backend):
    h = backend.connect("alice", "stdio-cwd", Tier.AGENT)
    backend.write(h, "marker.txt", b"here")
    line, _ = _stdio_roundtrip(
        backend,
        h,
        ["python3", "-c", "import sys; sys.stdin.readline(); print(open('marker.txt').read(), flush=True)"],
        b"go\n",
    )
    assert line == b"here\n"


def test_a_stdio_process_is_gone_once_the_session_closes(backend):
    h = backend.connect("alice", "stdio-reap", Tier.AGENT)
    _, proc = _stdio_roundtrip(
        backend,
        h,
        ["python3", "-c", "import sys, time; print(sys.stdin.readline(), end='', flush=True); time.sleep(60)"],
        b"hi\n",
    )
    assert proc.returncode is not None
