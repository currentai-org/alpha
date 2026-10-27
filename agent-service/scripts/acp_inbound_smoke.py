#!/usr/bin/env python3
"""End-to-end smoke for the in-app ACP client (api/acp_client.py + app._run AGENT_ACP branch).

Boots the real hosted-style stack (proxy + app, Apertus-1.5 on CSCS) with AGENT_ACP=1, submits a
tool-using task with a verify spec, and STREAMS GET /run/{id}/events while it runs. Proves the piece
streaming-spec §7.1 marked "not yet run": the app drives `hermes acp` as an ACP client, its
request_permission/write handlers mediate the tool calls, and the session updates surface as LIVE
plan/tool_call/tool_result SSE frames (which the oneshot transport cannot emit) — then the
independent _verify of the artifact passes and `done` carries the UPPERCASE COMPLETED state.

Contrast with acp_remote_smoke.py (the outbound shim): there the server ran oneshot and the client saw
only one coarse message; here the server runs ACP, so the per-step frames are the assertion.

Usage:  IK_TOKEN=... python scripts/acp_inbound_smoke.py    (IK_TOKEN defaults to the gitignored token file)
"""
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "api"))

import dogfood as df  # noqa: E402

TASK = ("Create a file named result.txt in the current directory whose entire contents are the single "
        "word DONE (uppercase, no other text). Then stop.")
VERIFY = {"expect_file": "result.txt", "expect_contains": "DONE"}


async def drive() -> int:
    import httpx

    base = f"http://127.0.0.1:{df.APORT}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=df.WALL + 60)) as c:
        r = await c.post(f"{base}/run", json={"prompt": TASK, "verify": VERIFY})
        r.raise_for_status()
        rid = r.json()["id"]
        print(f"  submitted task {rid} (AGENT_ACP=1) — streaming events …", flush=True)

        frames: list[str] = []
        done: dict | None = None
        async with c.stream("GET", f"{base}/run/{rid}/events") as resp:
            resp.raise_for_status()
            etype = None
            async for line in resp.aiter_lines():
                if line.startswith("event:"):
                    etype = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    frames.append(etype or "?")
                    if etype == "done":
                        done = json.loads(line.split(":", 1)[1].strip() or "{}")
                        break

    final = df._get(f"/run/{rid}")
    kinds = set(frames)
    print(f"\n  frame kinds : {sorted(kinds)}")
    print(f"  done        : {done}")
    print(f"  final state : {final.get('state')}  verified={final.get('verified')}")
    # NOTE: this Hermes build's ACP bridge emits ToolCallStart only (acp_adapter/events.py: "Only emit
    # ACP ToolCallStart for tool.started; ignore other event types"), so plain tools produce a live
    # `tool_call` frame but NO `tool_call_update` → no `tool_result` (that path fires only for
    # edit-approval diffs; unit-tested in api/test_acp_client.py). We assert the live-progress
    # `tool_call` frame that the oneshot path cannot deliver, not a completion frame.
    if "tool_result" not in kinds:
        print("  (info) no tool_result frame — expected: this Hermes build streams tool starts only")

    checks = {
        "live tool_call frame arrived": "tool_call" in kinds,
        "done frame present": done is not None,
        "done state is UPPERCASE COMPLETED": (done or {}).get("state") == "COMPLETED",
        "final state COMPLETED": final.get("state") == "COMPLETED",
        "independently verified": final.get("verified") is True,
    }
    print()
    ok = True
    for name, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    print(f"\n  ==== ACP-inbound (hermes acp client) smoke {'GREEN' if ok else 'RED'} ====")
    return 0 if ok else 1


def main() -> None:
    mode = df.MODES["apertus15"]
    tok = df.token_for(mode)
    df.check_model_live(mode, tok)
    df.start_proxy(tok, mode["base"])
    # AGENT_ACP=1 flips app._run onto the in-app ACP client; sandbox stays as dogfood sets it (off locally).
    df.start_app(mode["model"], {**mode["env"], "AGENT_ACP": "1"})
    sys.exit(asyncio.run(drive()))


if __name__ == "__main__":
    main()
