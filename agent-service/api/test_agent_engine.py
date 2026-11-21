"""AGENT_ENGINE: which engine drives an agent-mode attempt over ACP, Hermes (the default) or Kilo.

The switch is temporary, for the move to Kilo, and is removed when Kilo becomes the only engine. These tests pin
what it must and must not do: unset, an attempt launches Hermes exactly as before; set to kilo, `_acp_run` drives
a Kilo ACP session to completion, answers permissions only ever with `allow_once` or a reject, refuses to start
when the Kilo binary is missing (locally or in the sandbox), and keeps Kilo's control password away from the
agent's own shell. The Kilo session here is a recorded fake speaking real ACP over a pipe: no model, no sandbox.
"""
import asyncio
import contextlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import acp
import acp_client
import app
import pytest
from acp.schema import (
    AgentCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
)
from sandbox_backend import ExecResult, Handle, Tier

_GW = {"HF_TOKEN": "task-nonce", "HF_BASE_URL": "https://gw.example/v1"}
_API = Path(__file__).resolve().parent


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, 20))


class _StopBeforeSpawn(Exception):
    pass


def _task(**kw):
    return types.SimpleNamespace(id="t", _canceled=False, unrun_detail="", _acp_cancel=None, _acp_confirm=None,
                                 _confirm_wait_secs=0.0, **kw)


# --------------------------------------------------------------------------- the switch itself
def _import_app(**env) -> subprocess.CompletedProcess:
    full = {k: v for k, v in os.environ.items() if k not in ("AGENT_ENGINE", "AGENT_ACP")}
    full.update(env)
    return subprocess.run([sys.executable, "-c", "import app; print(app.AGENT_ENGINE)"], cwd=_API, env=full,
                          capture_output=True, text=True, timeout=120, check=False)


def test_with_agent_engine_unset_the_service_picks_hermes():
    r = _import_app()
    assert r.returncode == 0, r.stderr[-2000:]
    assert r.stdout.strip() == "hermes"


@pytest.mark.parametrize(("env", "says"), [({"AGENT_ENGINE": "kilocode", "AGENT_ACP": "1"}, "expected 'hermes'"),
                                           ({"AGENT_ENGINE": "kilo"}, "needs AGENT_ACP=1")])
def test_an_engine_the_service_cannot_run_refuses_to_start_instead_of_falling_back(env, says):
    """A typo, or Kilo without ACP (the only transport Kilo has), would otherwise run Hermes under a deploy that
    chose Kilo, and nothing would say so."""
    r = _import_app(**env)
    assert r.returncode != 0
    assert says in r.stderr


def test_with_agent_engine_unset_healthz_has_no_engine_field():
    """Unset, /healthz reports exactly the fields it did before the switch existed."""
    assert app._AGENT_ENGINE_RAW == ""
    assert "engine" not in app.healthz()


def _kwargs_passed_by_execute_attempt(monkeypatch, tmp_path) -> dict:
    seen = {}

    async def _fake_acp_run(*a, **kw):
        seen.update(kw)
        return "", None, 0

    monkeypatch.setattr(acp_client, "_acp_run", _fake_acp_run)
    t = app.Task(id="engine-t", prompt="hi", user="dev-bypass-user")
    app._execute_attempt(t, work=str(tmp_path), attempt_home=str(tmp_path / "hermes-home-engine-t-1"),
                         attempt_prompt="hi", attempts=1, nonce=None, timeout_secs=30.0, buf=None, sandbox=[],
                         use_acp=True, decision={"policy": "allow", "tier": "uniform"}, verify_check=None,
                         repair_check=None, tool_kinds=set(), tool_failures=set())
    return seen


def test_with_agent_engine_unset_an_attempt_passes_nothing_new_to_the_acp_client(monkeypatch, tmp_path):
    """Production runs with AGENT_ENGINE unset, so its attempts must reach `_acp_run` with the same arguments as
    before the switch: the Hermes binary, and no engine, kilo_bin or agent_home."""
    kw = _kwargs_passed_by_execute_attempt(monkeypatch, tmp_path)
    assert kw["hermes_bin"] == app.HERMES_BIN
    assert not {"engine", "kilo_bin", "agent_home"} & set(kw)


