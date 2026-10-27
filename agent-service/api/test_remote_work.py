"""A task whose Hermes ran in its sandbox gets the same artifacts, verdicts and resets as one that ran here (CUR-4483).

Each test builds one workspace tree twice, reads one copy through app.py's local readers and the other through
`RemoteWork`, and asserts the answers match. The fake backend runs the guest's shell commands on this machine,
so what is under test is RemoteWork's commands and app.py's dispatch, not E2B.
"""

import os
import shutil
import subprocess
import time
import types
from pathlib import Path

import app
import pytest
import remote_work
from remote_work import RemoteWork
from sandbox_backend import ExecResult, Handle, Tier


class LocalShell:
    """Runs exec argv on this machine, standing in for the guest."""

    def exec(self, h, argv, timeout, *, stdin=None):
        t0 = time.monotonic()
        try:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, input=stdin)
        except subprocess.TimeoutExpired:
            return ExecResult("", "", None, int((time.monotonic() - t0) * 1000), timed_out=True)
        return ExecResult(p.stdout, p.stderr, p.returncode, int((time.monotonic() - t0) * 1000))


def _tree(root: Path) -> None:
    (root / "hermes-home").mkdir(parents=True)
    (root / "hermes-home" / "config.yaml").write_text("model: x\n")
    (root / "hermes-home-t1-1").mkdir()
    (root / "hermes-home-t1-1" / "state.db").write_text("session")
    (root / "hermes-home-notes.txt").write_text("a top-level file with the prefix is work\n")
    (root / "report.md").write_text("# Report\nfine\n")
    (root / "data.csv").write_text("name,score\nana,3\nbo,1\n")
    (root / "reports" / "q1").mkdir(parents=True)
    (root / "reports" / "b.txt").write_text("b\n")
    (root / "reports" / "q1" / "a.txt").write_text("a\n")
    (root / "blob.bin").write_bytes(b"\x00\x01\x02binary")
    (root / "tab\tname.txt").write_text("a tab in the name\n")          # review on #4094: dropped by a tab split
    (root / "new\nline.txt").write_text("a newline in the name\n")
    (root / "raw.log").write_text("service log\n")
    (root / app.ARTIFACT_QUARANTINE_DIRNAME).mkdir()
    (root / app.ARTIFACT_QUARANTINE_DIRNAME / "old.txt").write_text("blocked\n")
    (root / "outside-link.txt").symlink_to("/etc/hostname")
    (root / "alias.md").symlink_to("report.md")                    # inside the root, still never served


def _files(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*"))
            if p.is_file() and not p.is_symlink()}


@pytest.fixture
def pair(tmp_path, monkeypatch):
    monkeypatch.setattr(remote_work, "SNAPSHOT_ROOT", str(tmp_path / "snapshots"))
    local, guest = tmp_path / "local", tmp_path / "guest"
    _tree(local)
    _tree(guest)
    ws = RemoteWork(LocalShell(), Handle("k", Tier.AGENT), str(guest), local=str(tmp_path / "scratch"))  # pyright: ignore[reportArgumentType]
    return local, guest, ws


def test_a_remote_workspace_lists_reads_and_moderates_the_same_files_as_a_local_one(pair):
    local, _guest, ws = pair
    assert app._artifact_paths(ws, 10**9) == app._artifact_paths(str(local), 10**9)
    assert app._artifact_paths(ws, 2) == app._artifact_paths(str(local), 2)        # one past the cap, same files
    assert app._collect_artifacts(ws) == app._collect_artifacts(str(local))
    assert app._artifact_text_for_moderation(ws) == app._artifact_text_for_moderation(str(local))
    assert app._scratch_artifacts(ws) == app._scratch_artifacts(str(local))
    assert app._read_rel(ws, "outside-link.txt", 100) == (None, False)            # a planted link reads as nothing
    assert app._read_rel(ws, "alias.md", 100) == app._read_rel(str(local), "alias.md", 100) == (None, False)
    assert app._read_rel(ws, "../local/report.md", 100) == (None, False)


