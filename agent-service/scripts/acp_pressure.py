#!/usr/bin/env python3
"""Local pressure test for the agentic stack — concurrency, cancel, and wall-clock, ACP or oneshot.

Boots the real proxy+app (Apertus-1.5 on CSCS) with a scenario-specific env and hammers /run to
exercise the parts that only break under load or interruption: the MAX_CONCURRENCY slot gate, per-user
reservations, gateway nonce grant/revoke, mid-flight DELETE, the wall-clock cap — and, most importantly,
that every path REAPS its `hermes`/`bwrap` subprocess (no orphans, no stuck slots).

Scenarios (default: all):
  sat    — fire N concurrent submits at MAX_CONCURRENCY=C → assert clean 429 overflow, all accepted runs
           reach COMPLETED, and afterwards zero orphan agent procs + slots fully recovered (leak check).
  cancel — submit a batch, DELETE half mid-flight → assert CANCELED + zero orphans + nonces revoked.
  wall   — WALL_CLOCK tiny → a normal task trips it → assert FAILED(wall-clock) + zero orphans.

Usage:
  IK_TOKEN=... PYBIN=.../python HERMES_BIN=.../hermes \
    python scripts/acp_pressure.py --transport acp --sandbox off [--only sat,cancel,wall]
"""
import argparse
import concurrent.futures as cf
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "api"))

import dogfood as df  # noqa: E402

MODEL = df.MODES["apertus15"]["model"]
FAST_TASK = "Reply with only the single word OK, then stop. Do not use any tools."
WORK_TASK = ("Using the terminal tool, create a file named p.txt containing the word DONE in the current "
             "directory, then read it back to confirm. Then stop.")
WORK_VERIFY = {"expect_file": "p.txt", "expect_contains": "DONE"}
# Deliberately multi-step so a mid-range wall-clock cap axes the run DURING a tool call (a live child),
# not while idling on a model response — the more interesting reap case.
MULTITOOL_TASK = ("Using the terminal tool, do these one at a time: create dir work/, then create "
                  "work/1.txt..work/5.txt each containing its number, then list work/, then concatenate "
                  "them into all.txt, then read all.txt back. Narrate each step.")


# ---- stack lifecycle (full env control, unlike dogfood.start_app which hardcodes some) -------------
def start_stack(extra_env: dict) -> None:
    import os
    df.start_proxy(df.ik_token())
    env = {**os.environ,
           "AGENT_MODEL_PROXY_URL": f"http://127.0.0.1:{df.PPORT}", "PROXY_ADMIN_KEY": df.ADMIN,
           "AGENT_MODEL": MODEL, "AGENT_MODEL_PROVIDER": "huggingface",
           "AGENT_AUTH_DISABLED": "1", "AGENT_MODERATION_DISABLED": "1",
           "HERMES_BIN": df.HERMES, "AGENT_DB_PATH": "/tmp/acp_pressure.db", "AGENT_SANDBOX_BACKEND": "bwrap",
           **extra_env}
    df._spawn([df.PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(df.APORT)],
              env, Path("/tmp/acp_pressure_app.log"))
    if not df._wait_health(df.APORT):
        sys.exit("app did not come up — see /tmp/acp_pressure_app.log")


def stop_stack() -> None:
    for p in list(df._procs):
        df._kill(p)
    df._procs.clear()
    time.sleep(1.0)


# ---- HTTP (capture status codes; dogfood._post raises on non-200) ---------------------------------
def submit(prompt: str, verify: "dict | None") -> tuple[int, str | None]:
    import json
    body = {"prompt": prompt}
    if verify:
        body["verify"] = verify
    req = urllib.request.Request(f"http://127.0.0.1:{df.APORT}/run", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=30))
        return 200, r.get("id")
    except urllib.error.HTTPError as e:
        return e.code, None


def poll(rid: str, timeout: int) -> dict:
    deadline = time.monotonic() + timeout
    out: dict = {}
    while time.monotonic() < deadline:
        out = df._get(f"/run/{rid}")
        if str(out.get("state", "")).upper() in ("COMPLETED", "FAILED", "CANCELED"):
            return out
        time.sleep(1.5)
    return out