def test_with_agent_engine_kilo_an_attempt_asks_the_acp_client_for_kilo(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "AGENT_ENGINE", "kilo")
    monkeypatch.setattr(app, "KILO_BIN", "/opt/kilo/kilo")
    kw = _kwargs_passed_by_execute_attempt(monkeypatch, tmp_path)
    assert (kw["engine"], kw["kilo_bin"]) == ("kilo", "/opt/kilo/kilo")
    assert kw["agent_home"] == str(tmp_path / "hermes-home-engine-t-1")


def test_the_hermes_launch_is_unchanged_when_no_engine_is_named(tmp_path, monkeypatch):
    """`_acp_run` called the way production calls it: `hermes acp --accept-hooks`, the caller's env as given, a
    Hermes config.yaml written, and no Kilo config anywhere."""
    seen = {}

    @contextlib.asynccontextmanager
    async def open_stdio(argv, env):
        seen["argv"], seen["env"] = argv, env
        raise _StopBeforeSpawn
        yield  # pragma: no cover

    home = tmp_path / "hermes-home"
    home.mkdir()
    with contextlib.suppress(_StopBeforeSpawn):
        _run(acp_client._acp_run(str(tmp_path), str(home), "p", None, 30, None, _task(), sandbox_prefix=[],
                                 hermes_bin="hermes", model_env={"X": "1"}, model="org/Model-X",
                                 provider="huggingface", attempt=1, open_stdio=open_stdio))
    assert seen == {"argv": ["hermes", "acp", "--accept-hooks"], "env": {"X": "1"}}
    assert (home / "config.yaml").exists()
    assert not (home / "config" / "kilo").exists()


# --------------------------------------------------------------------------- a recorded Kilo session
def _pipe(loop):
    rfd, wfd = os.pipe()
    reader = asyncio.StreamReader(limit=1 << 20)

    async def wire():
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(rfd, "rb"))
        transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, os.fdopen(wfd, "wb"))
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop), transport
    return wire()


# The options Kilo offers on every permission request (kilocode packages/opencode/src/acp/permission.ts), with
# "always" FIRST, where a first-allow-wins picker would take it.
_KILO_OPTIONS = [PermissionOption(option_id="always", name="Always allow", kind="allow_always"),
                 PermissionOption(option_id="once", name="Allow once", kind="allow_once"),
                 PermissionOption(option_id="reject", name="Reject", kind="reject_once")]


class _RecordedKilo:
    """What `kilo acp` sends for one task that runs one shell command: the tool call, a permission request for
    it, progress while it runs, its completion, then the answer. Records what our client sent back."""

    def __init__(self):
        self.answers: list[str] = []
        self.client_fs = None
        self.cwd = None
        self._conn = None

    def on_connect(self, conn):
        self._conn = conn

    async def initialize(self, protocol_version, client_capabilities=None, client_info=None, **_):
        self.client_fs = client_capabilities.fs if client_capabilities else None
        return InitializeResponse(protocol_version=protocol_version, agent_capabilities=AgentCapabilities(),
                                  agent_info=Implementation(name="kilo", version="7.8.27"))

    async def new_session(self, cwd, mcp_servers=None, **_):
        self.cwd = cwd
        return NewSessionResponse(session_id="ses_1")

    async def prompt(self, prompt, session_id, **_):
        conn = self._conn
        call = acp.start_tool_call("call_1", "bash", kind="execute", status="pending",
                                   raw_input={"command": "echo hi > a.txt"})
        await conn.session_update(session_id, call)
        resp = await conn.request_permission(session_id=session_id, options=_KILO_OPTIONS,
                                             tool_call=acp.update_tool_call("call_1", kind="execute",
                                                                            raw_input={"command": "echo hi > a.txt"}))
        self.answers.append(getattr(resp.outcome, "option_id", resp.outcome.outcome))
        await conn.session_update(session_id, acp.update_tool_call("call_1", status="in_progress"))
        await conn.session_update(session_id, acp.update_tool_call("call_1", status="completed"))
        await conn.session_update(session_id, acp.update_agent_message_text("Wrote a.txt."))
        return PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id, **_):
        pass


class _Buf:
    def __init__(self):
        self.frames = []

    def emit(self, etype, data):
        self.frames.append((etype, data))