def test_a_remote_workspace_keeps_only_this_turns_files_when_asked(pair):
    local, guest, ws = pair
    since = time.time() - 1
    for root in (local, guest):
        for p in root.rglob("*"):
            if not p.is_symlink():
                os.utime(p, (since - 100, since - 100))
        (root / "new.txt").write_text("this turn\n")
    assert app._artifact_paths(ws, 10**9, since=since) == app._artifact_paths(str(local), 10**9, since=since) \
        == [("new.txt", 10)]


def test_a_remote_verify_gives_the_local_verdicts(pair):
    local, _guest, ws = pair
    specs = [
        app.VerifySpec(expect_file="data.csv", expect_contains="ana"),
        app.VerifySpec(expect_file="data.csv", expect_lines=3),
        app.VerifySpec(expect_file="data.csv", expect_columns=["name", "score"]),
        app.VerifySpec(expect_file="missing.csv"),
        app.VerifySpec(expect_file="../escape.txt"),
        app.VerifySpec(check_cmd="test -f report.md"),
    ]
    for spec in specs:
        assert app._verify(ws, spec) == app._verify(str(local), spec), spec
    for root in (local, ws.root):
        Path(root, "broken.py").write_text("def f(:\n")
    assert app._syntax_errors(ws) == app._syntax_errors(str(local)) == ["broken.py:1: invalid syntax"]
    ok, detail = app._verify(ws, app.VerifySpec(check_cmd="echo 'want 3, got 2' >&2; exit 1"))
    assert (ok, detail) == (False, "check_cmd exit 1: want 3, got 2")


def test_best_of_n_reset_snapshot_and_restore_leave_the_guest_as_they_leave_a_local_workspace(pair):
    local, guest, ws = pair
    snap_local, snap_remote = app._snapshot_scratch(str(local)), app._snapshot_scratch(ws)
    assert isinstance(snap_remote, RemoteWork)
    assert not snap_remote.root.startswith(str(guest))                          # a reset can't reach it

    app._reset_scratch(str(local))
    app._reset_scratch(ws)
    assert _files(guest) == _files(local) == {"hermes-home/config.yaml": b"model: x\n"}

    for root in (local, guest):
        (root / "loser.txt").write_text("a losing attempt\n")
    app._restore_scratch(str(local), snap_local)
    app._restore_scratch(ws, snap_remote)
    assert _files(guest) == _files(local)
    assert "loser.txt" not in _files(guest) and "reports/q1/a.txt" in _files(guest)

    app._drop_snapshot(snap_remote)
    app._drop_snapshot(snap_local)
    assert not Path(snap_remote.root).exists() and not Path(str(snap_local)).exists()


def test_a_remote_moderation_block_quarantines_the_files_it_screened(pair):
    local, guest, ws = pair
    assert sorted(app._quarantine_blocked_artifacts(ws)) == sorted(app._quarantine_blocked_artifacts(str(local)))
    assert _files(guest) == _files(local)
    assert app._artifact_paths(ws, 10**9) == [("blob.bin", 9)]


def test_dropping_a_workspace_that_is_not_a_snapshot_deletes_nothing(pair):
    _local, guest, ws = pair
    app._drop_snapshot(ws)
    assert (guest / "report.md").exists()


def test_an_answer_naming_the_guest_workspace_names_the_file_alone(pair):
    _local, _guest, ws = pair
    assert app._hide_workdir(f"saved to {ws.root}/report.md", ws) == "saved to report.md"


class GuestBackend(LocalShell):
    """An e2b-shaped backend: a sandbox exists only for the conversations listed."""

    name = "e2b"

    def __init__(self, live: set[str]):
        self.live = live

    def find(self, principal, conversation, tier):
        return Handle(f"{principal}/{conversation}", tier) if f"{principal}/{conversation}" in self.live else None


