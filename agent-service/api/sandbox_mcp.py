"""The per-conversation sandbox as an MCP server, with no agent loop behind it (CUR-4232).

Chat already runs its own tool loop and already has web search. What it lacks is a place to run code.
This module serves the same box the agent runs in (`_sandbox_prefix` in app.py: read-only host, hidden
home and data dirs, the conversation's workdir as the only writable path, prlimit caps) as five MCP tools,
so chat's model can search and then compute in one turn. Two things differ from the agent's box:

- The network is unshared. The agent needs the model gateway, so its egress is an nftables allowlist; a
  code call needs nothing, so it gets no network at all (`--unshare-net`), allowlisted hosts included.
- The environment is built from nothing rather than filtered, so no secret can reach the code by a name
  `_SECRET_ENV_RE` does not know.

The tools reach the code and its files only through a `SandboxBackend` (CUR-4438), so moving each
conversation into a sandbox of its own is a backend swap. With `BwrapBackend` the workdir is the one the
agent uses for the same (principal, conversation), so a file one writes the other can read, and the
existing artifact route serves anything the code writes.

Auth is the service's own: `Authorization: Bearer <token>` checked by `require_user`, `X-Agent-Subject`
for the visitor inside the caller. `X-Agent-Session` names the conversation; without it a call is refused,
since an unkeyed workdir would be a fresh one per call and nothing would carry between calls.
"""

from __future__ import annotations

import os
from collections.abc import Callable

import sandbox_backend
from anyio import from_thread, to_thread
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from sandbox_backend import (  # noqa: F401  (sandbox_env re-exported)
    Handle,
    OnWait,
    SandboxBackend,
    SandboxError,
    Tier,
    sandbox_env,
)

# Chat gives a call 10 s to connect and answer (`CALL_TIMEOUT_MS`, web serversKit.ts), so the code gets less.
RUN_TIMEOUT_SECS = float(os.environ.get("AGENT_SANDBOX_MCP_TIMEOUT_SECS", "7"))
# Chat caps a tool result at 8,000 characters; the rest of the reply is the exit line and the file list.
OUTPUT_MAX_CHARS = 6000
READ_MAX_BYTES = 200_000
WRITE_MAX_BYTES = 2_000_000
SESSION_MAX_CHARS = 200


class SandboxRefused(ToolError):
    """A call the sandbox will not run, with the reason the model reads back. A ToolError, so the SDK keeps
    its text in the error result; any other exception reaches the client as a bare "Error executing tool"."""


def confine(work: str, rel: str):
    """`sandbox_backend.confine`, refusing with the error the model reads back."""
    try:
        return sandbox_backend.confine(work, rel)
    except SandboxError as e:
        raise SandboxRefused(str(e)) from None


