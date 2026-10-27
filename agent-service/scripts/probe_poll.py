#!/usr/bin/env python3
"""Poll a submitted task to a terminal state, answering its confirmation prompts on the way.

WHY THIS IS SHARED RATHER THAN COPIED INTO EACH PROBE (CUR-1224). Two hazards make a probe report
something other than the service's health, and every probe in this directory is exposed to both:

1. CONFIRMATIONS. `edit`, `delete` and `execute` ALWAYS pause for a human answer, on every tier,
   `trusted` included, regardless of the resolved policy (CUR-760, CUR-975). `prod_smoke.py`'s fixture
   writes a file, so a probe that never answers cannot pass: the write pauses, nobody answers, and the
   task fails `expect_file not found: out.txt` on every attempt. A check that can only go red is as dead
   an instrument as one that can only go green. Blanket-allowing is correct HERE and nowhere near a UI: the
   probe submitted its own fixed fixture seconds ago and is confirming that task's own tool calls.

2. THE POLL BUDGET. `/healthz` reports `wall_clock_task_s: 900` (three attempts at `wall_clock_s:
   300`). A fixed budget shorter than that (400s, say) makes any task needing a second attempt outlive
   the probe watching it, and the probe calls that a failure. A deploy gate that false-fails on a
   healthy service is no safer (CUR-1222), so the budget is read from the service
   rather than guessed at.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

TERMINAL = ("COMPLETED", "FAILED", "CANCELED")


def request(url: str, token: str | None = None, body: dict | None = None, timeout: int = 60,
            machine_id: str | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
        headers["x-agent-account"] = "user"  # CUR-4402: agent-service refuses a run that names no account
    if machine_id:
        headers["Fly-Force-Instance-Id"] = machine_id      # CUR-895: no session affinity by default
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {url}: {e.read()[:300].decode(errors='replace')}")


def default_timeout(health: dict, margin_s: int = 120) -> int:
    """The service's own per-task budget plus room for queueing, not a number chosen here.

    `wall_clock_task_s` is the whole-task ceiling (best_of attempts x `wall_clock_s`). Falling back to
    900 rather than to something small: a probe that gives up early reports a failure the service did
    not have, which is the more expensive way to be wrong in a deploy gate."""
    try:
        return int(health.get("wall_clock_task_s") or 900) + margin_s
    except (TypeError, ValueError):
        return 900 + margin_s


def answer_confirmations(base: str, token: str, task_id: str, status: dict,
                         machine_id: str | None = None, decision: str = "allow") -> int:
    """Answer every confirmation currently open on this task. Returns how many were answered.

    A 409 means it timed out or someone else answered it — not an error worth ending a probe over, so
    it is counted as handled rather than raised. Anything else still exits, because a probe that
    silently tolerates an unexpected API response is back to measuring nothing."""
    answered = 0
    for c in status.get("pending_confirmations") or []:
        cid = c.get("confirm_id")
        if not cid:
            continue
        try:
            request(f"{base}/run/{task_id}/confirm", token,
                    {"confirm_id": cid, "decision": decision}, machine_id=machine_id)
        except SystemExit as e:
            if "HTTP 409" not in str(e):
                raise
        answered += 1
    return answered


def poll(base: str, token: str, task_id: str, machine_id: str | None, timeout_s: int,
         interval_s: int = 3, auto_confirm: bool = True, verbose: bool = False) -> dict:
    """Poll to a terminal state. Raises SystemExit on timeout — a probe that returns a non-terminal
    status lets its caller read `verified: false` as a verdict when it is really just "not done yet"."""
    t0 = time.monotonic()
    confirmed = 0
    status: dict = {}
    while time.monotonic() - t0 < timeout_s:
        time.sleep(interval_s)
        status = request(f"{base}/run/{task_id}", token, machine_id=machine_id)
        if auto_confirm:
            n = answer_confirmations(base, token, task_id, status, machine_id)
            if n and verbose:
                print(f"    auto-confirmed {n} tool call(s)")
            confirmed += n
        if status.get("state") in TERMINAL:
            status["_wall"] = time.monotonic() - t0
            status["_confirmations"] = confirmed
            return status
    sys.exit(f"task {task_id} never reached a terminal state within {timeout_s}s "
             f"(last state: {status.get('state')}, confirmations answered: {confirmed})")