def test_a_sandboxed_sessions_download_comes_from_its_guest_and_never_makes_one(pair, monkeypatch):
    import store as store_mod
    from fastapi import HTTPException

    _local, guest, _ws = pair
    backend = GuestBackend({"alice/agent:conv-1"})
    monkeypatch.setattr(app, "SANDBOX_BACKEND", backend)
    monkeypatch.setattr(app, "_remote_work", lambda: str(guest))
    monkeypatch.setattr(app, "store", store_mod.Store(":memory:"))
    for conv in ("conv-1", "conv-2"):
        app.store.touch_session_workdir("alice", conv, "/nonexistent-local-scratch")  # the guest holds the files

    r = app.get_artifact("conv-1", "reports/q1/a.txt", "alice")
    assert (r.status_code, r.body) == (200, b"a\n")
    assert 'filename="a.txt"' in r.headers["content-disposition"]

    def status(session, name, user="alice"):
        with pytest.raises(HTTPException) as ei:
            app.get_artifact(session, name, user)
        return ei.value.status_code

    assert status("conv-2", "report.md") == 404                     # no sandbox: nothing created to look in
    assert status("conv-1", "report.md", user="mallory") == 404     # another account has no session row
    assert status("conv-1", "../local/report.md") == 404
    assert status("conv-1", "hermes-home/config.yaml") == 404       # session state, not work
    assert status("conv-1", "raw.log") == 404
    assert status("conv-1", "alias.md") == 404                      # a link the agent planted
    monkeypatch.setattr(app, "ARTIFACT_DOWNLOAD_MAX_BYTES", 4)
    assert status("conv-1", "report.md") == 413


class _Failing(LocalShell):
    """The guest as LocalShell, except a command containing `marker` fails or times out."""

    def __init__(self, marker, *, timed_out=False):
        self.marker, self.timed_out = marker, timed_out

    def exec(self, h, argv, timeout, *, stdin=None):
        if self.marker in argv[-1]:
            return ExecResult("", "boom", None if self.timed_out else 1, 5, timed_out=self.timed_out)
        return super().exec(h, argv, timeout, stdin=stdin)


@pytest.mark.parametrize("timed_out", [False, True])
def test_a_listing_that_fails_in_the_guest_fails_moderation_closed_never_as_an_empty_workspace(pair, timed_out):
    """An empty answer from a dead `find` would let STAGE_ARTIFACTS moderation pass files it
    never saw. It raises instead, which fails the task, so nothing unscreened is served."""
    _local, guest, _ws = pair
    ws = RemoteWork(_Failing("find .", timed_out=timed_out), Handle("k", Tier.AGENT), str(guest))  # pyright: ignore[reportArgumentType]
    with pytest.raises(remote_work.SandboxError, match="listing the workspace"):
        app._artifact_text_for_moderation(ws)


def test_a_snapshot_or_reset_that_fails_in_the_guest_raises(pair):
    _local, guest, _ws = pair
    with pytest.raises(remote_work.SandboxError, match="snapshotting"):
        RemoteWork(_Failing("tar"), Handle("k", Tier.AGENT), str(guest)).snapshot()  # pyright: ignore[reportArgumentType]
    with pytest.raises(remote_work.SandboxError, match="clearing"):
        RemoteWork(_Failing("rm -rf"), Handle("k", Tier.AGENT), str(guest)).reset()  # pyright: ignore[reportArgumentType]


class _LaggingClock(LocalShell):
    """A guest whose clock runs an hour behind this machine's, as one resumed from a memory snapshot can."""

    LAG = 3600.0

    def exec(self, h, argv, timeout, *, stdin=None):
        script = argv[-1].replace("date +%s.%N", f"echo {time.time() - self.LAG:.6f}")
        return super().exec(h, [*argv[:-1], script], timeout, stdin=stdin)


def test_a_guest_clock_behind_ours_still_keeps_this_turns_files_and_drops_last_turns(pair):
    """`since` is this machine's clock and mtimes are the guest's. Written a few seconds into
    this turn by a lagging guest, a file must still count; one from ten minutes before the turn must not."""
    _local, guest, _ws = pair
    now, lag = time.time(), _LaggingClock.LAG
    for p in guest.rglob("*"):
        if not p.is_symlink():
            os.utime(p, (now - lag - 600, now - lag - 600))
    os.utime(guest / "report.md", (now - lag - 5, now - lag - 5))
    ws = RemoteWork(_LaggingClock(), Handle("k", Tier.AGENT), str(guest))  # pyright: ignore[reportArgumentType]
    assert ws.files(100, since=now - 60) == [("report.md", (guest / "report.md").stat().st_size)]


