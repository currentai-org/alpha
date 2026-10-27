#!/usr/bin/env python3
"""Offline unit tests for the in-app ACP client (api/acp_client.py) — the transport that drives a
sandboxed `hermes acp` when AGENT_ACP=1 (streaming-spec §3/§7.1).

Covers the parts that need no live Hermes: message accumulation, session_update -> redacted SSE frames
(the two-tier audit contract — no raw_input/title/locations may cross), the request_permission gate
(default-allow == old --yolo; deny_writes rejects edits; CUR-760: edit/delete always pauses for confirm
regardless of resolved policy, deny_writes excepted), the fs handlers' sandbox containment
(fail-closed on escape), the argv split, config synthesis, and the AGENT_EARLY_EXIT debounce (2
consecutive verify() passes before signaling, wired to fire only on a completed tool_call_update). The
live end-to-end drive of `hermes acp` through these handlers is scripts/acp_inbound_smoke.py.

Importing this pulls in `agent-client-protocol` (a dev dep; in production it lives in the Hermes venv).
"""
import asyncio
import contextlib
import inspect
import json
import os
import types

import acp
import acp_client
import pytest


class _CapBuf:
    """Stand-in for app._EventBuffer — records (event_type, data) the way emit() would."""

    def __init__(self):
        self.frames: list[tuple[str, dict]] = []

    def emit(self, event_type, data):
        self.frames.append((event_type, data))


def _u(disc, **fields):
    """A fake ACP session update: SimpleNamespace with the `session_update` discriminator + fields."""
    return types.SimpleNamespace(session_update=disc, **fields)


def _run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- text accumulation
def test_message_accumulation():
    """agent_message_chunk deltas accumulate into .text — the stdout-blob replacement fed downstream."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="Hello, "))))
    _run(c.session_update("s", _u("agent_message_chunk", content={"text": "world"})))  # dict form too
    _run(c.session_update("s", _u("agent_thought_chunk", content=types.SimpleNamespace(text="(thinking)"))))
    assert c.text == "Hello, world", "chunks concatenate; thoughts are NOT part of the answer text"


# --------------------------------------------------------------------------- answer-text streaming
def test_a_tool_call_starting_clears_the_narration_that_preceded_it():
    """A turn that loops through many tool calls must not return every aside the model said before each
    call joined into one wall of near-duplicate one-liners ahead of the real final answer (CUR-542).
    Mirrors the repair-turn `.clear()` (same file, the while
    loop in `_acp_run`): a new tool call is the same kind of boundary — whatever text accumulated before
    it is not the turn's answer, because more work is about to happen."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("agent_message_chunk",
                                  content=types.SimpleNamespace(text="Let me check that for you..."))))
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t1", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="completed")))
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="Done."))))
    assert c.text == "Done.", "the pre-tool-call aside is gone; only the answer after the last call remains"


def test_multiple_tool_call_rounds_each_clear_in_turn():
    """A long tool-heavy turn has several rounds, not one — each round's leftover narration must not
    survive into the next, or a long tool-heavy turn just relocates the bug from 'never clears' to
    'clears once and then re-accumulates across the rest.'"""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="First, I'll read the file."))))
    _run(c.session_update("s", _u("tool_call", kind="read", tool_call_id="t1", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="completed")))
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="Now I'll run it."))))
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t2", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t2", status="completed")))
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="The result is 42."))))
    assert c.text == "The result is 42.", "only the final round's answer survives, not every round's narration"


def test_a_message_streamed_in_chunks_with_no_tool_call_between_them_still_concatenates():
    """The fix must not overcorrect: chunks belonging to ONE message, with no tool call interleaved,
    are still deltas of the same answer and must still join — nothing clears unless a tool_call fires."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="The answer "))))
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="is 42."))))
    assert c.text == "The answer is 42.", "no tool call fired, so nothing clears and the deltas still join"


def test_flag_off_emits_no_token_frame():
    """The test that matters most, because it is the fallback: with emit_token off the frame stream is
    byte-identical to a stream without token frames, and .text is unaffected either way."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1)          # default: emit_token=False
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="Hello, "))))
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="world"))))
    assert buf.frames == [], "flag off -> not one frame on the wire"
    assert c.text == "Hello, world", "accumulation is unconditional — done.result must not depend on the flag"


def test_flag_on_streams_deltas_and_they_reassemble_into_the_answer():
    """A consumer concatenating the deltas must arrive at exactly what done.result will carry, or the two
    delivery paths disagree and the streamed version is a second, unverified answer."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, emit_token=True)
    for part in ("The ", "answer ", "is 42."):
        _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text=part))))
    assert [f[0] for f in buf.frames] == ["token"] * 3, "one frame per chunk, nothing else"
    assert "".join(f[1]["delta"] for f in buf.frames) == c.text == "The answer is 42.", \
        "concatenated deltas == the text done.result carries"
    assert all(f[1]["attempt"] == 1 for f in buf.frames), "each frame names its attempt"


def test_thoughts_never_reach_the_token_stream():
    """agent_thought_chunk is outside the SSE contract and is not the answer. Streaming it would publish the
    model's scratch reasoning to the chat surface as if it were prose — a content decision, not a plumbing
    one, and not one this flag is entitled to make."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, emit_token=True)
    _run(c.session_update("s", _u("agent_thought_chunk", content=types.SimpleNamespace(text="hmm, maybe"))))
    assert buf.frames == [], "no frame for a thought chunk"
    assert c.text == "", "and it is not part of the answer either"


def test_token_frames_are_capped_with_exactly_one_marker():
    """Uncapped, an answer stream evicts its own turn's plan/tool_call at the _EventBuffer trim and a client
    resuming with Last-Event-ID sees a turn that never planned. The marker exists so a consumer can tell
    'the answer changed' from 'I stopped being sent it' — silently stopping makes those identical."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, emit_token=True, token_max_frames=3)
    for i in range(10):
        _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text=f"{i}"))))
    kinds = [f[0] for f in buf.frames]
    assert kinds == ["token", "token", "token", "token_truncated"], f"3 tokens then ONE marker; got {kinds}"
    assert buf.frames[-1][1] == {"attempt": 1, "frames": 3}, "the marker says how many made it"
    assert c.text == "0123456789", "the cap bounds PUBLICATION only — the answer is still whole"


def test_token_cap_of_zero_means_uncapped():
    """0 is the 'off' convention every other cap in this service uses; reading it as 'emit nothing' would
    silently disable streaming for anyone who set it that way meaning unlimited."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, emit_token=True, token_max_frames=0)
    for _ in range(50):
        _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="x"))))
    assert [f[0] for f in buf.frames] == ["token"] * 50, "0 -> no cap, no marker"


def test_empty_deltas_do_not_produce_frames():
    """Hermes sends empty chunks. Each one would be a frame against the cap and a no-op for the reader."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, emit_token=True, token_max_frames=2)
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text=""))))
    _run(c.session_update("s", _u("agent_message_chunk", content=types.SimpleNamespace(text="real"))))
    assert [f[0] for f in buf.frames] == ["token"], "the empty chunk spends no frame"


# --------------------------------------------------------------------------- redacted tool frames
def test_tool_frames_are_redacted():
    """tool_call/tool_result emit ONLY kind+step / ok+step+summary — never raw_input/title/locations."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t1",
                                  title="rm -rf /secret/path", raw_input={"cmd": "cat /etc/shadow"},
                                  raw_output="SECRET", locations=["/etc/shadow"], status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", kind="execute", tool_call_id="t1",
                                  title="rm -rf /secret/path", raw_input={"cmd": "cat /etc/shadow"},
                                  status="completed")))
    kinds = [f[0] for f in buf.frames]
    assert kinds == ["tool_call", "tool_result"], "one start frame, one result frame"
    call, result = buf.frames[0][1], buf.frames[1][1]
    assert call == {"tool": "execute", "step": 1}, "tool_call carries kind + step index ONLY"
    assert result == {"ok": True, "step": 1, "summary": "completed"}, "tool_result: ok/step/redacted summary"
    # Hard redaction guard: none of the raw args survive anywhere in the serialized frames.
    blob = json.dumps(buf.frames, default=str)
    for leak in ("/etc/shadow", "rm -rf", "cat /etc/shadow", "SECRET", "raw_input", "title", "locations"):
        assert leak not in blob, f"raw arg leaked into SSE frame: {leak!r}"


def test_tool_step_index_is_stable_per_call_id():
    """The same tool_call_id keeps its step number across start->update; a new id increments."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="read", tool_call_id="a", status="in_progress")))
    _run(c.session_update("s", _u("tool_call", kind="edit", tool_call_id="b", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="a", status="completed")))
    steps = [f[1]["step"] for f in buf.frames]
    assert steps == [1, 2, 1], "id 'a'->1, id 'b'->2, and 'a' keeps 1 on its update"


def test_tool_failures_tracks_kind_not_call_id():
    """CUR-574: a tool_call_update with status=="failed" adds the call's KIND (looked up via the id ->
    kind map set at tool_call time) to tool_failures — the fact _wrote_code_without_running_it needed
    and couldn't get from tool_kinds alone, since that set never distinguished success from failure."""
    buf = _CapBuf()
    fails: set[str] = set()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, tool_failures=fails)
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t1", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="failed")))
    assert c.tool_failures == {"execute"} == fails, "shared by reference, same as tool_kinds"

    # A merely in_progress update is not a failure — must not pre-emptively mark the kind before the
    # call's terminal status is known.
    fails.clear()
    _run(c.session_update("s", _u("tool_call", kind="edit", tool_call_id="t2", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t2", status="in_progress")))
    assert fails == set(), "in_progress is not failed"

    # A completed call never enters tool_failures regardless of what other calls did this attempt.
    fails.clear()
    _run(c.session_update("s", _u("tool_call", kind="read", tool_call_id="t3", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t3", status="completed")))
    assert fails == set()


def test_tool_failures_discards_kind_on_later_success_of_same_kind():
    """CUR-772: execute fails, the model retries, the retry succeeds — tool_failures must not still
    say "execute never ran," or the honesty caveat fires on a turn whose answer IS grounded in a real
    measurement. A failure of a DIFFERENT kind, and a same-kind failure with no successful retry
    (CUR-574's own case), must both still flag."""
    buf = _CapBuf()
    fails: set[str] = set()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, tool_failures=fails)
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t1", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="failed")))
    assert fails == {"execute"}, "first execute call failed"

    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t2", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t2", status="completed")))
    assert fails == set(), "retry of the SAME kind succeeded — the earlier failure no longer applies"

    # A different kind's failure is untouched by an execute success.
    fails.clear()
    _run(c.session_update("s", _u("tool_call", kind="edit", tool_call_id="t3", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t3", status="failed")))
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t4", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t4", status="completed")))
    assert fails == {"edit"}, "an execute success does not clear a DIFFERENT kind's failure"

    # No successful retry of the failed kind — stays flagged (CUR-574's case, unchanged).
    fails.clear()
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t5", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t5", status="failed")))
    assert fails == {"execute"}, "never retried successfully — the caveat's original case still holds"


