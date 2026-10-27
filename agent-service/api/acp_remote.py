"""ACP↔HTTP shim — point a LOCAL Hermes/editor frontend at the HOSTED agent service.

The `mcp-remote` analog for ACP. A thin local Agent Client Protocol server (stdio JSON-RPC) that forwards
each prompt to the deployed service's `POST /run` and streams `GET /run/{id}/events` back as ACP
session_update notifications. It runs NOTHING locally: the plan, tool execution, bwrap sandbox, best-of-N,
metering, auth, and moderation all happen server-side. The editor just sees a normal ACP agent; the work is
hosted + sovereign (Apertus-1.5 on CSCS).

Pure transport translation to the remote HTTP service — the hosted-backend case ("we host the backend, you run Hermes/Zed
locally") needs only this shim + a per-user token. (Hermes itself already speaks ACP natively for a purely
local run; this file exists only to point that same editor UX at the HOSTED service instead.)

Boundary note: the shim never holds the upstream model token or the proxy admin key — it carries only the
caller's per-user JWT (AGENT_TOKEN), exactly the credential a normal API client would. Every control
(sandbox, caps, secrets split) lives behind the HTTP service.

Run (the editor's ACP agent command):
  AGENT_URL=https://…fly.dev  AGENT_TOKEN=<per-user JWT>  python acp_remote.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import acp
from acp.schema import (
    AgentCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PromptResponse,
    ToolKind,
)

URL = os.environ.get("AGENT_URL", "").rstrip("/")
TOKEN = os.environ.get("AGENT_TOKEN", "")
HTTP_TIMEOUT = float(os.environ.get("AGENT_HTTP_TIMEOUT", "30"))            # connect/submit/cancel timeout
STREAM_TIMEOUT = int(os.environ.get("AGENT_WALL_CLOCK_SECS", "300")) + 60   # cap the SSE read (server wall-clock + slack)
PROTOCOL_VERSION = int(os.environ.get("ACP_PROTOCOL_VERSION", "1"))

# server tool_call event carries the step KIND in its `tool` field (instruction text is redacted server-side)
# Annotated: start_tool_call's `kind` is a Literal, and an unannotated dict literal infers `str`.
_KIND: dict[str, ToolKind] = {"tool": "execute", "write": "edit", "read": "read", "compute": "think"}


def _headers(machine_id: str | None = None) -> dict:
    h = {"content-type": "application/json"}
    if TOKEN:
        h["authorization"] = f"Bearer {TOKEN}"
    if machine_id:
        # Pin follow-up requests to the machine that created the task — a multi-machine
        # deploy has no session affinity by default, so an unpinned request can land on a machine
        # that never saw the task and 404. (CUR-895)
        h["Fly-Force-Instance-Id"] = machine_id
    return h


def _prompt_text(blocks) -> str:
    """Flatten ACP prompt content blocks to the task string (text blocks only)."""
    parts = []
    for b in blocks or []:
        t = getattr(b, "text", None)
        if t is None and isinstance(b, dict):
            t = b.get("text")
        if t:
            parts.append(str(t))
    return "\n".join(parts).strip()


class RemoteACPAgent:
    """Forwards each prompt to the hosted service and mirrors its SSE stream onto ACP session_update."""

    def __init__(self) -> None:
        self._conn = None
        self._sessions: dict[str, dict] = {}

    # called synchronously by AgentSideConnection on connect (acp/agent/connection.py)
    def on_connect(self, conn) -> None:
        self._conn = conn

    async def initialize(self, protocol_version: int, client_capabilities=None, client_info=None, **kw):
        return InitializeResponse(
            protocol_version=min(protocol_version, PROTOCOL_VERSION),
            agent_info=Implementation(name="publicai-remote", version="0.1.0"),
            agent_capabilities=AgentCapabilities())

    async def authenticate(self, method_id: str, **kw):
        return None

    async def new_session(self, cwd: str, mcp_servers=None, **kw):
        sid = uuid.uuid4().hex[:12]
        self._sessions[sid] = {"cwd": cwd, "task_id": None, "machine_id": None, "canceled": False}
        return NewSessionResponse(session_id=sid)

    async def cancel(self, session_id: str, **kw) -> None:
        sess = self._sessions.get(session_id)
        if not sess:
            return
        sess["canceled"] = True
        if sess.get("task_id"):
            await self._delete_run(sess["task_id"], sess.get("machine_id"))  # server-side cancel (kills the run + frees spend)

    async def prompt(self, prompt, session_id: str, message_id: str | None = None, **kw):
        if not URL:
            raise RuntimeError("AGENT_URL not set — the shim must point at the hosted service")
        import httpx
        sess = self._sessions.setdefault(
            session_id, {"cwd": os.getcwd(), "task_id": None, "machine_id": None, "canceled": False})
        sess["canceled"] = False
        task = _prompt_text(prompt)

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:  # submit; free-form prompt → no verify spec
            r = await c.post(f"{URL}/run", headers=_headers(), json={"prompt": task})
            r.raise_for_status()
            submitted = r.json()
            rid = submitted.get("id", "")
        if not rid:
            await self._send(session_id, acp.update_agent_message_text("error: service returned no task id"))
            return PromptResponse(stop_reason="end_turn")
        sess["task_id"] = rid
        # The machine that created this task — a multi-machine deploy has no session affinity
        # by default, so the /events open below is a SEPARATE request that must pin back to it. (CUR-895)
        mid = submitted.get("machine_id")
        sess["machine_id"] = mid

        final, state = None, "COMPLETED"
        timeout = httpx.Timeout(HTTP_TIMEOUT, read=STREAM_TIMEOUT)
        async with httpx.AsyncClient(timeout=timeout) as c:  # noqa: SIM117 — merging these would
            # reindent the entire streaming loop below for no behavioural change
            async with c.stream("GET", f"{URL}/run/{rid}/events", headers=_headers(mid)) as resp:
                resp.raise_for_status()
                etype = None
                async for line in resp.aiter_lines():
                    if line.startswith("event:"):
                        etype = line.split(":", 1)[1].strip()
                    elif line.startswith("data:"):
                        data = json.loads(line.split(":", 1)[1].strip() or "{}")
                        done_final = await self._translate(session_id, etype, data)
                        if done_final is not None:               # the `done` frame
                            final, state = done_final, data.get("state", "COMPLETED")
                            break
        if final:
            await self._send(session_id, acp.update_agent_message_text(final))
        if sess["canceled"] or state == "CANCELED":
            return PromptResponse(stop_reason="cancelled")
        return PromptResponse(stop_reason="end_turn")

    # -- internals ------------------------------------------------------------------------------
    async def _send(self, session_id: str, update) -> None:
        if self._conn is not None:
            await self._conn.session_update(session_id=session_id, update=update)

    async def _translate(self, session_id: str, etype: str | None, data: dict):
        """SSE frame -> ACP session_update. Returns the final message string on `done`, else None.
        Mirrors the redaction: the server already stripped instruction text/stdout, so the plan/tool rows
        carry only step KINDS, indexes, and a short summary."""
        if etype == "plan":
            entries = [acp.plan_entry(content=str(k), priority="medium", status="pending")
                       for k in data.get("steps", [])]
            await self._send(session_id, acp.update_plan(entries))
        elif etype == "tool_call":
            kind = data.get("tool", "tool")
            await self._send(session_id, acp.start_tool_call(
                tool_call_id=f"{session_id}-{data.get('step')}",
                title=f"{kind} (step {data.get('step')})",
                kind=_KIND.get(kind, "other"), status="in_progress"))
        elif etype == "tool_result":
            summary = data.get("summary")
            content = [acp.tool_content(acp.text_block(str(summary)))] if summary else None
            await self._send(session_id, acp.update_tool_call(
                tool_call_id=f"{session_id}-{data.get('step')}", status="completed", content=content))
        elif etype == "message":
            await self._send(session_id, acp.update_agent_message_text(str(data.get("text", ""))))
        elif etype == "done":
            res = (data.get("result") or "").strip()
            return res or (data.get("summary") or f"done ({data.get('state', 'COMPLETED')})")
        return None

    async def _delete_run(self, rid: str, machine_id: str | None = None) -> None:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                await c.delete(f"{URL}/run/{rid}", headers=_headers(machine_id))
        except Exception:  # noqa: BLE001 — best-effort; the server's caps bound any leftover spend
            pass


def main() -> None:
    # Same structural-vs-nominal mismatch as acp_client.py's spawn_agent_process call: this class
    # implements every method acp invokes without inheriting acp.Agent.
    asyncio.run(acp.run_agent(RemoteACPAgent(),  # pyright: ignore[reportArgumentType]
                              use_unstable_protocol=True))


if __name__ == "__main__":
    main()