def _clip(text: str, limit: int = OUTPUT_MAX_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [{len(text) - limit} more characters cut]"


def _listing(backend: SandboxBackend, h: Handle, limit: int = 50) -> list[str]:
    files = backend.list(h, limit + 1)
    out = [f"{rel} ({size} bytes)" for rel, size in files[:limit]]
    if len(files) > limit:
        out.append("…")
    return out


def build_sandbox_server(
    *,
    backend: SandboxBackend,
    sandbox_on: Callable[[], bool],
    principal_for: Callable[[str | None, str | None], str],
    log_event: Callable[..., None],
) -> MCPServer:
    """The MCP server. `principal_for(authorization, subject)` is `require_user` (raises on a bad token);
    `backend` is where the conversation's code runs and its files live (`sandbox_backend.py`)."""

    server = MCPServer(
        name="sandbox",
        instructions=(
            "A private workspace for this conversation, with Python 3 (numpy, pandas, matplotlib) and a "
            "shell. It has no internet: look things up with web search first, then compute here. Files "
            "you write stay for the rest of the conversation."
        ),
    )

    def _caller(ctx: Context) -> tuple[str, str]:
        headers = ctx.headers or {}
        principal = principal_for(headers.get("authorization"), headers.get("x-agent-subject"))
        session = (headers.get("x-agent-session") or "").strip()
        if not session or len(session) > SESSION_MAX_CHARS:
            raise SandboxRefused("no conversation named (X-Agent-Session)")
        if not sandbox_on():
            raise SandboxRefused("the sandbox is off on this deployment")
        return principal, session

    def _handle(ctx: Context) -> tuple[str, Handle]:
        """The conversation's sandbox, made if it has none. Called on a worker thread: on a full host connect waits
        there for a slot (CUR-4584), and tells chat so through the call's MCP progress."""
        principal, session = _caller(ctx)
        return principal, backend.connect(principal, session, Tier.RUN_CODE, on_wait=_progress(ctx))

    def _progress(ctx: Context) -> OnWait:
        def say(text: str) -> None:
            try:
                from_thread.run(ctx.report_progress, 0, None, text)
            except Exception:  # noqa: BLE001 — a status chat missed must not fail the call it describes
                pass
        return say

    def _existing(ctx: Context) -> Handle | None:
        """The conversation's sandbox if it has one. A read needs no new sandbox: on E2B that is a microVM held
        for minutes just to answer "empty", and on a full host a busy error instead (CUR-4502)."""
        principal, session = _caller(ctx)
        return backend.find(principal, session, Tier.RUN_CODE)

    def _refusing(fn: Callable[[], str]) -> str:
        try:
            return fn()
        except SandboxError as e:
            raise SandboxRefused(str(e)) from None

    def _run(h: Handle, argv: list[str], tool: str, principal: str, stdin: str | None = None) -> str:
        before = set(_listing(backend, h, limit=500))
        res = backend.exec(h, argv, RUN_TIMEOUT_SECS, stdin=stdin)
        if res.timed_out:
            log_event("sandbox_mcp.call", tool=tool, principal=principal, outcome="timeout", ms=res.ms)
            return f"Stopped after {RUN_TIMEOUT_SECS:g} s without finishing.\n{_clip(res.stdout)}"
        log_event("sandbox_mcp.call", tool=tool, principal=principal, outcome="exit", code=res.code, ms=res.ms)
        new = [f for f in _listing(backend, h, limit=500) if f not in before]
        parts = [f"exit code {res.code} ({res.ms} ms)"]
        if res.stdout:
            parts.append("stdout:\n" + _clip(res.stdout))
        if res.stderr:
            parts.append("stderr:\n" + _clip(res.stderr, 2000))
        if new:
            parts.append("new files: " + ", ".join(new[:20]))
        return "\n".join(parts)

    @server.tool(
        description="Run Python 3 code in this conversation's workspace and return what it printed. "
        "Print the values you need; the last expression is not echoed. No internet.",
        annotations=ToolAnnotations(title="Run code", read_only_hint=False, destructive_hint=False,
                                    open_world_hint=False),
    )
    async def run_code(code: str, ctx: Context) -> str:
        def go() -> str:
            principal, h = _handle(ctx)
            # The code arrives on stdin, so nothing is written into the workspace on its behalf.
            return _run(h, ["python3", "-"], "run_code", principal, stdin=code)
        return await to_thread.run_sync(lambda: _refusing(go))

    @server.tool(
        description="Run a shell command (bash) in this conversation's workspace. No internet.",
        annotations=ToolAnnotations(title="Run command", read_only_hint=False, destructive_hint=False,
                                    open_world_hint=False),
    )
    async def run_command(command: str, ctx: Context) -> str:
        def go() -> str:
            principal, h = _handle(ctx)
            return _run(h, ["bash", "-c", command], "run_command", principal)
        return await to_thread.run_sync(lambda: _refusing(go))

    @server.tool(
        description="Read a text file from this conversation's workspace.",
        annotations=ToolAnnotations(title="Read file", read_only_hint=True, open_world_hint=False),
    )
    async def read_file(path: str, ctx: Context) -> str:
        def go() -> str:
            h = _existing(ctx)
            if h is None:
                raise SandboxRefused(f"{path!r} is not a file in the workspace")
            return _clip(backend.read(h, path, READ_MAX_BYTES).decode("utf-8", "replace"))
        return await to_thread.run_sync(lambda: _refusing(go))

    @server.tool(
        description="Write a text file into this conversation's workspace, replacing it if it exists.",
        annotations=ToolAnnotations(title="Write file", read_only_hint=False, destructive_hint=True,
                                    open_world_hint=False),
    )
    async def write_file(path: str, content: str, ctx: Context) -> str:
        def go() -> str:
            _, h = _handle(ctx)
            data = content.encode("utf-8")
            if len(data) > WRITE_MAX_BYTES:
                raise SandboxRefused(f"content is {len(data)} bytes, over the {WRITE_MAX_BYTES} limit")
            backend.write(h, path, data)
            return f"wrote {path} ({len(data)} bytes)"
        return await to_thread.run_sync(lambda: _refusing(go))

    @server.tool(
        description="List the files in this conversation's workspace.",
        annotations=ToolAnnotations(title="List files", read_only_hint=True, open_world_hint=False),
    )
    async def list_files(ctx: Context) -> str:
        def go() -> str:
            h = _existing(ctx)
            files = _listing(backend, h) if h is not None else []
            return "\n".join(files) if files else "The workspace is empty."
        return await to_thread.run_sync(lambda: _refusing(go))

    return server


def sandbox_http_app(server: MCPServer):
    """The Starlette app to mount. Stateless, because chat opens a new connection per call; no Host check,
    because callers are servers holding a bearer token, not browsers. Each call is answered as an SSE stream
    rather than one JSON body, since a JSON body has no room for the progress a call waiting on a full host
    sends ahead of its result (CUR-4584)."""
    return server.streamable_http_app(
        streamable_http_path="/",
        json_response=False,
        stateless_http=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