def test_tool_failures_redaction_matches_tool_kinds():
    """Same two-tier audit contract as test_tool_frames_are_redacted: tool_failures is a set of kind
    strings only, and none of the raw args reach it or the frames on the wire."""
    buf = _CapBuf()
    fails: set[str] = set()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1, tool_failures=fails)
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t1",
                                  title="cat /etc/shadow", raw_input={"cmd": "cat /etc/shadow"},
                                  status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", raw_output="SECRET",
                                  status="failed")))
    assert fails == {"execute"}
    blob = json.dumps(buf.frames, default=str)
    for leak in ("/etc/shadow", "cat /etc/shadow", "SECRET", "raw_input", "title"):
        assert leak not in blob, f"raw arg leaked into SSE frame: {leak!r}"


# ── tool_kinds commits on COMPLETION, not proposal (CUR-705) ─────────────────────────────────────────
# The shape: an edit proposed, the confirm denied on timeout, the model gives up and hands back a script
# instead. If self.tool_kinds held "edit" from the bare proposal, the groundedness judge would never
# fire. The web side's toolKinds tracking (endpointAgent.ts) follows the same rule. These tests drive
# session_update directly instead of constructing tool_kinds as a literal, which is what exercises it.

def test_tool_kinds_stays_empty_when_no_completion_ever_arrives():
    """The exact denied/timed-out-confirm shape: a tool_call proposal with no matching tool_call_update
    at all — acp_client.py's own request_permission confirms a denied/timed-out confirm never reaches a
    real tool call, so no tool_call_update frame is ever emitted for it. tool_kinds must stay empty, not
    permanently record a call that never ran."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="edit", tool_call_id="t1", status="in_progress")))
    assert c.tool_kinds == set(), "a proposal alone must not count as something that ran"


def test_tool_kinds_commits_when_tool_call_update_reports_completed():
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="edit", tool_call_id="t1", status="in_progress")))
    assert c.tool_kinds == set(), "not yet — completion hasn't arrived"
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="completed")))
    assert c.tool_kinds == {"edit"}, "commits only once the completion status actually arrives"


def test_failed_tool_call_update_does_not_join_tool_kinds():
    """A tool call that ran and FAILED is a different, lesser bug (TOOL_FAILED_PREFIX's own territory in
    app.py) — not "never ran", but also not "ran cleanly". Only status=="completed" commits to
    tool_kinds; "failed" must not, or a broken call reads identically to a successful one downstream."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="execute", tool_call_id="t1", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="failed")))
    assert c.tool_kinds == set()


def test_a_second_kind_in_the_same_attempt_is_independently_gated():
    """Two calls, one completed and one only proposed — proves the commit is per-call, not a blanket
    flip once anything in the attempt succeeds."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="read", tool_call_id="t1", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="t1", status="completed")))
    _run(c.session_update("s", _u("tool_call", kind="edit", tool_call_id="t2", status="in_progress")))
    # t2 never gets a tool_call_update — the denied-confirm shape.
    assert c.tool_kinds == {"read"}, "the completed call counts; the merely-proposed one still doesn't"


def test_id_less_tool_call_keeps_the_eager_add_as_an_acknowledged_fallback():
    """An id-less call (tool_call_id is None/absent) has no way to correlate a later completion back to
    it — _call_kind is keyed by id and deliberately records nothing for a missing one (see that
    assignment's own comment). Rather than silently never counting it, this keeps the OLD eager-add
    behavior for exactly this one edge case — a narrow, acknowledged exception, not a gap."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("tool_call", kind="think", tool_call_id=None, status="in_progress")))
    assert c.tool_kinds == {"think"}, "id-less calls still count immediately, same as before this fix"


# --------------------------------------------------------------------------- plan frame
def test_plan_frame_truncated():
    """plan entries surface as a redacted, whitespace-collapsed, truncated step list under the attempt."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=2)
    long = "x" * 200
    _run(c.session_update("s", _u("plan", entries=[
        types.SimpleNamespace(content="Write   the\nfile", priority="high", status="pending"),
        types.SimpleNamespace(content=long, priority="low", status="pending"),
    ])))
    assert buf.frames[0][0] == "plan"
    data = buf.frames[0][1]
    assert data["attempt"] == 2
    assert data["steps"][0] == "Write the file", "whitespace collapsed"
    assert len(data["steps"][1]) <= 80, "long step content is hard-truncated"


# --------------------------------------------------------------------------- usage frame
def test_usage_frame():
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=1)
    _run(c.session_update("s", _u("usage_update", used=1234, size=8000, cost=None)))
    assert buf.frames == [("usage", {"tokens": 1234})], "usage forwards the token tally only"


# --------------------------------------------------------------------------- policy frame (CUR-471)
def test_emit_policy_stamps_the_attempt_and_forwards_the_decision_verbatim():
    """Unlike plan/tool_call/usage (reactions to session_update), emit_policy is called directly by
    _acp_run right after construction — this is the boundary that actually needs a test; the two-line
    `if policy_detail is not None: client.emit_policy(policy_detail)` in _acp_run itself is too small
    to need its own live-session test on top of this."""
    buf = _CapBuf()
    c = acp_client._AgentClient(work="/tmp", buf=buf, attempt=3)
    decision = {"policy": "deny_writes", "tier": "new", "tasks_done": 1, "tasks_required": 3}
    c.emit_policy(decision)
    assert buf.frames == [("policy", {"policy": "deny_writes", "tier": "new", "tasks_done": 1,
                                       "tasks_required": 3, "attempt": 3})]


def test_emit_policy_never_fires_unless_acp_run_is_given_a_decision():
    """policy_detail=None (the default) means _acp_run never calls emit_policy at all — confirmed by
    inspecting the source rather than driving a live session, since _acp_run needs a real Hermes
    subprocess to run past this point and no existing test in this file attempts that."""
    src = inspect.getsource(acp_client._acp_run)
    assert "if policy_detail is not None:" in src and "client.emit_policy(policy_detail)" in src, \
        "the guard must exist verbatim — an unconditional emit would send a bogus frame under oneshot " \
        "callers or any caller that doesn't pass policy_detail"


# --------------------------------------------------------------------------- request_permission gate
def _opt(kind, oid):
    return types.SimpleNamespace(kind=kind, option_id=oid, name=kind)


def test_permission_default_allow():
    """Default policy picks the allow option — behaviorally identical to the old --yolo, but observed.
    kind="read": any kind outside _ALWAYS_CONFIRM_KINDS proves the point; "execute" is on that list
    (CUR-975) and would hang this test waiting for a confirm nobody answers."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)  # no permission_policy arg -> "allow"
    c.permission_policy = "allow"
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]
    resp = _run(c.request_permission(opts, "s", types.SimpleNamespace(kind="read")))
    assert resp.outcome.option_id == "yes", "selects the allow_* option id"
    assert c.permission_calls == 1, "permission decisions are counted (observability)"


def test_permission_deny_writes_rejects_edits():
    """deny_writes rejects edit/delete kinds, still allows reads/execs."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    c.permission_policy = "deny_writes"
    opts = [_opt("allow_once", "yes"), _opt("reject_once", "no")]
    edit = _run(c.request_permission(opts, "s", types.SimpleNamespace(kind="edit")))
    assert edit.outcome.option_id == "no", "an edit is rejected under deny_writes"
    read = _run(c.request_permission(opts, "s", types.SimpleNamespace(kind="read")))
    assert read.outcome.option_id == "yes", "a read is still allowed under deny_writes"


# --------------------------------------------------------------------------- confirm x staged (CUR-760)
def test_always_confirm_kinds_is_the_short_named_list_the_ticket_asked_for():
    """Documentation-as-test: the actual list a reviewer needs to check is this tuple, not a scattered
    set of `in (...)` literals. Pins it to CUR-217's write-effect pair plus CUR-975's execute addition so
    a future edit that silently widens or narrows it fails a test, not just a code review."""
    assert acp_client._ALWAYS_CONFIRM_KINDS == ("edit", "delete", "execute")


def test_permission_allow_still_pauses_for_confirm_on_an_always_confirm_kind():
    """CUR-760's core case: a trusted caller (resolved policy="allow", whether from bare
    ACP_PERMISSION_POLICY=allow or a `staged` caller's earned trusted tier — this class only ever sees
    the resolved string) still gets paused for a human decision on an edit/delete-kind call. Without
    that, "allow" would short-circuit straight to yes with no pause at all."""
    for kind, decision, want in (("edit", "allow", "yes"), ("delete", "deny", "no")):
        c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="allow")
        opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

        async def drive():
            task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(kind=kind)))
            await asyncio.sleep(0)                 # let request_permission run up to its await
            assert len(c._pending_confirms) == 1, f"{kind}: must actually pause, not auto-allow"
            confirm_id = next(iter(c._pending_confirms))
            c._pending_confirms[confirm_id].set_result(decision)
            return await task

        resp = _run(drive())
        assert resp.outcome.option_id == want, f"{kind}: human answer '{decision}' must be honored"


def test_permission_allow_proceeds_without_confirm_on_everything_else():
    """The DoD's other half: "and proceeds without it on everything else" — a trusted/allow caller's
    non-listed tool kinds still resolve immediately, no pause, exactly as before. A short
    confirm_timeout_secs makes a regression (accidentally routing these through the pause) fail fast
    instead of hanging ~45s. "execute" is on _ALWAYS_CONFIRM_KINDS (CUR-975) — see
    test_permission_allow_still_pauses_for_confirm_on_an_always_confirm_kind below for its own coverage."""
    for kind in ("read", "search", "fetch", "other", "think", "move", "switch_mode"):
        c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="allow",
                                    confirm_timeout_secs=0.01)
        opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]
        resp = _run(c.request_permission(opts, "s", _tool_call(kind=kind)))
        assert resp.outcome.option_id == "yes", f"{kind}: must still auto-allow"
        assert c._pending_confirms == {}, f"{kind}: must never have paused at all"


def test_permission_deny_writes_keeps_failing_closed_no_confirm_pause():
    """The DoD's untrusted-caller guarantee: "a tier-0/untrusted caller keeps failing closed on anything
    above their floor exactly as before" — composing confirm onto `allow` must NOT soften deny_writes's
    outright refusal of edit/delete/execute into "pause and ask a human". Asserts the stronger claim than
    test_permission_deny_writes_rejects_edits above: no confirmation is ever registered, i.e. this
    resolves synchronously without anyone needing to answer it. "execute" here is defense in depth only —
    in practice app.py's _deny_writes_toolsets keeps an untrusted caller from ever proposing one; this
    pins what happens if that floor were ever bypassed."""
    for kind in ("edit", "delete", "execute"):
        c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="deny_writes",
                                    confirm_timeout_secs=0.01)
        opts = [_opt("allow_once", "yes"), _opt("reject_once", "no")]
        resp = _run(c.request_permission(opts, "s", _tool_call(kind=kind)))
        assert resp.outcome.option_id == "no", f"{kind}: still denied outright under deny_writes"
        assert c._pending_confirms == {}, f"{kind}: deny_writes must not route through the confirm pause"


def test_permission_allow_still_pauses_for_confirm_on_execute_kind():
    """The core case of CUR-975, symmetric with test_permission_allow_still_pauses_for_confirm_on_an_
    always_confirm_kind above but for "execute" specifically: a trusted caller (resolved policy="allow")
    that issues a terminal/process/execute_code call — now proposed via
    deploy/hermes/0002-acp-confirm-execute.patch's maybe_require_execute_approval — still gets paused for
    a human decision. Without the patch Hermes never proposes the call, and "allow" and "confirm" are
    indistinguishable for a shell command."""
    for decision, want in (("allow", "yes"), ("deny", "no")):
        c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="allow")
        opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

        async def drive():
            task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(kind="execute")))
            await asyncio.sleep(0)
            assert len(c._pending_confirms) == 1, "must actually pause, not auto-allow"
            confirm_id = next(iter(c._pending_confirms))
            c._pending_confirms[confirm_id].set_result(decision)
            return await task

        resp = _run(drive())
        assert resp.outcome.option_id == want, f"human answer '{decision}' must be honored"


def test_permission_confirm_policy_still_confirms_kinds_outside_the_always_confirm_list():
    """Regression guard the other direction: literal ACP_PERMISSION_POLICY=confirm must keep pausing on
    EVERY tool call that reaches this method, not narrow down to only _ALWAYS_CONFIRM_KINDS — composing
    the list onto other policies must not accidentally become the new definition of "confirm" itself."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm")
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

    async def drive():
        task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(kind="read")))
        await asyncio.sleep(0)
        assert len(c._pending_confirms) == 1, "confirm mode pauses on a non-listed kind too"
        confirm_id = next(iter(c._pending_confirms))
        c._pending_confirms[confirm_id].set_result("allow")
        return await task

    resp = _run(drive())
    assert resp.outcome.option_id == "yes"


