"""Deleting a conversation or an account deletes its sandboxes, and idle ones are reaped (CUR-4484)."""

import app
import pytest
import store as store_mod


class RecordingBackend:
    name = "e2b"

    def __init__(self, fail=False):
        self.destroyed, self.swept, self.fail = [], [], fail

    def destroy(self, principal, conversation):
        if self.fail:
            raise ConnectionError("sandbox host down")
        self.destroyed.append((principal, conversation))
        return 1

    def sweep(self, older_than_secs):
        if self.fail:
            raise ConnectionError("sandbox host down")
        self.swept.append(older_than_secs)
        return ["k"]


@pytest.fixture
def backend(monkeypatch):
    b = RecordingBackend()
    monkeypatch.setattr(app, "SANDBOX_BACKEND", b)
    monkeypatch.setattr(app, "store", store_mod.Store(":memory:"))
    return b


def test_deleting_conversations_removes_their_workdirs_and_both_sandboxes_for_that_visitor_only(backend, tmp_path):
    keep, gone = tmp_path / "keep", tmp_path / "gone"
    for d in (keep, gone):
        d.mkdir()
    app.store.touch_session_workdir("svc/alice", "conv-1", str(gone))
    app.store.touch_session_workdir("svc/alice", "conv-2", str(keep))
    app.store.touch_session_workdir("svc/bob", "conv-1", str(keep))     # same id, another visitor

    r = app.delete_sessions(app.DeleteSessionsRequest(subject="alice", session_ids=["conv-1"]), "svc")

    assert (r.workdirs_deleted, r.sandboxes_deleted) == (1, 2)
    assert backend.destroyed == [("svc/alice", "conv-1"), ("svc/alice", "agent:conv-1")]
    assert not gone.exists() and keep.exists()
    assert app.store.get_session_workdir("svc/alice", "conv-2") == str(keep)
    assert app.store.get_session_workdir("svc/bob", "conv-1") == str(keep)


def test_a_conversation_that_never_ran_agent_mode_still_has_its_run_code_sandbox_killed(backend):
    r = app.delete_sessions(app.DeleteSessionsRequest(subject="alice", session_ids=["conv-9"]), "svc")
    assert (r.workdirs_deleted, r.sandboxes_deleted) == (0, 2)
    assert ("svc/alice", "conv-9") in backend.destroyed


def test_deleting_an_account_kills_every_conversations_sandboxes(backend, tmp_path):
    for sid in ("a", "b"):
        (tmp_path / sid).mkdir()
        app.store.touch_session_workdir("svc/alice", sid, str(tmp_path / sid))
    app.delete_caller(app.DeleteCallerRequest(subject="alice"), "svc")
    assert sorted(backend.destroyed) == [("svc/alice", "a"), ("svc/alice", "agent:a"),
                                         ("svc/alice", "agent:b"), ("svc/alice", "b")]


def test_the_reaper_sweeps_sandboxes_at_the_session_idle_limit(backend):
    assert app._sweep_sandboxes() == ["k"]
    assert backend.swept == [app.SESSION_IDLE_SECS]


def test_an_unreachable_sandbox_host_never_fails_a_delete_or_a_reaper_pass(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "SANDBOX_BACKEND", RecordingBackend(fail=True))
    monkeypatch.setattr(app, "store", store_mod.Store(":memory:"))
    (tmp_path / "w").mkdir()
    app.store.touch_session_workdir("svc/alice", "conv-1", str(tmp_path / "w"))
    r = app.delete_sessions(app.DeleteSessionsRequest(subject="alice", session_ids=["conv-1"]), "svc")
    assert (r.workdirs_deleted, r.sandboxes_deleted) == (1, 0)
    assert app._sweep_sandboxes() == []


class _Buf:
    def __init__(self):
        self.events = []

    def emit(self, event_type, data):
        self.events.append((event_type, data))


class _WaitingBackend:
    """Waits on a full host (tells on_wait once), then gets a slot, or gives up when `full`."""

    name = "e2b"

    def __init__(self, full=False):
        self.full, self.cancelled = full, None

    def connect(self, principal, conversation, tier, *, on_wait=None, cancelled=None):
        from sandbox_backend import SANDBOX_WAIT_TEXT, Handle, SandboxBusy
        self.cancelled = cancelled
        on_wait(SANDBOX_WAIT_TEXT)
        if self.full:
            raise SandboxBusy("the sandbox host is full right now; try again in a minute")
        return Handle(key=f"{principal}/{conversation}", tier=tier)


def test_an_agent_task_waiting_for_a_slot_streams_the_wait_then_working_and_gets_its_sandbox(monkeypatch):
    """CUR-4584: the event stream chat reads carries one "waiting_sandbox" with the status text, then "working"."""
    from sandbox_backend import SANDBOX_WAIT_TEXT
    backend = _WaitingBackend()
    monkeypatch.setattr(app, "SANDBOX_BACKEND", backend)
    task, buf = app.Task(id="t1", prompt="p", user="alice"), _Buf()
    h = app._connect_agent_sandbox(task, buf)
    assert h is not None and h.key == "alice/agent:t1"
    assert [(e, d["state"], d.get("text")) for e, d in buf.events] == [
        ("state", "waiting_sandbox", SANDBOX_WAIT_TEXT), ("state", "working", None)]
    assert task.state != app.State.FAILED
    task._canceled = True
    assert backend.cancelled() is True  # a cancel reaches the wait


def test_an_agent_task_still_waiting_past_the_bound_fails_with_the_host_full_sentence(monkeypatch):
    monkeypatch.setattr(app, "SANDBOX_BACKEND", _WaitingBackend(full=True))
    task, buf = app.Task(id="t2", prompt="p", user="alice"), _Buf()
    assert app._connect_agent_sandbox(task, buf) is None
    assert (task.state, task.summary) == (app.State.FAILED, "failed: sandbox busy")
    assert task.error == "the sandbox host is full right now; try again in a minute"
    assert [d["state"] for _e, d in buf.events] == ["waiting_sandbox"]


def test_an_agent_task_cancelled_during_the_wait_keeps_its_canceled_state(monkeypatch):
    monkeypatch.setattr(app, "SANDBOX_BACKEND", _WaitingBackend(full=True))
    task = app.Task(id="t3", prompt="p", user="alice")
    task._canceled, task.summary, task.state = True, "canceled by user", app.State.CANCELED
    assert app._connect_agent_sandbox(task, None) is None
    assert (task.state, task.summary) == (app.State.CANCELED, "canceled by user")
