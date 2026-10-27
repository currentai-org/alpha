#!/usr/bin/env python3
"""Prove the caller-deadline count is DURABLE, not just present.

WHY A SEPARATE PROBE. An in-process `caller_deadlines` counter on an app with
`min_machines_running = 0` reports 0 after every scale-to-zero, even while the chat tier sends
`wall_clock_secs` on every turn. The obvious check — send one and watch the number go up — passes for BOTH an in-process
counter and a durable one, because within a single boot either increments fine. The only
observation that separates them is the number surviving a restart. So this does three steps and the
middle one is the point:

  1. POST /run with wall_clock_secs -> count must rise by exactly 1
  2. restart the machine                 <- the step an in-process counter fails
  3. read /healthz again                 -> count must still be there

The token comes from AGENT_SMOKE_TOKEN (env, else the gitignored .env) and is never printed.

  python scripts/deadline_probe.py                 # against the preview app
  python scripts/deadline_probe.py --no-restart    # steps 1 and 3 only, no machine bounce
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

BASE = os.environ.get("AGENT_URL", "http://localhost:8731")  # the compose.yaml port
APP = os.environ.get("AGENT_FLY_APP", "")  # the Fly app behind AGENT_URL; needed only for the restart step


def _token() -> str:
    import os
    t = os.environ.get("AGENT_SMOKE_TOKEN", "").strip()
    if t:
        return t
    raise RuntimeError("no AGENT_SMOKE_TOKEN — run via `doppler run` (agent-service/prd), or mint one "
                        "as an HS256 JWT signed with WEBUI_SECRET_KEY")


def _get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return json.loads(r.read())


def _post(path: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}", "x-agent-account": "user"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-restart", action="store_true", help="skip the machine bounce")
    ap.add_argument("--wall", type=int, default=150, help="deadline to state (default 150, the chat tier's)")
    args = ap.parse_args()

    before = _get("/healthz")
    print(f"  build={before['build']}  tasks_total={before['tasks_total']}  "
          f"caller_deadlines={before['caller_deadlines']}")

    tid = _post("/run", _token(), {"prompt": "Reply with the single word: ok.",
                                   "wall_clock_secs": args.wall})["id"]
    print(f"  submitted {tid} with wall_clock_secs={args.wall}")

    # The row is written at submission, ahead of the run thread, so this does not wait on the agent.
    time.sleep(2)
    mid = _get("/healthz")
    print(f"  after submit: caller_deadlines={mid['caller_deadlines']}")
    if mid["caller_deadlines"] != before["caller_deadlines"] + 1:
        print("  FAIL: the count did not rise by exactly 1 — the field never reached the store")
        return 1

    if args.no_restart:
        print("  (skipping the restart — this run has NOT shown durability, only presence)")
        return 0

    if not APP:
        print("  FAIL: set AGENT_FLY_APP to the Fly app behind AGENT_URL, or pass --no-restart")
        return 1
    print(f"  restarting {APP} — this is the step the in-process counter failed")
    # NOT `--select`: that prompts, and a probe that blocks on a TTY is a probe nobody runs twice.
    # `fly apps restart` bounces every machine in the app without asking which.
    r = subprocess.run(["fly", "apps", "restart", APP],
                       check=False, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        print(f"  FAIL: restart did not run — {r.stderr.strip()[:200]}")
        return 1
    for _ in range(30):
        time.sleep(4)
        try:
            after = _get("/healthz")
            break
        except Exception:  # noqa: BLE001 — it is restarting; keep asking
            continue
    else:
        print("  FAIL: the app never came back")
        return 1

    print(f"  after restart: caller_deadlines={after['caller_deadlines']}  "
          f"tasks_total={after['tasks_total']}")
    if after["caller_deadlines"] != mid["caller_deadlines"]:
        print("  FAIL: the count did not survive the restart — still not durable")
        return 1
    print("  PASS: the count rose and survived a restart")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as e:
        sys.exit(str(e))