def test_a_cancel_during_a_pending_confirmation_stays_a_cancel_and_is_not_masked():
    """CUR-1227. Names the contract, not the behavior: what must survive this block is the CancelledError
    itself. _request_confirmation's `finally` emits a confirm_result carrying `decision`/`reason`, and
    those two names are assigned only by the try body and the `except TimeoutError` handler — so
    without a default bound before the try, any other exception through the wait would reach that finally
    with both unbound and raise UnboundLocalError in their place, destroying the real reason the attempt ended. The live shape is the
    agent process dying with a confirmation open: the acp TaskSupervisor cancels this coroutine as the
    session tears down. (The DELETE path does not hit it — _cancel_soon resolves every pending future
    with "canceled" explicitly, so the designed cancel binds both names.)

    Deleting the `decision, reason = "deny", "aborted"` line above the try makes this fail with
    UnboundLocalError."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm")
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

    async def drive():
        task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(kind="edit")))
        await asyncio.sleep(0)
        assert len(c._pending_confirms) == 1, "must be parked on the confirmation before we cancel it"
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return "cancelled"
        except BaseException as e:            # noqa: BLE001 — the point is to NAME whatever came out
            return f"{type(e).__name__}: {e}"
        return "returned normally"

    assert _run(drive()) == "cancelled"


def test_confirm_allow_credits_tool_kinds_with_no_completion_event_ever_arriving():
    """CUR-468: at the pinned Hermes SHA, Hermes's edit-approval flow sends exactly ONE tool_call
    notification — the "Preparing write..." proposal that opens the confirmation — and, once approved,
    no matching tool_call_update(completed), even though the file is written. The normal "commit at completion" path
    (session_update's status=="completed" branch) is therefore structurally unreachable for this call
    shape, and a spec-less turn (task._verify_spec is None — the real chat-surface/synthesize=True case,
    not just a bare script) whose only tool call was an approved edit would report FAILED "agent made no
    tool calls" despite the human saying yes and the write succeeding. No session_update of any kind is
    delivered here — this asserts the credit happens off the confirm decision alone."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm",
                                tool_failures={"edit"})
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

    async def drive():
        task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(kind="edit")))
        await asyncio.sleep(0)
        confirm_id = next(iter(c._pending_confirms))
        c._pending_confirms[confirm_id].set_result("allow")
        return await task

    resp = _run(drive())
    assert resp.outcome.option_id == "yes"
    assert c.tool_kinds == {"edit"}, "an explicit allow is the only completion signal this flow ever gets"
    assert c.tool_failures == set(), "a fresh allow clears a stale failure the same way a real completion would"


def test_confirm_deny_never_credits_tool_kinds():
    """The other half of CUR-468's fix: an unapproved call never runs, so crediting it on deny/timeout
    would reintroduce the exact fabrication gap CUR-705 round three closed on the tool_call proposal
    itself. Both exit paths of _request_confirmation (a human "deny" and a timeout) must leave
    tool_kinds untouched."""
    for decision in ("deny", None):  # None -> let it time out
        c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm",
                                    confirm_timeout_secs=0.01)
        opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

        async def drive():
            task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(kind="edit")))
            await asyncio.sleep(0)
            if decision is not None:
                confirm_id = next(iter(c._pending_confirms))
                c._pending_confirms[confirm_id].set_result(decision)
            return await task

        resp = _run(drive())
        assert resp.outcome.option_id == "no"
        assert c.tool_kinds == set(), f"decision={decision}: an unapproved call must never be credited"


def test_permission_policy_constructor_arg_threads_through_and_defaults_to_allow():
    """CUR-470: the constructor is handed the already-resolved value now (app.py's
    _resolve_permission_policy), not left to re-derive it from ACP_PERMISSION_POLICY itself — under
    "staged" there is no single global value left to re-derive. The default has to stay "allow" so
    every one of this file's ~18 other _AgentClient(...) call sites, none of which pass this arg,
    keep behaving exactly as before."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    assert c.permission_policy == "allow", "omitted -> allow, matching every pre-CUR-470 construction"
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1, permission_policy="deny_writes")
    assert c.permission_policy == "deny_writes", "passed explicitly -> threads straight through"


# --------------------------------------------------------------------------- _AttemptClock (CUR-218)
class _FakeLoop:
    """A controllable loop.time() — real-time sleeps would make "banks the exact remaining budget"
    either slow or flaky. advance() moves the fake clock deterministically."""

    def __init__(self, t: float = 0.0):
        self._t = t

    def time(self) -> float:
        return self._t

    def advance(self, dt: float) -> None:
        self._t += dt


def test_attempt_clock_pause_resume_banks_exact_remaining_budget():
    loop = _FakeLoop(100.0)
    clock = acp_client._AttemptClock(loop, timeout_secs=10.0)
    assert clock.deadline == 110.0
    loop.advance(3.0)                      # 7s of compute budget left
    clock.pause()
    assert clock.deadline == float("inf"), "frozen while paused — bounded separately by confirm_timeout_secs"
    loop.advance(50.0)                     # a long human wait — must not touch the banked budget
    clock.resume()
    assert clock.deadline == loop.time() + 7.0, "the exact remaining budget is restored, not a guess"
    assert clock.total_paused == 50.0, "accumulated for app.py's _RUN_START reimbursement"


def test_attempt_clock_reentrant_pause_stays_frozen_until_last_resume():
    """Up to 8 tool calls can be concurrently awaiting confirmation for one attempt — the compute
    deadline must stay paused until the LAST one resolves, not the first."""
    loop = _FakeLoop(0.0)
    clock = acp_client._AttemptClock(loop, timeout_secs=10.0)
    clock.pause()
    clock.pause()                          # a second, independent confirmation opens
    assert clock.deadline == float("inf")
    clock.resume()                         # the first one resolves
    assert clock.deadline == float("inf"), "still frozen — one more open confirmation remains"
    clock.resume()                         # the second, last one resolves
    assert clock.deadline == 10.0, "restored only once depth returns to zero"


def test_the_watchdog_fires_after_a_confirmation_pause_that_outlasts_the_original_deadline(monkeypatch):
    """The watchdog wakes at the first deadline while a confirmation holds the clock paused, so it reads inf.
    Once the confirmation resolves it must still fire on the banked budget, not sleep forever (CUR-4535)."""
    monkeypatch.setattr(acp_client, "_WATCHDOG_TICK_SECS", 0.02)

    async def scenario() -> float:
        loop = asyncio.get_running_loop()
        clock = acp_client._AttemptClock(loop, timeout_secs=0.1)
        watchdog = asyncio.create_task(acp_client._deadline_watchdog(clock, loop))
        await asyncio.sleep(0.05)
        clock.pause()                        # a confirmation opens with 0.05 s of budget left
        await asyncio.sleep(0.2)             # the watchdog's first deadline passes while paused
        clock.resume()
        started = loop.time()
        await asyncio.wait_for(watchdog, 2.0)
        return loop.time() - started

    assert asyncio.run(scenario()) < 0.5, "fired on the banked 0.05 s, plus at most a tick"


def test_attempt_clock_resume_without_pause_is_noop():
    loop = _FakeLoop(0.0)
    clock = acp_client._AttemptClock(loop, timeout_secs=10.0)
    clock.resume()                         # no matching pause() — must not corrupt state
    assert clock.deadline == 10.0, "unmatched resume must not touch the deadline"
    assert clock._pause_depth == 0, "depth cannot go negative"


# --------------------------------------------------------------------------- confirm policy (CUR-218)
def _tool_call(kind="edit", title="edit result.txt", content=None):
    return types.SimpleNamespace(kind=kind, title=title, content=content or [],
                                  raw_input={"secret": "should never cross the SSE boundary"},
                                  raw_output=None, locations=None)


def test_confirm_policy_resolves_from_a_human_answer():
    """The happy path: request_permission pauses, something resolves the pending future with "allow",
    and the call completes with the allow option selected."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm")
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

    async def drive():
        task = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call()))
        await asyncio.sleep(0)                     # let request_permission run up to its await
        assert len(c._pending_confirms) == 1, "one confirmation registered while pending"
        confirm_id = next(iter(c._pending_confirms))
        c._pending_confirms[confirm_id].set_result("allow")   # simulates task._acp_confirm's _do()
        return await task

    resp = _run(drive())
    assert resp.outcome.option_id == "yes"
    assert c._pending_confirms == {}, "popped once resolved"


def test_confirm_policy_denies_on_timeout():
    """No answer arrives within confirm_timeout_secs — fails CLOSED (deny), not open."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm",
                                confirm_timeout_secs=0.01)
    opts = [_opt("allow_once", "yes"), _opt("reject_once", "no")]
    resp = _run(c.request_permission(opts, "s", _tool_call()))
    assert resp.outcome.option_id == "no", "timeout resolves to deny, never allow"
    result_frames = [d for t, d in c._buf.frames if t == "confirm_result"]
    assert result_frames and result_frames[-1]["reason"] == "timeout"
    assert c._pending_confirms == {}, "popped even on the timeout path"


def test_confirm_late_decision_after_timeout_is_structurally_a_noop():
    """A decision arriving after the timeout already fired must not raise (InvalidStateError on an
    already-cancelled future) — the guard in the real cross-thread closure checks `not fut.done()`
    against the SAME dict this test inspects, so an absent (already-popped) confirm_id is the
    concrete mechanism that makes a late arrival safe, not a hope."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm",
                                confirm_timeout_secs=0.01)
    _run(c.request_permission([_opt("allow_once", "yes")], "s", _tool_call()))
    assert c._pending_confirms == {}, "nothing left to resolve — a late POST finds no live future"


