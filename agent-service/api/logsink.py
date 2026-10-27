"""Ship the structured log lines somewhere they outlive the process.

Both planes already emit one JSON object per line with a shared `ts` — `_log_event` (app.py) and
`_plog` (proxy.py) — so that the app's timeline and the gateway's merge on one axis. Without a sink that
merge is theoretical: both end at stdout, which on every host we have used is a live tail and not
a history. If nobody was watching, it did not happen.

WHY AN HTTP SINK IN-PROCESS, AND NOT A PLATFORM LOG DRAIN. The platform may
change. Fly is where this runs today, and a platform-specific shipper would be thrown away at a move. A POST from inside the process
depends on none of that, so this survives whatever the migration turns out to be.

OFF UNLESS `AXIOM_TOKEN` IS SET. No token means every function here is a cheap no-op: stdout keeps
its current behavior, and local runs, pytest and CI are unaffected without opting out of anything.

WHAT LEAVES THE MACHINE IS NOT WHAT GOES TO STDOUT. The `_log_event` docstring's claim — "carries no
secrets (caller passes only ids/states/counts)" — is true about CREDENTIALS and was written for a
sink we controlled. It is not true about CONTENT: `run.repair` carries `detail` (check output from
inside the sandbox) and `artifacts` (filenames the agent chose), `verify.autoderived` carries an
`expect_file` a model derived from the user's prompt, and the gateway's `upstream.error` carries up
to a kilobyte of provider error body. Each can quote fragments of a user's task.

That is fine on our own box and is a different question once the destination is a third-party SaaS in
another jurisdiction — for a project whose model plane is deliberately Swiss, it is the kind of thing
that should be a decision rather than a side effect. So the default here is conservative: free-text
fields are replaced with a length marker on the way out (the field still shows up, so you can see it
was there and how big it was, and go read the real value in stdout), and `user` is hashed. Both are
one env var away from full fidelity when someone wants it, deliberately.
"""
from __future__ import annotations

import atexit
import hashlib
import json
import os
import threading
import time
from collections import deque

TOKEN = os.environ.get("AXIOM_TOKEN", "").strip()
DATASET = os.environ.get("AXIOM_DATASET", "agent-service").strip()
URL = os.environ.get("AXIOM_URL", "https://api.axiom.co").strip().rstrip("/")

# One dataset, both planes, distinguished by a `service` field. Two datasets would filter more
# cleanly and would also undo the reason `ts` was aligned in the first place: the question you
# actually ask of these logs is "what was the gateway doing while that run was failing".
SERVICE = "unset"

MAX_QUEUE = int(os.environ.get("AXIOM_MAX_QUEUE", "5000"))    # records held before dropping
BATCH = int(os.environ.get("AXIOM_BATCH", "100"))             # records per POST
FLUSH_SECS = float(os.environ.get("AXIOM_FLUSH_SECS", "5"))   # max age of a queued record
TIMEOUT = float(os.environ.get("AXIOM_TIMEOUT_SECS", "5"))    # an Axiom failure never affects the service

# Fields whose values can quote the user's task rather than describe it. Redacted on the way out
# unless AXIOM_SEND_CONTENT=1. Names are matched exactly, across both planes.
#
# What is deliberately NOT here: `reason` and `stop_reason` (closed sets — "task_rate_limit",
# "ssrf_guard", "wall_clock"), `path` (a mkdtemp name), `host` (a webhook destination the caller
# configured). Redacting those would cost the alerting the sink exists for and protect nothing.
# `structural` IS here because `_detect_run_failure` interpolates a stderr tail and a matched stdout
# marker into it (see `_detect_run_failure` in app.py) — which is why app.py logs a canned `structural_kind` alongside
# it, so "how many runs hit the step cap" survives the redaction and only the tail is lost.
CONTENT_FIELDS = frozenset({"detail", "artifacts", "expect_file", "body", "structural"})
SEND_CONTENT = os.environ.get("AXIOM_SEND_CONTENT", "") not in ("", "0", "false")
# `user` is an identity, not a secret, and grouping by it is half the value of having a log sink at
# all. Hashing keeps the grouping and keeps the address out of a third party's index. Pseudonymous,
# not anonymous — an unsalted digest of a known address set is reversible by anyone who has the set.
# The task id joins back to our own store when a real identity is actually needed.
HASH_USER = os.environ.get("AXIOM_HASH_USER", "1") not in ("0", "false")

_lock = threading.Lock()
_buf: deque[dict] = deque()
_wake = threading.Event()
_worker: threading.Thread | None = None
_stopping = False
_sent = 0
_dropped = 0
_failed = 0
_last_error = ""


def enabled() -> bool:
    return bool(TOKEN)


