#!/usr/bin/env python3
"""Live SSE smoke — boot the real stack, submit a run against the shipped executor, and stream
GET /run/{id}/events.

Proves the interactive event surface end-to-end against Apertus-1.5 on CSCS —
no Zed / browser needed. Reuses dogfood.py's stack boot (proxy holds the token; app is credential-free,
best-of-3). The oneshot transport only streams coarse state + a final `done` frame; per-step
plan/tool-call progress is the ACP transport's job (see scripts/acp_inbound_smoke.py). Run:
python scripts/sse_smoke.py
"""
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dogfood as df

TASK = ("Using the terminal tool only: create three files named a.py, b.py and c.py in the current "
        "directory, then count the .py files there and write just that integer to r.txt, then read it back.")
VERIFY = {"expect_file": "r.txt", "expect_contains": "3"}


def main() -> None:
    mode = df.MODES["apertus15"]
    df.start_proxy(df.ik_token())
    df.start_app(mode["model"], mode["env"])
    rid = df._post("/run", {"prompt": TASK, "verify": VERIFY}).get("id", "")
    if not rid:
        sys.exit("POST /run returned no id — see /tmp/dogfood_app.log")
    print(f"submitted {rid} — streaming /run/{rid}/events:\n", flush=True)
    seen: list[str] = []
    etype = None
    req = urllib.request.Request(f"http://127.0.0.1:{df.APORT}/run/{rid}/events")
    with urllib.request.urlopen(req, timeout=df.WALL + 30) as r:
        for raw in r:                                      # SSE: id: / event: / data: / blank, per frame
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("event:"):
                etype = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = line.split(":", 1)[1].strip()
                seen.append(etype or "?")
                print(f"  {etype:12} {data[:110]}", flush=True)
                if etype == "done":
                    break
    ok = "done" in seen and "state" in seen
    print(f"\n{'✅ live SSE stream OK' if ok else '❌ stream incomplete'} — types: {seen}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
