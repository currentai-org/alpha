"""The sandbox's MCP face (CUR-4232), through the real app: auth, the bwrap box, no network, no secrets.

Each test speaks JSON-RPC to `/mcp/` the way chat's client does (stateless, each reply an SSE stream). The box tests
need bwrap and skip without it; CI installs it (agent-service-ci.yml).
"""

import contextlib
import json
import shutil

import app
import pytest
import sandbox_mcp
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount

needs_bwrap = pytest.mark.skipif(shutil.which("bwrap") is None, reason="bwrap not installed")

HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
    "x-agent-session": "conv-1",
}


@pytest.fixture(scope="module")
def _shared():
    # The app's own lifespan closes the module-wide store on exit, and the SDK's session manager runs once
    # per instance, so the module shares one client whose lifespan enters only the MCP transport.
    @contextlib.asynccontextmanager
    async def mcp_only(_):
        async with app._SANDBOX_MCP.session_manager.run():
            yield
    with TestClient(Starlette(routes=[Mount("/", app.app)], lifespan=mcp_only)) as tc:
        yield tc


@pytest.fixture
def client(_shared, monkeypatch):
    monkeypatch.setattr(app, "SANDBOX", "bwrap")
    monkeypatch.setattr(app, "AUTH_DISABLED", True)
    # prlimit's --nproc counts every process of the uid; a developer desktop runs more than the box allows.
    monkeypatch.setattr(app, "RLIMIT_ENABLED", False)
    # The prefix re-binds the Hermes install, which a dev box may not have; any real binary stands in.
    monkeypatch.setattr(app, "HERMES_BIN", shutil.which("python3") or "/usr/bin/python3")
    return _shared


def messages(r):
    """Every JSON-RPC message in a reply: the SSE stream's `data:` lines, or a plain JSON body."""
    if r.headers.get("content-type", "").startswith("application/json"):
        return [r.json()]
    return [json.loads(line[5:]) for line in r.text.splitlines() if line.startswith("data:") and line[5:].strip()]


def rpc(r):
    """The reply's response: the one message carrying an id."""
    return next(m for m in messages(r) if "id" in m)


def call(tc, name, arguments, headers=HEADERS):
    r = tc.post("/mcp/", headers=headers, json={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments},
    })
    assert r.status_code == 200, r.text
    result = rpc(r)["result"]
    return result["isError"], result["content"][0]["text"]