def test_confirm_two_concurrent_calls_resolve_independently():
    """Realistic under hermes-agent's concurrent tool executor: two edit calls can each be awaiting
    confirmation at once. Each must resolve on its own answer, not the other's."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm")
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]

    async def drive():
        t1 = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(title="edit a.py")))
        t2 = asyncio.ensure_future(c.request_permission(opts, "s", _tool_call(title="edit b.py")))
        await asyncio.sleep(0)
        assert len(c._pending_confirms) == 2, "both open at once"
        ids = list(c._pending_confirms)
        c._pending_confirms[ids[0]].set_result("deny")
        c._pending_confirms[ids[1]].set_result("allow")
        return await t1, await t2

    r1, r2 = _run(drive())
    assert r1.outcome.option_id == "no" and r2.outcome.option_id == "yes", \
        "each call resolved on its own future, not cross-contaminated"


def test_confirm_open_close_callbacks_fire_with_matched_confirm_id():
    """app.py wires on_confirmation_open/close to mutate Task.state/pending_confirmations — assert the
    callback contract (called once each, same confirm_id) rather than app.py's own state machine, which
    is covered separately in test_agent_service.py."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm",
                                confirm_timeout_secs=0.01)
    opened, closed = [], []
    c.on_confirmation_open = lambda desc: opened.append(desc)
    c.on_confirmation_close = lambda confirm_id: closed.append(confirm_id)
    _run(c.request_permission([_opt("allow_once", "yes")], "s", _tool_call()))
    assert len(opened) == 1 and len(closed) == 1
    assert opened[0]["confirm_id"] == closed[0], "open and close describe the SAME confirmation"


def test_confirm_clock_resumes_even_when_on_confirmation_open_raises():
    """The bug this test exists to catch: an earlier version paused the clock and called
    on_confirmation_open() BEFORE the try/finally that resumes it, so an exception from that callback
    (it calls _persist(task) in app.py — real sqlite I/O) would leave the attempt's deadline frozen at
    inf forever. Every exit path must resume, including this one."""
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=1, permission_policy="confirm",
                                confirm_timeout_secs=0.01)
    loop = asyncio.new_event_loop()
    try:
        clock = acp_client._AttemptClock(loop, timeout_secs=10.0)
        c._clock = clock

        def _boom(desc):
            raise RuntimeError("_persist(task) blew up")
        c.on_confirmation_open = _boom
        try:
            loop.run_until_complete(c.request_permission([_opt("allow_once", "yes")], "s", _tool_call()))
            assert False, "the callback's exception must propagate, not be swallowed"
        except RuntimeError:
            pass
        assert clock.deadline != float("inf"), "resume() ran despite on_confirmation_open raising"
    finally:
        loop.close()


def test_confirm_awaiting_and_result_frames_carry_expected_fields():
    c = acp_client._AgentClient(work="/tmp", buf=_CapBuf(), attempt=3, permission_policy="confirm",
                                confirm_timeout_secs=0.01)
    _run(c.request_permission([_opt("allow_once", "yes")], "s", _tool_call(title="edit x.py")))
    kinds = [t for t, _ in c._buf.frames]
    assert "awaiting_confirmation" in kinds and "confirm_result" in kinds
    opened = next(d for t, d in c._buf.frames if t == "awaiting_confirmation")
    closed = next(d for t, d in c._buf.frames if t == "confirm_result")
    assert opened["attempt"] == 3 and closed["attempt"] == 3
    assert opened["confirm_id"] == closed["confirm_id"]
    assert closed["reason"] == "timeout" and closed["decision"] == "deny"
    # The client had no way to render an honest countdown without this — assert the exact
    # configured value, not just "a number", so a future default-value change is caught here too. (CUR-1094)
    assert opened["timeout_secs"] == 0.01


def test_describe_tool_call_redacts_raw_input_output():
    """A confirmation is a DELIBERATE, scoped exception to the tool_call/tool_result redaction
    discipline — but still never a raw dump. raw_input/raw_output must not appear anywhere in the
    description even though the ToolCall object carries them."""
    tc = _tool_call(kind="edit", title="edit result.txt",
                    content=[types.SimpleNamespace(type="diff", path="result.txt",
                                                    new_text="the new content", old_text=None)])
    desc = acp_client._describe_tool_call("cid123", tc)
    assert desc == {"confirm_id": "cid123", "kind": "edit", "title": "edit result.txt",
                    "summary": "result.txt: the new content"}
    assert "secret" not in json.dumps(desc), "raw_input never crosses into the redacted description"


def test_describe_tool_call_bounds_summary_length():
    long_text = "x" * 5000
    tc = _tool_call(content=[types.SimpleNamespace(type="diff", path="f.txt",
                                                    new_text=long_text, old_text=None)])
    desc = acp_client._describe_tool_call("cid", tc)
    assert len(desc["summary"]) <= acp_client._SUMMARY_MAX, "bounded through _clip like every other frame"


# ------------------------------------------------- CUR-1405: an execute confirm shows the real command
def _exec_call(raw_input, title="apt && apt"):
    """An execute-kind call whose `title` is Hermes' argument-dropping summary — the observed shape."""
    return types.SimpleNamespace(
        kind="execute", title=title,
        content=[types.SimpleNamespace(type="terminal", terminal_id="term_7")],
        raw_input=raw_input, raw_output=None, locations=None)


def test_execute_confirm_shows_the_command_not_just_the_binary_names():
    """The whole point of the confirmation: the string a human authorises must BE the command.

    A dialog showing `apt && apt` for a real
    `apt update && apt install -y pandoc` would get two package installs approved by someone who could
    not have known they were installs. A pass here means the arguments survived; it does NOT mean the
    title improved, because the title is Hermes' and we don't own it.
    """
    real = "apt update && apt install -y pandoc"
    desc = acp_client._describe_tool_call("cid", _exec_call({"command": real}))
    assert desc["summary"] == real, "the command reaches the human, arguments and all"
    assert "pandoc" in desc["summary"], "the thing being installed is legible, not elided"


def test_execute_confirm_prefers_the_command_over_the_opaque_terminal_id():
    """Regression guard on the ORDER, not just the presence: the content blocks carry a `terminal`
    entry that resolves to `terminal:term_7`, which tells a reader nothing.
    An execute call must never fall back to it while a command is available."""
    desc = acp_client._describe_tool_call("cid", _exec_call({"command": "rm -rf ./build"}))
    assert desc["summary"] == "rm -rf ./build"
    assert "term_7" not in desc["summary"], "the terminal id is not a description of anything"


def test_execute_confirm_joins_an_argv_command():
    desc = acp_client._describe_tool_call("cid", _exec_call({"command": ["rm", "-rf", "./build"]}))
    assert desc["summary"] == "rm -rf ./build", "argv renders as one command line, not a list repr"


def test_execute_confirm_still_withholds_every_other_raw_input_key():
    """The widening is ONE allowlisted key, not a raw_input dump. A credential sitting beside the
    command in the same raw_input must still never cross the SSE boundary."""
    desc = acp_client._describe_tool_call(
        "cid", _exec_call({"command": "curl https://example.invalid",
                           "env": {"API_KEY": "sk-should-never-cross"},
                           "secret": "should never cross the SSE boundary"}))
    blob = json.dumps(desc)
    assert "sk-should-never-cross" not in blob, "an adjacent credential is still redacted"
    assert "should never cross" not in blob, "only the command key is allowlisted"
    assert desc["summary"] == "curl https://example.invalid"


def test_execute_confirm_with_an_unrecognised_shape_is_no_worse_than_before():
    """raw_input is typed `Any` in the ACP schema, so an unknown producer is a real possibility. It
    must degrade to the previous description, never to a dump and never to a crash."""
    for raw in ({"unexpected": "shape"}, {"command": ""}, {"command": []}, None, "not-a-dict", 42):
        desc = acp_client._describe_tool_call("cid", _exec_call(raw))
        assert desc["summary"] == "terminal:term_7", f"falls back cleanly for {raw!r}"
        assert "unexpected" not in json.dumps(desc), "still no raw dump on the fallback path"


def test_execute_confirm_command_is_bounded():
    desc = acp_client._describe_tool_call("cid", _exec_call({"command": "echo " + "x" * 5000}))
    assert len(desc["summary"]) <= acp_client._SUMMARY_MAX, "bounded through _clip like every other frame"


# --------------------------------------------------------------------------- fs containment (fail-closed)
def test_write_read_roundtrip_within_scratch(tmp_path):
    c = acp_client._AgentClient(work=str(tmp_path), buf=None, attempt=1)
    _run(c.write_text_file("payload", "out/result.txt", "s"))     # relative -> resolved under work
    assert (tmp_path / "out" / "result.txt").read_text() == "payload", "write lands in the scratch dir"
    resp = _run(c.read_text_file("out/result.txt", "s"))
    assert resp.content == "payload", "read returns the file content"


def test_write_escape_is_fail_closed(tmp_path):
    c = acp_client._AgentClient(work=str(tmp_path), buf=None, attempt=1)
    for bad in ("../escape.txt", "/etc/evil.txt", "out/../../escape.txt"):
        try:
            _run(c.write_text_file("x", bad, "s"))
            assert False, f"expected PermissionError for {bad!r}"
        except PermissionError:
            pass
    assert not (tmp_path.parent / "escape.txt").exists(), "no file was written outside the sandbox"


def test_read_escape_is_fail_closed(tmp_path):
    c = acp_client._AgentClient(work=str(tmp_path), buf=None, attempt=1)
    try:
        _run(c.read_text_file("/etc/passwd", "s"))
        assert False, "expected PermissionError reading outside the sandbox"
    except PermissionError:
        pass


# --------------------------------------------------------------------------- argv split
def test_acp_argv_split():
    """Splits the bwrap prefix into (command, *args); appends the acp subcommand + --accept-hooks."""
    cmd, args = acp_client._acp_argv(["bwrap", "--bind", "/w", "/w"], "/venv/bin/hermes")
    assert cmd == "bwrap"
    assert args == ["--bind", "/w", "/w", "/venv/bin/hermes", "acp", "--accept-hooks"]
    cmd2, args2 = acp_client._acp_argv([], "/venv/bin/hermes")   # sandbox off
    assert cmd2 == "/venv/bin/hermes"
    assert args2 == ["acp", "--accept-hooks"]