def _drive_recorded_kilo(tmp_path, *, answer="allow"):
    guest, seen, buf = _RecordedKilo(), {}, _Buf()

    @contextlib.asynccontextmanager
    async def open_stdio(argv, env):
        seen["argv"], seen["env"] = argv, env
        loop = asyncio.get_running_loop()
        to_guest_r, to_guest_w, t1 = await _pipe(loop)
        to_host_r, to_host_w, t2 = await _pipe(loop)
        task = loop.create_task(acp.run_agent(guest, to_host_w, to_guest_r))  # pyright: ignore[reportArgumentType]
        try:
            yield to_host_r, to_guest_w, types.SimpleNamespace(stderr=asyncio.StreamReader(), returncode=0)
        finally:
            task.cancel()
            t1.close()
            t2.close()

    task = _task()
    cards = []

    def on_open(desc):
        cards.append(desc)
        asyncio.get_running_loop().call_later(0.05, task._acp_confirm, desc["confirm_id"], answer)

    home = tmp_path / "hermes-home-t-1"
    home.mkdir()
    text, stop, ret = _run(acp_client._acp_run(
        str(tmp_path), str(home), "write a.txt", None, 10, buf, task, sandbox_prefix=[], hermes_bin="hermes",
        model_env=dict(_GW), model="mistral-large-2610", provider="", attempt=1, open_stdio=open_stdio,
        session_cwd="/home/user/work", engine="kilo", kilo_bin="kilo", agent_home="/home/user/work/hermes-home-t-1",
        permission_policy="allow", confirm_timeout_secs=5, on_confirmation_open=on_open,
        on_confirmation_close=lambda cid: None))
    return types.SimpleNamespace(text=text, stop=stop, ret=ret, guest=guest, seen=seen, buf=buf, cards=cards,
                                 home=home)


def test_the_kilo_engine_drives_a_recorded_session_to_completion(tmp_path):
    r = _drive_recorded_kilo(tmp_path)
    assert (r.text, r.stop, r.ret) == ("Wrote a.txt.", "end_turn", 0)
    assert r.seen["argv"] == ["kilo", "acp", "--pure"]
    env = r.seen["env"]
    assert env["HOME"] == "/home/user/work/hermes-home-t-1"           # the guest's path, not this machine's
    assert env["KILO_DISABLE_PROJECT_CONFIG"] == "1" and len(env["KILO_SERVER_PASSWORD"]) == 32
    assert env["HF_TOKEN"] == "task-nonce"
    cfg = json.loads((r.home / "config" / "kilo" / "kilo.json").read_text())
    assert cfg["model"] == "potluck/mistral-large-2610"
    assert cfg["provider"]["potluck"]["options"]["baseURL"] == "https://gw.example/v1"
    assert not (r.home / "config.yaml").exists(), "no Hermes config on a Kilo attempt"
    assert r.guest.cwd == "/home/user/work"
    assert (r.guest.client_fs.read_text_file, r.guest.client_fs.write_text_file) == (False, False)
    # the shell call went to a person, who allowed it; the answer Kilo got was "once"
    assert [c["summary"] for c in r.cards] == ["echo hi > a.txt"]
    assert r.guest.answers == ["once"]
    # Kilo's in-progress update is not a result: one tool_result for the call, and it succeeded
    assert [d["ok"] for t, d in r.buf.frames if t == "tool_result"] == [True]


def test_a_shell_call_the_person_denies_on_kilo_is_answered_with_a_reject(tmp_path):
    r = _drive_recorded_kilo(tmp_path, answer="deny")
    assert r.guest.answers == ["reject"]


# --------------------------------------------------------------------------- permission answers
def _kilo_client(tmp_path, **kw):
    c = acp_client._AgentClient(str(tmp_path), _Buf(), 1, engine="kilo", confirm_timeout_secs=0.2, **kw)
    return c


def _call(kind, **kw):
    return types.SimpleNamespace(kind=kind, title=kind, content=kw.get("content"), raw_input=kw.get("raw_input"))


def _answer_with(c, decision):
    def on_open(desc):
        asyncio.get_running_loop().call_soon(lambda: c._pending_confirms[desc["confirm_id"]].set_result(decision))
    c.on_confirmation_open = on_open


@pytest.mark.parametrize("case", ["person_allows_shell", "person_allows_unknown_tool", "auto_allows_in_folder_edit",
                                  "person_denies", "nobody_answers", "deny_writes", "auto_reviewer_runs"])
