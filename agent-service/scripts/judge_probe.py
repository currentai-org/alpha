#!/usr/bin/env python3
"""Drive free-form chat turns so the judge and best-of-N actually run, then read what happened.

WHY THIS EXISTS. `scripts/prod_smoke.py` posts a deterministic `verify` spec, which makes `may_judge`
False (`_best_of_gates` in api/app.py) — so smoke traffic exercises the one path
where the judge never runs and best-of-N never retries, which can read as "best-of-3 never fires" when
it means "best-of-3 has not been asked to".

`synthesize=true` with no spec is the chat surface. It engages the auto-derive and LLM-judge gates and
is the only way to observe a rejection without waiting for real users.

Prompts are deliberately mixed. Some are easy enough that a rejection would indicate a judge that is
too strict; some are the kind of specific, checkable claim a 70B gets subtly wrong, which is where a
judge earns its seat. A probe made only of easy prompts measures nothing but its own optimism.

  scripts/judge_probe.py [--n 8] [--base URL] [--timeout 300]

Reads AGENT_SMOKE_TOKEN from env or the gitignored .env, same as prod_smoke.py. Never prints it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("AGENT_URL", "http://localhost:8731")  # the compose.yaml port

# Every prompt carries its GROUND TRUTH, worked out by hand. Without it this script can only report the
# judge's opinion of itself, which is the one thing a judge cannot be measured by. With it, each turn
# scores two independent things: whether the ANSWER was right, and whether the JUDGE agreed — and the
# interesting cell is where they disagree.
#
#   answer right + judge passed  → true accept
#   answer wrong + judge passed  → FALSE ACCEPT, the failure that makes `verified` a lie
#   answer right + judge failed  → false reject, a judge rejecting correct answers
#   answer wrong + judge failed  → true reject, the seat earning its place
EASY = [
    ("Write a one-sentence summary of what a semaphore does.", None),
    ("What is 17 * 23? Answer with just the number.", "391"),
    ("Name the three states a POSIX process can be in and give one sentence each.", None),
    ("A file has 40 lines. You delete every third line starting from line 3. How many lines remain?", "27"),
    ("Write a Python one-liner that returns the second-largest distinct value in a list. Show the line only.", None),
    ("In UTF-8, how many bytes does the character U+1F600 occupy, and why that many?", "4"),
    ("A tar archive is 4.2 GB and compresses to 1.1 GB with gzip. What compression ratio is that, to one decimal place?", "3.8"),
    ("Given a 300-second wall clock and calls that each take 12 seconds, how many complete calls fit, and what is left over?", "25"),
]

# Difficulty from reasoning depth and known traps, NOT obscurity. An obscure fact tests memorisation and
# makes a hallucination indistinguishable from a judge failure; a trap has one attractive wrong answer,
# so a model that falls for it produces a specific, recognisable error the judge either catches or does
# not. Several of these are the canonical traps mid-size models fail.
HARD = [
    # Intuitive-but-wrong answer is $0.10. The single most reliable arithmetic trap there is.
    ("A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. "
     "How much does the ball cost? Answer with just the amount.", "0.05"),
    # Tokenizer trap: models routinely miscount letters. strawberry has 3 r, raspberry has 3 r.
    ("How many times does the letter 'r' appear in the phrase 'strawberry raspberry'? "
     "Answer with just the number.", "6"),
    # Inclusion-exclusion: 33 + 20 - 6. Answering 53 means forgetting to subtract the overlap.
    ("How many integers from 1 to 100 inclusive are divisible by 3 or by 5? Answer with just the number.", "47"),
    # Minute carry across the hour: 14:47 + 3h46m. 18:33, not 17:93 or 18:23.
    ("A train departs at 14:47 and the journey takes 3 hours and 46 minutes. "
     "What time does it arrive? Answer in 24-hour HH:MM format.", "18:33"),
    # Harmonic, not arithmetic. 1/(1/6 + 1/4) = 12/5. Answering 5 averages the times.
    ("One pipe fills a tank in 6 hours, another fills it in 4 hours. With both open, how many hours "
     "does it take? Give the answer as a decimal.", "2.4"),
    # Classic weighing puzzle. 3 groups, not binary search — 2 weighings, not 3.
    ("You have 8 identical-looking balls; one is heavier. Using a balance scale, what is the minimum "
     "number of weighings that GUARANTEES finding it? Answer with just the number.", "2"),
    # Inclusive date arithmetic in a leap year: 29 days in Feb, plus Mar 1 itself.
    ("How many days are there from 2024-02-01 to 2024-03-01, counting both endpoints? "
     "Answer with just the number.", "30"),
    # Hex without a calculator. 0xFF XOR 0x0F = 0xF0.
    ("What is 0xFF XOR 0x0F? Answer in hexadecimal.", "F0"),
]


def _token() -> str:
    if tok := os.environ.get("AGENT_SMOKE_TOKEN", "").strip():
        return tok
    raise RuntimeError("no AGENT_SMOKE_TOKEN — run via `doppler run` (agent-service/prd)")


def _req(url: str, token: str, body: dict | None = None, timeout: int = 60,
         machine_id: str | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", "authorization": f"Bearer {token}", "x-agent-account": "user"}
    if machine_id:
        # Pin follow-up requests to the machine that created the task — a multi-machine
        # deploy has no session affinity by default, so an unpinned poll can land on a machine that
        # never saw it and 404. (CUR-895)
        headers["Fly-Force-Instance-Id"] = machine_id
    r = urllib.request.Request(url, data=data, method="POST" if data else "GET", headers=headers)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.load(resp)


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--n", type=int, default=8)
    a.add_argument("--hard", action="store_true", help="the trap set, with ground truth")
    a.add_argument("--base", default=BASE)
    a.add_argument("--timeout", type=int, default=300)
    args = a.parse_args()
    token = _token()

    rows = []
    for i, (prompt, truth) in enumerate((HARD if args.hard else EASY)[: args.n], 1):
        try:
            # No `verify` key at all. A spec here would flip may_judge False and silently turn this
            # probe back into prod_smoke, measuring the thing it was written to stop measuring.
            submitted = _req(f"{args.base}/run", token, {"prompt": prompt, "synthesize": True})
            tid, mid = submitted["id"], submitted.get("machine_id")
        except urllib.error.HTTPError as e:
            print(f"{i}. SUBMIT FAILED {e.code}: {e.read().decode(errors='replace')[:160]}")
            continue
        t0 = time.monotonic()
        st = {}
        while time.monotonic() - t0 < args.timeout:
            time.sleep(3)
            st = _req(f"{args.base}/run/{tid}", token, machine_id=mid)
            if st.get("state") in ("COMPLETED", "FAILED", "CANCELED"):
                break
        rej = st.get("attempt_rejections") or []
        text = (st.get("result") or "")
        # Scored against ground truth, NOT against the judge — a judge cannot be measured by its own
        # verdict. `right` is unknown (None) for open-ended prompts with no single checkable answer.
        right = None if truth is None else (truth.lower() in text.lower())
        rows.append({"n": i, "state": st.get("state"), "verified": st.get("verified"),
                     "method": st.get("verify_method"), "calls": st.get("model_calls"),
                     "rejections": len(rej), "wall": round(time.monotonic() - t0, 1),
                     "right": right, "judge_reason": (st.get("judge_reason") or "")[:50]})
        r = rows[-1]
        mark = {True: "OK ", False: "WRONG", None: "  —  "}[r["right"]]
        print(f"{i}. answer={mark:<5} verified={r['verified']!s:<5} via={r['method']!s:<16} "
              f"calls={r['calls']:<3} rej={r['rejections']} {r['wall']}s  {r['judge_reason']}")

    if not rows:
        return 1
    scored = [r for r in rows if r["right"] is not None]
    fa = [r for r in scored if r["verified"] and not r["right"]]
    fr = [r for r in scored if not r["verified"] and r["right"]]
    if scored:
        print(f"\nagainst ground truth: {sum(1 for r in scored if r['right'])}/{len(scored)} answers correct")
        print(f"  FALSE ACCEPTS (wrong answer badged verified): {len(fa)}  <- makes `verified` a lie")
        print(f"  false rejects (right answer badged unverified): {len(fr)}  <- the previous seat's failure")
    ver = sum(1 for r in rows if r["verified"])
    rej = sum(r["rejections"] for r in rows)
    judged = sum(1 for r in rows if (r["method"] or "").find("judge") >= 0)
    print(f"\n{len(rows)} turns · {ver} verified · {judged} went through the judge · {rej} attempt rejections")
    if judged == 0:
        print("NO TURN REACHED THE JUDGE. CUR-744 (2026-08-29): this is the EXPECTED result for --hard "
              "— none of its 8 riddles can produce an artifact-backed spec, so the judge never gets an "
              "unchecked vote, by design. Only worth investigating if --n includes fixtures that SHOULD "
              "produce a file/shell spec (see --hard's own comments) and still show judged=0; check "
              "AGENT_JUDGE_VERIFY and that best_of > 1 first.")
    if rej == 0 and judged:
        print("Judge ran and rejected nothing. Either the answers were all good or the seat is "
              "permissive; one probe cannot tell those apart — compare against harder prompts.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        sys.exit(str(e))
