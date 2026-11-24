#!/usr/bin/env python3
"""One spec'd task against the deployed service, plus the config it actually ran under.

`scripts/client.py` is the thing you hand a testing user; this is the thing you run yourself after a
deploy. The difference that matters is the `/healthz` block printed first. A config surprise is
usually invisible from the repo (a template that deploys nothing, a toolset the transport ignores)
while the running service will say so if asked. So ask it, on every run, before trusting the numbers
underneath.

The token is read from AGENT_SMOKE_TOKEN (env, else the gitignored .env) and never printed.

  python scripts/prod_smoke.py --base https://…    # the default fixture against that deployment (see below)
  python scripts/prod_smoke.py --base https://… --baseline-tokens 17354 --baseline-calls 3   # paired comparison
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import probe_poll as pp

_req, poll, default_timeout = pp.request, pp.poll, pp.default_timeout

# Deliberately the smallest task with a real side effect: one file, one string. A smoke test that
# fails should implicate the service, not the fixture's difficulty.
PROMPT = "Write the text ok to a file named out.txt in the working directory."
SPEC = {"expect_file": "out.txt", "expect_contains": "ok"}

# The knobs worth seeing before the numbers. Not all of /healthz, only the ones whose drift changes
# what a measurement means.
SHOW = ("model", "compute_provider", "toolsets_effective", "spend_cap", "wall_clock_s",
        "user_daily_tokens", "user_daily_tasks", "sandbox", "step_cap")


def _token() -> str:
    import os
    if tok := os.environ.get("AGENT_SMOKE_TOKEN", "").strip():
        return tok
    sys.exit("no AGENT_SMOKE_TOKEN — run via `doppler run` (agent-service/prd), or mint one with "
             "fly/mint-token.sh")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="the deployment's address, https://<host>")
    ap.add_argument("--prompt", default=PROMPT)
    ap.add_argument("--timeout", type=int, default=0,
                    help="give up polling after this many seconds (default: /healthz's own task budget)")
    ap.add_argument("--baseline-tokens", type=int, help="a prior run's tokens, to print a paired delta")
    ap.add_argument("--baseline-calls", type=int, help="a prior run's model_calls")
    args = ap.parse_args()

    token = _token()
    health = _req(f"{args.base}/healthz")
    width = max(len(k) for k in SHOW)
    for k in SHOW:
        print(f"  {k:<{width}}  {health.get(k)}")
    print()

    # The budget comes from the service, and the poller answers the confirmation every `edit` opens.
    # This fixture writes a file, so without both of those this probe could only ever fail. See
    # scripts/probe_poll.py.
    timeout = args.timeout or default_timeout(health)
    t0 = time.monotonic()
    submitted = _req(f"{args.base}/run", token, {"prompt": args.prompt, "verify": SPEC})
    tid, mid = submitted["id"], submitted.get("machine_id")
    print(f"task {tid} submitted; polling (budget {timeout}s, auto-confirming this task's own writes)")
    st = poll(args.base, token, tid, mid, timeout, verbose=True)
    if st.get("_confirmations"):
        print(f"  {'confirmations':<18}  {st['_confirmations']} answered (always-confirm)")

    for k in ("state", "verified", "verify_method", "verify_autoderived", "verify_check",
              "judge_reason", "attempt_rejections", "model_calls", "tokens"):
        v = st.get(k)
        print(f"  {k:<18}  {json.dumps(v) if isinstance(v, (dict, list)) else v}")
    print(f"  {'wall':<18}  {time.monotonic() - t0:.1f}s")

    calls, toks = st.get("model_calls") or 0, st.get("tokens") or 0
    if args.baseline_tokens and args.baseline_calls and calls:
        b_pc, a_pc = args.baseline_tokens / args.baseline_calls, toks / calls
        print("\nPAIRED against the given baseline — only meaningful if it ran the same fixture")
        print(f"  model calls  {args.baseline_calls} -> {calls}")
        print(f"  tokens       {args.baseline_tokens} -> {toks}")
        print(f"  per call     {b_pc:.0f} -> {a_pc:.0f}   "
              f"({abs(1 - a_pc / b_pc) * 100:.0f}% {'cut' if a_pc < b_pc else 'MORE'})")

    if st.get("state") != "COMPLETED" or st.get("verified") is not True:
        sys.exit("\nFAIL: the deployed service did not complete and verify the simplest spec'd task.\n"
                 "Next command: python scripts/modelcheck.py — it separates a model-side tool-calling\n"
                 "regression (R1h, upstream, nothing here fixes it) from a bug in this service.")
    print("\nPASS: completed and verified. One task is a smoke test, not a sample.")


if __name__ == "__main__":
    main()