def _redact(rec: dict) -> dict:
    """Copy `rec` with content fields replaced by a length marker. Never mutates the caller's dict —
    stdout gets the full-fidelity line and only the outbound copy is reduced."""
    out = {}
    for k, v in rec.items():
        if k == "user" and HASH_USER and isinstance(v, str) and v:
            out[k] = "u_" + hashlib.sha256(v.encode()).hexdigest()[:12]
        elif not SEND_CONTENT and k in CONTENT_FIELDS and v not in (None, "", [], {}):
            n = len(v) if isinstance(v, (str, list, dict)) else len(str(v))
            out[k] = f"<redacted:{n}>"
        else:
            out[k] = v
    return out


def emit(rec: dict) -> None:
    """Queue one record. Never raises, never blocks — this sits on the hot path of every log call,
    and a log sink that can fail a request is worse than no log sink."""
    if not TOKEN or _stopping:
        return
    try:
        item = _redact(rec)
        # Axiom stamps ingest time unless the event names its own. Ours is `ts` (epoch seconds), and
        # ingest time would smear a burst of events across whenever the batch happened to flush —
        # which is exactly the resolution the shared `ts` exists to preserve.
        ts = rec.get("ts")
        if isinstance(ts, (int, float)):
            item["_time"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + f".{int(ts % 1 * 1000):03d}Z"
        item["service"] = SERVICE
        global _dropped
        with _lock:
            if len(_buf) >= MAX_QUEUE:
                # Drop the OLDEST. When a sink backs up it is usually because something is going
                # wrong right now, and the newest records are the ones describing it.
                _buf.popleft()
                _dropped += 1
            _buf.append(item)
            full = len(_buf) >= BATCH
        if full:
            _wake.set()
    except Exception:  # noqa: BLE001 — a broken sink must never break the caller
        pass


def _post(batch: list) -> bool:
    import httpx

    global _sent, _failed, _last_error
    try:
        r = httpx.post(f"{URL}/v1/datasets/{DATASET}/ingest",
                       headers={"authorization": f"Bearer {TOKEN}",
                                "content-type": "application/json"},
                       # `default=str` matches app.py's own dumps. Without it one un-serializable
                       # field would raise here and take the whole BATCH down as a failed POST —
                       # ninety-nine good records lost to one Enum.
                       content=json.dumps(batch, default=str).encode(), timeout=TIMEOUT)
        if r.status_code >= 400:
            _failed += 1
            # The status is the whole point of recording this: a 401 here means the sink token is
            # dead and every number below is stale, which is precisely the failure CUR-182 is about.
            _last_error = f"HTTP {r.status_code}"
            return False
        _sent += len(batch)
        return True
    except Exception as e:  # noqa: BLE001
        _failed += 1
        _last_error = type(e).__name__
        return False


def _drain_once() -> None:
    global _dropped
    while True:
        with _lock:
            if not _buf:
                return
            batch = [_buf.popleft() for _ in range(min(BATCH, len(_buf)))]
        if not _post(batch):
            # One retry, then drop. Re-queueing indefinitely turns an unreachable sink into unbounded
            # memory growth in a service whose actual job is running agents.
            time.sleep(0.5)
            if not _post(batch):
                with _lock:
                    _dropped += len(batch)
                return


def _run() -> None:
    while True:
        _wake.wait(FLUSH_SECS)
        _wake.clear()
        try:
            _drain_once()
        except Exception:  # noqa: BLE001 — the worker outliving a bad batch matters more than the batch
            pass
        if _stopping:
            return


def _shutdown() -> None:
    """Flush on the way out. The last few seconds before a process dies are the interesting ones, and
    they are exactly what an unflushed buffer discards."""
    global _stopping
    _stopping = True
    _wake.set()
    t = _worker
    if t is not None and t.is_alive():
        t.join(timeout=TIMEOUT + 1)
    try:
        _drain_once()
    except Exception:  # noqa: BLE001
        pass


def init(service: str) -> bool:
    """Start the sink for one plane ("app" or "gateway"). Idempotent; returns whether it is on."""
    global _worker, SERVICE, _stopping
    SERVICE = service
    if not TOKEN:
        return False
    with _lock:
        if _worker is not None and _worker.is_alive():
            return True
        _stopping = False
        _worker = threading.Thread(target=_run, name="logsink", daemon=True)
        _worker.start()
    atexit.register(_shutdown)
    return True


def stats() -> dict:
    """Surfaced in both planes' /healthz. A sink whose own failures are invisible is the bug this
    whole change exists to fix, so `failed`/`last_error` are not optional decoration."""
    with _lock:
        queued = len(_buf)
    return {"enabled": bool(TOKEN), "dataset": DATASET if TOKEN else "", "service": SERVICE,
            "queued": queued, "sent": _sent, "dropped": _dropped, "failed": _failed,
            "last_error": _last_error, "send_content": SEND_CONTENT}