def test_a_file_read_that_fails_in_the_guest_fails_moderation_closed(pair):
    """A per-file read that fails must not read as "not a file", or moderation skips its text."""
    _local, guest, _ws = pair
    ws = RemoteWork(_Failing("base64"), Handle("k", Tier.AGENT), str(guest))  # pyright: ignore[reportArgumentType]
    with pytest.raises(remote_work.SandboxError, match="reading"):
        app._artifact_text_for_moderation(ws)


def test_names_holding_a_tab_or_newline_are_listed_and_moderated(pair):
    local, _guest, ws = pair
    listed = [rel for rel, _ in app._artifact_paths(ws, 10**9)]
    assert "tab\tname.txt" in listed and "new\nline.txt" in listed
    assert "a tab in the name" in app._artifact_text_for_moderation(ws)
    assert app._artifact_text_for_moderation(ws) == app._artifact_text_for_moderation(str(local))


def test_a_blocked_file_whose_move_fails_is_deleted_rather_than_left_downloadable(pair):
    _local, guest, _ws = pair
    ws = RemoteWork(LocalShell(), Handle("k", Tier.AGENT), str(guest))  # pyright: ignore[reportArgumentType]
    q = guest / app.ARTIFACT_QUARANTINE_DIRNAME
    shutil.rmtree(q, ignore_errors=True)
    q.write_text("x")  # a file where the directory goes: mkdir fails, so the move never runs
    assert ws.quarantine("report.md") is True
    assert not (guest / "report.md").exists()


class _Pausing:
    """Records the order of pause and busy-release; `fail` makes pause raise like an unreachable host."""

    name = "e2b"

    def __init__(self, fail=False):
        self.fail, self.events = fail, []

    def pause(self, h):
        self.events.append(("pause", h.key, h.key in app._REMOTE_BUSY))
        if self.fail:
            raise RuntimeError("host unreachable")


@pytest.mark.parametrize("fail", [False, True])
def test_a_finished_tasks_sandbox_is_paused_before_its_conversation_is_freed(monkeypatch, fail):
    """CUR-4503: a running E2B sandbox holds 1 GiB of the host's pool until it idles, so ten finished tasks filled
    the host; the task's end pauses it, and a failed pause still frees the conversation for its next task."""
    backend = _Pausing(fail)
    monkeypatch.setattr(app, "SANDBOX_BACKEND", backend)
    h = Handle("alice/agent:conv-1", Tier.AGENT)
    app._REMOTE_BUSY.add(h.key)
    task = types.SimpleNamespace(id="t-1", _sbx=h)
    app._release_sandbox(task)
    assert backend.events == [("pause", h.key, True)], "paused while the conversation was still held"
    assert h.key not in app._REMOTE_BUSY


def test_a_task_sent_right_after_stop_waits_for_the_stopped_one_to_free_the_conversation():
    """A person who presses Stop and sends again lands while the stopped task still pauses its sandbox; the new
    task waits for the release instead of failing with "another task is running in this conversation"."""
    import threading

    key = "bob-conv-wait"
    assert app._claim_remote(key, 0)
    threading.Timer(0.2, app._unclaim_remote, args=(key,)).start()
    t0 = time.monotonic()
    assert app._claim_remote(key, 5), "the second task gave up while the first was releasing"
    assert 0.1 < time.monotonic() - t0 < 4
    app._unclaim_remote(key)


def test_a_task_refuses_once_the_conversation_stays_held_past_the_wait():
    """The wait is bounded: a task that never releases still refuses the next one, after the wait, not forever."""
    key = "bob-conv-held"
    assert app._claim_remote(key, 0)
    t0 = time.monotonic()
    assert app._claim_remote(key, 0.3) is False
    assert time.monotonic() - t0 >= 0.3
    app._unclaim_remote(key)
    assert key not in app._REMOTE_BUSY


