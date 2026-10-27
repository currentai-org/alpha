#!/usr/bin/env python3
"""Does the agent still know what day it is — and does knowing still leave a relative deadline alone?

WHY THIS EXISTS. None of the seven `*_NOTE` constants in app.py states the current date, yet a prose
deadline question reaches the model with a wall-clock anchor (CUR-1217): on both transports, with zero
tool calls, the agent resolves a lapsed-deadline question with the right arithmetic. The anchor comes
from one layer up:
Hermes' own system prompt renders

    Conversation started: {%A, %B %d, %Y}{ (zone) }

unconditionally (agent/system_prompt.py at HERMES_SHA 29112bef, line ~995), plus a second
"Today's date (as of the last context rebuild)" line once a session crosses midnight.

So nothing here needs a NOW_NOTE, and adding one would put a second date into a prompt whose
note ORDER decides which instruction holds (CUR-706, CUR-752). What this repo lacks is an
assertion that the inherited property is still there. It rides on a pinned upstream SHA
(CUR-748), and upstream has a live code path that deliberately DROPS the date line
(`_bot_chat_timeless_prompt`). A bump that removed it would change nothing visible here — no test, no
CI job, and agent-service's deploy workflow runs no post-deploy probe at all. This is that probe.

  today     a date question with no tool available -> must match the date THIS PROCESS computes.
            Two clocks, one assertion: the expected value must not come from the service.
  lapsed    the ticket's own stated impact — "has this notice period lapsed?" -> must name the
            end date this probe derives itself (1 Aug 2026 + 28 days) and say it has passed.
  relative  a plain-language rewrite of a notice whose only deadline is RELATIVE -> must STAY
            relative. A model that knows today's date is a model equipped to convert one into a
            fixed date, which is the drift CUR-672/CUR-676 address. A green
            `today` leg over a red `relative` leg is a net loss, so a green run requires both.

The `relative` fixture deliberately carries no absolute date of its own, which makes its assertion
unambiguous: any absolute date in that answer was invented, since there was none to copy.

The token comes from AGENT_SMOKE_TOKEN and is never printed.

  doppler run -p agent-service -c prd -- python scripts/date_anchor_probe.py
  doppler run -p agent-service -c prd -- python scripts/date_anchor_probe.py --transport oneshot
  doppler run -p agent-service -c prd -- python scripts/date_anchor_probe.py --only relative -k 3
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import probe_poll as pp

_req, poll, default_timeout = pp.request, pp.poll, pp.default_timeout

DEFAULT_BASE = os.environ.get("AGENT_URL", "http://localhost:8731")  # the compose.yaml port

# No tool can answer this and no file is wanted — the prose path is the whole point, and it is all a
# `new`-tier caller has (no terminal, no code_execution; see _policy_note).
TODAY_PROMPT = "What is today's date? Answer in one short sentence, in prose. Do not write a file."

# The ticket's own impact sentence, made concrete. Derived here rather than written down: see _lapsed().
NOTICE_DATE = datetime(2026, 8, 1, tzinfo=UTC)
NOTICE_DAYS = 28
LAPSED_PROMPT = (
    f"A notice dated 1 August 2026 says: \"Any representations you wish to make must be submitted "
    f"within {NOTICE_DAYS} days from the date of this notice.\" Has that deadline passed? Answer in "
    f"one or two sentences, in prose, and say what the final date was. Do not write a file."
)

# A notice with a relative deadline and no absolute date anywhere in it. "entitlement"/"under review"
# are CUR-676's category and status axes, kept so a failure implicates one axis rather than three.
RELATIVE_PROMPT = (
    "Rewrite the following notice in plain language, in English, so that someone without legal "
    "training can act on it. Keep it short. Do not write a file.\n\n"
    "---\n"
    "Further to our review of your entitlement to the supplementary allowance, we write to advise "
    "that your entitlement remains under review pending receipt of the outstanding documentation. "
    "Any representations you wish to make must be submitted within 28 days from the date of this "
    "notice. Failure to respond within that period may result in the review concluding on the "
    "information currently held."
)

MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
# An absolute date in any shape this model has actually produced: ISO, "14 September 2026",
# "September 14, 2026", "14/09/2026".
ABSOLUTE_DATE = re.compile(
    rf"\b\d{{4}}-\d{{2}}-\d{{2}}\b|\b\d{{1,2}}\s+(?:{MONTHS})\s+\d{{4}}\b|"
    rf"\b(?:{MONTHS})\s+\d{{1,2}},?\s+\d{{4}}\b|\b\d{{1,2}}/\d{{1,2}}/\d{{4}}\b",
    re.IGNORECASE,
)
# The other half of CUR-672's drift, and the half a date-aware model is newly equipped to reach for:
# re-anchoring the countdown to the reader instead of to the notice.
REANCHORED = re.compile(
    r"\bfrom today\b|\bfrom now\b|\bstarting today\b|\bwithin 28 days of (?:today|receiving|receipt)\b|"
    r"\bfrom the day you (?:receive|read|get)\b|\bfrom when you (?:receive|read|get)\b",
    re.IGNORECASE,
)
KEPT_RELATIVE = re.compile(
    r"28\s*days?.{0,60}?\b(?:notice|notification|letter)\b|"
    r"\b(?:notice|notification|letter)\b.{0,60}?28\s*days?",
    re.IGNORECASE | re.DOTALL,
)
NEGATED = re.compile(r"\b(?:not|hasn't|has not|hasn’t|no[t]? yet)\b\s+(?:\w+\s+){0,3}"
                     r"(?:passed|expired|lapsed|elapsed)", re.IGNORECASE)
AFFIRMED = re.compile(r"\b(?:passed|expired|lapsed|elapsed|is over|has closed)\b", re.IGNORECASE)


def _token() -> str:
    if tok := os.environ.get("AGENT_SMOKE_TOKEN", "").strip():
        return tok
    sys.exit("no AGENT_SMOKE_TOKEN — run via `doppler run -p agent-service -c prd`, or mint one as "
             "an HS256 JWT signed with WEBUI_SECRET_KEY")


def _run_task(base: str, token: str, prompt: str, transport: str | None, poll_timeout: int) -> dict:
    body: dict = {"prompt": prompt}
    if transport:
        body["transport"] = transport
    submitted = _req(f"{base}/run", token, body)
    # Every leg says "do not write a file", but COMPUTATION_NOTE pushes date arithmetic toward the
    # terminal tool and CUR-975 made that always-confirm too — so a `lapsed` run that decides to check
    # its own subtraction would pause forever without this. It has not happened yet; that is luck about
    # which path the model picks, not a property of the prompt (CUR-1224).
    return poll(base, token, submitted["id"], submitted.get("machine_id"), poll_timeout)


def _answer(st: dict) -> str:
    return (st.get("result") or st.get("summary") or st.get("error") or "").strip()


def _renderings(d: datetime) -> list[str]:
    return [f"{d:%Y-%m-%d}", f"{d.day} {d:%B} {d.year}", f"{d:%B} {d.day}, {d.year}",
            f"{d:%B} {d.day} {d.year}", f"{d:%d/%m/%Y}", f"{d:%m/%d/%Y}"]


def _today(answer: str) -> tuple[bool, str]:
    low, now = answer.lower(), datetime.now(UTC)
    for want in _renderings(now):
        if want.lower() in low:
            return True, f"contains {want!r}"
    # An off-by-one is a milder, differently-caused defect than no anchor at all (a timezone, not a
    # missing line) — say which one it is rather than reporting both as a bare FAIL.
    for delta, label in ((-1, "yesterday"), (1, "tomorrow")):
        d = now + timedelta(days=delta)
        if any(w.lower() in low for w in _renderings(d)[:3]):
            return False, f"answered {label}'s UTC date — off by one (timezone), not unanchored"
    return False, f"no rendering of {now:%Y-%m-%d} anywhere in the answer"


def _lapsed(answer: str) -> tuple[bool, str]:
    end = NOTICE_DATE + timedelta(days=NOTICE_DAYS)          # derived here, not copied from the answer
    low = answer.lower()
    if not any(w.lower() in low for w in _renderings(end)):
        return False, f"never names the end date ({end:%-d %B %Y})"
    if NEGATED.search(answer):
        return False, f"names {end:%-d %B %Y} but says it has NOT passed, on {datetime.now(UTC):%-d %B %Y}"
    if not AFFIRMED.search(answer):
        return False, "names the end date but never says whether it has passed"
    return True, f"named {end:%-d %B %Y} and said it has passed"


def _relative(answer: str) -> tuple[bool, str]:
    if m := ABSOLUTE_DATE.search(answer):
        return False, (f"converted the relative deadline to an absolute date ({m.group(0)!r}) — the "
                       f"source contains no date to copy, so this one was computed")
    if m := REANCHORED.search(answer):
        return False, f"re-anchored the countdown to the reader ({m.group(0)!r}), not to the notice"
    if not KEPT_RELATIVE.search(answer):
        return False, "lost the 28-days-from-this-notice anchor entirely"
    return True, "kept 28 days relative to the notice, no absolute date, no re-anchor"


LEGS = {
    "today": (TODAY_PROMPT, _today),
    "lapsed": (LAPSED_PROMPT, _lapsed),
    "relative": (RELATIVE_PROMPT, _relative),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--only", choices=sorted(LEGS), help="run one leg instead of all three")
    ap.add_argument("--transport", choices=("acp", "oneshot"),
                    help="force a transport (default: the service's own pick, currently acp)")
    ap.add_argument("-k", type=int, default=1,
                    help="runs per leg — prompt-shaped behaviour is sampled, never proved by n=1")
    ap.add_argument("--min-pass", type=int, default=0,
                    help="passes a leg needs out of -k (default: all k). A removed anchor fails every "
                         "run, so 2 of 3 still catches it; one wrong sample in three does not block "
                         "a deploy (two builds, two different legs on 2026-10-09)")
    ap.add_argument("--timeout", type=int, default=0,
                    help="per-leg poll budget (default: /healthz's own wall_clock_task_s)")
    args = ap.parse_args()

    token = _token()
    health = _req(f"{args.base}/healthz")
    print(f"  base   {args.base}")
    print(f"  build  {health.get('build')}   model {health.get('model')}   acp {health.get('acp')}")
    print(f"  clock  {datetime.now(UTC):%Y-%m-%d %H:%M}Z (this process — the expected value)\n")

    legs = [args.only] if args.only else list(LEGS)
    timeout = args.timeout or default_timeout(health)
    need = args.min_pass or args.k
    if not 1 <= need <= args.k:
        ap.error(f"--min-pass must be between 1 and -k ({args.k})")
    failures, red_legs = 0, []
    for leg in legs:
        prompt, check = LEGS[leg]
        passed = 0
        for i in range(args.k):
            st = _run_task(args.base, token, prompt, args.transport, timeout)
            answer = _answer(st)
            ok, why = check(answer)
            failures += 0 if ok else 1
            passed += 1 if ok else 0
            print(f"[{'PASS' if ok else 'FAIL'}] {leg} {i + 1}/{args.k}  ({st['_wall']:.0f}s, "
                  f"state={st.get('state')}, transport={st.get('transport_used')}, "
                  f"calls={st.get('model_calls')})")
            print(f"       {why}")
            print(f"       answer: {answer[:400]!r}{'…' if len(answer) > 400 else ''}\n")
        if passed < need:
            red_legs.append(f"{leg} {passed}/{args.k}")

    total = len(legs) * args.k
    if red_legs:
        print(f"FAIL: {', '.join(red_legs)} passed, under {need} of {args.k}; {failures}/{total} runs red.\n"
              f"  today/lapsed red  -> the Hermes system-prompt date anchor is gone or moved. Check\n"
              f"                       HERMES_SHA in deploy/Dockerfile against agent/system_prompt.py\n"
              f"                       upstream before adding any prompt text here.\n"
              f"  relative red      -> something reintroduced CUR-672's deadline drift. A date anchor\n"
              f"                       that breaks this leg is worse than no date anchor.")
        return 1
    print(f"PASS: {total - failures}/{total} runs, every leg at least {need} of {args.k}. The agent knows the date, resolves a lapsed deadline, and "
          f"still keeps a relative deadline relative.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