# --------------------------------------------------------------------------- early-exit debounce
def test_early_exit_debounce_requires_two_consecutive_passes():
    """No kill on the first pass; kill on the second CONSECUTIVE pass; a miss in between resets the streak."""
    calls = iter([True, True])
    d = acp_client._EarlyExitDebounce(lambda: next(calls))
    assert d.check() is False, "one pass alone must not signal exit"
    assert d.check() is True, "two consecutive passes signal exit"

    seq = iter([True, False, True, True])
    d2 = acp_client._EarlyExitDebounce(lambda: next(seq))
    assert d2.check() is False   # pass 1
    assert d2.check() is False   # miss — resets the streak
    assert d2.check() is False   # pass 1 of a fresh streak
    assert d2.check() is True    # pass 2 of that streak — now signals


def test_early_exit_debounce_disabled_is_always_false():
    """verify_check=None (feature off, or no verify spec) never signals — check() is a permanent no-op."""
    d = acp_client._EarlyExitDebounce(None)
    assert d.check() is False
    assert d.check() is False


def test_early_exit_debounce_survives_a_broken_check():
    """A verify_check that raises is treated as a miss, not a crash — and resets any in-progress streak."""
    calls = iter([True, RuntimeError("boom")])

    def flaky():
        v = next(calls)
        if isinstance(v, Exception):
            raise v
        return v

    d = acp_client._EarlyExitDebounce(flaky)
    assert d.check() is False   # pass 1
    assert d.check() is False   # raises internally -> treated as a miss, streak reset, no crash