def test_the_auto_reviewer_sees_the_guests_own_files_not_this_machines(pair):
    """A sandbox run's files live in the guest, so the reviewer's files_in_folder has to come from there, or
    a delete of the person's file is reviewed against a folder that holds nothing of theirs."""
    _local, guest, ws = pair
    names = app._workdir_listing(ws)
    hermes_dirs = {"hermes-home", "hermes-home-t1-1"}
    assert names == [n for n in app._workdir_listing(str(guest)) if n not in hermes_dirs]
    assert "report.md" in names and "hermes-home-notes.txt" in names


def test_a_guest_listing_that_fails_raises_so_the_reviewer_asks_rather_than_seeing_an_empty_folder(pair):
    _local, guest, _ws = pair
    ws = RemoteWork(_Failing("-maxdepth 1"), Handle("k", Tier.AGENT), str(guest))  # pyright: ignore[reportArgumentType]
    with pytest.raises(remote_work.SandboxError, match="listing the workspace"):
        app._workdir_listing(ws)


def test_a_file_the_agent_made_in_the_guest_is_never_called_missing(tmp_path):
    """CUR-4595: a task that delivers a .docx/.xlsx must not be answered "I was not able to complete
    this"; the existence check looks in the guest, not this machine's empty scratch."""
    guest, scratch = tmp_path / "guest", tmp_path / "scratch"
    guest.mkdir()
    scratch.mkdir()
    (guest / "heating_repair_request.docx").write_bytes(b"PK\x03\x04docx")
    ws = RemoteWork(LocalShell(), Handle("k", Tier.AGENT), str(guest), local=str(scratch))  # pyright: ignore[reportArgumentType]
    made = "I saved the letter as `heating_repair_request.docx` in your folder."
    assert app._false_existence_claim(made, ws) is None
    assert app._wrote_code_without_running_it({"execute"}, set(), ws, made, True) is None
    assert app._false_existence_claim(made, str(scratch)) == "heating_repair_request.docx", \
        "the local scratch really is empty, so only the guest-aware read clears it"
    invented = "I saved the letter as `landlord_letter.docx` in your folder."
    assert app._false_existence_claim(invented, ws) == "landlord_letter.docx", "a file in neither place is still missing"


def test_the_unrun_script_check_finds_python_in_the_guest(tmp_path):
    guest, scratch = tmp_path / "guest", tmp_path / "scratch"
    (guest / "hermes-home").mkdir(parents=True)
    (guest / "hermes-home" / "plugin.py").write_text("x = 1\n")
    (guest / "tools").mkdir()
    (guest / "tools" / "chart.py").write_text("print(1)\n")
    scratch.mkdir()
    ws = RemoteWork(LocalShell(), Handle("k", Tier.AGENT), str(guest), local=str(scratch))  # pyright: ignore[reportArgumentType]
    assert app._runnable_python(ws) == "tools/chart.py"
    assert app._wrote_code_without_running_it({"edit"}, set(), ws, "", True) == "tools/chart.py"
    (guest / "tools" / "chart.py").unlink()
    assert app._runnable_python(ws) is None


def test_a_continued_session_on_e2b_is_told_the_files_its_guest_already_holds(tmp_path):
    """CUR-4595: the note lists the guest's files, not this machine's empty scratch, so a follow-up turn
    is not told an empty room and does not answer "the file does not exist" about a file made the turn before."""
    guest, scratch = tmp_path / "guest", tmp_path / "scratch"
    guest.mkdir()
    scratch.mkdir()
    (guest / "plan-1.txt").write_text("potluck 1\n")
    ws = RemoteWork(LocalShell(), Handle("k", Tier.AGENT), str(guest), local=str(scratch))  # pyright: ignore[reportArgumentType]
    note, count = app._workdir_note(ws, True, False)
    assert "- plan-1.txt" in note and count == 1
    assert app._workdir_note(str(scratch), True, False)[1] == 0, "the local scratch alone shows the empty room"
