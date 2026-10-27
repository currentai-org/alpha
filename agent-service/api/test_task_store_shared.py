"""The task store on one machine (SQLite) and shared across machines (Postgres), and what the app does with a
shared one (CUR-4443).

The Postgres half needs `AGENT_TEST_POSTGRES_URL`, a database these tests may empty; CI runs a Postgres
service for it (agent-service-ci.yml). Without it those cases skip and the SQLite half still runs.
"""

import os
import sqlite3
import threading
import time

import app
import pytest
import store as store_mod
from fastapi.testclient import TestClient

PG_URL = os.environ.get("AGENT_TEST_POSTGRES_URL")
needs_pg = pytest.mark.skipif(not PG_URL, reason="AGENT_TEST_POSTGRES_URL not set")


def _pg_store():
    import psycopg

    with psycopg.connect(PG_URL, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS task_events")
        c.execute("DROP TABLE IF EXISTS tasks")
    return store_mod.Store(":memory:", tasks_url=PG_URL)


@pytest.fixture(params=["sqlite", pytest.param("postgres", marks=needs_pg)])
def store(request):
    s = store_mod.Store(":memory:") if request.param == "sqlite" else _pg_store()
    yield s
    s.close()


# ---- the store's existing contract, on both backends ------------------------------------------------------


def test_a_task_row_records_its_outcome_and_a_restart_fails_what_it_interrupted(store):
    store.create("t1", "alice", "SUBMITTED")
    store.update("t1", state="COMPLETED", result="done", verified=True, tokens=1500, model_calls=4)
    rec = store.get("t1")
    assert rec["state"] == "COMPLETED" and rec["result"] == "done" and rec["verified"] == 1
    assert rec["tokens"] == 1500 and store.get("nope") is None
    store.create("t2", "alice", "WORKING")
    store.create("t3", "bob", "AWAITING_CONFIRMATION")
    assert store.recover_orphans() == 2
    assert store.get("t2")["state"] == "FAILED" and "awaiting your answer" in store.get("t3")["error"]
    assert store.get("t1")["state"] == "COMPLETED"


def test_spend_and_history_are_counted_per_user_and_per_caller(store):
    for i in range(3):
        store.create(f"a{i}", "c/alice", "COMPLETED")
        store.update(f"a{i}", tokens=1000)
    store.create("b0", "c/bob", "COMPLETED")
    store.update("b0", tokens=500)
    store.create("x0", "c%", "COMPLETED")                       # a LIKE wildcard must not over-match
    assert store.user_tokens_since("c/alice", 0) == 3000 and store.user_tasks_since("c/alice", 0) == 3
    assert store.caller_tasks_since("c", 0) == 4 and store.caller_tokens_since("c", 0) == 3500
    assert store.caller_history("c")["task_count"] == 4 and store.caller_history("nobody")["first_seen"] is None
    assert store.user_tokens_since("c/alice", time.time() + 100) == 0
    assert store.caller_deadline_count() == 0


def test_rows_move_with_a_sign_in_and_go_with_an_account_deletion(store):
    store.create("m1", "c/anon", "COMPLETED")
    assert store.migrate_caller("c", "anon", "acct") == {"migrated": 1}
    assert store.get("m1")["user"] == "c/acct"
    store.append_events([("m1", 0, "done", {"ok": True})])
    assert store.delete_for_user("c", "acct")["tasks_deleted"] == 1
    assert store.get("m1") is None and store.events_since("m1", -1) == []


def test_an_unknown_column_and_a_duplicate_id_are_refused_and_prune_keeps_running_tasks(store):
    store.create("z1", "u", "SUBMITTED")
    with pytest.raises(ValueError):
        store.update("z1", state="COMPLETED", evil_col="x")
    with pytest.raises(store_mod._DUPLICATE):
        store.create("z1", "u", "SUBMITTED")
    store.update("z1", state="COMPLETED")
    store.append_events([("z1", 0, "done", {})])
    store.create("z2", "u", "WORKING")
    assert store.prune(-1) == 1
    assert store.get("z1") is None and store.get("z2") is not None and store.events_since("z1", -1) == []


def test_events_come_back_in_order_and_a_repeated_seq_is_kept_not_doubled(store):
    store.create("e1", "u", "WORKING")
    store.append_events([("e1", 1, "token", {"t": "b"}), ("e1", 0, "state", {"s": "WORKING"})])
    store.append_events([("e1", 1, "token", {"t": "OVERWRITE"}), ("e1", 2, "done", {"result": "ab"})])
    assert store.events_since("e1", -1) == [(0, "state", {"s": "WORKING"}), (1, "token", {"t": "b"}),
                                            (2, "done", {"result": "ab"})]
    assert [seq for seq, _, _ in store.events_since("e1", 0)] == [1, 2]


def test_one_machine_store_is_not_shared_and_sqlite_errors_stay_sqlite():
    s = store_mod.Store(":memory:")
    assert not s.shared
    s.create("d", "u", "SUBMITTED")
    with pytest.raises(sqlite3.IntegrityError):
        s.create("d", "u", "SUBMITTED")


# ---- what only a shared store does -------------------------------------------------------------------------


@needs_pg
def test_a_restart_ends_only_its_own_tasks_on_a_shared_store():
    s = _pg_store()
    try:
        s.create("mine", "u", "WORKING", owner="m-a", lease_until=time.time() + 60)
        s.create("theirs", "u", "WORKING", owner="m-b", lease_until=time.time() + 60)
        assert s.recover_orphans("m-a") == 1
        assert s.get("mine")["state"] == "FAILED" and s.get("theirs")["state"] == "WORKING"
    finally:
        s.close()


@needs_pg
def test_a_lapsed_lease_fails_the_task_naming_the_machine_and_a_renewed_one_does_not():
    s = _pg_store()
    try:
        now = time.time()
        s.create("gone", "u", "WORKING", owner="m-gone", lease_until=now - 1)
        s.create("alive", "u", "WORKING", owner="m-alive", lease_until=now - 1)
        assert s.renew_leases("m-alive", ["alive"], now + 15) == []      # renewed, and still its to run
        ended = s.fail_lapsed(now)
        assert [r["id"] for r in ended] == ["gone"]
        assert s.get("gone")["state"] == "FAILED" and "m-gone" in s.get("gone")["error"]
        assert s.get("alive")["state"] == "WORKING"
    finally:
        s.close()


# ---- the app on a shared store: a task run by "another machine" served by this one -------------------------


@pytest.fixture
def shared_app(monkeypatch):
    if not PG_URL:
        pytest.skip("AGENT_TEST_POSTGRES_URL not set")
    s = _pg_store()
    monkeypatch.setattr(app, "store", s)
    monkeypatch.setattr(app, "AUTH_DISABLED", True)
    monkeypatch.setattr(app, "SSE_POLL_SECS", 0.05)
    yield s
    s.close()


def _read_sse(text: str) -> list[tuple[str, str]]:
    out, event = [], None
    for line in text.splitlines():
        if line.startswith("event:"):
            event = line.split(":", 1)[1].strip()
        elif line.startswith("data:") and event:
            out.append((event, line.split(":", 1)[1].strip()))
            event = None
    return out


def test_status_and_every_event_of_a_task_on_another_machine_are_served_here(shared_app):
    s = shared_app
    s.create("far", "dev-bypass-user", "WORKING", owner="m-other", lease_until=time.time() + 60)
    s.append_events([("far", 0, "state", {"state": "WORKING"}), ("far", 1, "token", {"text": "4"})])
    client = TestClient(app.app)
    assert client.get("/run/far").json()["state"] == "WORKING"

    def finish():  # the owner writes the rest while this machine is streaming
        time.sleep(0.3)
        s.append_events([("far", 2, "done", {"state": "COMPLETED", "result": "4"})])
        s.update("far", state="COMPLETED", result="4")

    threading.Thread(target=finish).start()
    frames = _read_sse(client.get("/run/far/events").text)
    assert [e for e, _ in frames] == ["state", "token", "done"], frames
    assert client.get("/run/far").json()["state"] == "COMPLETED"


def test_a_cancel_asked_here_stops_the_task_on_the_machine_running_it(shared_app, monkeypatch):
    s = shared_app
    s.create("run1", "dev-bypass-user", "WORKING", owner=app.OWNER_ID, lease_until=time.time() + 60)
    # This machine, before it knows the task: the cancel is forwarded through the store.
    r = TestClient(app.app).delete("/run/run1")
    assert r.status_code == 200 and s.get("run1")["cancel_requested"] == 1

    # The owner: the task is live in its table, and its next lease tick picks the cancel up.
    stopped = []
    task = app.Task(id="run1", prompt="p", user="dev-bypass-user", state=app.State.WORKING)
    task._acp_cancel = lambda: stopped.append(True)
    with app._TASKS_LOCK:
        app.TASKS["run1"] = task
    try:
        app._lease_tick()
        assert stopped == [True] and task.state == app.State.CANCELED
        assert s.get("run1")["state"] == "CANCELED"
    finally:
        with app._TASKS_LOCK:
            app.TASKS.pop("run1", None)


def test_a_task_whose_machine_stopped_renewing_ends_failed_naming_that_machine(shared_app):
    s = shared_app
    s.create("lost", "dev-bypass-user", "WORKING", owner="m-crashed", lease_until=time.time() - 1)
    app._lease_tick()
    body = TestClient(app.app).get("/run/lost").json()
    assert body["state"] == "FAILED" and "m-crashed" in (body.get("error") or ""), body


@needs_pg
def test_switching_to_a_shared_store_keeps_this_machines_spend_and_results(tmp_path):
    local = str(tmp_path / "tasks.db")
    one = store_mod.Store(local)
    one.create("old", "c/alice", "COMPLETED")
    one.update("old", result="kept", tokens=700)
    one.close()
    _pg_store().close()                                             # an empty shared store
    shared = store_mod.Store(local, tasks_url=PG_URL)
    try:
        assert shared.imported == 1
        assert shared.get("old")["result"] == "kept" and shared.user_tokens_since("c/alice", 0) == 700
        again = store_mod.Store(local, tasks_url=PG_URL)            # a second boot copies nothing twice
        assert again.count() == 1 and again.imported == 0
        again.close()
    finally:
        shared.close()


@needs_pg
def test_a_task_deleted_from_the_shared_store_stays_deleted_after_a_restart(tmp_path):
    local = str(tmp_path / "tasks.db")
    one = store_mod.Store(local)
    one.create("gone", "c/alice", "COMPLETED")
    one.create("aged", "c/bob", "COMPLETED")
    one.close()
    _pg_store().close()
    shared = store_mod.Store(local, tasks_url=PG_URL)
    shared.delete_for_user("c", "alice")
    shared._tasks.run("UPDATE tasks SET updated_at=0 WHERE id=?", ("aged",))
    shared.prune(60)
    shared.close()
    after = store_mod.Store(local, tasks_url=PG_URL)                # the next boot of this machine
    try:
        assert after.get("gone") is None and after.get("aged") is None
    finally:
        after.close()


@needs_pg
def test_an_owner_whose_task_was_failed_elsewhere_stops_it_and_keeps_that_verdict(shared_app):
    s = shared_app
    s.create("stale", "dev-bypass-user", "WORKING", owner=app.OWNER_ID, lease_until=time.time() - 1)
    s.fail_lapsed()                                                 # another machine saw the lease lapse
    stopped = []
    task = app.Task(id="stale", prompt="p", user="dev-bypass-user", state=app.State.WORKING)
    task._acp_cancel = lambda: stopped.append(True)
    with app._TASKS_LOCK:
        app.TASKS["stale"] = task
    try:
        app._lease_tick()
        assert stopped == [True] and task.state == app.State.FAILED and app.OWNER_ID in (task.error or "")
        assert s.get("stale")["state"] == "FAILED"
    finally:
        with app._TASKS_LOCK:
            app.TASKS.pop("stale", None)


def test_a_remote_stream_ends_with_a_done_frame_even_when_the_owner_never_wrote_one(shared_app, monkeypatch):
    monkeypatch.setattr(app, "TAIL_WAIT_SECS", 0.5)
    s = shared_app
    s.create("nodone", "dev-bypass-user", "WORKING", owner="m-other", lease_until=time.time() + 60)
    s.append_events([("nodone", 0, "state", {"state": "WORKING"})])
    s.update("nodone", state="FAILED", error="lost")
    frames = _read_sse(TestClient(app.app).get("/run/nodone/events").text)
    assert [e for e, _ in frames] == ["state", "done"], frames


def test_a_cancel_marks_the_task_canceled_before_the_run_could_write_its_own_ending(monkeypatch):
    seen = []
    monkeypatch.setattr(app, "_persist", lambda t: seen.append(t._canceled))
    task = app.Task(id="c1", prompt="p", user="dev-bypass-user", state=app.State.WORKING)
    app._cancel_local(task)
    assert seen == [True] and task.state == app.State.CANCELED
