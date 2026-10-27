#!/usr/bin/env python3
"""The chat surface's own shape against a deployed service: no spec, auto mode, nobody answering cards (CUR-4595).

`prod_smoke.py` hands the agent a verify spec, answers every confirmation, and asks for `out.txt`. A person in
chat does none of that: the turn is `synthesize`d with no spec, auto mode decides each call, and they ask for a
Word or Excel file. This probe runs that second path, which the smoke does not exercise.

Two modes. `chat` sends exactly what the chat client sends (`synthesize`), so whether a spec is derived is a model
call's coin flip, and only the no-spec turns reach the file checks (`verify_autoderived=false`). `nospec` sends no `synthesize` and no spec, which takes that no-spec path every time,
so it is the deterministic mode and the one the deploy runs.

A run passes when the task completes, delivers a non-empty file with the asked-for extension, and the answer is
not the give-up text and carries no `unrun_detail` (any value puts a caveat over the answer on the site). Confirmation cards are counted, never answered:
an in-folder write in auto mode should raise none.

  python scripts/chat_file_probe.py --base https://<agent-service-host> -k 3 --min-pass 3

The token is read from AGENT_SMOKE_TOKEN and never printed. Prompts are our own fixtures, not anyone's chat.
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
import probe_poll as pp
from xlsx_check import chart_problems

GIVE_UP = "I was not able to complete this after several attempts"

CASES = (
    ("docx-letter", ".docx",
     "Write a short, polite letter to my landlord asking them to repair the heating, which has not worked for a "
     "week. Save it as a Word document."),
    ("xlsx-chart", ".xlsx",
     "Make an Excel spreadsheet comparing rent, commute time and green space for four neighbourhoods of your "
     "choice, with a bar chart of the rents. Mark the figures as illustrative."),
    ("docx-bilingual", ".docx",
     "Write a one-page note for parents about a class trip to a science museum, in English and then in "
     "Portuguese, and save it as a Word document."),
)


def _token() -> str:
    if tok := os.environ.get("AGENT_SMOKE_TOKEN", "").strip():
        return tok
    sys.exit("no AGENT_SMOKE_TOKEN — run under `doppler run -p agent-service -c <config>`")


def judge(status: dict, ext: str) -> list[str]:
    """Why this run fails, or [] when it passes. PURE, so the rules unit-test on a status dict alone."""
    why = []
    if status.get("state") != "COMPLETED":
        why.append(f"state {status.get('state')}: {status.get('error') or status.get('summary')}")
    made = [a for a in status.get("artifacts") or [] if str(a.get("name", "")).lower().endswith(ext)
            and (a.get("bytes") or 0) > 0]
    if not made:
        names = [a.get("name") for a in status.get("artifacts") or []]
        why.append(f"no non-empty {ext} delivered (artifacts: {names})")
    if GIVE_UP in (status.get("result") or ""):
        why.append("the answer is the give-up text")
    # Any non-empty unrun_detail puts a caveat over the answer on the website (`Boolean(unrun_detail.trim())`),
    # so the person sees a warning whatever its prefix says.
    if detail := (status.get("unrun_detail") or "").strip():
        why.append(f"unrun_detail set, so the site shows a caveat ({detail})")
    return why


def judge_charts(files: dict[str, bytes | None]) -> list[str]:
    """Why the delivered workbooks' charts fail, or [] when at least one chart exists and every one plots the cells
    it should (CUR-4600). Same rules the service applies before answering, so a pass here is the file a person gets."""
    if not files:
        return []                                       # judge() already reports the missing file
    why, charts = [], 0
    for name, raw in files.items():
        if raw is None:
            why.append(f"{name} could not be downloaded")
            continue
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                charts += sum(n.startswith("xl/charts/chart") for n in z.namelist())
        except zipfile.BadZipFile:
            why.append(f"{name} is not a readable workbook")
            continue
        why += [f"{name}: {p}" for p in chart_problems(raw)]
    if not charts and not why:
        why.append("no chart in the delivered workbook")
    return why


def _download(base: str, token: str, session_id: str, name: str, machine_id: str | None) -> bytes | None:
    headers = {"authorization": f"Bearer {token}", "x-agent-account": "user"}
    if machine_id:
        headers["Fly-Force-Instance-Id"] = machine_id
    req = urllib.request.Request(f"{base}/sessions/{session_id}/artifacts/{quote(name)}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.URLError:
        return None


def run_once(base: str, token: str, prompt: str, timeout: int, mode: str,
             fetch_ext: str | None = None) -> tuple[dict, int, float]:
    """One run to a terminal state. With `fetch_ext`, every delivered file with that extension is downloaded
    from the session before it is reaped and returned under the status's `_files`."""
    t0 = time.monotonic()
    body = {"prompt": prompt, "approval_mode": "auto", "session_id": f"probe-{uuid.uuid4().hex[:16]}"}
    if mode == "chat":
        body["synthesize"] = True
    sub = pp.request(f"{base}/run", token, body)
    cards = 0
    deadline = time.monotonic() + timeout
    while True:
        st = pp.request(f"{base}/run/{sub['id']}", token, machine_id=sub.get("machine_id"))
        cards = max(cards, len(st.get("pending_confirmations") or []))
        if st.get("state") in ("COMPLETED", "FAILED", "CANCELLED"):
            st = {**st, "id": sub["id"]}
            if fetch_ext:
                st["_files"] = {a["name"]: _download(base, token, body["session_id"], a["name"], sub.get("machine_id"))
                                for a in st.get("artifacts") or []
                                if str(a.get("name", "")).lower().endswith(fetch_ext)}
            return st, cards, time.monotonic() - t0
        if time.monotonic() > deadline:
            return {**st, "id": sub["id"], "state": f"TIMEOUT({st.get('state')})"}, cards, time.monotonic() - t0
        time.sleep(3)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("-k", type=int, default=1, help="runs per case")
    ap.add_argument("--min-pass", type=int, default=1, help="runs per case that must pass")
    ap.add_argument("--only", help="run one case by name")
    ap.add_argument("--mode", choices=("nospec", "chat"), default="nospec")
    args = ap.parse_args()
    token = _token()
    timeout = pp.default_timeout(pp.request(f"{args.base}/healthz"))
    short = []
    for name, ext, prompt in CASES:
        if args.only and name != args.only:
            continue
        passed = 0
        for i in range(args.k):
            charted = ext == ".xlsx"                    # the xlsx case asks for a chart; read what it plots
            st, cards, wall = run_once(args.base, token, prompt, timeout, args.mode, ext if charted else None)
            why = judge(st, ext) + (judge_charts(st.get("_files") or {}) if charted else [])
            passed += not why
            verdict = "PASS" if not why else "FAIL: " + "; ".join(why)
            print(f"{name} [{args.mode}] run {i + 1}/{args.k} · task {st.get('id', '?')} · {wall:.0f}s · cards seen {cards} · "
                  f"unrun_detail={st.get('unrun_detail') or '-'} · {verdict}", flush=True)
        print(f"{name}: {passed}/{args.k}", flush=True)
        if passed < args.min_pass:
            short.append(f"{name} {passed}/{args.k}")
    if short:
        sys.exit("FAIL: below --min-pass: " + ", ".join(short))
    print("PASS: every case met --min-pass")


if __name__ == "__main__":
    main()
