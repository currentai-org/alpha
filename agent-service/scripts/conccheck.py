#!/usr/bin/env python3
"""Does the upstream serve N concurrent streams, or serialize them?

The decision this exists for: agent-service runs best-of-N attempts SEQUENTIALLY, sharing one task
deadline, which makes best_of=3 behave as best_of=1 whenever attempt 1 spends the clock.
Running the attempts concurrently instead is only an improvement if the upstream actually serves them
concurrently. If it serializes, parallel attempts are strictly worse than sequential ones — same total
work, no early exit, and every task pays for every attempt.

The threshold is arithmetic, not taste. With per-call latency L1 solo and LN at N concurrent, N parallel
attempts finish in about calls x LN where N sequential attempts take about N x calls x L1. So parallel
wins iff LN < N x L1, and is close to free iff LN ~ L1. This exits 2 when LN >= N x L1 — the regime where
switching to parallel attempts would make the service slower, not faster.

Deliberately NOT an agent-loop measurement: dividing task wall-clock by metered call count cannot
separate generation from queueing, retries, or session restarts. Hermes'
own `latency=` lines are the ground truth for a real run; this script is the controlled version of the
same measurement, one request in and one duration out, with nothing in between to attribute wrongly.

Usage:  scripts/conccheck.py [--n 1,3] [--rounds 3]
Exit:   0 concurrency is served   2 upstream serializes (parallel attempts would be a regression)
        1 could not run (no credentials, unreachable, model absent)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))


def _env(key: str) -> str:
    """Real env only — run this via `doppler run` (agent-service/prd holds the live values). There is
    no .env-parsing fallback, which avoids a whole class of quote-stripping bugs."""
    return os.environ.get(key, "")


def _model() -> str:
    """Prod's own AGENT_MODEL, not a copy. A concurrency verdict about a model prod doesn't serve is
    worth nothing, and hardcoding it here is how this file would drift from the deploy config."""
    try:
        import prodcheck
        m = prodcheck.prod_env().get("AGENT_MODEL", "")
        if m:
            return m
    except Exception:  # noqa: BLE001 — fall through to the env below
        pass
    return _env("AGENT_MODEL")


# Sized to an agent call rather than a toy one: the runs this decision is about carry 4k-13k prompt
# tokens (Hermes' own logs) because the tool schemas travel on every call. A 50-token probe
# would measure the endpoint's admission path and miss whatever scales with prompt size.
_FILLER = ("The record store keeps notes as JSON. Each note has a title, a body, and tags. "
           "Tags are lowercased and sorted. The store survives being closed and reopened. ") * 120


def _one_call(base: str, token: str, model: str, max_tokens: int, salt: int = 0) -> tuple[float, int, str]:
    """One non-streaming completion. Returns (seconds, completion_tokens, error).

    The ASK has to demand length, not just permit it. A prompt like "summarise in one paragraph"
    with max_tokens as the only lever leaves the median unchanged when that lever is raised — the model
    writes its paragraph and stops either way, so the run measures prefill and not decode. Decode is
    what N concurrent agent attempts contend over."""
    # Distinct prefix per concurrent call, and it has to lead. CSCS does not re-prefill a repeated prefix
    # (measured, CUR-138), so N identical prompts share one prefill and the probe would report the cost of
    # concurrency for traffic nobody sends — real concurrent tasks are different tasks. The salt goes at
    # the FRONT because a shared prefix with a varying tail still hits the cache for everything before the
    # tail, which is most of the prompt.
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": "You are a careful assistant who writes at length."},
                     {"role": "user", "content": f"[request {salt}] " + _FILLER + (
                         f"\n\nWrite a detailed technical specification for this record store: data model, "
                         f"file format, every operation with its edge cases, error handling, and a test "
                         f"plan. Aim for roughly {max_tokens * 3 // 4} words. Do not stop early.")}],
        "temperature": 0.0, "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=body, method="POST",
                                 headers={"authorization": f"Bearer {token}",
                                          "content-type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        return time.monotonic() - t0, 0, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — a transport failure is a datum, not a crash
        return time.monotonic() - t0, 0, f"{type(e).__name__}"
    return (time.monotonic() - t0,
            int((d.get("usage") or {}).get("completion_tokens") or 0), "")


def measure(base: str, token: str, model: str, n: int, rounds: int, max_tokens: int) -> tuple[list, list]:
    """`rounds` batches of `n` simultaneous calls. Returns (latencies, errors)."""
    lat: list = []
    errs: list = []
    outs: list = []
    for rnd in range(rounds):
        with cf.ThreadPoolExecutor(max_workers=n) as ex:
            for secs, out, err in ex.map(
                    lambda i: _one_call(base, token, model, max_tokens, salt=rnd * 1000 + i),  # noqa: B023
                    range(n)):   # ex.map is consumed by this same for-loop, before `rnd` is rebound
                if err:
                    errs.append(err)
                else:
                    lat.append(secs)
                    outs.append(out)
    return lat, errs, outs


def verdict(solo: float, conc: float, n: int) -> tuple[bool, str]:
    """Parallel attempts beat sequential ones iff N concurrent calls cost less than N serial ones."""
    if solo <= 0:
        return False, "no solo baseline"
    ratio = conc / solo
    if ratio >= n:
        return False, (f"{ratio:.1f}x slower at n={n} — at or past the {n}x line where {n} parallel "
                       f"attempts cost more wall-clock than {n} sequential ones")
    if ratio <= 1.3:
        return True, f"{ratio:.1f}x — served concurrently, parallel attempts are close to free"
    return True, (f"{ratio:.1f}x — degraded but under the {n}x line, so parallel attempts still finish "
                  f"sooner than sequential ones")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", default="1,3", help="concurrency levels to compare (default 1,3)")
    ap.add_argument("--rounds", type=int, default=3, help="batches per level (default 3)")
    ap.add_argument("--max-tokens", type=int, default=400,
                    help="completion cap per call — held FIXED across levels so latency differences are "
                         "queueing and not a different amount of generation (default 400)")
    args = ap.parse_args()

    base, token, model = _env("PROVIDER_CSCS_BASE"), _env("PROVIDER_CSCS_TOKEN"), _model()
    if not base or not token:
        sys.exit("set PROVIDER_CSCS_BASE and PROVIDER_CSCS_TOKEN (env or .env)")
    if not model:
        sys.exit("no AGENT_MODEL — neither the deployed config nor the environment names one")
    levels = [int(x) for x in args.n.split(",") if x.strip()]
    if 1 not in levels:
        sys.exit("--n must include 1: without a solo baseline there is nothing to compare against")

    print(f"== concurrency == {model} at {base}")
    print(f"   {args.rounds} rounds per level, max_tokens={args.max_tokens} fixed, "
          f"prompt ~{len(_FILLER)//4} tokens\n")
    medians: dict = {}
    gen: dict = {}
    for n in levels:
        lat, errs, outs = measure(base, token, model, n, args.rounds, args.max_tokens)
        if not lat:
            sys.exit(f"n={n}: every call failed ({', '.join(sorted(set(errs))) or 'no detail'})")
        med = statistics.median(lat)
        medians[n] = med
        gen[n] = statistics.median(outs) if outs else 0
        p90 = sorted(lat)[int(len(lat) * 0.9) - 1] if len(lat) >= 2 else med
        note = f"  ({len(errs)} failed: {', '.join(sorted(set(errs)))})" if errs else ""
        # out_tok is PRINTED, not assumed. Without it the run cannot distinguish "concurrency is free"
        # from "nothing generated, so there was nothing to contend over" — and those look identical.
        print(f"  n={n:<2} median {med:6.1f}s   p90 {p90:6.1f}s   out_tok {gen[n]:5.0f}   "
              f"n_calls={len(lat)}{note}")

    solo = medians[1]
    worst_ok = True
    print()
    # A verdict drawn from calls that barely generated describes prefill, and prefill is not what N
    # concurrent attempts contend over. Say so rather than let the ratio stand unqualified.
    if gen.get(1, 0) < args.max_tokens * 0.5:
        print(f"  NOTE: solo calls generated a median {gen.get(1, 0):.0f} tokens against a "
              f"{args.max_tokens}-token cap, so this compares prefill more than decode. Raise --max-tokens "
              f"or strengthen the ask before trusting the ratio for long agent turns.")
    for n in levels:
        if n == 1:
            continue
        ok, why = verdict(solo, medians[n], n)
        print(f"  {'ok ' if ok else 'BAD'} n={n}: {why}")
        worst_ok = worst_ok and ok
    print("\n  Parallel best-of-N is worth building only where this says ok. Where it says BAD the "
          "upstream is serializing,\n  and sequential attempts with a per-attempt clock are the "
          "correct shape instead.")
    sys.exit(0 if worst_ok else 2)


if __name__ == "__main__":
    main()