def test_on_kilo_every_permission_answer_is_allow_once_or_a_reject_never_allow_always(tmp_path, case):
    """Kilo stores an `allow_always` reply as a session rule and stops asking, so a later call would pass our
    approval cards unseen. Whatever decided the call, a person, auto mode or policy, the option sent is
    `allow_once` for a yes and a reject for a no."""
    async def reviewer(action):
        return {"decision": "run", "plain": "Runs a harmless command."}

    kw = {"deny_writes": {"permission_policy": "deny_writes"},
          "auto_allows_in_folder_edit": {"approval_mode": "auto"},
          "auto_reviewer_runs": {"approval_mode": "auto", "auto_reviewer": reviewer}}.get(case, {})
    c = _kilo_client(tmp_path, **kw)
    if case in ("person_allows_shell", "person_allows_unknown_tool"):
        _answer_with(c, "allow")
    elif case == "person_denies":
        _answer_with(c, "deny")
    call = {"person_allows_unknown_tool": _call("other"),
            "auto_allows_in_folder_edit": _call("edit", content=[types.SimpleNamespace(
                type="diff", path=str(tmp_path / "budget.csv"), new_text="a,b")])}.get(
        case, _call("execute", raw_input={"command": "ls"}))
    resp = asyncio.run(c.request_permission(list(_KILO_OPTIONS), "s", call))
    allowed = case in ("person_allows_shell", "person_allows_unknown_tool", "auto_allows_in_folder_edit",
                       "auto_reviewer_runs")
    assert resp.outcome.option_id == ("once" if allowed else "reject")


def test_on_kilo_a_tool_kilo_cannot_name_goes_to_a_person_rather_than_being_allowed_by_policy(tmp_path):
    """Kilo sends a tool it has no kind for (an MCP tool, a tool a later release adds) as kind "other". Hermes
    never asked about those, so the Hermes rule lets them through under "allow"; on Kilo it is an `ask` rule
    that reached us, and a person decides."""
    c = _kilo_client(tmp_path)
    opened = []
    c.on_confirmation_open = opened.append
    resp = asyncio.run(c.request_permission(list(_KILO_OPTIONS), "s", _call("other")))
    assert len(opened) == 1
    assert resp.outcome.option_id == "reject", "unanswered, it fails closed"


def test_on_hermes_the_option_picker_is_the_one_it_always_was(tmp_path):
    """The Kilo picker is Kilo's only: Hermes' picker, untouched, still takes the first allow it is offered."""
    c = acp_client._AgentClient(str(tmp_path), None, 1)
    resp = asyncio.run(c.request_permission(list(_KILO_OPTIONS), "s", _call("read")))
    assert resp.outcome.option_id == "always"


# --------------------------------------------------------------------------- a missing Kilo binary
def _no_spawn(*_a, **_k):
    raise AssertionError("a Kilo process was started")


def test_a_kilo_binary_missing_here_fails_naming_it_before_anything_starts(tmp_path, monkeypatch):
    monkeypatch.setattr(acp_client.acp, "spawn_agent_process", _no_spawn)
    with pytest.raises(acp_client.KiloMissing, match="kilo-not-installed-here"):
        _run(acp_client._acp_run(str(tmp_path), str(tmp_path / "h"), "p", None, 30, None, _task(),
                                 sandbox_prefix=[], hermes_bin="hermes", model_env=dict(_GW), model="m",
                                 provider="", attempt=1, engine="kilo", kilo_bin="kilo-not-installed-here"))


class _FakeBackend:
    name = "e2b"

    def __init__(self, probe: ExecResult):
        self.probe, self.writes, self.launched = probe, {}, None

    def exec(self, h, argv, timeout, *, stdin=None):
        self.exec_argv = argv
        return self.probe

    def write(self, h, path, data):
        self.writes[path] = data

    @contextlib.asynccontextmanager
    async def open_stdio(self, h, argv, env):
        self.launched = (argv, env)
        raise _StopBeforeSpawn
        yield  # pragma: no cover


