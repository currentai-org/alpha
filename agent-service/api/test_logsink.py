"""Tests for the off-box log sink (api/logsink.py).

Two properties matter more than the happy path and are what most of this file is about:

  1. It cannot break the caller. It sits inside `_log_event`/`_plog`, so an exception or a block here
     becomes an exception or a block in a request that was only trying to write a log line.
  2. It cannot leak what stdout is allowed to see. The redaction boundary is the reason this sink is
     shippable at all, so it is asserted per-field rather than trusted to the docstring.
"""
from __future__ import annotations

import importlib
import json

import pytest


@pytest.fixture()
def sink(monkeypatch):
    """A fresh logsink module with a token set, so the queue is live but nothing is posted."""
    monkeypatch.setenv("AXIOM_TOKEN", "tok-test")
    monkeypatch.setenv("AXIOM_DATASET", "agent-service-test")
    monkeypatch.delenv("AXIOM_SEND_CONTENT", raising=False)
    monkeypatch.delenv("AXIOM_HASH_USER", raising=False)
    import logsink as ls
    mod = importlib.reload(ls)
    mod.SERVICE = "app"
    yield mod
    mod._stopping = True
    importlib.reload(ls)          # leave the module as the rest of the suite expects it


def _drain(mod) -> list:
    with mod._lock:
        return list(mod._buf)


# ---- the off switch -------------------------------------------------------------------------

def test_disabled_without_token(monkeypatch):
    monkeypatch.delenv("AXIOM_TOKEN", raising=False)
    import logsink as ls
    mod = importlib.reload(ls)
    assert mod.enabled() is False
    assert mod.init("app") is False
    mod.emit({"ts": 1.0, "event": "run.started", "id": "t1"})
    assert _drain(mod) == []              # queued nothing; no thread, no allocation
    assert mod.stats()["enabled"] is False


def test_no_token_means_no_worker_thread(monkeypatch):
    """The default posture for every local run and every CI run is 'this file does nothing'."""
    monkeypatch.delenv("AXIOM_TOKEN", raising=False)
    import logsink as ls
    mod = importlib.reload(ls)
    mod.init("app")
    assert mod._worker is None


# ---- redaction ------------------------------------------------------------------------------

def test_content_fields_become_length_markers(sink):
    sink.emit({"ts": 1.0, "event": "run.repair", "id": "t1", "attempt": 2,
               "detail": "expected 3 lines, got 1: banana", "artifacts": ["a.txt", "b.txt"]})
    rec = _drain(sink)[0]
    assert rec["detail"] == "<redacted:31>"
    assert rec["artifacts"] == "<redacted:2>"
    assert rec["id"] == "t1" and rec["attempt"] == 2      # descriptive fields ride along untouched


def test_upstream_error_body_is_redacted(sink):
    """The gateway's `body` is up to a kilobyte of provider error text — the one proxy field that can
    quote a request back at us."""
    sink.emit({"ts": 1.0, "event": "upstream.error", "status": 401, "provider": "cscs",
               "body": '{"error":"invalid api key"}'})
    rec = _drain(sink)[0]
    assert rec["body"].startswith("<redacted:")
    assert rec["status"] == 401 and rec["provider"] == "cscs"   # the alertable part survives


def test_closed_set_fields_are_not_redacted(sink):
    """`reason`/`stop_reason`/`path` were candidates and were deliberately left out: redacting a
    closed set costs the alerting the sink exists for and protects nothing."""
    sink.emit({"ts": 1.0, "event": "run.rejected", "reason": "task_rate_limit", "limit": 20})
    sink.emit({"ts": 1.0, "event": "run.attempt", "stop_reason": "wall_clock",
               "structural": "hermes exit 1: Traceback ...", "structural_kind": "exit_nonzero"})
    a, b = _drain(sink)
    assert a["reason"] == "task_rate_limit"
    assert b["stop_reason"] == "wall_clock"
    # `structural` interpolates a stderr tail, so it goes; the kind is what you actually group by.
    assert b["structural"].startswith("<redacted:")
    assert b["structural_kind"] == "exit_nonzero"


def test_empty_content_field_is_left_alone(sink):
    """`<redacted:0>` would read as 'something was here'. Nothing was."""
    sink.emit({"ts": 1.0, "event": "run.attempt", "structural": "", "detail": None})
    rec = _drain(sink)[0]
    assert rec["structural"] == "" and rec["detail"] is None


def test_user_is_hashed_not_shipped(sink):
    sink.emit({"ts": 1.0, "event": "run.started", "id": "t1", "user": "user@example.org"})
    rec = _drain(sink)[0]
    assert "user@example.org" not in json.dumps(rec)
    assert rec["user"].startswith("u_")
    assert len(rec["user"]) == 14


def test_hash_is_stable_so_grouping_still_works(sink):
    sink.emit({"ts": 1.0, "event": "run.started", "user": "a@b.co"})
    sink.emit({"ts": 2.0, "event": "run.finished", "user": "a@b.co"})
    sink.emit({"ts": 3.0, "event": "run.started", "user": "c@d.co"})
    a, b, c = _drain(sink)
    assert a["user"] == b["user"] != c["user"]


