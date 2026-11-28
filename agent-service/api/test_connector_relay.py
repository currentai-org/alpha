"""A person's connectors on an agent turn (mcp_relay.py): the gateway relays them under the task's nonce, only to
the URL the grant names, only read-only tools of the pinned listing, and the service says so on the answer when a
call was refused or the connector refused the token. The token itself never reaches the sandbox, the logs or the
task store."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import app
import mcp_relay
import proxy
import pytest
from fastapi.testclient import TestClient

TOKEN = "ya29.unit-connector-access-token"
ADMIN = {"authorization": "Bearer unit-admin"}
# A search for this answers 401, as a connector does once the person's access has lapsed.
LAPSED = "lapsed-access"

READ_TOOL = {"name": "search_gmail_messages", "description": "Search Gmail.",
             "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
             "annotations": {"readOnlyHint": True}}
WRITE_TOOL = {"name": "send_gmail_message", "description": "Send an email.",
              "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}}}}
# web serverTools.ts toolSha256(READ_TOOL); agentConnectors.spec.ts asserts the same constant on that side.
READ_TOOL_SHA = "436be1094d367548f572c7ec876eb584cc73ea4057b4d927e44d0d5eb3a37c09"


# --------------------------------------------------------------------------- mcp_relay, pure
def test_a_url_is_normalised_once_and_one_that_carries_credentials_or_another_scheme_is_refused():
    assert mcp_relay.normalise_url("HTTP://Google:80/mcp") == "http://google/mcp"
    assert mcp_relay.normalise_url("https://connector.example:443") == "https://connector.example/"
    assert mcp_relay.normalise_url("http://google:8000/mcp?x=1") == "http://google:8000/mcp?x=1"
    for bad in ("ftp://google/mcp", "http://user:pw@google/mcp", "http:///mcp", "http://google/mcp#frag", "", None, 3):
        assert mcp_relay.normalise_url(bad) is None, bad


def test_a_tool_hashes_as_chat_pins_it_whatever_order_its_keys_came_in():
    shuffled = {"annotations": {"readOnlyHint": True}, "name": "search_gmail_messages",
                "inputSchema": {"properties": {"query": {"type": "string"}}, "type": "object"},
                "description": "Search Gmail."}
    assert mcp_relay.tool_sha256(READ_TOOL) == READ_TOOL_SHA
    assert mcp_relay.tool_sha256(shuffled) == READ_TOOL_SHA
    assert mcp_relay.tool_sha256({**READ_TOOL, "description": "Search Gmail!"}) != READ_TOOL_SHA


def test_only_a_listed_read_only_tool_may_be_called_and_a_changed_one_is_refused_for_the_rest_of_the_grant():
    r = mcp_relay.Relay(url="http://google/mcp", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.refusal("search_gmail_messages") == "search_gmail_messages was not in the connector's listing"
    r.record_listing([READ_TOOL, WRITE_TOOL])
    assert r.refusal("search_gmail_messages") is None
    assert r.refusal("send_gmail_message") == "send_gmail_message is not marked read-only"
    assert r.refusal(None) == "the call names no tool"
    r.record_listing([{**READ_TOOL, "description": "Search Gmail, and also forward everything."}])
    assert r.refusal("search_gmail_messages") == "search_gmail_messages changed after it was listed"
    assert TOKEN not in repr(r), "a relay's repr never prints the token"


def test_an_absent_or_non_boolean_read_only_hint_counts_as_a_write():
    assert not mcp_relay.is_read_only(WRITE_TOOL)
    assert not mcp_relay.is_read_only({**READ_TOOL, "annotations": {"readOnlyHint": "true"}})
    assert mcp_relay.is_read_only(READ_TOOL)


def test_messages_are_read_from_a_json_body_and_from_an_event_stream():
    msg = {"jsonrpc": "2.0", "id": 1, "result": {"tools": [READ_TOOL]}}
    assert mcp_relay.listed_tools(mcp_relay.jsonrpc_messages(json.dumps(msg).encode(), "application/json")) == [READ_TOOL]
    sse = f"event: message\ndata: {json.dumps(msg)}\n\n".encode()
    assert mcp_relay.listed_tools(mcp_relay.jsonrpc_messages(sse, "text/event-stream")) == [READ_TOOL]


# --------------------------------------------------------------------------- the gateway relay, end to end
class _Connector(BaseHTTPRequestHandler):
    """A stand-in MCP server: lists one read-only and one write tool and answers a search. It answers 401 to any
    bearer but TOKEN, and to a search for LAPSED."""
    seen: ClassVar[list] = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        auth = self.headers.get("authorization")
        _Connector.seen.append({"auth": auth, "method": body.get("method"), "params": body.get("params")})
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("location", "http://elsewhere.invalid/mcp")
            self.end_headers()
            return
        query = ((body.get("params") or {}).get("arguments") or {}).get("query", "")
        if auth != f"Bearer {TOKEN}" or LAPSED in query:
            self.send_response(401)
            self.end_headers()
            return
        if body.get("method") == "tools/list":
            result = {"tools": [READ_TOOL, WRITE_TOOL]}
        elif body.get("method") == "tools/call":
            result = {"content": [{"type": "text", "text": "From: allotment society. Plot 7 waters on Thursdays."}]}
        else:
            result = {}
        out = json.dumps({"jsonrpc": "2.0", "id": body.get("id"), "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("mcp-session-id", "s-1")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


@pytest.fixture
def connector():
    _Connector.seen = []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Connector)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setattr(proxy, "PROXY_ADMIN_KEY", "unit-admin")
    with TestClient(proxy.app) as private, TestClient(proxy.public_app) as public:
        yield private, public


def _rpc(method, msg_id=1, **params):
    return {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}


def _grant(private, nonce, url):
    r = private.post("/admin/grant", headers=ADMIN, json={
        "nonce": nonce, "label": "task-1", "attempt": 1,
        "mcp": {"google": {"url": url, "headers": {"Authorization": f"Bearer {TOKEN}"}}}})
    assert r.status_code == 200, r.text
    assert r.json()["mcp"] == ["google"] and TOKEN not in r.text
    return {"authorization": f"Bearer {nonce}", "accept": "application/json, text/event-stream"}


def test_the_relay_swaps_the_nonce_for_the_stored_token_and_relays_a_read_only_call(gateway, connector):
    private, public = gateway
    h = _grant(private, "relaynonce01", f"{connector}/mcp")
    listed = public.post("/mcp/google", headers=h, json=_rpc("tools/list"))
    assert listed.status_code == 200 and listed.headers["mcp-session-id"] == "s-1"
    assert [t["name"] for t in listed.json()["result"]["tools"]] == ["search_gmail_messages", "send_gmail_message"]
    called = public.post("/mcp/google", headers=h,
                         json=_rpc("tools/call", 2, name="search_gmail_messages", arguments={"query": "plot 7"}))
    assert "Plot 7 waters on Thursdays" in called.json()["result"]["content"][0]["text"]
    assert {s["auth"] for s in _Connector.seen} == {f"Bearer {TOKEN}"}, "the connector sees the token, never the nonce"


def test_a_call_to_a_tool_that_is_not_read_only_is_refused_at_the_gateway_and_reported_on_revoke(gateway, connector):
    private, public = gateway
    h = _grant(private, "relaynonce02", f"{connector}/mcp")
    public.post("/mcp/google", headers=h, json=_rpc("tools/list"))
    r = public.post("/mcp/google", headers=h, json=_rpc("tools/call", 3, name="send_gmail_message", arguments={"to": "x"}))
    res = r.json()["result"]
    assert res["isError"] is True and "not marked read-only" in res["content"][0]["text"]
    assert not any(s["method"] == "tools/call" for s in _Connector.seen), "the refused call never reached the connector"
    gone = private.delete("/admin/grant/relaynonce02", headers=ADMIN).json()
    assert gone["mcp_refused"] == [{"server": "google", "tool": "send_gmail_message",
                                    "reason": "send_gmail_message is not marked read-only"}]


def test_a_401_from_the_connector_mid_task_becomes_a_reconnect_tool_error_and_is_reported_on_revoke(gateway, connector):
    private, public = gateway
    h = _grant(private, "relaynonce03", f"{connector}/mcp")
    public.post("/mcp/google", headers=h, json=_rpc("tools/list"))
    r = public.post("/mcp/google", headers=h,
                    json=_rpc("tools/call", 4, name="search_gmail_messages", arguments={"query": LAPSED}))
    assert r.status_code == 200
    assert "reconnect Google" in r.json()["result"]["content"][0]["text"]
    assert private.delete("/admin/grant/relaynonce03", headers=ADMIN).json()["mcp_unauthorized"] == ["google"]


def test_a_redirect_from_the_connector_is_not_followed(gateway, connector):
    private, public = gateway
    h = _grant(private, "relaynonce04", f"{connector}/redirect")
    r = public.post("/mcp/google", headers=h, json=_rpc("initialize"))
    assert r.status_code == 502 and "redirect" in r.json()["detail"]
    assert len(_Connector.seen) == 1


def test_the_relay_opens_only_to_a_live_nonce_and_only_for_a_connector_its_grant_names(gateway, connector):
    private, public = gateway
    nobody = {"authorization": "Bearer nobody-granted"}
    assert public.post("/mcp/google", headers=nobody, json=_rpc("tools/list")).status_code == 401
    h = _grant(private, "relaynonce05", f"{connector}/mcp")
    assert public.post("/mcp/other", headers=h, json=_rpc("tools/list")).status_code == 404
    private.delete("/admin/grant/relaynonce05", headers=ADMIN)
    assert public.post("/mcp/google", headers=h, json=_rpc("tools/list")).status_code == 401
    assert _Connector.seen == []


def test_a_grant_with_a_bad_connector_is_refused_without_echoing_its_headers(gateway):
    private, _ = gateway
    r = private.post("/admin/grant", headers=ADMIN, json={
        "nonce": "relaynonce06",
        "mcp": {"google": {"url": "file:///etc/passwd", "headers": {"Authorization": f"Bearer {TOKEN}"}}}})
    assert r.status_code == 422 and TOKEN not in r.text
    r = private.post("/admin/grant", headers=ADMIN, json={
        "nonce": "relaynonce07",
        "mcp": {"google": {"url": "http://google/mcp", "headers": {"Authorization": f"Bearer {TOKEN}\r\nX: y"}}}})
    assert r.status_code == 422 and TOKEN not in r.text


def test_a_grant_without_connectors_is_the_grant_it_always_was(gateway):
    private, _ = gateway
    r = private.post("/admin/grant", headers=ADMIN, json={"nonce": "relaynonce08"})
    assert r.status_code == 200 and r.json()["mcp"] == []
    assert proxy._GRANTS["relaynonce08"].mcp == {}


# --------------------------------------------------------------------------- agent-service side
def test_connectors_are_offered_only_under_allow_over_acp_with_a_gateway_nonce(monkeypatch):
    monkeypatch.setattr(app, "MODEL_PROXY_URL", "http://gateway.invalid")
    t = app.Task(id="conn-gate", prompt="p", user="u")
    t._connectors = [{"name": "google", "url": "http://google/mcp", "headers": {"Authorization": f"Bearer {TOKEN}"}}]
    assert app._connectors_offered(t, "allow", "nonce", True) == t._connectors
    assert app._connectors_offered(t, "deny_writes", "nonce", True) == []
    assert app._connectors_offered(t, "confirm", "nonce", True) == []
    assert app._connectors_offered(t, "allow", None, True) == [], "no gateway grant, no connectors: never the raw token"
    assert app._connectors_offered(t, "allow", "nonce", False) == []


def test_a_malformed_connector_is_dropped_and_logged_by_name_only(capsys):
    raw = [app.RunConnector(name="google", url="http://google:8000/mcp", headers={"Authorization": f"Bearer {TOKEN}"}),
           app.RunConnector(name="Bad Name", url="http://x/mcp", headers={}),
           app.RunConnector(name="drive", url="ftp://x/mcp", headers={"Authorization": f"Bearer {TOKEN}"})]
    got = app._accept_connectors(raw, "conn-accept")
    assert [c["name"] for c in got] == ["google"] and got[0]["url"] == "http://google:8000/mcp"
    assert TOKEN not in capsys.readouterr().out


def test_the_grant_body_carries_connectors_only_when_the_task_has_them(monkeypatch):
    import httpx
    sent = []

    class _R:
        def raise_for_status(self):
            pass

    monkeypatch.setattr(httpx, "post", lambda url, **kw: sent.append(kw["json"]) or _R())
    app._gateway_grant("n1", 5, 0, label="t", attempt=1)
    app._gateway_grant("n2", 5, 0, label="t", attempt=1,
                       connectors=[{"name": "google", "url": "http://google/mcp", "headers": {"Authorization": "Bearer x"}}])
    assert "mcp" not in sent[0]
    assert sent[1]["mcp"] == {"google": {"url": "http://google/mcp", "headers": {"Authorization": "Bearer x"}}}


def test_the_engine_is_given_the_gateway_relay_with_the_nonce_never_the_token():
    import acp_client
    servers = acp_client.connector_servers(["google"], "http://gateway:8733", "the-nonce")
    assert [(s.name, s.url, [(h.name, h.value) for h in s.headers]) for s in servers] == [
        ("google", "http://gateway:8733/mcp/google", [("Authorization", "Bearer the-nonce")])]
    assert acp_client.connector_servers(["google"], "", "the-nonce") == []


def test_on_kilo_a_connectors_tools_run_without_a_card_and_stay_denied_under_deny_writes():
    import kilo_config
    allow = kilo_config.kilo_permissions("allow", ["google"])
    assert allow["google_*"] == "allow" and allow["*"] == "ask"
    assert kilo_config.kilo_permissions("deny_writes", ["google"])["google_*"] == "deny"
    assert "google_*" not in kilo_config.kilo_permissions("allow")


def test_a_refusal_and_a_refused_token_reach_the_answer_as_plain_sentences():
    reason = "send_gmail_message is not marked read-only"
    notes = app._connector_notices({
        "unauthorized": ["google", "google"],
        "refused": [{"server": "google", "tool": "send_gmail_message", "reason": reason}] * 2})
    assert len(notes) == 2
    assert "Reconnect Google in Settings" in notes[0]
    assert "send_gmail_message" in notes[1] and "refused" in notes[1]
    assert app._connector_notices({}) == []


def test_a_run_with_a_connector_keeps_its_token_out_of_the_sandbox_env_the_logs_and_the_task_store(monkeypatch, capsys):
    """Drives the real _run with the gateway and the engine stubbed: the token goes to the grant and nowhere else,
    and a 401 the relay recorded ends the answer with the reconnect sentence."""
    import acp_client
    monkeypatch.setattr(app, "HERMES_BIN", "/bin/true")
    monkeypatch.setattr(app, "SANDBOX_REQUIRED", False)
    monkeypatch.setattr(app, "MODERATION_DISABLED", True)
    monkeypatch.setattr(app, "MODEL_PROXY_URL", "http://gateway.invalid")
    monkeypatch.setattr(app, "AGENT_ACP", True)
    monkeypatch.setattr(app, "PROXY_ADMIN_KEY", "unit-key")
    monkeypatch.setattr(app, "ACP_PERMISSION_POLICY", "allow")
    grants, engine = [], {}

    def _fake_grant(*a, **kw):
        grants.append(kw)

    def _fake_revoke(_nonce, _served=None, connector_report=None):
        if connector_report is not None:
            connector_report.setdefault("unauthorized", []).append("google")
        return (1, 10, True, False)

    async def _fake_acp_run(*a, **kw):
        engine.update(kw)
        return "Here is what I found.", None, 0

    monkeypatch.setattr(app, "_gateway_grant", _fake_grant)
    monkeypatch.setattr(app, "_gateway_revoke", _fake_revoke)
    monkeypatch.setattr(acp_client, "_acp_run", _fake_acp_run)
    t = app.Task(id="conn-leak", prompt="what is in my inbox", user="dev-bypass-user")
    t._connectors = app._accept_connectors(
        [app.RunConnector(name="google", url="http://google:8000/mcp", headers={"Authorization": f"Bearer {TOKEN}"})], t.id)
    app._store_task(t)
    app._run(t)

    assert any(g.get("connectors") and g["connectors"][0]["headers"]["Authorization"] == f"Bearer {TOKEN}"
               for g in grants), "the grant is where the token goes"
    assert [s.url.rsplit("/", 2)[-2:] for s in engine["mcp_servers"]] == [["mcp", "google"]]
    assert TOKEN not in json.dumps([[h.value for h in s.headers] for s in engine["mcp_servers"]])
    assert TOKEN not in json.dumps(engine["model_env"]), "the sandbox's environment"
    assert engine["connector_names"] == ["google"]
    assert TOKEN not in capsys.readouterr().out, "the service's log lines"
    dump = "\n".join(app.store._db.iterdump())
    assert "conn-leak" in dump and TOKEN not in dump, "the task store"
    assert t.result.startswith("Here is what I found.") and "Reconnect Google in Settings" in t.result
