#!/usr/bin/env python3
"""Live probe for CUR-3025: a real `hermes acp` session calls tools on a configured MCP server.

Runs everything on loopback, offline, with no model spend:

- a stub MCP server (the `mcp` package's MCPServer, Streamable HTTP) with `add` and `multiply` tools,
  which refuses any request whose Authorization header is not the expected value;
- a scripted OpenAI-compatible model that asks for `mcp__stub__add`, then `mcp__stub__multiply` on the
  first result, then answers with the second result. It only knows the numbers the tools returned, so a
  correct final answer is evidence the calls really went through MCP;
- the service's own path: `mcp_config.load` parses AGENT_MCP_SERVERS, `acp_client.build_mcp_servers`
  resolves the header from the environment, and `acp_client._acp_run` drives the real Hermes binary.

Needs a Python with the pinned Hermes installed as `[acp,mcp]` (it carries both `acp` and `mcp`):

    HERMES_PY=/path/to/hermes/.venv/bin/python
    $HERMES_PY scripts/mcp_live_probe.py            # exit 0 = two MCP calls made and the answer is right
    $HERMES_PY scripts/mcp_live_probe.py --no-mcp   # the injury: same run, no servers on new_session

No sandbox (bwrap) here: this proves the ACP and MCP wiring, not the Fly egress rules.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

AUTH_VALUE = "Bearer probe-" + os.urandom(6).hex()
MCP_CALLS: list[tuple[str, dict]] = []
MODEL_REQUESTS: list[dict] = []


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ------------------------------------------------------------------------------------ stub MCP server
def start_mcp(port: int) -> None:
    import uvicorn
    from mcp.server.mcpserver import MCPServer

    srv = MCPServer("stub")

    @srv.tool()
    def add(a: int, b: int) -> str:
        """Add two integers."""
        MCP_CALLS.append(("add", {"a": a, "b": b}))
        return str(a + b)

    @srv.tool()
    def multiply(a: int, b: int) -> str:
        """Multiply two integers."""
        MCP_CALLS.append(("multiply", {"a": a, "b": b}))
        return str(a * b)

    inner = srv.streamable_http_app()

    async def guarded(scope, receive, send):
        if scope["type"] == "http":
            got = dict(scope["headers"]).get(b"authorization", b"").decode()
            if got != AUTH_VALUE:
                await send({"type": "http.response.start", "status": 401, "headers": []})
                await send({"type": "http.response.body", "body": b"bad auth"})
                return
        await inner(scope, receive, send)

    cfg = uvicorn.Config(guarded, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    threading.Thread(target=uvicorn.Server(cfg).run, daemon=True).start()


# ------------------------------------------------------------------------------------ scripted model
def _decide(body: dict) -> dict:
    """The next assistant message, from what the tools have returned so far."""
    tool_results = [m for m in body.get("messages", []) if m.get("role") == "tool"]
    if not tool_results:
        if "mcp__stub__add" not in json.dumps(body):
            return {"role": "assistant", "content": "NO_MCP_TOOLS_OFFERED"}
        return _call(body, "mcp__stub__add", {"a": 2, "b": 3})
    # Hermes wraps an MCP result as JSON that can repeat the value (text + structured content), so take
    # the first integer rather than every digit.
    found = re.search(r"-?\d+", str(tool_results[-1].get("content", "")))
    num = found.group(0) if found else "0"
    if len(tool_results) == 1:
        return _call(body, "mcp__stub__multiply", {"a": int(num), "b": 10})
    return {"role": "assistant", "content": f"RESULT={num}"}


def _call(body: dict, name: str, args: dict) -> dict:
    """Call `name` directly when it is in the tools array, else through Hermes' `tool_call` bridge.

    Hermes defers every MCP tool behind tool_search/tool_describe/tool_call as soon as any exist
    (tools/tool_search.py, tier 1: a name + description listing in the prompt), so a real model reaches
    an MCP tool through `tool_call` — and so does this one."""
    direct = {t.get("function", {}).get("name") for t in body.get("tools") or []}
    fn, fargs = (name, args) if name in direct else ("tool_call", {"name": name, "arguments": args})
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": f"call_{len(MODEL_REQUESTS)}", "type": "function",
        "function": {"name": fn, "arguments": json.dumps(fargs)}}]}


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):   # quiet
        pass

    def do_GET(self):
        self._json({"object": "list", "data": [{"id": "probe/model", "object": "model"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        MODEL_REQUESTS.append(body)
        msg = _decide(body)
        finish = "tool_calls" if msg.get("tool_calls") else "stop"
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if not body.get("stream"):
            self._json({"id": "x", "object": "chat.completion", "created": int(time.time()), "model": "probe/model",
                        "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage})
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        delta = {"role": "assistant"}
        if msg.get("tool_calls"):
            delta["tool_calls"] = [{**tc, "index": i} for i, tc in enumerate(msg["tool_calls"])]
        else:
            delta["content"] = msg["content"]
        for chunk in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                      {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage}):
            chunk.update({"id": "x", "object": "chat.completion.chunk", "created": int(time.time()),
                          "model": "probe/model"})
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def _json(self, obj):
        raw = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


# ------------------------------------------------------------------------------------ the run
async def _wait_listening(port: int, limit_s: float = 15.0) -> None:
    deadline = time.monotonic() + limit_s
    while time.monotonic() < deadline:
        with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return
        await asyncio.sleep(0.05)
    raise RuntimeError(f"nothing listening on 127.0.0.1:{port} after {limit_s}s")


async def run(no_mcp: bool, tmp_root: str | None) -> int:
    mcp_port, model_port = _free_port(), _free_port()
    start_mcp(mcp_port)
    model = ThreadingHTTPServer(("127.0.0.1", model_port), ModelHandler)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    await _wait_listening(mcp_port)
    await _wait_listening(model_port)

    os.environ["PROBE_MCP_AUTH"] = AUTH_VALUE
    os.environ["AGENT_MCP_ALLOW_LOCALHOST"] = "1"
    os.environ["AGENT_MCP_SERVERS"] = json.dumps([{
        "name": "stub", "url": f"http://127.0.0.1:{mcp_port}/mcp",
        "headers": {"Authorization": "PROBE_MCP_AUTH"}}])

    import acp_client
    import mcp_config

    cfg = mcp_config.load()
    assert not cfg.error, cfg.error
    servers = [] if no_mcp else acp_client.build_mcp_servers(cfg, os.environ, "probe")
    hermes_bin = shutil.which("hermes", path=str(Path(sys.executable).parent)) or "hermes"

    tmp = Path(tempfile.mkdtemp(prefix="mcp-probe-", dir=tmp_root))
    work, home = tmp / "work", tmp / "home"
    work.mkdir(); home.mkdir()
    (home / "config.yaml").write_text("")
    env = {k: v for k, v in os.environ.items() if k != "PROBE_MCP_AUTH"}
    env.update({"HERMES_HOME": str(home), "HF_TOKEN": "probe-nonce",
                "HF_BASE_URL": f"http://127.0.0.1:{model_port}/v1"})
    task = types.SimpleNamespace(id="probe", _canceled=False, _acp_cancel=None, _acp_confirm=None,
                                 _confirm_wait_secs=0.0, unrun_detail=None)
    text, stop, rc = await acp_client._acp_run(
        str(work), str(home), "Add 2 and 3 with the stub tool, multiply the sum by 10, report RESULT=<n>.",
        "probe-nonce", 120.0, None, task, sandbox_prefix=[], hermes_bin=hermes_bin, model_env=env,
        model="probe/model", provider="huggingface", attempt=1, mcp_servers=servers)

    offered = sorted(n for n in ("mcp__stub__add", "mcp__stub__multiply")
                     if any(n in json.dumps(r) for r in MODEL_REQUESTS))
    report = {"final_text": text, "stop_reason": stop, "returncode": rc, "mcp_calls": MCP_CALLS,
              "model_requests": len(MODEL_REQUESTS), "mcp_tools_offered": offered}
    print(json.dumps(report, indent=2))
    ok = (MCP_CALLS == [("add", {"a": 2, "b": 3}), ("multiply", {"a": 5, "b": 10})]
          and "RESULT=50" in (text or ""))
    print("PASS: two MCP tool calls through Hermes, answer RESULT=50" if ok else "FAIL")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


async def serve() -> int:
    """Run only the stub MCP server and the scripted model, and print the env a locally started
    agent-service needs to use them, so a full /run task can be driven against the real app."""
    mcp_port, model_port = _free_port(), _free_port()
    start_mcp(mcp_port)
    model = ThreadingHTTPServer(("127.0.0.1", model_port), ModelHandler)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    await _wait_listening(mcp_port)
    await _wait_listening(model_port)
    print(json.dumps({
        "AGENT_MCP_ALLOW_LOCALHOST": "1", "PROBE_MCP_AUTH": AUTH_VALUE,
        "AGENT_MCP_SERVERS": json.dumps([{"name": "stub", "url": f"http://127.0.0.1:{mcp_port}/mcp",
                                          "headers": {"Authorization": "PROBE_MCP_AUTH"}}]),
        "HF_BASE_URL": f"http://127.0.0.1:{model_port}/v1"}), flush=True)
    while True:
        await asyncio.sleep(5)
        print(json.dumps({"mcp_calls": MCP_CALLS, "model_requests": len(MODEL_REQUESTS)}), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-mcp", action="store_true", help="injury: send no MCP servers on new_session")
    ap.add_argument("--serve", action="store_true",
                    help="run only the stub MCP server and scripted model, print their env, and keep serving")
    ap.add_argument("--tmp", default=None, help="parent dir for the work/home dirs (default: the system temp dir)")
    a = ap.parse_args()
    if a.serve:
        return asyncio.run(serve())
    return asyncio.run(run(a.no_mcp, a.tmp))


if __name__ == "__main__":
    sys.exit(main())