def test_lists_five_tools_and_marks_only_reads_read_only(client):
    r = client.post("/mcp/", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = {t["name"]: t for t in rpc(r)["result"]["tools"]}
    assert set(tools) == {"run_code", "run_command", "read_file", "write_file", "list_files"}
    read_only = {n for n, t in tools.items() if t.get("annotations", {}).get("readOnlyHint")}
    # chat asks before any tool without readOnlyHint (web mcp/serverTools.ts isReadOnly)
    assert read_only == {"read_file", "list_files"}


def test_refuses_a_request_without_a_bearer_token(client, monkeypatch):
    monkeypatch.setattr(app, "AUTH_DISABLED", False)
    r = client.post("/mcp/", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401


def test_refuses_a_guest_when_the_deployment_requires_an_account(client, monkeypatch):
    """CUR-4402: with AGENT_REQUIRE_ACCOUNT on, a call chat did not mark as a signed-in account is refused
    before the MCP transport reads it, and one it did mark gets through."""
    monkeypatch.setattr(app, "REQUIRE_ACCOUNT", True)
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    assert client.post("/mcp/", headers=HEADERS, json=body).status_code == 403
    assert client.post("/mcp/", headers={**HEADERS, "x-agent-account": "guest"}, json=body).status_code == 403
    r = client.post("/mcp/", headers={**HEADERS, "x-agent-account": "user"}, json=body)
    assert r.status_code == 200, r.text


@needs_bwrap
def test_run_code_returns_what_the_code_printed(client):
    is_error, text = call(client, "run_code", {"code": "from datetime import date\nprint((date(2026,10,28)-date(2026,10,20)).days)"})
    assert not is_error
    assert "exit code 0" in text and "stdout:\n8\n" in text


@needs_bwrap
def test_code_has_no_network_not_even_an_allowlisted_host(client):
    is_error, text = call(client, "run_command", {
        "command": "curl -sS -m 3 https://www.aipotluck.org >/dev/null && echo REACHED || echo BLOCKED; "
                   "curl -sS -m 3 http://1.1.1.1 >/dev/null && echo REACHED || echo BLOCKED",
    })
    assert not is_error
    assert "REACHED" not in text and text.count("BLOCKED") == 2


@needs_bwrap
def test_code_sees_no_service_secret(client, monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", "should-never-reach-the-box")
    monkeypatch.setenv("WEBUI_SECRET_KEY", "nor-this")
    _, text = call(client, "run_command", {"command": "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'"})
    assert "should-never-reach-the-box" not in text and "nor-this" not in text


@needs_bwrap
def test_a_file_written_by_code_is_read_back_in_a_later_call(client):
    call(client, "run_code", {"code": "open('answer.txt','w').write('16 days')"})
    is_error, text = call(client, "read_file", {"path": "answer.txt"})
    assert not is_error and text == "16 days"
    _, listing = call(client, "list_files", {})
    assert "answer.txt" in listing


def test_listing_or_reading_a_fresh_conversation_starts_no_sandbox(client, monkeypatch):
    """CUR-4502: on E2B a connect is a microVM held for minutes; a read with nothing to read needs none."""
    made = []
    monkeypatch.setattr(app.SANDBOX_BACKEND, "connect", lambda *a, **k: made.append(a))
    fresh = {**HEADERS, "x-agent-session": "conv-never-used"}
    is_error, listing = call(client, "list_files", {}, headers=fresh)
    assert not is_error and listing == "The workspace is empty."
    is_error, text = call(client, "read_file", {"path": "notes.txt"}, headers=fresh)
    assert is_error and "not a file" in text
    assert made == [], "a read-only tool created a sandbox"


@needs_bwrap
def test_two_conversations_do_not_share_a_workspace(client):
    call(client, "write_file", {"path": "mine.txt", "content": "conv-1"})
    other = {**HEADERS, "x-agent-session": "conv-2"}
    is_error, text = call(client, "read_file", {"path": "mine.txt"}, headers=other)
    assert is_error and "not a file" in text


def test_paths_outside_the_workspace_are_refused(client):
    for path in ("../../etc/passwd", "/etc/passwd"):
        is_error, text = call(client, "read_file", {"path": path})
        assert is_error and "outside the workspace" in text


def test_a_call_without_a_conversation_is_refused(client):
    headers = {k: v for k, v in HEADERS.items() if k != "x-agent-session"}
    is_error, text = call(client, "list_files", {}, headers=headers)
    assert is_error and "X-Agent-Session" in text


def test_refuses_to_run_when_the_deployment_has_no_sandbox(client, monkeypatch):
    monkeypatch.setattr(app, "SANDBOX", "off")
    is_error, text = call(client, "run_code", {"code": "print(1)"})
    assert is_error and "sandbox is off" in text


def test_confine_refuses_a_symlink_that_points_out(tmp_path):
    (tmp_path / "out").symlink_to("/etc")
    with pytest.raises(sandbox_mcp.SandboxRefused):
        sandbox_mcp.confine(str(tmp_path), "out/passwd")


def test_result_text_is_json_safe():
    # The reply goes back inside a JSON-RPC body; a clipped run must still serialise.
    json.dumps(sandbox_mcp._clip("x" * 10_000))


def test_a_call_on_the_wrong_machine_is_replayed_to_the_conversations_home(client, monkeypatch):
    # Chat pins none of its sandbox calls, so the server sends each conversation to one machine. (CUR-4435)
    import home_machine
    ids = ("m-aaaa", "m-bbbb")
    home = home_machine.home_for("conv-1", ids)
    monkeypatch.setattr(home_machine, "machine_ids", lambda *a, **k: ids)
    monkeypatch.setattr(app, "FLY_MACHINE_ID", next(m for m in ids if m != home))
    r = client.post("/mcp/", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 204
    assert r.headers["fly-replay"] == f"prefer_instance={home}"
    monkeypatch.setattr(app, "FLY_MACHINE_ID", home)
    r = client.post("/mcp/", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 200


def test_a_run_waiting_on_a_full_host_sends_the_wait_as_progress_before_its_result():
    """CUR-4584: connect tells the tool it is waiting for a slot; chat hears that as MCP progress on the same call,
    ahead of the result, which is what lets its live line say so while the call is still pending."""
    from sandbox_backend import SANDBOX_WAIT_TEXT, ExecResult, Handle

    class Waiting:
        name = "fake"

        def connect(self, principal, conversation, tier, *, on_wait=None, cancelled=None):
            on_wait(SANDBOX_WAIT_TEXT)
            return Handle(key="k", tier=tier)

        def list(self, h, limit):
            return []

        def exec(self, h, argv, timeout, *, stdin=None):
            return ExecResult("42\n", "", 0, 3)

    server = sandbox_mcp.build_sandbox_server(backend=Waiting(), sandbox_on=lambda: True,
                                              principal_for=lambda _a, _s: "alice", log_event=lambda *_a, **_k: None)

    @contextlib.asynccontextmanager
    async def lifespan(_):
        async with server.session_manager.run():
            yield
    with TestClient(Starlette(routes=[Mount("/mcp", sandbox_mcp.sandbox_http_app(server))], lifespan=lifespan)) as tc:
        r = tc.post("/mcp/", headers=HEADERS, json={
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "run_code", "arguments": {"code": "print(42)"}, "_meta": {"progressToken": "p-1"}},
        })
    assert r.status_code == 200, r.text
    msgs = messages(r)
    progress = [m for m in msgs if m.get("method") == "notifications/progress"]
    assert [(p["params"]["progressToken"], p["params"]["message"]) for p in progress] == [("p-1", SANDBOX_WAIT_TEXT)]
    result = rpc(r)
    assert msgs.index(progress[0]) < msgs.index(result)
    assert result["result"]["isError"] is False and "42" in result["result"]["content"][0]["text"]