def cancel(rid: str) -> None:
    req = urllib.request.Request(f"http://127.0.0.1:{df.APORT}/run/{rid}", method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except urllib.error.HTTPError:
        pass


def app_pid() -> int | None:
    """The app uvicorn process — last thing start_stack spawned (proxy first, app second)."""
    return df._procs[-1].pid if df._procs else None


def fd_rss(pid: int | None) -> tuple[int, int]:
    """(open fd count, RSS kB) for a pid — the leak signal across a sustained batch."""
    if pid is None:
        return (0, 0)
    try:
        fds = len(list(Path(f"/proc/{pid}/fd").iterdir()))
        rss = 0
        for ln in Path(f"/proc/{pid}/status").read_text().splitlines():
            if ln.startswith("VmRSS:"):
                rss = int(ln.split()[1])
                break
        return (fds, rss)
    except Exception:  # noqa: BLE001
        return (0, 0)


def orphan_agent_procs() -> list[str]:
    """Lines for any lingering agent subprocess (should be empty at rest). Matches the ACTUAL executor
    invocation — `<venv>/bin/hermes acp|-z` or a bwrap bound to a task scratch — not this harness process
    (whose path contains 'hermes-agent' + 'acp_pressure' and would false-match a loose pattern)."""
    try:
        out = subprocess.run(["pgrep", "-af", r"/hermes (acp|-z)\b|bwrap .*agent-run-"],
                             capture_output=True, text=True).stdout
    except Exception:  # noqa: BLE001
        return []
    return [ln for ln in out.splitlines()
            if ln.strip() and "pgrep" not in ln and "acp_pressure" not in ln]


# ---- scenarios ------------------------------------------------------------------------------------
def scn_saturation(transport_env: dict, sandbox: str, n: int, cap: int) -> bool:
    print(f"\n== SATURATION == {n} concurrent submits at MAX_CONCURRENCY={cap} (sandbox={sandbox}) …")
    start_stack({**transport_env, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": str(cap),
                 "AGENT_WALL_CLOCK_SECS": "180", "AGENT_BEST_OF": "1"})
    try:
        with cf.ThreadPoolExecutor(max_workers=n) as ex:
            results = list(ex.map(lambda _: submit(FAST_TASK, None), range(n)))
        codes = [c for c, _ in results]
        accepted = [rid for c, rid in results if c == 200 and rid]
        n429 = codes.count(429)
        print(f"  submitted: {len(codes)}  accepted(200): {len(accepted)}  rejected(429): {n429}")
        finals = [poll(rid, 200) for rid in accepted]
        states = [str(f.get("state", "?")).upper() for f in finals]
        completed = states.count("COMPLETED")
        print(f"  accepted-run states: COMPLETED={completed} other={len(states) - completed} {set(states)}")
        time.sleep(2.0)
        orphans = orphan_agent_procs()
        # slots recovered? a fresh submit must be accepted again.
        recov_code, recov_id = submit(FAST_TASK, None)
        if recov_id:
            poll(recov_id, 120)
        checks = {
            "overflow rejected with 429 (not a crash)": n429 > 0,
            "at least MAX_CONCURRENCY ran at once": len(accepted) >= cap,
            "every accepted run reached COMPLETED": completed == len(accepted) and completed > 0,
            "no orphan agent procs after drain": not orphans,
            "slots recovered (fresh submit accepted)": recov_code == 200,
        }
        return _report("saturation", checks, extra=("orphans:\n    " + "\n    ".join(orphans)) if orphans else "")
    finally:
        stop_stack()


def scn_cancel(transport_env: dict, sandbox: str, n: int, kill: int) -> bool:
    print(f"\n== CANCEL STORM == submit {n}, DELETE {kill} mid-flight (sandbox={sandbox}) …")
    start_stack({**transport_env, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": str(n),
                 "AGENT_WALL_CLOCK_SECS": "180", "AGENT_BEST_OF": "1"})
    try:
        ids = [rid for _, rid in (submit(WORK_TASK, WORK_VERIFY) for _ in range(n)) if rid]
        time.sleep(3.5)                                   # let them enter WORKING (first model call in flight)
        for rid in ids[:kill]:
            cancel(rid)
        killed = [poll(rid, 60) for rid in ids[:kill]]
        rest = [poll(rid, 200) for rid in ids[kill:]]
        canceled = sum(1 for f in killed if str(f.get("state", "")).upper() == "CANCELED")
        rest_ok = sum(1 for f in rest if str(f.get("state", "")).upper() in ("COMPLETED", "FAILED"))
        print(f"  canceled: {canceled}/{kill}   remaining terminal: {rest_ok}/{len(rest)}")
        time.sleep(2.0)
        orphans = orphan_agent_procs()
        checks = {
            f"all {kill} DELETEd runs are CANCELED": canceled == kill,
            "remaining runs still reached terminal": rest_ok == len(rest),
            "no orphan agent procs after cancel": not orphans,
        }
        return _report("cancel", checks, extra=("orphans:\n    " + "\n    ".join(orphans)) if orphans else "")
    finally:
        stop_stack()


def scn_wall(transport_env: dict, sandbox: str, wall: int) -> bool:
    print(f"\n== WALL-CLOCK == AGENT_WALL_CLOCK_SECS={wall}, a normal task must trip it (sandbox={sandbox}) …")
    start_stack({**transport_env, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": "4",
                 "AGENT_WALL_CLOCK_SECS": str(wall), "AGENT_BEST_OF": "1"})
    try:
        _, rid = submit(WORK_TASK, WORK_VERIFY)
        final = poll(rid, wall + 120) if rid else {}
        state = str(final.get("state", "?")).upper()
        reason = (final.get("error") or final.get("summary") or "")
        print(f"  final state: {state}   reason: {reason[:90]}")
        time.sleep(2.0)
        orphans = orphan_agent_procs()
        checks = {
            "run FAILED (did not falsely COMPLETE)": state == "FAILED",
            "failure reason cites the wall-clock cap": "wall-clock" in reason.lower(),
            "no orphan agent procs after timeout": not orphans,
        }
        return _report("wall", checks, extra=("orphans:\n    " + "\n    ".join(orphans)) if orphans else "")
    finally:
        stop_stack()


def scn_wall_midtool(transport_env: dict, sandbox: str, wall: int) -> bool:
    print(f"\n== WALL MID-TOOL == AGENT_WALL_CLOCK_SECS={wall}, multi-tool task axed DURING a tool "
          f"(sandbox={sandbox}) …")
    start_stack({**transport_env, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": "4",
                 "AGENT_WALL_CLOCK_SECS": str(wall), "AGENT_BEST_OF": "1"})
    try:
        _, rid = submit(MULTITOOL_TASK, None)
        final = poll(rid, wall + 120) if rid else {}
        state = str(final.get("state", "?")).upper()
        reason = (final.get("error") or final.get("summary") or "")
        print(f"  final state: {state}   reason: {reason[:90]}")
        time.sleep(2.0)
        orphans = orphan_agent_procs()
        checks = {
            "run FAILED (killed mid-tool, not falsely COMPLETE)": state == "FAILED",
            "failure reason cites the wall-clock cap": "wall-clock" in reason.lower(),
            "no orphan agent/tool procs after mid-tool kill": not orphans,
        }
        return _report("wall-midtool", checks,
                       extra=("orphans:\n    " + "\n    ".join(orphans)) if orphans else "")
    finally:
        stop_stack()


def scn_bestofn(transport_env: dict, sandbox: str, n: int) -> bool:
    print(f"\n== BEST-OF-N UNDER LOAD == {n} concurrent verify-spec tasks, AGENT_BEST_OF=3 (sandbox={sandbox}) …")
    start_stack({**transport_env, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": str(n),
                 "AGENT_WALL_CLOCK_SECS": "200", "AGENT_BEST_OF": "3", "AGENT_AUTODERIVE_VERIFY": "1"})
    try:
        with cf.ThreadPoolExecutor(max_workers=n) as ex:
            res = list(ex.map(lambda _: submit(WORK_TASK, WORK_VERIFY), range(n)))
        ids = [rid for code, rid in res if code == 200 and rid]
        finals = [poll(rid, 240) for rid in ids]
        verified = sum(1 for f in finals if f.get("verified") is True)
        completed = sum(1 for f in finals if str(f.get("state", "")).upper() == "COMPLETED")
        attempts_seen = sum(1 for f in finals if "attempt" in str(f.get("summary", "")))
        print(f"  runs={len(ids)} COMPLETED={completed} verified={verified} summaries-with-attempt={attempts_seen}")
        time.sleep(2.0)
        orphans = orphan_agent_procs()
        recov_code, recov_id = submit(FAST_TASK, None)
        if recov_id:
            poll(recov_id, 120)
        checks = {
            "every run COMPLETED under concurrent best-of-N": completed == len(ids) and completed > 0,
            "every run independently verified (execution)": verified == len(ids),
            "best-of-N engaged (attempt N/3 in summaries)": attempts_seen == len(ids),
            "no orphan agent procs (per-attempt scratch/nonce clean)": not orphans,
            "slots recovered after the load": recov_code == 200,
        }
        return _report("bestofn", checks, extra=("orphans:\n    " + "\n    ".join(orphans)) if orphans else "")
    finally:
        stop_stack()


def scn_resource(transport_env: dict, sandbox: str, rounds: int, batch: int) -> bool:
    print(f"\n== RESOURCE == {rounds} rounds of {batch} tasks; app fd/RSS before vs after (sandbox={sandbox}) …")
    start_stack({**transport_env, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": str(batch),
                 "AGENT_WALL_CLOCK_SECS": "180", "AGENT_BEST_OF": "1"})
    try:
        # settle, then baseline the app process
        submit(FAST_TASK, None)
        time.sleep(3.0)
        fd0, rss0 = fd_rss(app_pid())
        print(f"  baseline: fd={fd0} rss={rss0}kB")
        total_ok = 0
        for r in range(rounds):
            with cf.ThreadPoolExecutor(max_workers=batch) as ex:
                ids = [rid for _, rid in ex.map(lambda _: submit(FAST_TASK, None), range(batch)) if _]
            for rid in ids:
                if rid and str(poll(rid, 150).get("state", "")).upper() == "COMPLETED":
                    total_ok += 1
            print(f"  round {r + 1}/{rounds} done ({total_ok} ok cumulative)")
        time.sleep(3.0)
        fd1, rss1 = fd_rss(app_pid())
        orphans = orphan_agent_procs()
        d_fd, d_rss = fd1 - fd0, rss1 - rss0
        total = rounds * batch
        print(f"  after: fd={fd1} rss={rss1}kB   Δfd={d_fd:+d} Δrss={d_rss:+d}kB   ({total_ok}/{total} runs ok)")
        if total_ok < total:
            print(f"  (info) {total - total_ok} run(s) did not COMPLETE — transient upstream errors are "
                  f"expected under sustained real-model load; this dim gates on LEAKS, not completion rate")
        # This dimension's job is LEAK detection (fd/RSS/procs). Completion rate is a reliability signal the
        # other dims own; tolerate a rare transient upstream failure rather than flag it as a resource leak.
        checks = {
            "no fd leak (Δfd small)": d_fd <= 8,
            "no runaway RSS growth (Δrss < 150MB)": d_rss < 150_000,
            "no orphan agent procs after sustained load": not orphans,
            f"completion healthy under load (>={total - 1}/{total})": total_ok >= total - 1,
        }
        return _report("resource", checks, extra=("orphans:\n    " + "\n    ".join(orphans)) if orphans else "")
    finally:
        stop_stack()


def scn_abparity(sandbox: str, k: int) -> bool:
    print(f"\n== A/B FLAG PARITY == {k}-task battery: oneshot vs acp (sandbox={sandbox}) …")

    def _battery(tenv: dict, label: str) -> tuple[int, int, float]:
        start_stack({**tenv, "AGENT_SANDBOX": sandbox, "AGENT_MAX_CONCURRENCY": str(k),
                     "AGENT_WALL_CLOCK_SECS": "200", "AGENT_BEST_OF": "3", "AGENT_AUTODERIVE_VERIFY": "1"})
        try:
            t0 = time.monotonic()
            with cf.ThreadPoolExecutor(max_workers=k) as ex:
                res = list(ex.map(lambda _: submit(WORK_TASK, WORK_VERIFY), range(k)))
            finals = [poll(rid, 240) for code, rid in res if code == 200 and rid]
            dur = time.monotonic() - t0
            comp = sum(1 for f in finals if str(f.get("state", "")).upper() == "COMPLETED")
            ver = sum(1 for f in finals if f.get("verified") is True)
            print(f"  {label:8s}: COMPLETED={comp}/{k} verified={ver}/{k} wall={dur:.0f}s")
            return comp, ver, dur
        finally:
            stop_stack()

    o_comp, o_ver, o_dur = _battery({}, "oneshot")
    a_comp, a_ver, a_dur = _battery({"AGENT_ACP": "1"}, "acp")
    checks = {
        "oneshot battery all COMPLETED (baseline sane)": o_comp == k,
        "acp COMPLETED >= oneshot (no regression)": a_comp >= o_comp and a_comp == k,
        "acp verified >= oneshot (no verify regression)": a_ver >= o_ver and a_ver == k,
    }
    return _report("abparity", checks,
                   extra=f"latency: oneshot {o_dur:.0f}s vs acp {a_dur:.0f}s (informational)")


def _report(name: str, checks: dict, extra: str = "") -> bool:
    ok = True
    for label, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        ok = ok and passed
    if extra:
        print("  " + extra)
    print(f"  ---- {name}: {'GREEN' if ok else 'RED'} ----")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="Local pressure test for the agentic stack.")
    ap.add_argument("--transport", choices=["acp", "oneshot"], default="acp")
    ap.add_argument("--sandbox", choices=["off", "bwrap"], default="off")
    ap.add_argument("--only", default="sat,cancel,wall,wallmid,bestofn,resource,abparity",
                    help="comma list: sat,cancel,wall,wallmid,bestofn,resource,abparity")
    ap.add_argument("--sat-n", type=int, default=10)
    ap.add_argument("--sat-cap", type=int, default=4)
    ap.add_argument("--cancel-n", type=int, default=6)
    ap.add_argument("--cancel-kill", type=int, default=3)
    ap.add_argument("--wall", type=int, default=4)
    ap.add_argument("--wallmid", type=int, default=15)      # mid-tool: enough to enter tool calls before the axe
    ap.add_argument("--bestofn-n", type=int, default=4)
    ap.add_argument("--res-rounds", type=int, default=3)
    ap.add_argument("--res-batch", type=int, default=4)
    ap.add_argument("--ab-k", type=int, default=3)
    args = ap.parse_args()

    tenv = {"AGENT_ACP": "1"} if args.transport == "acp" else {}
    want = {s.strip() for s in args.only.split(",")}
    print(f"== pressure test == transport={args.transport} sandbox={args.sandbox} scenarios={sorted(want)}")

    results = {}
    if "sat" in want:
        results["sat"] = scn_saturation(tenv, args.sandbox, args.sat_n, args.sat_cap)
    if "cancel" in want:
        results["cancel"] = scn_cancel(tenv, args.sandbox, args.cancel_n, args.cancel_kill)
    if "wall" in want:
        results["wall"] = scn_wall(tenv, args.sandbox, args.wall)
    if "wallmid" in want:
        results["wallmid"] = scn_wall_midtool(tenv, args.sandbox, args.wallmid)
    if "bestofn" in want:
        results["bestofn"] = scn_bestofn(tenv, args.sandbox, args.bestofn_n)
    if "resource" in want:
        results["resource"] = scn_resource(tenv, args.sandbox, args.res_rounds, args.res_batch)
    if "abparity" in want:
        results["abparity"] = scn_abparity(args.sandbox, args.ab_k)   # ignores tenv — runs both transports

    print("\n================ SUMMARY ================")
    for k, v in results.items():
        print(f"  {k:8s} {'GREEN' if v else 'RED'}")
    allgreen = all(results.values())
    print(f"  ==== pressure ({args.transport}/{args.sandbox}) {'ALL GREEN' if allgreen else 'SOME RED'} ====")
    sys.exit(0 if allgreen else 1)


if __name__ == "__main__":
    main()