# --------------------------------------------------------------------------- early-exit hook wiring
def test_on_step_fires_only_on_completed_tool_call_update():
    """_AgentClient invokes on_step on a completed tool_call_update, not on in_progress/failed ones."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    hits = []
    c.on_step = lambda: hits.append(1)
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="a", status="in_progress")))
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="a", status="failed")))
    assert hits == [], "on_step must not fire for anything other than a completed tool call"
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="a", status="completed")))
    assert hits == [1], "on_step fires exactly once for the completed update"


def test_on_step_unset_is_a_noop():
    """Default on_step (None) — a completed tool_call_update must not raise when nothing is wired up."""
    c = acp_client._AgentClient(work="/tmp", buf=None, attempt=1)
    _run(c.session_update("s", _u("tool_call_update", tool_call_id="a", status="completed")))  # no raise


# --------------------------------------------------------------------------- config synthesis
def test_write_acp_config(tmp_path):
    """Writes the model block only when a model is set (Fly/container); noop otherwise (dev global cfg)."""
    acp_client._write_acp_config(str(tmp_path), "org/Model-X", "huggingface")
    text = (tmp_path / "config.yaml").read_text()
    assert 'default: "org/Model-X"' in text and 'provider: "huggingface"' in text
    # noop path leaves no file
    other = tmp_path / "empty"
    other.mkdir()
    acp_client._write_acp_config(str(other), "", "")
    assert not (other / "config.yaml").exists(), "no model -> rely on the copied global config, write nothing"


def test_the_model_block_keeps_the_enforcement_keys_written_before_it(tmp_path):
    """CUR-2163. Every Fly attempt runs app._write_hermes_home_config (CUR-1155's `agent:` block) and then
    _write_acp_config (the `model:` block) on the SAME config.yaml. The second writer used to replace the
    file, so Apertus lost both enforcement nudges on every attempt that had a model set, which is all of
    them on Fly. Parsed with a real YAML loader because a duplicated top-level key would pass a substring
    check and still lose one block at load time."""
    import yaml
    from app import _write_hermes_home_config

    home = tmp_path / "hermes-home"
    home.mkdir()
    _write_hermes_home_config(str(home), tmp_path / "no-global-config.yaml")
    acp_client._write_acp_config(str(home), "org/Model-X", "huggingface")
    cfg = yaml.safe_load((home / "config.yaml").read_text())
    assert cfg["agent"] == {"tool_use_enforcement": True, "execution_guidance": True}
    assert cfg["model"] == {"provider": "huggingface", "default": "org/Model-X"}


def test_a_fenced_attempt_never_waits_on_hermes_public_metadata_fetches(tmp_path):
    """With a model set (Fly), the attempt config turns off Hermes' model-catalog fetch and points
    models.dev at a refused loopback port. Behind the egress fence both fetches otherwise wait out DNS
    timeouts, ~60 s per attempt. Written twice to prove the blocks are replaced, not duplicated."""
    import yaml

    acp_client._write_acp_config(str(tmp_path), "org/Model-X", "huggingface")
    acp_client._write_acp_config(str(tmp_path), "org/Model-X", "huggingface")
    text = (tmp_path / "config.yaml").read_text()
    cfg = yaml.safe_load(text)
    assert cfg["model_catalog"] == {"enabled": False}
    assert cfg["models_dev"]["url"].startswith("http://127.0.0.1:")
    assert text.count("models_dev:") == 1 and text.count("model_catalog:") == 1


class _StopBeforeSpawn(Exception):
    pass


def _acp_run_until_spawn(tmp_path, monkeypatch, model_env: dict) -> dict:
    """Drive the real _acp_run through its config writes and stop it where it would start `hermes acp`,
    then load the config.yaml that process would have read."""
    import yaml
    from app import _write_hermes_home_config

    def _no_spawn(*_a, **_k):
        raise _StopBeforeSpawn

    monkeypatch.setattr(acp_client.acp, "spawn_agent_process", _no_spawn)
    home = tmp_path / "hermes-home"
    home.mkdir()
    _write_hermes_home_config(str(home), tmp_path / "no-global-config.yaml")
    with contextlib.suppress(_StopBeforeSpawn):
        _run(acp_client._acp_run(str(tmp_path), str(home), "p", None, 30, None, types.SimpleNamespace(id="t"),
                                 sandbox_prefix=[], hermes_bin="hermes", model_env=model_env,
                                 model="org/Model-X", provider="huggingface", attempt=1))
    return yaml.safe_load((home / "config.yaml").read_text())


def test_hermes_acp_is_told_the_fly_toolset_through_config(tmp_path, monkeypatch):
    """CUR-2118. From Hermes v2026.9.24 an ACP session takes its toolsets from `platform_toolsets.acp`,
    and the HERMES_ACP_TOOLSETS patch (0001) is gone. Without this block Hermes resolves its own
    `hermes-acp` default: 13 toolsets including browser, vision and memory, per
    that release's own resolver. All three writers' blocks have to survive into the one file."""
    cfg = _acp_run_until_spawn(tmp_path, monkeypatch,
                               {"HERMES_ACP_TOOLSETS": "file,terminal,todo,code_execution"})
    assert cfg["platform_toolsets"] == {"acp": ["file", "terminal", "todo", "code_execution"]}
    assert cfg["agent"] == {"tool_use_enforcement": True, "execution_guidance": True}
    assert cfg["model"] == {"provider": "huggingface", "default": "org/Model-X"}


def test_deny_writes_narrowed_toolset_reaches_hermes_rather_than_the_fly_default(tmp_path, monkeypatch):
    """CUR-217's floor: under deny_writes/confirm _model_env hands the subprocess `file,todo`. That value,
    not the machine-wide one, is what must land in the config Hermes reads, or terminal and
    code_execution come back by the config door."""
    cfg = _acp_run_until_spawn(tmp_path, monkeypatch, {"HERMES_ACP_TOOLSETS": "file,todo"})
    assert cfg["platform_toolsets"] == {"acp": ["file", "todo"]}


def test_an_unset_toolset_writes_no_block_and_leaves_hermes_its_own_default(tmp_path, monkeypatch):
    """Unset keeps the pre-patch behaviour: no key, so Hermes' own default applies, as it did when 0001
    read an empty env var."""
    cfg = _acp_run_until_spawn(tmp_path, monkeypatch, {})
    assert "platform_toolsets" not in cfg
    assert cfg["agent"]["tool_use_enforcement"] is True


def test_the_toolset_block_replaces_an_earlier_one_rather_than_duplicating_it(tmp_path):
    import yaml

    (tmp_path / "config.yaml").write_text("platform_toolsets:\n  acp: [browser]\n  cli: [web]\nagent:\n  x: 1\n")
    acp_client._write_acp_toolsets(str(tmp_path), " file , todo ,")
    text = (tmp_path / "config.yaml").read_text()
    assert text.count("platform_toolsets:") == 1
    cfg = yaml.safe_load(text)
    assert cfg["platform_toolsets"] == {"acp": ["file", "todo"]}
    assert cfg["agent"] == {"x": 1}


def test_the_model_block_replaces_an_earlier_model_block_rather_than_duplicating_it(tmp_path):
    """A copied global config may already name a model. Ours wins, as it did when the writer overwrote the
    file, and the key appears once: a YAML loader keeps the last of two duplicate keys without a word."""
    import yaml

    (tmp_path / "config.yaml").write_text('model:\n  default: "old/Model"\nagent:\n  tool_use_enforcement: false\n')
    acp_client._write_acp_config(str(tmp_path), "org/Model-X", "")
    text = (tmp_path / "config.yaml").read_text()
    assert text.count("\nmodel:") + text.startswith("model:") == 1
    cfg = yaml.safe_load(text)
    assert cfg["model"] == {"default": "org/Model-X"}
    assert cfg["agent"] == {"tool_use_enforcement": False}, "the operator's own agent keys are left alone"


def test_the_model_does_not_get_to_declare_itself_done():
    """The in-session repair turn in acp_client._acp_run. Under a forced tool choice a model can spend its
    one required call on `task_complete` and stop with an empty directory, on every attempt. Hermes' own gate for that (HERMES_DONE_VERIFY) needs a hand-written expect_file,
    and pointing it at `notes_cli.py` taught the model to write `notes_cli.py` and nothing else — a gate
    becomes the spec. This one asks the spec that already decides the verdict."""
    src = inspect.getsource(acp_client._acp_run)
    body = src.split("stderr_task = loop.create_task", 1)[1]
    code = "\n".join(ln for ln in body.splitlines() if ln.strip() and not ln.lstrip().startswith("#"))
    assert "while True:" in code, "a turn can be followed by another turn on the same session"
    assert "session_id=sess.session_id" in code, "SAME session — the point is the model keeps its context"
    assert "ok, detail = repair_check(client.text)" in code, \
        "the task's own acceptance test decides, not the model — and it needs the answer text to catch a" \
        " claim with nothing behind it (CUR-226)"
    assert "turns_left -= 1" in code and "if turns_left <= 0" in code, "bounded"
    assert "if ok:" in code, "a passing check ends the turn rather than prompting again"
    # ONE deadline across every turn. Per-turn `timeout_secs` would hand an attempt N times the wall
    # clock it was granted, and each turn would still look individually bounded — the same denomination
    # error _remaining_timeout fixed one level up (see 0d2eb92). CUR-218 made the deadline a mutable
    # _AttemptClock (pausable for a human confirmation wait) instead of a bare float, so the marker this
    # test looks for changed shape — the invariant (one clock, shared by the wait and the loop guard,
    # never a fresh per-turn timeout) is unchanged and still asserted below.
    assert "_AttemptClock(loop, timeout_secs)" in code, "one clock object for the whole attempt"
    assert "timeout=timeout_secs" not in code, "no turn may claim the whole attempt budget for itself"
    assert "_deadline_watchdog(clock, loop)" in code, "the wait races against the SAME clock, not a fresh timeout"
    assert "clock.deadline - loop.time() <= 0" in code, "the repair-turn loop guard reads that same mutable deadline"
    assert "client.early_exit" in code, "an early-exit turn is already verified; do not re-prompt it"
    assert "task._canceled" in code, "an external cancel is not an invitation to send another prompt"


def test_tool_failures_reset_between_repair_turns():
    """CUR-574: unlike tool_kinds (deliberately cumulative across repair turns
    — file state genuinely persists), tool_failures must be cleared per TURN, not just per attempt. Read
    order matters: repair_check(client.text) has to see THIS turn's failures before the clear, or a
    failure would never be judged at all."""
    src = inspect.getsource(acp_client._acp_run)
    body = src.split("conn.initialize(", 1)[1]
    check_at = body.index("ok, detail = repair_check(client.text)")
    clear_at = body.index("client.tool_failures.clear()")
    assert clear_at > check_at, "must clear AFTER repair_check reads the turn's failures, not before"
    # And the clear is genuinely between turns, not a one-time reset before the loop starts.
    loop_at = body.index("while True:")
    assert clear_at > loop_at, "the clear must be inside the repair loop, not a pre-loop no-op"


def test_the_final_repair_turn_still_gets_checked_when_the_budget_or_the_clock_runs_out():
    """CUR-574 (repair-loop gap): breaking on `turns_left <= 0` OR on the deadline expiring, in both
    cases before calling repair_check again, would leave the ONE turn that spent the last of the budget,
    or the last of the wall clock, with zero scrutiny. There is nothing left to retry with either way, but
    the verdict is still worth keeping: see Task.unrun_detail, set here instead of silently discarded,
    so a client doesn't need its own copy of this heuristic to know the delivered answer went unchecked.
    Both triggers are asserted together because they share the one guarded check below them — a check that
    covered only one would leave the other blind."""
    src = inspect.getsource(acp_client._acp_run)
    body = src.split("conn.initialize(", 1)[1]
    code = "\n".join(ln for ln in body.splitlines() if ln.strip() and not ln.lstrip().startswith("#"))
    early_exit_at = code.index("if client.early_exit or task._canceled:")
    give_up_at = code.index("if turns_left <= 0 or clock.deadline - loop.time() <= 0:")
    guard_at = code.index("if repair_check is not None:")
    # The exact call, not just the assignment: repair_check's `detail` can come from _verify()'s check_cmd,
    # run inside the sandbox — the same nonce-in-environment exposure every OTHER consumer of that text
    # (last_verify_detail, judge_reason, attempt_rejections, the repair-turn prompt) already scrubs before
    # it becomes client-visible. Searching for the specific call, not the bare assignment, means a future
    # revert to unscrubbed `task.unrun_detail = detail` fails this assertion instead of passing it unnoticed.
    store_at = code.index("task.unrun_detail = _scrub(detail, nonce)")
    assert early_exit_at < give_up_at, \
        "an early-exit/canceled turn is already settled elsewhere — must not fall into this branch at all"
    assert give_up_at < guard_at < store_at, \
        "the guarded check and its verdict-store must live INSIDE the give-up branch, not before it"
    # The None-guard exists only so a task with no repair_check configured (REPAIR_TURNS=0, or the
    # spec-carries-scratch predicate) doesn't crash calling None() — it must not swallow a real one.
    assert "repair_check(client.text)" in code[give_up_at:guard_at + 200], \
        "the give-up branch must still call repair_check, not just break silently"


def test_exhausted_repair_replaces_ungrounded_text_instead_of_only_flagging_it():
    """The give-up branch above stores a failing verdict on task.unrun_detail (the client's caveat flag)
    and must also replace client.text, the model's own reply: otherwise a turn with zero "edit" calls can
    tell the user a file "has been created" with invented figures, and the caveat banner above that text
    is the only signal anything was wrong (CUR-705). This proves the replacement is wired INSIDE the same guarded
    block the verdict-store test above pins down, gated on tool_kinds having no "edit" — a real (even
    failed, or read-only) tool call this attempt is a different, lesser bug and must keep its own text."""
    src = inspect.getsource(acp_client._acp_run)
    body = src.split("conn.initialize(", 1)[1]
    code = "\n".join(ln for ln in body.splitlines() if ln.strip() and not ln.lstrip().startswith("#"))
    give_up_at = code.index("if turns_left <= 0 or clock.deadline - loop.time() <= 0:")
    store_at = code.index("task.unrun_detail = _scrub(detail, nonce)")
    replace_at = code.index('if repair_exhausted_answer is not None and "edit" not in client.tool_kinds:')
    clear_at = code.index("client.text_parts.clear()", replace_at)
    append_at = code.index("client.text_parts.append(repair_exhausted_answer)", replace_at)
    break_at = code.index("break", give_up_at)
    assert give_up_at < store_at < replace_at < clear_at < append_at < break_at, \
        "replacement must run AFTER the verdict is stored, gated inside the give-up branch, before break"
    # "edit" not "tool_kinds" bare — an attempt with only read/search calls (no write) is still eligible,
    # matching app.py's _wrote_code_without_running_it's own "edit" not in tool_kinds branch exactly.
    assert '"edit" not in client.tool_kinds' in code[replace_at:replace_at + 80]


def test_acp_client_scrub_matches_app_pys_and_is_direct_behavior_not_just_source_position():
    """Companion to test_check_output_crossing_out_of_the_sandbox_never_carries_the_nonce (app.py's own
    _scrub test) — acp_client.py duplicates that function rather than importing it (app.py imports
    acp_client, never the reverse), so it needs its own direct behavioral coverage, not just a source-text
    position check on where it's called."""
    n = "b4d5e6f7a8b9c0d1"
    assert acp_client._scrub(f"KeyError: {n} not in env", n) == "KeyError: <nonce> not in env"
    assert acp_client._scrub("nothing secret", n) == "nothing secret"
    assert acp_client._scrub("", n) == "" and acp_client._scrub("text", None) == "text", "no nonce, no rewrite"


def test_a_repair_turn_can_actually_clear_the_last_turns_text(tmp_path):
    """`_AgentClient.text` is a read-only property over `text_parts`. Assigning to it in the
    between-turn reset raises AttributeError inside the ACP loop and turns all three attempts into
    `hermes exit 1`. Tests that assert SOURCE STRUCTURE cannot tell a writable attribute from a property,
    so this one runs it."""
    c = acp_client._AgentClient(str(tmp_path), None, 1)
    c.text_parts.extend(["first turn ", "answer"])
    assert c.text == "first turn answer"
    c.text_parts.clear()                       # the exact statement the repair path executes
    assert c.text == "", "a repair turn starts with an empty answer"
    c.text_parts.append("second")
    assert c.text == "second", "and the next turn's text is the whole answer, not appended to the old"
    src = inspect.getsource(acp_client._acp_run)
    assert "client.text_parts.clear()" in src and "client.text = " not in src, \
        "the loop must clear the backing list; `text` has no setter"


def test_repair_exhausted_replacement_actually_swaps_the_text(tmp_path):
    """Companion to the source-structure test above, same reason: structure cannot tell a genuine swap
    from a no-op, and `.text` has no setter (see the sibling test above — the same class of mistake this
    guards against). Uses app.py's REAL constant, not a stand-in, so a future edit to its wording still
    exercises the actual value that ships."""
    import app
    c = acp_client._AgentClient(str(tmp_path), None, 1)
    c.text_parts.append(
        "The output.txt file has been created with the final results showing June 2024 as the top "
        "month with $18,500 in revenue, followed by May 2024 and April 2024."
    )
    assert "edit" not in c.tool_kinds, "the eligibility condition this replacement is gated on"
    # the exact two statements the give-up branch runs
    c.text_parts.clear()
    c.text_parts.append(app._REPAIR_EXHAUSTED_ANSWER)
    assert "May 2024" not in c.text and "April 2024" not in c.text, \
        "the invented months must not survive into the swapped text"
    assert c.text == app._REPAIR_EXHAUSTED_ANSWER


# --------------------------------------------------------------------------- CUR-653: hermes stderr drain
class _FakeStderr:
    """Stand-in for the asyncio.StreamReader on proc.stderr — yields each queued chunk, then EOF (b"")."""

    def __init__(self, chunks: list[bytes]):
        self._chunks = list(chunks)

    async def read(self, _n: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


def _fake_proc(chunks: list[bytes]):
    return types.SimpleNamespace(stderr=_FakeStderr(chunks))


def test_drain_stderr_logs_the_full_tail_on_a_normal_eof(monkeypatch):
    """The child's stderr is created and immediately discarded today (CUR-653) — this is the fix:
    drain to EOF, then log once rather than per line (this is an ops tail, not a live stream)."""
    logged = []
    monkeypatch.setattr(acp_client, "_log_stderr_tail", lambda *a: logged.append(a))
    _run(acp_client._drain_stderr(_fake_proc([b"SyntaxError: ", b"unexpected EOF"]), "task-1", 2, None))
    assert logged == [("task-1", 2, "SyntaxError: unexpected EOF")]


def test_drain_stderr_bounds_the_tail_to_stderr_max(monkeypatch):
    """Bounded the same way _detect_run_failure's [-300:] tail is in app.py — the whole point is an
    ops-log-level artifact, never the raw unbounded stream."""
    logged = []
    monkeypatch.setattr(acp_client, "_log_stderr_tail", lambda *a: logged.append(a))
    oversized = b"x" * (acp_client._STDERR_MAX + 250)
    _run(acp_client._drain_stderr(_fake_proc([oversized]), "task-1", 1, None))
    assert len(logged[0][2]) == acp_client._STDERR_MAX


def test_drain_stderr_scrubs_the_nonce_before_logging(monkeypatch):
    """Same exposure _scrub's own docstring names for check_cmd output: whatever Hermes prints to
    stderr ran with the gateway nonce in its environment and can echo it back."""
    logged = []
    monkeypatch.setattr(acp_client, "_log_stderr_tail", lambda *a: logged.append(a))
    _run(acp_client._drain_stderr(_fake_proc([b"leaked token: secret-nonce-123"]), "t", 1, "secret-nonce-123"))
    assert "secret-nonce-123" not in logged[0][2]
    assert "<nonce>" in logged[0][2]


def test_drain_stderr_logs_the_partial_tail_on_cancellation(monkeypatch):
    """The caller cancels this task from `_acp_run`'s finally block rather than letting it run past the
    reap — whatever was read before that must still reach the log, not be dropped."""
    logged = []
    monkeypatch.setattr(acp_client, "_log_stderr_tail", lambda *a: logged.append(a))

    async def _go():
        proc = _fake_proc([b"partial line, then we get cancelled"])

        async def _hang_forever(_n):
            await asyncio.sleep(3600)

        task = asyncio.get_event_loop().create_task(acp_client._drain_stderr(proc, "t", 1, None))
        await asyncio.sleep(0)              # let it consume the one queued chunk
        proc.stderr.read = _hang_forever    # next read() blocks, standing in for "still open"
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    _run(_go())
    assert logged == [("t", 1, "partial line, then we get cancelled")]


def test_log_stderr_tail_ships_the_tail_under_the_detail_field(monkeypatch):
    """`detail` is an existing logsink.CONTENT_FIELDS name — reusing it (rather than a new field) is
    what gets this tail the same off-box redaction every other sandbox-derived string already gets."""
    shipped = []
    monkeypatch.setattr(acp_client.logsink, "emit", lambda rec: shipped.append(rec))
    monkeypatch.setattr(acp_client, "_LOG", True)
    acp_client._log_stderr_tail("task-9", 3, "boom: real diagnostic")
    assert len(shipped) == 1
    rec = shipped[0]
    assert rec["event"] == "acp.hermes_stderr"
    assert rec["task_id"] == "task-9" and rec["attempt"] == 3
    assert rec["detail"] == "boom: real diagnostic"


def test_log_stderr_tail_is_a_noop_on_an_empty_tail(monkeypatch):
    """An empty drain (the child never wrote to stderr) shouldn't add a log line every single run."""
    shipped = []
    monkeypatch.setattr(acp_client.logsink, "emit", lambda rec: shipped.append(rec))
    monkeypatch.setattr(acp_client, "_LOG", True)
    acp_client._log_stderr_tail("task-9", 1, "")
    assert shipped == []


def test_acp_run_wires_the_stderr_drain_into_the_spawn_and_the_finally():
    """Confirmed by source inspection, same reason as the other _acp_run structural tests in this file:
    it needs a real Hermes subprocess to run past the spawn, which nothing here attempts."""
    src = inspect.getsource(acp_client._acp_run)
    assert "stderr_task = loop.create_task(_drain_stderr(proc, task.id, attempt, nonce))" in src
    assert "stderr_task.cancel()" in src and "await stderr_task" in src, \
        "the drain task must be cancelled and awaited before the spawn context manager reaps the child"


def test_a_backend_launch_gets_the_bare_hermes_argv_and_the_model_env(tmp_path, monkeypatch):
    """CUR-4450: with `open_stdio` the sandbox backend starts Hermes and owns where it runs, so it gets
    `hermes acp` with no bwrap prefix, and acp's own launch is never used."""
    from app import _write_hermes_home_config

    seen = {}

    def _no_spawn(*_a, **_k):
        raise AssertionError("acp.spawn_agent_process ran despite open_stdio")

    @contextlib.asynccontextmanager
    async def open_stdio(argv, env):
        seen["argv"], seen["env"] = argv, env
        raise _StopBeforeSpawn
        yield  # pragma: no cover

    monkeypatch.setattr(acp_client.acp, "spawn_agent_process", _no_spawn)
    home = tmp_path / "hermes-home"
    home.mkdir()
    _write_hermes_home_config(str(home), tmp_path / "no-global-config.yaml")
    with contextlib.suppress(_StopBeforeSpawn):
        _run(acp_client._acp_run(str(tmp_path), str(home), "p", None, 30, None, types.SimpleNamespace(id="t"),
                                 sandbox_prefix=[], hermes_bin="hermes", model_env={"X": "1"},
                                 model="org/Model-X", provider="huggingface", attempt=1, open_stdio=open_stdio))
    assert seen == {"argv": ["hermes", "acp", "--accept-hooks"], "env": {"X": "1"}}


def test_a_backend_launch_refuses_a_bwrap_prefix_beside_it(tmp_path):
    """Both would wrap Hermes twice, or run it on this machine while the backend thinks it owns it."""
    @contextlib.asynccontextmanager
    async def open_stdio(argv, env):
        yield  # pragma: no cover

    with pytest.raises(ValueError, match="no sandbox_prefix"):
        _run(acp_client._acp_run(str(tmp_path), str(tmp_path), "p", None, 30, None, types.SimpleNamespace(id="t"),
                                 sandbox_prefix=["bwrap"], hermes_bin="hermes", model_env={},
                                 model="", provider="", attempt=1, open_stdio=open_stdio))


def test_a_remote_attempt_writes_its_hermes_home_into_the_sandbox_and_leaves_none_here(tmp_path, monkeypatch):
    """CUR-4482: on a remote backend the attempt's config reaches the guest through `backend.write`, the local
    copy is gone before Hermes starts, and the guest's env carries no credential of ours."""
    import app
    from sandbox_backend import Handle, Tier

    writes, seen = {}, {}

    class _Fake:
        name = "e2b"

        def write(self, h, path, data):
            writes[path] = data

        @contextlib.asynccontextmanager
        async def open_stdio(self, h, argv, env):
            seen["argv"], seen["env"], seen["home_left"] = argv, env, home.exists()
            raise _StopBeforeSpawn
            yield  # pragma: no cover

    monkeypatch.setattr(app, "SANDBOX_BACKEND", _Fake())
    monkeypatch.setattr(app, "PROXY_ADMIN_KEY", "unit-admin")
    monkeypatch.setattr(app, "AGENT_GATEWAY_PUBLIC_URL", "https://gw.example")
    h = Handle(key="k1", tier=Tier.AGENT, ref=None)
    home = tmp_path / "hermes-home-t-1"
    home.mkdir()
    app._write_hermes_home_config(str(home), tmp_path / "no-global-config.yaml")
    env = app._remote_model_env("/home/user/work/hermes-home-t-1", "allow", "task-nonce-1")
    with contextlib.suppress(_StopBeforeSpawn):
        _run(acp_client._acp_run(str(tmp_path), str(home), "p", "task-nonce-1", 30, None,
                                 types.SimpleNamespace(id="t"), sandbox_prefix=[], hermes_bin="hermes",
                                 model_env=env, model="org/Model-X", provider="huggingface", attempt=1,
                                 open_stdio=app._remote_hermes_opener(h, str(home), home.name)))
    assert set(writes) == {"hermes-home-t-1/config.yaml", "hermes-home-t-1/SOUL.md"}
    assert b'default: "org/Model-X"' in writes["hermes-home-t-1/config.yaml"]
    assert seen["home_left"] is False and not home.exists()
    assert seen["argv"] == ["hermes", "acp", "--accept-hooks"]
    assert seen["env"]["HERMES_HOME"] == "/home/user/work/hermes-home-t-1"
    assert seen["env"]["HF_BASE_URL"] == "https://gw.example/v1"
    # The gateway authenticates the guest by the task's own nonce, since Embed never rewrites headers. (CUR-4500)
    assert seen["env"]["HF_TOKEN"] == "task-nonce-1"
    assert "unit-admin" not in set(seen["env"].values())
    assert not [k for k in seen["env"] if app._SECRET_ENV_RE.search(k) and k != "HF_TOKEN"]


# --------------------------------------------------------------------------- auto mode (CUR-3142)
def _diff(path):
    return types.SimpleNamespace(type="diff", path=path, new_text="x")


def _auto_client(tmp_path, reviewer=None, policy="allow"):
    return acp_client._AgentClient(work=str(tmp_path), buf=_CapBuf(), attempt=1, permission_policy=policy,
                                   confirm_timeout_secs=0.01, approval_mode="auto", auto_reviewer=reviewer)


def test_auto_mode_runs_an_in_folder_edit_without_a_card_and_records_it(tmp_path):
    c = _auto_client(tmp_path)
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]
    resp = _run(c.request_permission(opts, "s", _tool_call(kind="edit", content=[_diff(str(tmp_path / "budget.xlsx"))])))
    assert resp.outcome.option_id == "yes"
    assert c._pending_confirms == {}
    frames = [f for f in c._buf.frames if f[0] == "auto_approved"]
    assert frames and frames[0][1]["plain"] == "Write budget.xlsx" and frames[0][1]["by"] == "path"


def test_auto_mode_asks_about_an_edit_that_leaves_the_folder_or_names_a_sensitive_path(tmp_path):
    for path in ("/etc/passwd", str(tmp_path / "../escape.txt"), str(tmp_path / ".git" / "config"), ""):
        c = _auto_client(tmp_path)
        opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]
        resp = _run(c.request_permission(opts, "s", _tool_call(kind="edit", content=[_diff(path)])))
        assert resp.outcome.option_id == "no", f"{path!r}: must ask (and time out to deny), never run"
        assert not [f for f in c._buf.frames if f[0] == "auto_approved"]


def test_on_e2b_an_edit_named_by_its_guest_path_runs_and_the_client_measures_against_the_guest(tmp_path, monkeypatch):
    """CUR-4595: Hermes in the guest names writes as /home/user/work/<file>. Measured against this machine's scratch,
    every one would read as leaving the folder and go to a card."""
    guest = "/home/user/work"
    c = acp_client._AgentClient(work=guest, buf=_CapBuf(), attempt=1, confirm_timeout_secs=0.01, approval_mode="auto")
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]
    resp = _run(c.request_permission(opts, "s", _tool_call(kind="edit", content=[_diff(f"{guest}/plan-1.txt")])))
    assert resp.outcome.option_id == "yes"
    local = _auto_client(tmp_path)
    resp = _run(local.request_permission(opts, "s", _tool_call(kind="edit", content=[_diff(f"{guest}/plan-1.txt")])))
    assert resp.outcome.option_id == "no", "against the local scratch the same guest path is outside, the bug's shape"

    built = []

    class _Stop(Exception):
        pass

    def _record(work, *a, **kw):
        built.append(work)
        raise _Stop

    monkeypatch.setattr(acp_client, "_AgentClient", _record)
    home = tmp_path / "hermes-home-t-1"
    home.mkdir()
    with pytest.raises(_Stop):
        _run(acp_client._acp_run(str(tmp_path), str(home), "p", None, 30, None, types.SimpleNamespace(id="t"),
                                 sandbox_prefix=[], hermes_bin="hermes", session_cwd=guest, model_env={},
                                 model="org/Model-X", provider="huggingface", attempt=1))
    assert built == [guest], "the client judges paths in the folder the session runs in"


