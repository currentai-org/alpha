#!/usr/bin/env python3
"""End-to-end smoke for the ACP↔HTTP shim (api/acp_remote.py), no Zed/token required.

Boots the FULL hosted-style stack locally (proxy + app, Apertus-1.5 on CSCS, auth off), spawns
acp_remote.py as an ACP agent pointed at the local app's HTTP URL, and drives it through the real `acp`
client. Proves the path: local editor → shim → hosted HTTP service (POST /run + GET
/run/{id}/events) → ACP session_update. NOTHING runs in the shim — plan/exec/sandbox are all server-side;
we assert the verified final result reaching the client, not a local file.

Caveat: the oneshot transport only streams coarse state + a final `done` frame — there is no per-step
plan/tool-call progress to assert here; that's the ACP transport's job (acp_inbound_smoke.py). So the
client only ever sees one `agent_message_chunk`, carrying the full result.

Usage:  IK_TOKEN=... python acp_remote_smoke.py     (IK_TOKEN defaults to the gitignored token file)
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api"
sys.path.insert(0, str(API))
sys.path.insert(0, str(ROOT / "scripts"))

import acp  # noqa: E402
import dogfood as df  # noqa: E402


class RecordingClient:
    """Minimal ACP client — records session_update kinds + agent-message text (the shim mediates no fs)."""

    def __init__(self) -> None:
        self.updates: list[str] = []
        self.texts: list[str] = []

    async def session_update(self, session_id, update, **kw):
        kind = getattr(update, "session_update", "?")
        self.updates.append(kind)
        if kind == "agent_message_chunk":                      # the final result lands here, not in tool rows
            c = getattr(update, "content", None)
            txt = getattr(c, "text", None)
            if txt is None and isinstance(c, dict):
                txt = c.get("text")
            self.texts.append(str(txt if txt is not None else update))

    async def request_permission(self, options, session_id, tool_call, **kw):
        from acp.schema import RequestPermissionResponse
        oid = getattr(options[0], "option_id", "allow") if options else "allow"
        return RequestPermissionResponse(outcome={"outcome": "selected", "option_id": oid})

    async def write_text_file(self, content, path, session_id, **kw):
        return None                                            # shim never mediates fs (execution is server-side)

    async def read_text_file(self, path, session_id, limit=None, line=None, **kw):
        from acp.schema import ReadTextFileResponse
        return ReadTextFileResponse(content="")


async def drive() -> int:
    work = tempfile.mkdtemp(prefix="acp-remote-smoke-")
    client = RecordingClient()
    url = f"http://127.0.0.1:{df.APORT}"
    env = {**os.environ, "AGENT_URL": url, "AGENT_TOKEN": "", "AGENT_WALL_CLOCK_SECS": "240"}
    print(f"  spawning acp_remote shim → {url} (cwd={work}) …", flush=True)
    async with acp.spawn_agent_process(client, df.PY, str(API / "acp_remote.py"), env=env, cwd=str(API)) as (conn, _proc):
        await conn.initialize(protocol_version=1)
        sess = await conn.new_session(cwd=work)
        sid = sess.session_id
        print(f"  session {sid} — prompting (work runs server-side; watch the stream) …", flush=True)
        resp = await conn.prompt(prompt=[acp.text_block(df.DEFAULT_TASK)], session_id=sid)

    kinds = client.updates
    stop = getattr(resp, "stop_reason", "?")
    finaltext = " ".join(client.texts)
    print(f"\n  stop_reason : {stop}")
    print(f"  updates     : {kinds}")
    print(f"  final text  : {finaltext[:160]!r}")

    checks = {
        "got a final agent message": "agent_message_chunk" in kinds,
        "stop_reason end_turn": stop == "end_turn",
        "verified result reached client (contains 3)": "3" in finaltext,
    }
    print()
    ok = True
    for name, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    print(f"\n  ==== ACP-remote (shim) smoke {'GREEN' if ok else 'RED'} ====")
    return 0 if ok else 1


def main() -> None:
    mode = df.MODES["apertus15"]
    df.start_proxy(df.ik_token())
    df.start_app(mode["model"], mode["env"])
    sys.exit(asyncio.run(drive()))


if __name__ == "__main__":
    main()