def test_send_content_opt_in_restores_fidelity(monkeypatch):
    monkeypatch.setenv("AXIOM_TOKEN", "tok-test")
    monkeypatch.setenv("AXIOM_SEND_CONTENT", "1")
    import logsink as ls
    mod = importlib.reload(ls)
    try:
        mod.emit({"ts": 1.0, "event": "run.repair", "detail": "expected 3 lines"})
        assert _drain(mod)[0]["detail"] == "expected 3 lines"
    finally:
        importlib.reload(ls)


def test_redaction_does_not_mutate_the_caller(sink):
    """stdout gets the full line; only the outbound copy is reduced. If this ever mutated in place,
    the redaction would silently degrade the log we keep on our own box."""
    rec = {"ts": 1.0, "event": "run.repair", "detail": "the real detail", "user": "a@b.co"}
    sink.emit(rec)
    assert rec["detail"] == "the real detail" and rec["user"] == "a@b.co"


# ---- it cannot hurt the caller ---------------------------------------------------------------

def test_emit_never_raises_on_hostile_input(sink):
    class Exploding:
        def __str__(self):
            raise RuntimeError("boom")

    sink.emit({"ts": 1.0, "event": "run.repair", "detail": Exploding()})   # must not propagate
    assert _drain(sink) == []            # the one bad record is dropped, quietly and alone


def test_one_unserializable_record_does_not_sink_the_batch(sink, monkeypatch):
    """`json.dumps` without `default=str` would raise on the enum and take the other 99 records with
    it — a whole batch lost to one field, counted as an upstream failure it wasn't."""
    import enum

    class State(enum.Enum):
        WORKING = "working"

    class FakeResp:
        status_code = 200

    seen = {}

    def fake_post(url, headers=None, content=None, timeout=None):
        seen["body"] = json.loads(content)
        return FakeResp()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    sink.emit({"ts": 1.0, "event": "run.finished", "state": State.WORKING})
    sink.emit({"ts": 2.0, "event": "run.finished", "id": "t2"})
    sink._drain_once()
    assert len(seen["body"]) == 2
    assert sink.stats()["failed"] == 0 and sink.stats()["sent"] == 2


def test_queue_is_bounded_and_drops_oldest(monkeypatch):
    monkeypatch.setenv("AXIOM_TOKEN", "tok-test")
    monkeypatch.setenv("AXIOM_MAX_QUEUE", "5")
    import logsink as ls
    mod = importlib.reload(ls)
    try:
        for i in range(8):
            mod.emit({"ts": float(i), "event": "run.started", "id": f"t{i}"})
        held = _drain(mod)
        assert len(held) == 5
        # Oldest dropped, not newest: a backed-up sink usually means something is going wrong NOW.
        assert [r["id"] for r in held] == ["t3", "t4", "t5", "t6", "t7"]
        assert mod.stats()["dropped"] == 3
    finally:
        importlib.reload(ls)


def test_post_failure_is_counted_and_surfaced(sink, monkeypatch):
    """A failing sink endpoint must show up in /healthz rather than being swallowed — the
    same failure-is-invisible shape this sink was built to fix (CUR-182)."""
    calls = []

    class FakeResp:
        status_code = 401

    def fake_post(*a, **kw):
        calls.append(1)
        return FakeResp()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(sink.time, "sleep", lambda _s: None)
    sink.emit({"ts": 1.0, "event": "run.started", "id": "t1"})
    sink._drain_once()
    assert len(calls) == 2                       # one retry, then give up
    st = sink.stats()
    assert st["failed"] == 2 and st["dropped"] == 1 and st["last_error"] == "HTTP 401"
    assert _drain(sink) == []                    # dropped, not re-queued into unbounded growth


def test_transport_exception_is_caught_and_named(sink, monkeypatch):
    import httpx

    def fake_post(*a, **kw):
        raise httpx.ConnectTimeout("nope")

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(sink.time, "sleep", lambda _s: None)
    sink.emit({"ts": 1.0, "event": "run.started"})
    sink._drain_once()
    assert sink.stats()["last_error"] == "ConnectTimeout"


# ---- the wire shape -------------------------------------------------------------------------

def test_event_time_comes_from_ts_not_ingest(sink, monkeypatch):
    """Axiom stamps ingest time unless the event names its own, which would smear a burst across
    whenever the batch flushed — the exact resolution the two planes' shared `ts` exists to keep."""
    sink.emit({"ts": 1751328000.25, "event": "run.started"})
    rec = _drain(sink)[0]
    assert rec["_time"] == "2025-07-01T00:00:00.250Z"


def test_service_tag_distinguishes_the_two_planes(sink):
    sink.SERVICE = "gateway"
    sink.emit({"ts": 1.0, "event": "upstream.usage"})
    assert _drain(sink)[0]["service"] == "gateway"


def test_posts_a_json_array_to_the_dataset_ingest_path(sink, monkeypatch):
    seen = {}

    class FakeResp:
        status_code = 200

    def fake_post(url, headers=None, content=None, timeout=None):
        seen.update(url=url, headers=headers, body=json.loads(content))
        return FakeResp()

    import httpx
    monkeypatch.setattr(httpx, "post", fake_post)
    sink.emit({"ts": 1.0, "event": "run.started", "id": "t1"})
    sink._drain_once()
    assert seen["url"] == "https://api.axiom.co/v1/datasets/agent-service-test/ingest"
    assert seen["headers"]["authorization"] == "Bearer tok-test"
    assert isinstance(seen["body"], list) and seen["body"][0]["event"] == "run.started"
    assert sink.stats()["sent"] == 1