def test_auto_mode_runs_a_call_the_reviewer_clears_and_shows_its_plain_sentence(tmp_path):
    seen = []

    async def reviewer(action):
        seen.append(action)
        return {"decision": "run", "plain": "Make a budget spreadsheet called budget.xlsx"}

    c = _auto_client(tmp_path, reviewer)
    call = types.SimpleNamespace(kind="execute", title="Approve execute_code: import openpyxl", content=[],
                                 raw_input={"tool": "execute_code", "arguments": {"code": "import openpyxl"}})
    resp = _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s", call))
    assert resp.outcome.option_id == "yes" and c._pending_confirms == {}
    assert seen[0]["arguments"] == {"code": "import openpyxl"}
    auto = [d for t, d in c._buf.frames if t == "auto_approved"]
    assert auto[0]["plain"].startswith("Make a budget") and auto[0]["by"] == "reviewer"


def test_auto_mode_asks_with_the_reviewers_sentence_when_it_says_ask(tmp_path):
    async def reviewer(action):
        return {"decision": "ask", "plain": "Delete budget.xlsx"}

    c = _auto_client(tmp_path, reviewer)
    call = types.SimpleNamespace(kind="execute", title="Approve terminal: rm budget.xlsx", content=[],
                                 raw_input={"command": "rm budget.xlsx"})
    resp = _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s", call))
    assert resp.outcome.option_id == "no", "an unanswered card still times out to deny"
    waits = [d for t, d in c._buf.frames if t == "awaiting_confirmation"]
    assert waits[0]["plain"] == "Delete budget.xlsx" and waits[0]["summary"] == "rm budget.xlsx"


