#!/usr/bin/env python3
"""Does the model still emit tool calls — the thing every task actually rides on?

`check_model_live()` in scripts/dogfood.py asks whether the model id is in the catalog. An id can stay
in the catalog and answer while tool ARGUMENTS come back as ordinary message content whenever the
prompt carries instruction text (`finish_reason=stop`, no `tool_calls`), and every agent task then
fails. From outside, a working service and a broken one look identical unless something probes the
capability.

This is that probe. Four conditions, because when tool calling breaks they do NOT agree and the
disagreement is the diagnosis:

  bare              a bare user turn                   — still works when tool calling is broken
  system            instruction text in a system turn   — fails; this is what Hermes sends
  stream            the same, streamed                  — fails; this is how Hermes sends it
  folded            the same text in the USER turn      — red at baseline; a control, not a check
  neutral           unrelated instruction, USER turn    — green at baseline; what `folded` is measured against

`folded` fails 0/3 on a healthy endpoint and is excluded from the exit code, because a permanently-red
row is one people learn to scroll past. `neutral` is here so that red row means something. On a healthy
endpoint, one tool throughout:

    task alone, user turn ....................... 3/3
    NEUTRAL instruction + task, user turn ....... 3/3
    2.4KB of non-instruction padding + task ..... 3/3
    TOOL-REFERENCING instruction + task, user ... 0/3
    the same tool-referencing text, system turn .. 3/3

So it is not length, not position, and not the presence of instructions. Text *about the tools*
suppresses tool calling when it sits in the user turn, and the identical text in a system turn is fine.
The mechanism is not established. Hermes puts its instructions in a system turn, so the user-turn case
is not on our path.

`folded` is red at baseline, so it is a control: it carries no signal about instruction text versus role.

Repeats default to 3 because temperature 0 is not deterministic on this endpoint (about 5% flips over 20
samples on one fixture), so a single sample can mislead.

  python scripts/modelcheck.py              # against prod's own AGENT_MODEL
  python scripts/modelcheck.py -n 5         # more repeats
  python scripts/modelcheck.py --model X    # some other id

Exit 0 every condition passed · 2 tool calling is broken (an instruction-carrying condition failed) ·
1 could not run (missing token, unreachable, id not in the catalog).

NOTE: this script hits CSCS DIRECTLY, using PROVIDER_CSCS_TOKEN/BASE from the CALLER's own
local env. Production does NOT talk to CSCS directly (CUR-189): the model app has no CSCS credential of
its own; it proxies through the internal gateway app, which holds its OWN separate CSCS credential. A
local run of this script therefore tests a different credential over a different network path than any real request takes,
and it can return 404 on every condition, `bare` included, while the same model completes real tasks
through the deployed path (`scripts/client.py` against the live service URL, or
`scripts/dogfood.py apertus15`). A uniform failure here — especially 404, which is outside the documented
error codes (401 bad token, 503 unrecognized model id) — is at least as likely to
mean "this local credential or IP is not allowlisted" as "CSCS is down." Confirm against the actual
deployed service (`scripts/client.py`) before treating a red run here as a production failure.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# One tool is enough: the failure is identical at 1 and at 8 tools, so schema count is not the variable
# and a wider set would only cost tokens.
TOOL = [{"type": "function", "function": {
    "name": "write_file", "description": "Write text to a file.",
    "parameters": {"type": "object",
                   "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                   "required": ["path", "content"]}}}]
INSTRUCTION = "You are a coding agent. Use the provided tools to act, and do not describe what you would do."
# Same length and register as INSTRUCTION, saying nothing about tools. The pair isolates tool-talk from
# "there is extra text here"; without it the `folded` row reads as an unexplained permanent failure.
UNRELATED = "You are a careful assistant. Respond concisely, prefer British spelling, and do not apologise."
TASK = "Write the text ok to a file named out.txt."


def _env() -> dict[str, str]:
    """Real env only — run this via `doppler run` (agent-service/prd holds the live values)."""
    return dict(os.environ)


def _prod_model() -> str:
    """Whatever the DEPLOYED config says, not whatever this file was written knowing. Probing a model
    prod does not run measures a model that is not shipped."""
    try:
        spec = importlib.util.spec_from_file_location("prodcheck", ROOT / "eval" / "prodcheck.py")
        pc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(spec and pc)
        return pc.prod_env().get("AGENT_MODEL", "")
    except Exception:  # noqa: BLE001 — a missing/renamed config must not stop the probe, only un-default it
        return ""


def _post(base: str, tok: str, body: dict, timeout: int = 120) -> tuple[int, str]:
    # user-agent matches api/proxy.py's UPSTREAM_USER_AGENT — see the matching comment in dogfood.py's
    # snapshot_models() for why this is here (CUR-602).
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {tok}",
                                          "content-type": "application/json",
                                          "user-agent": "curl/8.5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode(errors="replace")
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def _called(raw: str, stream: bool) -> bool:
    """Whether a tool call actually came back. A streamed response arrives as name/arguments deltas and
    can carry frames with an empty `choices` list, which is legal and must not raise."""
    if not stream:
        try:
            msg = json.loads(raw)["choices"][0]["message"]
        except Exception:  # noqa: BLE001
            return False
        return bool(msg.get("tool_calls"))
    for line in raw.splitlines():
        if not line.startswith("data: ") or line.strip() == "data: [DONE]":
            continue
        try:
            choices = json.loads(line[6:]).get("choices") or []
        except Exception:  # noqa: BLE001
            continue
        for ch in choices:
            for call in ch.get("delta", {}).get("tool_calls") or []:
                if (call.get("function") or {}).get("name"):
                    return True
    return False


CONDITIONS = (
    # name,     messages builder,                                                    stream, prod-relevant
    ("bare",   lambda: [{"role": "user", "content": TASK}],                            False, False),
    ("system", lambda: [{"role": "system", "content": INSTRUCTION},
                        {"role": "user", "content": TASK}],                            False, True),
    ("stream", lambda: [{"role": "system", "content": INSTRUCTION},
                        {"role": "user", "content": TASK}],                            True,  True),
    # Controls, deliberately last and deliberately not prod-relevant. `folded` is red at baseline;
    # `neutral` is the same shape with an instruction that says nothing about tools, and is green. The
    # pair is what makes the red row mean "tool-talk in a user turn" rather than "user turns are broken".
    ("folded",  lambda: [{"role": "user", "content": f"{INSTRUCTION}\n\n{TASK}"}],      False, False),
    ("neutral", lambda: [{"role": "user", "content": f"{UNRELATED}\n\n{TASK}"}],        False, False),
)


def probe(base: str, model: str, tok: str, repeats: int,
          tool_choice: str = "auto") -> list[tuple[str, int, int, bool, str]]:
    """(condition, hits, repeats, prod_relevant, note) per condition.

    `tool_choice` is the knob, not a constant, because "auto" measures whether the model CHOOSES to call
    a tool and "required" measures whether the SERVER will make it. Those are different questions.
    The second is the one that matters when a model answers with a long chat message containing the whole
    deliverable instead of writing a file, which no amount of prompt wording makes impossible the way a
    server-side constraint does. A non-200 on "required" is itself the answer —
    it means the fix is not available on this endpoint."""
    rows = []
    for name, build, stream, relevant in CONDITIONS:
        hits, note = 0, ""
        for _ in range(repeats):
            status, raw = _post(base, tok, {"model": model, "temperature": 0, "max_tokens": 300,
                                            "messages": build(), "tools": TOOL,
                                            "tool_choice": tool_choice, "stream": stream})
            if status != 200:
                note = f"HTTP {status}" if status else raw[:60]
                continue
            hits += _called(raw, stream)
        rows.append((name, hits, repeats, relevant, note))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--repeats", type=int, default=3)
    ap.add_argument("--model", default="")
    ap.add_argument("--base", default="")
    ap.add_argument("--tool-choice", default="auto", choices=("auto", "required", "none"),
                    help="auto: does the model CHOOSE to call a tool. required: will the SERVER make it.")
    args = ap.parse_args()

    env = _env()
    base = (args.base or env.get("PROVIDER_CSCS_BASE") or env.get("MODEL_UPSTREAM_BASE") or "").rstrip("/")
    tok = env.get("PROVIDER_CSCS_TOKEN") or env.get("MODEL_UPSTREAM_TOKEN") or ""
    model = args.model or _prod_model()
    if not (base and tok):
        print("no upstream base/token (env or .env: PROVIDER_CSCS_BASE/_TOKEN)", file=sys.stderr)
        return 1
    if not model:
        print("no model: prod config unreadable and --model not given", file=sys.stderr)
        return 1

    print(f"  base   {base}\n  model  {model}\n  n      {args.repeats} per condition"
          f"\n  choice {args.tool_choice}\n")
    rows = probe(base, model, tok, args.repeats, args.tool_choice)
    for name, hits, n, relevant, note in rows:
        mark = "ok " if hits == n else ("   " if hits else "BAD")
        tag = ("  <- prod sends this shape" if relevant else
               {"folded": "  (control, red at baseline: tool-talk in a user turn)",
                "neutral": "  (control, green at baseline: the same shape without tool-talk)"}.get(name, ""))
        print(f"  {mark} {name:<7} {hits}/{n} tool_calls{tag}{'   ' + note if note else ''}")

    broken = [r for r in rows if r[3] and r[1] < r[2]]
    if not broken:
        print("\nTool calling is intact on every shape prod sends. A failing task is not this.")
        return 0
    bare_ok = any(r[0] == "bare" and r[1] == r[2] for r in rows)
    print(f"\nREGRESSION: {', '.join(r[0] for r in broken)} did not produce a tool call.")
    if bare_ok:
        print("`bare` still works, so the capability is intact and the trigger is the instruction text —\n"
              "the instruction text differs between the passing and failing shapes. Agent tasks that send a\n"
              "failing shape fail until the upstream behaviour changes; re-run this to see whether it has.")
    else:
        print("`bare` failed too, so this is broader than the R1h shape.\n"
              "Before treating this as a production incident: this script hits CSCS DIRECTLY with a\n"
              "credential from YOUR local env, not the path production takes (the model app proxies\n"
              "through the internal LiteLLM gateway, which holds its own separate CSCS token). A uniform\n"
              "failure across every condition, including `bare`, is at least as likely to be this script's\n"
              "own credential or IP being rejected as it is a real outage — confirmed live 2026-08-25, a\n"
              "404 here while the real deployed service completed a task in the same minute. Confirm\n"
              "against the actual service (scripts/client.py against its real URL) before escalating.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