def _remote_kilo_attempt(tmp_path, monkeypatch, probe: ExecResult) -> _FakeBackend:
    backend = _FakeBackend(probe)
    monkeypatch.setattr(app, "SANDBOX_BACKEND", backend)
    h = Handle(key="k1", tier=Tier.AGENT, ref=None)
    home = tmp_path / "hermes-home-t-1"
    home.mkdir()
    with contextlib.suppress(_StopBeforeSpawn):
        _run(acp_client._acp_run(str(tmp_path), str(home), "p", "task-nonce", 30, None, _task(),
                                 sandbox_prefix=[], hermes_bin="hermes", model_env=dict(_GW), model="m",
                                 provider="", attempt=1, engine="kilo", kilo_bin="kilo",
                                 agent_home="/home/user/work/hermes-home-t-1",
                                 open_stdio=app._remote_kilo_opener(h, str(home), home.name)))
    return backend


def test_a_sandbox_template_without_kilo_fails_naming_it_and_never_launches(tmp_path, monkeypatch):
    """Until the sandbox template carries Kilo, a Kilo attempt there must fail at once with a reason, rather
    than start a command that exits 127 and leave the attempt to read a closed stream."""
    with pytest.raises(acp_client.KiloMissing, match=r"'kilo' is not on the guest's PATH.*sandbox template"):
        _remote_kilo_attempt(tmp_path, monkeypatch, ExecResult("", "", 1, 3))


def test_a_sandbox_with_kilo_gets_the_config_and_an_execed_launch(tmp_path, monkeypatch):
    """With Kilo in the guest, its config is copied in and the launch replaces envd's shell (`exec`), so no
    shell is left holding the control password in its environment."""
    backend = _remote_kilo_attempt(tmp_path, monkeypatch, ExecResult("/usr/local/bin/kilo\n", "", 0, 3))
    argv, env = backend.launched
    assert argv == ["exec", "kilo", "acp", "--pure"]
    assert set(backend.writes) == {"hermes-home-t-1/config/kilo/kilo.json"}
    assert env["XDG_CONFIG_HOME"] == "/home/user/work/hermes-home-t-1/config"


# --------------------------------------------------------------------------- the control password
def test_a_local_launch_refuses_a_kilo_binary_this_user_can_read(tmp_path, monkeypatch):
    """A readable executable leaves `kilo acp` dumpable, and then the agent's shell (same uid) reads the control
    password out of /proc/<kilo>/environ and approves its own calls. Refused before anything starts."""
    fake = tmp_path / "kilo"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setattr(acp_client.acp, "spawn_agent_process", _no_spawn)
    with pytest.raises(PermissionError, match="execute-only"):
        _run(acp_client._acp_run(str(tmp_path), str(tmp_path / "h"), "p", None, 30, None, _task(),
                                 sandbox_prefix=[], hermes_bin="hermes", model_env=dict(_GW), model="m",
                                 provider="", attempt=1, engine="kilo", kilo_bin=str(fake)))


def test_under_bwrap_the_control_password_reaches_kilo_by_descriptor_never_by_environment(tmp_path, monkeypatch):
    """bwrap stays in the sandbox as PID 1 with the environment it was launched with, readable from the agent's
    shell, so the password goes in through `--args` from a private file that is gone once the launch ends."""
    seen = {}

    def _spawn(client, command, *args, env=None, **_k):
        seen["argv"], seen["env"] = [command, *args], env
        path = args[args.index('exec "$@" 8<"$0"') + 1]
        seen["file"], seen["data"] = path, Path(path).read_bytes()
        raise _StopBeforeSpawn

    monkeypatch.setattr(acp_client.acp, "spawn_agent_process", _spawn)
    monkeypatch.setattr(acp_client, "_local_kilo", lambda b: "/opt/kilo/kilo")
    with contextlib.suppress(_StopBeforeSpawn):
        _run(acp_client._acp_run(str(tmp_path), str(tmp_path / "h"), "p", None, 30, None, _task(),
                                 sandbox_prefix=["/usr/bin/bwrap", "--die-with-parent"], hermes_bin="hermes",
                                 model_env=dict(_GW), model="m", provider="", attempt=1, engine="kilo"))
    argv = seen["argv"]
    assert "KILO_SERVER_PASSWORD" not in seen["env"]
    assert argv[argv.index("--die-with-parent") + 1:] == ["--args", "8", "/opt/kilo/kilo", "acp", "--pure"]
    key, password = seen["data"].split(b"\0")[1:3]
    assert key == b"KILO_SERVER_PASSWORD" and len(password) == 32
    assert password.decode() not in "\0".join(argv), "never on a command line /proc/<pid>/cmdline shows"
    assert not os.path.exists(seen["file"]), "the file is removed even when the launch fails"