def test_auto_mode_fails_toward_asking_when_the_reviewer_breaks_or_is_missing(tmp_path):
    async def raises(action):
        raise RuntimeError("gateway down")

    async def junk(action):
        return {"decision": "run"}          # no sentence: the person could not see what ran

    for reviewer in (raises, junk, None):
        c = _auto_client(tmp_path, reviewer)
        call = types.SimpleNamespace(kind="execute", title="t", content=[], raw_input={"command": "ls"})
        resp = _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s", call))
        assert resp.outcome.option_id == "no"
        assert [t for t, _ in c._buf.frames if t == "awaiting_confirmation"]
        assert not [t for t, _ in c._buf.frames if t == "auto_approved"]


class _GatewayStatusError(Exception):
    """Shaped like httpx.HTTPStatusError: the gateway answered, with a status on `response`."""

    def __init__(self, status):
        super().__init__(f"{status}")
        self.response = types.SimpleNamespace(status_code=status)


def test_a_reviewer_404_is_tried_once_more_and_its_second_answer_decides_with_no_card(tmp_path):
    """CUR-4630: a review call that answers 404 would open a card that outlasts the chat turn. One gateway error is retried; the retry's verdict decides, so no card opens."""
    calls = []

    async def reviewer(action):
        calls.append(action)
        if len(calls) == 1:
            raise _GatewayStatusError(404)
        return {"decision": "run", "plain": "List the files in the folder"}

    c = _auto_client(tmp_path, reviewer)
    call = types.SimpleNamespace(kind="execute", title="t", content=[], raw_input={"command": "ls"})
    resp = _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s", call))
    assert resp.outcome.option_id == "yes" and len(calls) == 2
    assert not [t for t, _ in c._buf.frames if t == "awaiting_confirmation"]
    assert [d["plain"] for t, d in c._buf.frames if t == "auto_approved"] == ["List the files in the folder"]


def test_a_reviewer_that_fails_twice_or_times_out_still_asks_and_never_runs(tmp_path):
    """The retry never widens what runs: two gateway errors ask, and a timeout asks without a second wait."""
    for first, second, want_calls in ((_GatewayStatusError(404), _GatewayStatusError(404), 2),
                                      (TimeoutError("review took too long"), None, 1)):
        calls = []

        async def reviewer(action, first=first, second=second, calls=calls):
            calls.append(action)
            raise first if len(calls) == 1 else second

        c = _auto_client(tmp_path, reviewer)
        call = types.SimpleNamespace(kind="execute", title="t", content=[], raw_input={"command": "ls"})
        resp = _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s", call))
        assert resp.outcome.option_id == "no" and len(calls) == want_calls
        assert [t for t, _ in c._buf.frames if t == "awaiting_confirmation"]
        assert not [t for t, _ in c._buf.frames if t == "auto_approved"]


def test_a_failed_review_log_line_names_the_gateway_status_so_a_404_and_a_429_read_apart(tmp_path, capsys):
    """CUR-4667: acp.auto_review_failed carried only the exception's class, so every gateway answer looked
    the same. Each failed try now names the status the gateway gave."""
    calls = []

    async def reviewer(action):
        calls.append(action)
        raise _GatewayStatusError(404 if len(calls) == 1 else 429)

    c = _auto_client(tmp_path, reviewer)
    call = types.SimpleNamespace(kind="execute", title="t", content=[], raw_input={"command": "ls"})
    _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s", call))
    recs = [json.loads(l) for l in capsys.readouterr().out.splitlines() if "acp.auto_review_failed" in l]
    assert [r["status"] for r in recs] == [404, 429]


def test_auto_mode_never_softens_deny_writes(tmp_path):
    async def reviewer(action):
        raise AssertionError("deny_writes must not reach the reviewer")

    c = _auto_client(tmp_path, reviewer, policy="deny_writes")
    for kind in ("edit", "execute"):
        resp = _run(c.request_permission([_opt("allow_once", "yes"), _opt("reject_once", "no")], "s",
                                         _tool_call(kind=kind, content=[_diff(str(tmp_path / "a.txt"))])))
        assert resp.outcome.option_id == "no" and c._pending_confirms == {}


def test_ask_mode_is_unchanged_an_in_folder_edit_still_opens_a_card(tmp_path):
    c = acp_client._AgentClient(work=str(tmp_path), buf=_CapBuf(), attempt=1, permission_policy="allow",
                                confirm_timeout_secs=0.01)
    resp = _run(c.request_permission([_opt("reject_once", "no"), _opt("allow_once", "yes")], "s",
                                     _tool_call(kind="edit", content=[_diff(str(tmp_path / "a.txt"))])))
    assert resp.outcome.option_id == "no"
    assert [t for t, _ in c._buf.frames if t == "awaiting_confirmation"]


def test_a_guest_hermes_that_never_answers_initialize_times_out_on_the_attempts_wall_clock(tmp_path):
    """CUR-4535. The attempt clock covers the handshake, so a guest that never answers `initialize`
    cannot hold its agent slot forever."""
    import time

    from app import _write_hermes_home_config

    @contextlib.asynccontextmanager
    async def open_stdio(argv, env):
        loop = asyncio.get_running_loop()
        rfd, wfd = os.pipe()
        transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, os.fdopen(wfd, "wb"))
        writer = asyncio.StreamWriter(transport, protocol, None, loop)
        try:   # nothing ever reads the request, and nothing ever answers it
            yield asyncio.StreamReader(), writer, types.SimpleNamespace(stderr=asyncio.StreamReader(), returncode=None)
        finally:
            transport.close()
            os.close(rfd)

    home = tmp_path / "hermes-home"
    home.mkdir()
    _write_hermes_home_config(str(home), tmp_path / "no-global-config.yaml")
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        _run(asyncio.wait_for(
            acp_client._acp_run(str(tmp_path), str(home), "p", None, 0.5, None, types.SimpleNamespace(id="t"),
                                sandbox_prefix=[], hermes_bin="hermes", model_env={}, model="org/Model-X",
                                provider="huggingface", attempt=1, open_stdio=open_stdio),
            10))
    assert time.monotonic() - started < 5


def _pipe_streams(loop):
    """One OS pipe as an asyncio (reader, writer) pair, plus a closer."""
    rfd, wfd = os.pipe()
    reader = asyncio.StreamReader(limit=1 << 20)

    async def wire():
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(rfd, "rb"))
        transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, os.fdopen(wfd, "wb"))
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop), transport
    return wire()


def _run_against_a_guest_that_records_its_cwd(tmp_path, **kw) -> list[str]:
    from acp.schema import AgentCapabilities, Implementation, InitializeResponse, NewSessionResponse, PromptResponse
    from app import _write_hermes_home_config

    seen: list[str] = []

    class Guest:
        def on_connect(self, conn):
            pass

        async def initialize(self, protocol_version, client_capabilities=None, client_info=None, **_):
            return InitializeResponse(protocol_version=protocol_version, agent_capabilities=AgentCapabilities(),
                                      agent_info=Implementation(name="guest", version="0"))

        async def new_session(self, cwd, mcp_servers=None, **_):
            seen.append(cwd)
            return NewSessionResponse(session_id="s1")

        async def prompt(self, prompt, session_id, **_):
            return PromptResponse(stop_reason="end_turn")

        async def cancel(self, session_id, **_):
            pass

    @contextlib.asynccontextmanager
    async def open_stdio(argv, env):
        loop = asyncio.get_running_loop()
        to_guest_r, to_guest_w, t1 = await _pipe_streams(loop)
        to_host_r, to_host_w, t2 = await _pipe_streams(loop)
        guest = loop.create_task(acp.run_agent(Guest(), to_host_w, to_guest_r))  # pyright: ignore[reportArgumentType]
        try:
            yield to_host_r, to_guest_w, types.SimpleNamespace(stderr=asyncio.StreamReader(), returncode=None)
        finally:
            guest.cancel()
            t1.close()
            t2.close()

    home = tmp_path / "hermes-home"
    home.mkdir()
    _write_hermes_home_config(str(home), tmp_path / "no-global-config.yaml")
    _run(asyncio.wait_for(
        acp_client._acp_run(str(tmp_path), str(home), "p", None, 10, None,
                            types.SimpleNamespace(id="t", _canceled=False, unrun_detail=""),
                            sandbox_prefix=[], hermes_bin="hermes", model_env={}, model="org/Model-X",
                            provider="huggingface", attempt=1, open_stdio=open_stdio, **kw),
        20))
    return seen


def test_a_guest_session_starts_in_the_guests_own_folder_not_this_machines(tmp_path):
    """CUR-4595. Every remote session was opened with this machine's /tmp/agent-run-* folder as its cwd, which
    does not exist in the sandbox, so every `terminal` call failed with `cd: … No such file or directory`."""
    assert _run_against_a_guest_that_records_its_cwd(tmp_path, session_cwd="/home/user/work") == ["/home/user/work"]


def test_a_local_session_still_starts_in_the_work_folder(tmp_path):
    assert _run_against_a_guest_that_records_its_cwd(tmp_path) == [str(tmp_path)]


def test_every_permission_decision_leaves_one_retained_log_line_without_the_path(tmp_path, monkeypatch, capsys):
    """CUR-4595: denied writes on develop left no record of who denied them; each decision now logs kind and verdict."""
    sent = []
    monkeypatch.setattr(acp_client.logsink, "emit", sent.append)
    c = _auto_client(tmp_path)
    c.task_id = "t-9"
    opts = [_opt("reject_once", "no"), _opt("allow_once", "yes")]
    _run(c.request_permission(opts, "s", _tool_call(kind="edit", content=[_diff(str(tmp_path / "budget.xlsx"))])))
    _run(c.request_permission(opts, "s", _tool_call(kind="edit", content=[_diff("/etc/passwd")])))
    perms = [r for r in sent if r["event"] == "acp.permission"]
    assert [(r["decision"], r["by"]) for r in perms] == [("run", "path"), ("ask", "path"), ("deny", "person")]
    assert perms[-1]["reason"] == "timeout" and all(r["task_id"] == "t-9" for r in perms)
    assert "budget.xlsx" not in repr(perms) and "passwd" not in repr(perms), "no path in the retained line"
