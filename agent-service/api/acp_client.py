"""In-app ACP CLIENT — drive a sandboxed `hermes acp` from the /run worker (streaming-spec §3/§7.1).

The inverse of `api/acp_remote.py`: there, our code is an ACP *agent* forwarding to the hosted HTTP
service; here, our app is the ACP *client* that drives Hermes' stock `hermes acp` subcommand as the task
executor. This replaces the blocking `hermes -z` oneshot (which deliberately nulls every stream callback,
`oneshot.py`) so the reserved SSE frames plan/tool_call/tool_result populate live, and makes our client
the per-tool-call policy chokepoint via `request_permission` (replacing `--yolo` allow-all).

Reached ONLY when `AGENT_ACP=1` in `api/app.py`; the surrounding best-of-N / nonce / verify / moderation
machinery in `app.py._run` is unchanged — only the per-attempt transport is swapped. Kept in its own
module so the default (flag-off) path never imports `acp`.

CUR-760: `request_permission` composes an always-confirm tool-effect list with WHATEVER resolved policy
it is handed — including "allow" (bare, or a `staged` caller's earned trusted tier) — so a genuinely
risky action still pauses for a human even for a fully-trusted caller. See `_ALWAYS_CONFIRM_KINDS` and
`request_permission` below for what is on the list, what is deliberately not, and why.

`hermes acp` takes NO `-t`/`-m`/`--provider` (unlike `-z`): the toolset is fixed to `hermes-acp` and the
model is read from the per-task `HERMES_HOME/config.yaml`. So `_acp_run` synthesizes that config from the
same AGENT_MODEL/AGENT_MODEL_PROVIDER the oneshot flags use; gateway routing stays via the HF_TOKEN(nonce)
+ HF_BASE_URL env `_model_env` sets (metering binds identically — see api/proxy.py)."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import acp
import logsink
from acp.schema import (
    AllowedOutcome,
    ClientCapabilities,
    FileSystemCapabilities,
    HttpHeader,
    HttpMcpServer,
    ReadTextFileResponse,
    RequestPermissionResponse,
    WriteTextFileResponse,
)

_SUMMARY_MAX = 200   # cap any redacted summary/step string that crosses the SSE boundary
_STEP_CLIP = 80
_STDERR_MAX = 500    # CUR-653: bounded tail, same denomination as _detect_run_failure's [-300:] in app.py

_LOG = bool(int(os.environ.get("AGENT_LOG_JSON", "1")))


def _clip(s: object, n: int = _STEP_CLIP) -> str:
    """Collapse whitespace + hard-truncate — operational-log level, never raw tool args."""
    t = " ".join(str(s or "").split())
    return t[:n]


def _scrub(text: str, nonce: str | None) -> str:
    """Strip the task's gateway bearer out of text that came back from inside the sandbox. Duplicated from
    app.py's identical function rather than imported — app.py imports acp_client (locally, inside _acp_run's
    caller), never the reverse, and this is a 2-line pure function with no other dependencies, same
    precedent as _clip above not being shared either.

    The agent runs with the nonce in its environment, so anything that echoes an environment can carry it
    back out — a check_cmd that prints `os.environ` on failure, e.g. See app.py's `_scrub` for the fuller
    rationale; kept in sync by hand since there's no shared module for either module to import from."""
    return text.replace(nonce, "<nonce>") if (nonce and text) else text


def _log_stderr_tail(task_id: str, attempt: int, tail: str) -> None:
    """Mirror app.py's _log_event shape locally rather than import it — app.py imports acp_client, not
    the reverse, same tradeoff _scrub above already made. `detail` is an existing logsink.CONTENT_FIELDS
    name, so this tail gets the same length-marker redaction off-box as everything else that quotes
    sandbox output."""
    if not _LOG or not tail:
        return
    rec = {"ts": round(time.time(), 3), "event": "acp.hermes_stderr", "task_id": task_id,
           "attempt": attempt, "detail": tail}
    print(json.dumps(rec, default=str), flush=True)
    logsink.emit(rec)


async def _drain_stderr(proc, task_id: str, attempt: int, nonce) -> None:
    """Read the hermes acp child's stderr to EOF so the pipe never backs up, and log a bounded,
    nonce-scrubbed tail once it closes (normally at EOF, or via `finally` on cancellation).

    The tail goes to the ops log only, so a failure inside the child (a syntax error vs. an HTTP 400
    underneath) can be diagnosed afterwards. It doesn't change what reaches the client."""
    if proc.stderr is None:
        return
    chunks: list[bytes] = []
    try:
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        tail = b"".join(chunks).decode("utf-8", errors="replace")[-_STDERR_MAX:]
        _log_stderr_tail(task_id, attempt, _scrub(tail, nonce))


def _chunk_text(update) -> str:
    """Pull the text out of an AgentMessageChunk's content block (attr or dict form)."""
    c = getattr(update, "content", None)
    txt = getattr(c, "text", None)
    if txt is None and isinstance(c, dict):
        txt = c.get("text")
    return str(txt) if txt else ""


def _pick_option(options, allow: bool) -> str:
    """Choose an allow (or reject) PermissionOption id. Kinds are allow_once/allow_always/reject_once/
    reject_always; fall back to the first option so we always return a valid id."""
    want = "allow" if allow else "reject"
    for o in options or []:
        if str(getattr(o, "kind", "")).startswith(want):
            return getattr(o, "option_id", "")
    return getattr(options[0], "option_id", "allow") if options else "allow"


def _selected(option_id: str) -> RequestPermissionResponse:
    """Answer the permission request by naming one option. "selected" covers a reject option too — the
    schema's other outcome, "cancelled", means the request was abandoned, not answered with a no.

    Built as the real AllowedOutcome rather than the bare dict these three call sites each wrote out:
    pydantic coerces the dict fine at runtime, but the dict is a `dict[str, str]` to a type checker and
    so is unverifiable against the schema it is standing in for (CUR-1227)."""
    return RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id=option_id))


# Keys an execute-kind tool call may carry its shell command under, most specific first. An ALLOWLIST
# rather than a dump of raw_input: the redaction discipline above holds for every other key, so a
# credential sitting elsewhere in the same raw_input still never crosses (CUR-1405). Hermes has been
# seen using "command"; the rest are here because the ACP schema types raw_input as free-form `Any`
# and an unrecognised key must degrade to today's behaviour, not to a dump.
_COMMAND_KEYS = ("command", "cmd", "shell_command", "script")


def _execute_command_text(tool_call) -> str:
    """The actual shell command an execute-kind call proposes, or "" when it can't be identified.

    `tool_call.title` is Hermes' own summary and it omits arguments: `apt update && apt install -y pandoc`
    arrives as the string `apt && apt`, which is not a command and cannot be reasoned about. The command
    belongs in `summary`, which is already the field the UI renders under the title, and already bounded
    by _clip.
    """
    raw = getattr(tool_call, "raw_input", None)
    if not isinstance(raw, dict):
        return ""
    for key in _COMMAND_KEYS:
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            return val
        # argv form: join so the reader sees one command line rather than a Python list repr.
        if isinstance(val, (list, tuple)) and all(isinstance(p, str) for p in val) and val:
            return " ".join(val)
    return ""


def _describe_tool_call(confirm_id: str, tool_call) -> dict:
    """CUR-218: what a human needs to see to actually decide allow/deny. Deliberate, scoped exception
    to the tool_call/tool_result redaction above ("tool KIND + step index only") — a confirmation the
    human is supposed to act on has to show them what's being asked. Still bounded through _clip, same
    as everything else that crosses this boundary — never a raw dump of raw_input/raw_output."""
    kind = str(getattr(tool_call, "kind", "") or "")
    title = _clip(getattr(tool_call, "title", ""), _SUMMARY_MAX)
    summary = ""
    # For an execute call the command outranks anything the content blocks carry — the
    # `terminal` branch below yields `terminal:<id>`, an id that tells the reader nothing at all. Falls
    # through to the old behaviour when no command key is recognised, so an unknown shape is no worse
    # than it is today. (CUR-1405)
    if kind == "execute":
        command = _execute_command_text(tool_call)
        if command:
            return {"confirm_id": confirm_id, "kind": kind, "title": title,
                    "summary": _clip(command, _SUMMARY_MAX)}
    for c in getattr(tool_call, "content", None) or []:
        ctype = getattr(c, "type", None)
        if ctype == "diff":
            path = getattr(c, "path", "")
            new_text = getattr(c, "new_text", "") or ""
            summary = _clip(f"{path}: {new_text}", _SUMMARY_MAX)
            break
        if ctype == "terminal":
            summary = _clip(f"terminal:{getattr(c, 'terminal_id', '')}", _SUMMARY_MAX)
            break
        if ctype == "content":
            inner = getattr(c, "content", None)
            summary = _clip(getattr(inner, "text", "") or "", _SUMMARY_MAX)
            break
    return {"confirm_id": confirm_id, "kind": kind, "title": title, "summary": summary}


# The tool kinds that always pause for a human (CUR-760). The deny_writes branch of `request_permission`
# reads the same tuple, so the deny path and the always-confirm path share one fact instead of two copies
# that could drift.
#
# Grounded in what the wire actually sends, not guessed from the ACP ToolKind enum's full list
# (read/edit/delete/move/search/execute/think/fetch/switch_mode/other): hermes-agent's
# `maybe_require_edit_approval` (acp_adapter/edit_approval.py) is the ONLY caller of
# `request_permission` for edits, and it only ever proposes kind="edit" (write_file, patch). "delete" is
# a defensive placeholder in case a future Hermes build adds a real delete-kind proposal.
#
# "execute" (terminal, process, execute_code) is proposed by deploy/hermes/0002-acp-confirm-execute.patch
# (CUR-975), which adds acp_adapter/execute_approval.py (mirroring edit_approval.py's
# maybe_require_edit_approval). It calls request_permission(kind="execute") from model_tools.py's single
# dispatch chokepoint before terminal/process/execute_code run, which covers the nested case too, since
# execute_code's own sandbox RPC re-enters that same chokepoint. Toolset EXCLUSION (app.py's
# `_deny_writes_toolsets`) is still the deny_writes floor: an untrusted caller never sees these tools at
# all, so this per-call pause only engages for a resolved "allow" (bare, or a `staged` caller's earned
# trusted tier), the same class edit/delete pause for. A caller can therefore see two separate prompts for one dangerous shell command (Hermes's own
# pattern-matched dangerous-command confirm, unrelated to ACP, plus this one) — extra friction, not a
# gap; left as a known consequence rather than merged, since unifying them risks the dangerous-command
# gate's own test coverage.
_ALWAYS_CONFIRM_KINDS = ("edit", "delete", "execute")

# approval_mode="auto" decides an _ALWAYS_CONFIRM_KINDS call instead of asking a person about every
# one (CUR-3142). An everyday request such as a budget in a spreadsheet would otherwise raise a card
# per script, each the agent creating the file it had just been asked for. The sandbox is what makes
# deciding safe: bwrap leaves only this attempt's work dir writable, and egress is default-deny
# (agent-app.toml AGENT_EGRESS), so the worst an approved call can do is change or remove files in
# that dir. Auto mode therefore asks only about the second of those.
#   edit:    allowed with no model call when every target path resolves inside the work dir and none
#            is a sensitive name. The same rule as upstream Hermes's "workspace" auto-approve policy
#            (acp_adapter/edit_approval.py should_auto_approve_edit).
#   execute/delete: handed to `auto_reviewer`, an injected async callable (app.py builds it on the
#            task's gateway nonce) returning {"decision": "run"|"ask", "plain": "<one sentence>"}.
# Anything the reviewer cannot answer (raises, times out, returns another shape) asks; an HTTP error from the
# gateway is retried once first (CUR-4630). deny_writes is
# untouched: an untrusted caller still fails closed and never reaches the reviewer.
APPROVAL_MODES = ("ask", "auto")
_SENSITIVE_PARTS = frozenset({".git", ".ssh", ".hermes", ".env"})


def _edit_paths(tool_call) -> list[str]:
    return [str(getattr(c, "path", "") or "") for c in getattr(tool_call, "content", None) or []
            if getattr(c, "type", None) == "diff"]


def _edit_stays_in(work: str, tool_call) -> bool:
    """True when the edit names at least one path and every one resolves inside `work`."""
    paths = _edit_paths(tool_call)
    if not paths or any(not p for p in paths):
        return False
    root = Path(work).resolve()
    for p in paths:
        target = Path(p) if os.path.isabs(p) else root / p
        resolved = target.resolve(strict=False)
        if not resolved.is_relative_to(root):
            return False
        if {part.lower() for part in resolved.relative_to(root).parts} & _SENSITIVE_PARTS:
            return False
    return True


class _AttemptClock:
    """Same-loop mutable deadline (CUR-218). pause()/resume() are reentrant with a depth counter —
    up to _MAX_TOOL_WORKERS (8, in hermes-agent) tool calls can be running, and thus awaiting
    confirmation, concurrently for one attempt, and the compute deadline must stay paused until the
    LAST one resolves, not the first. Banks the exact remaining compute budget on pause and restores
    the identical remaining budget on resume, so a confirm wait's duration never eats into the
    attempt's actual compute timeout — this is pause/resume, not a guessed extension."""

    def __init__(self, loop: asyncio.AbstractEventLoop, timeout_secs: float) -> None:
        self._loop = loop
        self.deadline = loop.time() + timeout_secs
        self._pause_depth = 0
        self._banked: float | None = None
        self.total_paused = 0.0   # accumulated actual paused seconds, for the caller's wall-clock reimbursement

    def pause(self) -> None:
        if self._pause_depth == 0:
            self._banked = max(0.0, self.deadline - self._loop.time())
            self._pause_started = self._loop.time()
            self.deadline = float("inf")
        self._pause_depth += 1

    def resume(self) -> None:
        self._pause_depth = max(0, self._pause_depth - 1)
        if self._pause_depth == 0 and self._banked is not None:
            self.total_paused += self._loop.time() - self._pause_started
            self.deadline, self._banked = self._loop.time() + self._banked, None


_WATCHDOG_TICK_SECS = 1.0   # the longest the watchdog sleeps before re-reading the deadline


async def _deadline_watchdog(clock: _AttemptClock, loop: asyncio.AbstractEventLoop) -> None:
    while (remaining := clock.deadline - loop.time()) > 0:  # noqa: ASYNC110 — an Event cannot do this:
        # Sliced, never the whole remainder: a wake during a confirmation's pause reads inf, and a sleep(inf)
        # never saw the resume() that set the deadline back, so the attempt ran on with no clock (CUR-4535).
        await asyncio.sleep(min(remaining, _WATCHDOG_TICK_SECS))


_TEARDOWN_SECS = 10.0   # each step of ending a remote attempt (cancel, close) gets this long, then is abandoned


@contextlib.asynccontextmanager
async def _agent_connection(client, command: str, args: list[str], env: dict, work: str, open_stdio):
    """An ACP connection to `hermes acp`. With no `open_stdio` it is the launch agent mode has always done,
    bwrap prefix and all. With one (CUR-4450), the sandbox backend starts the process from the bare Hermes argv
    and owns where it runs, and only the ACP connection over its streams is built here."""
    if open_stdio is None:
        async with acp.spawn_agent_process(client, command, *args,  # pyright: ignore[reportArgumentType]
                                           env=env, cwd=work) as pair:
            yield pair
        return
    async with open_stdio([command, *args], env) as (reader, writer, proc):
        conn = acp.connect_to_agent(client, writer, reader)  # pyright: ignore[reportArgumentType]
        try:
            yield conn, proc
        finally:
            # A guest that stopped reading would hold this close, and the task's slot with it (CUR-4535).
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(conn.close(), _TEARDOWN_SECS)


def _acp_argv(sandbox_prefix: list[str], hermes_bin: str, accept_hooks: bool = True) -> tuple[str, list[str]]:
    """Split the bwrap prefix so `spawn_agent_process` gets (command, *args). `--accept-hooks` stops a
    headless shell-hook prompt from blocking (no TTY in the sandbox); tool approval still routes through
    our `request_permission`."""
    tail = [hermes_bin, "acp"]
    if accept_hooks:
        tail.append("--accept-hooks")
    if sandbox_prefix:
        return sandbox_prefix[0], [*sandbox_prefix[1:], *tail]
    return tail[0], tail[1:]


_MODELS_DEV_OFFLINE_URL = "http://127.0.0.1:9/api.json"   # discard port: refused, so no timeout wait


def _write_acp_config(attempt_home: str, model: str, provider: str) -> None:
    """Synthesize the per-task hermes config so `hermes acp` picks the gateway-routed model. Only when
    AGENT_MODEL is set (container/Fly, no global config) — else leave the copied global ~/.hermes/config
    untouched, exactly as the oneshot path relies on `_model_flags()` only when AGENT_MODEL is set."""
    if not model:
        return
    lines = ["model:"]
    if provider:
        lines.append(f'  provider: "{provider}"')
    lines.append(f'  default: "{model}"')
    # app._write_hermes_home_config has already written this file (the `agent:` enforcement keys, or the
    # copied global config), so merge into it; replacing it would drop both enforcement nudges (CUR-2163).
    # Hermes fetches its model catalog (two public URLs) and the models.dev registry during
    # `initialize`/`session/new`. Under the egress fence DNS lookups get no answer, so each fetch waits
    # out its timeout: about 60 s before the first model call on every attempt. The catalog has a
    # switch; models.dev has only a URL override, so point it at a refused loopback port and Hermes
    # falls back at once. Neither feeds the gateway-routed model we name above.
    lines += ["model_catalog:", "  enabled: false", "models_dev:", f'  url: "{_MODELS_DEV_OFFLINE_URL}"']
    path = Path(attempt_home, "config.yaml")
    kept = path.read_text() if path.exists() else ""
    for key in ("model", "model_catalog", "models_dev"):
        kept = _without_top_level_block(kept, key)
    path.write_text(kept + "\n".join(lines) + "\n")


def _without_top_level_block(text: str, key: str) -> str:
    """Drop `key:` and its indented body from a block-style YAML mapping, so the caller can append its own
    without a duplicate key (a YAML loader keeps the last duplicate silently). Text-level on purpose:
    PyYAML is not a declared dependency, and a load/dump round trip would also rewrite the operator's
    comments and quoting."""
    out: list[str] = []
    skipping = False
    for line in text.splitlines(keepends=True):
        top_level = bool(line.strip()) and not line[0].isspace() and not line.startswith("#")
        if top_level:
            skipping = line.split(":", 1)[0].strip() == key
        if not skipping:
            out.append(line)
    kept = "".join(out)
    return kept if not kept or kept.endswith("\n") else kept + "\n"


def _write_acp_toolsets(attempt_home: str, toolsets: str) -> None:
    """Hand `hermes acp` its toolset through config, since the env var does not reach it (CUR-2118).

    Hermes resolves an ACP session's toolsets from `platform_toolsets.acp` in config.yaml
    (NousResearch/hermes-agent acp_adapter/session.py `_make_agent`), so this block carries the
    comma-separated HERMES_ACP_TOOLSETS value, including app._deny_writes_toolsets' narrowed list. Empty
    means unset: no block, and Hermes picks its own `hermes-acp` default. A set value
    replaces any earlier `platform_toolsets:` block whole, other platforms' lists included; nothing but
    `acp` runs under this HERMES_HOME."""
    names = [n.strip() for n in toolsets.split(",") if n.strip()]
    if not names:
        return
    path = Path(attempt_home, "config.yaml")
    kept = _without_top_level_block(path.read_text(), "platform_toolsets") if path.exists() else ""
    block = ["platform_toolsets:", "  acp:", *(f"    - {json.dumps(n)}" for n in names)]
    path.write_text(kept + "\n".join(block) + "\n")


class _EarlyExitDebounce:
    """Require `verify_check()` to pass on 2 CONSECUTIVE calls before signaling exit. A single incidental
    match isn't enough — e.g. the agent's own "write then read back to confirm" step can make the artifact
    look done a beat before the turn actually is — but two passes in a row, across two separate tool-call
    completions (each at least one model round-trip apart), is a strong signal the task is genuinely over.
    `verify_check` is None when early-exit is disabled or there's no verify spec; `check()` is then always
    a no-op False so the caller never has to branch on that separately."""

    def __init__(self, verify_check: Callable[[], bool] | None) -> None:
        self._verify_check = verify_check
        self.hits = 0

    def check(self) -> bool:
        """Call on every candidate event. Returns True the moment 2 consecutive checks pass. Never raises —
        a broken verify_check is treated as a miss (resets the streak), not a crash of the ACP loop."""
        if self._verify_check is None:
            return False
        try:
            ok = bool(self._verify_check())
        except Exception:  # noqa: BLE001
            ok = False
        self.hits = self.hits + 1 if ok else 0
        return self.hits >= 2


class _AgentClient:
    """ACP Client for ONE attempt. Accumulates the agent's final text and re-emits session updates as
    redacted SSE frames on the task's _EventBuffer. Its write/read/permission handlers are the per-op
    policy chokepoint (streaming-spec §0/§2). Single-threaded on the attempt's asyncio loop, so plain
    attributes need no lock."""

    def __init__(self, work: str, buf, attempt: int, emit_token: bool = False,
                 token_max_frames: int = 0, tool_kinds: set[str] | None = None,
                 tool_failures: set[str] | None = None,
                 permission_policy: str = "allow",
                 confirm_timeout_secs: float = 45.0,
                 approval_mode: str = "ask",
                 auto_reviewer: Callable[[dict], Awaitable[dict]] | None = None) -> None:
        self.work = str(Path(work).resolve())
        # See APPROVAL_MODES. "auto" without a reviewer still decides edits by path and asks
        # about everything else, so a wiring miss costs cards, never an unreviewed shell command. (CUR-3142)
        self.approval_mode = approval_mode if approval_mode in APPROVAL_MODES else "ask"
        self.task_id = ""                    # set by _acp_run; stamps the acp.permission log line
        self.auto_reviewer = auto_reviewer
        self._buf = buf                       # _EventBuffer | None
        self._attempt = attempt
        self._emit_token = emit_token
        # Capped AT THE SOURCE, not at the buffer. The buffer trims oldest-first to SSE_MAX_EVENTS, so an
        # uncapped answer stream evicts this turn's `plan` and `tool_call` frames and a client reconnecting
        # with Last-Event-ID resumes into a turn that appears to have had no plan. Capping here also keeps
        # the seq space contiguous, which `_EventBuffer._base` and Last-Event-ID both depend on. 0 = no cap.
        self._token_max = token_max_frames
        self._tokens_emitted = 0
        self._token_truncated = False
        self.text_parts: list[str] = []
        self._step = 0
        self._steps: dict = {}                # tool_call_id -> stable step index (across start/update)
        # Passed in, not read from env here. Under ACP_PERMISSION_POLICY="staged" the resolved
        # value differs per caller (app.py:_resolve_permission_policy), and this instance is constructed
        # fresh per attempt already knowing which task it belongs to — the caller has the answer this
        # class needs, so it hands it over instead of this __init__ re-deriving a global that no longer
        # has a single value to re-derive. (CUR-470)
        self.permission_policy = permission_policy
        self.permission_calls = 0             # observability / test hook
        self.early_exit = False               # set True by _acp_run's debounce right before it cancels
        self.on_step: Callable[[], None] | None = None   # early-exit hook, wired by _acp_run after construction
        # policy="confirm" pauses request_permission for a real human answer instead of
        # resolving from policy. _pending_confirms is keyed by confirm_id (uuid4, task-scoped rather
        # than attempt-local — see request_permission below); on_confirmation_open/close let app.py's
        # _run mutate Task.state/pending_confirmations without acp_client.py importing State from app.py
        # (app.py imports acp_client, not the reverse — a module-level import back would cycle). (CUR-218)
        self.confirm_timeout_secs = confirm_timeout_secs
        self._pending_confirms: dict[str, asyncio.Future] = {}
        self.on_confirmation_open: Callable[[dict], None] | None = None
        self.on_confirmation_close: Callable[[str], None] | None = None
        self._clock: _AttemptClock | None = None   # wired by _acp_run right after construction
        # Tool KINDS that actually RAN this attempt, shared by reference with the caller so a repair_check
        # built before the session exists can still read what the session did. Kinds only — the same
        # redaction the tool_call frame observes below, and nothing here widens it.
        #
        # "Actually ran" is load-bearing: committed at tool_call_update's status=="completed" branch, NOT
        # at the tool_call proposal, so a denied/timed-out confirm never joins this set (CUR-705; see both
        # branches' comments).
        self.tool_kinds: set[str] = tool_kinds if tool_kinds is not None else set()
        # Kinds with an outstanding (not yet recovered) call failure this attempt (CUR-574). Same redaction
        # level as tool_kinds (kind strings only, never which call or why). A tool_call_update with a real
        # completion status does arrive for execute-kind calls, including a turn's last one, so a failed
        # call shows up here. _call_kind below is what turns a completion status back into a kind, since
        # tool_call_update carries only the id, not the kind that was started.
        #
        # A later call of the SAME kind completing discards that kind again (CUR-772; see the
        # tool_call_update handler below) — a fail-then-retry-succeed sequence should not still read as
        # "never ran," since the model did get a real measurement of that kind before answering. A kind
        # with no successful retry stays in the set and still flags, which is the CUR-574 case.
        self.tool_failures: set[str] = tool_failures if tool_failures is not None else set()
        self._call_kind: dict = {}            # tool_call_id -> kind, set at tool_call time

    @property
    def text(self) -> str:
        return "".join(self.text_parts)

    def _emit(self, etype: str, data: dict) -> None:
        if self._buf is not None:
            self._buf.emit(etype, data)

    def _log_permission(self, kind: str, decision: str, by: str, reason: str = "") -> None:
        """One retained line per permission decision (CUR-4595), so a run of denied writes leaves a record of
        who denied them and why. Kind and verdict only, no path or command: those are the person's content."""
        rec = {"ts": round(time.time(), 3), "event": "acp.permission", "task_id": self.task_id,
               "attempt": self._attempt, "kind": kind,
               "decision": decision, "by": by, "reason": reason, "approval_mode": self.approval_mode,
               "policy": self.permission_policy}
        print(json.dumps(rec), flush=True)
        logsink.emit(rec)

    def emit_policy(self, decision: dict) -> None:
        """CUR-471: fired PROACTIVELY by our side, once, right after construction — unlike
        `plan`/`tool_call`/`tool_result`, which are reactions to what Hermes's ACP session reports,
        `policy` describes our own caller's trust state, which Hermes has no concept of and so can
        never surface through `session_update`. Stamps `attempt` itself, matching how `plan`/
        `tool_call` already do."""
        self._emit("policy", {**decision, "attempt": self._attempt})

    def _emit_token_frame(self, txt: str) -> None:
        """One `token` frame per answer chunk, until the per-turn cap. Past it, exactly ONE
        `token_truncated` frame and then silence.

        Announced rather than silently stopped: a consumer that concatenates deltas and compares them to
        `done.result` has to be able to tell "the answer changed" from "I stopped being sent it". Without
        the marker the two look identical, and the second one is not an error."""
        if self._token_max and self._tokens_emitted >= self._token_max:
            if not self._token_truncated:
                self._token_truncated = True
                self._emit("token_truncated", {"attempt": self._attempt, "frames": self._tokens_emitted})
            return
        self._tokens_emitted += 1
        self._emit("token", {"delta": txt, "attempt": self._attempt})

    def _step_for(self, tool_call_id) -> int:
        key = tool_call_id if tool_call_id is not None else object()
        if key not in self._steps:
            self._step += 1
            self._steps[key] = self._step
        return self._steps[key]

    # ---- Client protocol -----------------------------------------------------------------------
    async def session_update(self, session_id, update, **kw) -> None:
        kind = getattr(update, "session_update", None)
        if kind == "agent_message_chunk":
            txt = _chunk_text(update)
            if txt:
                # ACCUMULATION IS UNCONDITIONAL. `self.text` is the turn's answer and `done.result` carries
                # it whole regardless of the flag, so streaming can be switched off without changing what a
                # turn returns — that is what makes the flag safe rather than a second delivery path.
                self.text_parts.append(txt)
                if self._emit_token:
                    self._emit_token_frame(txt)
        elif kind == "plan":
            steps = [_clip(getattr(e, "content", "")) for e in (getattr(update, "entries", None) or [])]
            self._emit("plan", {"attempt": self._attempt, "steps": steps})
        elif kind == "tool_call":
            # A NEW tool call starting is the same kind of boundary the repair-turn `.clear()` below
            # already treats as one: whatever narration chunks accumulated before this call are not the
            # turn's answer, because more work is about to happen. Without it, a turn that loops through
            # many tool calls returns every pre-tool-call aside joined into one wall of near-duplicate
            # one-line answers ahead of the real final answer. Without this clear, self.text is "everything the model
            # said during the turn"; the docstring at self.text_parts's declaration and the repair-turn
            # clear both already assume it means "the turn's answer" — this makes tool-call rounds honor
            # that too. A message that streams across multiple chunks with NO tool call in between is
            # unaffected: nothing here fires unless a new tool_call actually starts.
            self.text_parts.clear()
            # REDACTED: tool KIND + step index only — never title/raw_input/raw_output/locations.
            tcid = getattr(update, "tool_call_id", None)
            step = self._step_for(tcid)
            tool = getattr(update, "kind", "other") or "other"
            # NOT added to self.tool_kinds here: this fires the instant a call is PROPOSED, before
            # permission resolves, and a denied/timed-out confirm never reaches a real tool call
            # (request_permission's deny path returns without the agent calling the tool). Adding it here
            # would leave a kind that never ran in the set, and every downstream check that reads
            # tool_kinds (_wrote_code_without_running_it's "edit" branch, the groundedness judge's
            # `not tool_kinds` gate) would read it as "something ran" (CUR-705). The web side's toolKinds
            # tracking in endpointAgent.ts follows the same rule. The commit happens in tool_call_update
            # below; this only records WHICH kind a call id maps to (needed for tool_failures too).
            #
            # Only when the id is real: _step_for treats a missing id as unidentifiable (a fresh throwaway
            # key every call, so it never collides with anything). Keying _call_kind on a bare None instead
            # would let two different-kind id-less calls silently overwrite each other, and a later failure
            # for an id-less call would then get attributed to whichever kind happened to write last —
            # wrong, not just imprecise. Safer to record nothing than to misattribute. An id-less call also
            # has no way to correlate a later completion back to it, so it is added to tool_kinds at
            # proposal as a narrow fallback: safer to over-credit a call we can never otherwise confirm
            # than to never count it at all.
            #
            # An ASSUMPTION, not a proven invariant: if an id-less call ever went through the
            # deny/timeout confirm path, this fallback would count a kind that never ran. Low exposure,
            # because every _ALWAYS_CONFIRM_KINDS proposer builds a real tool_call_id: edit/delete via
            # maybe_require_edit_approval, execute via maybe_require_execute_approval
            # (deploy/hermes/0002-acp-confirm-execute.patch's build_acp_execute_tool_call, same
            # `f"{kind}-approval-{counter}"` pattern). Hermes does not guarantee that it always will.
            if tcid is not None:
                self._call_kind[tcid] = tool
            else:
                self.tool_kinds.add(tool)
            self._emit("tool_call", {"tool": tool, "step": step})
        elif kind == "tool_call_update":
            # A completion status arrives here for plain tool calls, including execute, including a
            # turn's LAST call before it ends (see self.tool_failures above).
            tcid = getattr(update, "tool_call_id", None)
            step = self._step_for(tcid)
            status = getattr(update, "status", None)
            if status == "failed":
                kind_of_call = self._call_kind.get(tcid)
                if kind_of_call:
                    self.tool_failures.add(kind_of_call)
            elif status == "completed":
                # This kind just ran for real, so an earlier failure of the SAME kind no longer
                # means "never measured" — discard it. Only this kind; a failure of a different kind is
                # untouched, and a kind with no successful retry stays flagged (CUR-574's own case). (CUR-772)
                kind_of_call = self._call_kind.get(tcid)
                if kind_of_call:
                    self.tool_failures.discard(kind_of_call)
                    # CUR-705, round three: commit HERE, not at the tool_call proposal above — see that
                    # branch's own comment. A denied/timed-out confirm never reaches this branch at all
                    # (no tool_call_update ever arrives for it), so it correctly never joins tool_kinds.
                    self.tool_kinds.add(kind_of_call)
            self._emit("tool_result", {"ok": status == "completed", "step": step,
                                       "summary": _clip(status, _SUMMARY_MAX)})
            if status == "completed" and self.on_step is not None:
                self.on_step()                # early-exit check — see _acp_run's _EarlyExitDebounce wiring
        elif kind == "usage_update":
            self._emit("usage", {"tokens": getattr(update, "used", None)})
        # agent_thought_chunk / available_commands / mode / session_info: not in the SSE contract → drop.

    async def request_permission(self, options, session_id, tool_call, **kw) -> RequestPermissionResponse:
        # Default (allow) runs every tool call, observably (each decision is surfaced as a tool_call
        # frame). bwrap + the nonce step/spend caps remain the hard bounds.
        # deny_writes: reject edit/delete/execute kinds only.
        #
        # What reaches here: Hermes asks for permission from `maybe_require_edit_approval` (write_file,
        # patch(mode=replace)) and, with deploy/hermes/0002-acp-confirm-execute.patch,
        # acp_adapter/execute_approval.py's maybe_require_execute_approval at the same model_tools.py
        # chokepoint, so a `terminal`/`process`/`execute_code` call arrives too, with kind="execute"
        # (CUR-975). Under deny_writes that is moot in practice: app.py's `_model_env` filters those tool
        # names out of the toolset before the subprocess starts (`_deny_writes_toolsets`), so an untrusted
        # caller never gets far enough to propose one, and this callback denying "execute" is defense in
        # depth, not the operative gate. See _permission_state in app.py for how the two add up.
        #
        # `execute_code`'s RPC does NOT bypass this: a write_file issued from inside the sandbox reaches
        # the gate and is refused.
        #
        # `confirm` composes with WHATEVER policy this attempt resolved to (CUR-760). `staged` sets a
        # caller's toolset FLOOR (which tools exist at all, enforced upstream by _model_env), but a floor
        # alone leaves no per-action gate once a caller crosses into "allow", so a trusted caller would get
        # a free pass on an edit/delete-kind call. _ALWAYS_CONFIRM_KINDS closes that gap at this single chokepoint, for every resolved
        # policy that would otherwise auto-allow: bare ACP_PERMISSION_POLICY=allow, and `staged`'s
        # trusted tier (which resolves to "allow" — see app.py's _permission_decision). `confirm` itself
        # already pauses unconditionally above, so this is a no-op there. `deny_writes` is deliberately
        # UNCHANGED below: a new/untrusted caller already fails CLOSED on these kinds outright, and
        # softening that into "ask a human" would widen what deny_writes promises: a caller below their
        # floor keeps failing closed.
        self.permission_calls += 1
        kind = str(getattr(tool_call, "kind", "") or "")
        if self.permission_policy == "deny_writes" and kind in _ALWAYS_CONFIRM_KINDS:
            self._log_permission(kind, "deny", "policy")
            oid = _pick_option(options, allow=False)
            return _selected(oid)
        if self.permission_policy == "confirm" or kind in _ALWAYS_CONFIRM_KINDS:
            plain = None
            if self.approval_mode == "auto":
                verdict = await self._auto_verdict(kind, tool_call)
                if verdict["decision"] == "run":
                    self._emit("auto_approved", {"kind": kind, "title": _clip(getattr(tool_call, "title", ""), _SUMMARY_MAX),
                                                 "plain": verdict["plain"], "by": verdict["by"],
                                                 "attempt": self._attempt})
                    self._log_permission(kind, "run", verdict["by"])
                    return _selected(_pick_option(options, allow=True))
                plain = verdict["plain"] or None
                self._log_permission(kind, "ask", verdict["by"])
            return await self._request_confirmation(options, tool_call, plain=plain)
        self._log_permission(kind, "allow", "policy")
        oid = _pick_option(options, allow=True)
        return _selected(oid)

    async def _auto_verdict(self, kind: str, tool_call) -> dict:
        """CUR-3142: decide one call under approval_mode="auto". Returns {"decision", "plain", "by"},
        where `by` says what decided ("path" or "reviewer") so the trace can show it. Fails toward
        asking: no reviewer, a reviewer error, or an answer of any other shape is decision "ask"."""
        if kind == "edit":
            if _edit_stays_in(self.work, tool_call):
                names = ", ".join(Path(p).name for p in _edit_paths(tool_call))
                return {"decision": "run", "plain": _clip(f"Write {names}", _SUMMARY_MAX), "by": "path"}
            return {"decision": "ask", "plain": "", "by": "path"}
        if self.auto_reviewer is None:
            return {"decision": "ask", "plain": "", "by": "none"}
        raw = getattr(tool_call, "raw_input", None)
        action = {"kind": kind, "title": str(getattr(tool_call, "title", "") or ""),
                  "command": _execute_command_text(tool_call),
                  "arguments": raw.get("arguments") if isinstance(raw, dict) else None}
        out = None
        for review_try in (1, 2):
            try:
                out = await self.auto_reviewer(action)
                break
            except Exception as exc:  # noqa: BLE001 — a reviewer failure asks the person; it never allows
                # An error the gateway answered (an HTTP status, such as the router's intermittent
                # 404) is tried once more before asking, since an ask opens a card that can outlast the chat
                # turn. A timeout is not retried: a second wait of AGENT_AUTO_REVIEW_TIMEOUT_SECS costs the
                # turn more than the card does. (CUR-4630)
                retry = review_try == 1 and getattr(exc, "response", None) is not None
                rec = {"ts": round(time.time(), 3), "event": "acp.auto_review_failed", "attempt": self._attempt,
                       "error": type(exc).__name__, "review_try": review_try, "retrying": retry}
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if isinstance(status, int):
                    rec["status"] = status    # CUR-4667: a 404, a 429 and a 500 need different fixes
                print(json.dumps(rec), flush=True)
                logsink.emit(rec)
                if not retry:
                    return {"decision": "ask", "plain": "", "by": "reviewer"}
        decision = out.get("decision") if isinstance(out, dict) else None
        plain = out.get("plain") if isinstance(out, dict) else None
        plain = _clip(plain, _SUMMARY_MAX) if isinstance(plain, str) else ""
        if decision == "run" and plain:
            return {"decision": "run", "plain": plain, "by": "reviewer"}
        return {"decision": "ask", "plain": plain, "by": "reviewer"}

    async def _request_confirmation(self, options, tool_call, plain: str | None = None) -> RequestPermissionResponse:
        """CUR-218: pause and wait for a real human answer, bounded by confirm_timeout_secs (fail
        CLOSED — a timeout is a deny, not an allow). confirm_id is uuid4, not an attempt-local counter:
        each attempt gets a fresh _AgentClient/registry, so a counter would restart at 1 every attempt
        and a stale UI could POST an attempt-1 id into attempt-2's window and hit the wrong live
        request. uuid4 sidesteps the reset entirely."""
        confirm_id = uuid.uuid4().hex[:12]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending_confirms[confirm_id] = fut
        desc = _describe_tool_call(confirm_id, tool_call)
        if plain:
            desc["plain"] = plain     # CUR-3142: the reviewer's one sentence; the card leads with it
        if self._clock is not None:
            self._clock.pause()   # exempt this wait from the attempt's compute deadline — see _AttemptClock
        # Everything from pause() to resume() is ONE try/finally. Pausing, or calling
        # on_confirmation_open(), before the try block would let an exception FROM on_confirmation_open
        # (it calls _persist(task), real sqlite I/O) skip resume() entirely and leave the attempt's
        # deadline frozen at inf forever.
        try:
            if self.on_confirmation_open is not None:
                self.on_confirmation_open(desc)
            # The real deadline (this attempt's confirm_timeout_secs) crosses the ACP boundary (CUR-1094), so
            # the client can count down from it instead of showing a static "times out eventually" line.
            # A duration, not an absolute timestamp — the Python and Node clocks aren't the same
            # clock, so the web side stamps its own receipt-time deadline from this value instead of
            # trusting an epoch computed here.
            self._emit("awaiting_confirmation",
                        {**desc, "attempt": self._attempt, "timeout_secs": self.confirm_timeout_secs})
            # Bound BEFORE the try, because the `finally` below reads both names and only the
            # try body and the `except TimeoutError` handler assign them. Any OTHER exception through
            # this block reached that finally with both unbound and raised UnboundLocalError IN PLACE OF
            # the real one — and the exception that actually arrives here is asyncio.CancelledError,
            # raised into this coroutine when the acp TaskSupervisor tears the session down with a
            # confirmation still open (the agent process dying mid-confirmation is the live shape; the
            # DELETE path resolves these futures explicitly via _cancel_soon and never hits it).
            # Swallowing a CancelledError and substituting a name error is the worst version of that:
            # the attempt's real ending is gone and the cancel does not read as a cancel. Fail CLOSED on
            # the default, same as a timeout. Pyright reports the possibly unbound names; ty and mypy model this
            # finally as reachable only from the two binding paths and report nothing at any rule setting. (CUR-1227)
            decision, reason = "deny", "aborted"
            try:
                decision = await asyncio.wait_for(fut, timeout=self.confirm_timeout_secs)
                reason = "canceled" if decision == "canceled" else "human"
            except TimeoutError:
                decision, reason = "deny", "timeout"          # fail CLOSED
            finally:
                self._pending_confirms.pop(confirm_id, None)
                if self.on_confirmation_close is not None:
                    self.on_confirmation_close(confirm_id)
                self._emit("confirm_result",
                           {"confirm_id": confirm_id, "decision": decision, "reason": reason, "attempt": self._attempt})
        finally:
            if self._clock is not None:
                self._clock.resume()   # runs no matter what happened above — every exit path must
                                        # resume, or the deadline is frozen forever
        self._log_permission(str(getattr(tool_call, "kind", "") or ""), decision, "person", reason)
        if decision == "allow":
            # At the pinned Hermes SHA (deploy/Dockerfile's HERMES_SHA), for an edit-approval-gated call (CUR-468),
            # Hermes's own edit_approval.py sends exactly ONE tool_call notification — the
            # "Preparing write..." proposal that opens this confirmation — and, once approved, performs
            # the real write and moves straight to the model's next turn. No matching
            # tool_call_update(status=completed) arrives for that id, so the normal "commit at completion"
            # path above (session_update's status=="completed" branch) is structurally unreachable for
            # this call shape: the file lands on disk while tool_kinds stays empty and
            # self._call_kind[tcid] never resolves. The consequence is real, not cosmetic: a spec-less turn (task._verify_spec is None — the
            # actual "chat surface" / synthesize=True shape, not just a bare script) whose only tool
            # call was an approved edit reports FAILED "agent made no tool calls" even though the human
            # said yes and the write succeeded. Crediting the kind HERE, on an explicit allow, is the
            # only synchronization point this Hermes build ever gives us for this flow. Deny/timeout are
            # deliberately excluded: an unapproved call never runs, and crediting it would count a tool
            # that never ran (CUR-705).
            kind = str(getattr(tool_call, "kind", "") or "")
            self.tool_failures.discard(kind)
            self.tool_kinds.add(kind)
        oid = _pick_option(options, allow=decision == "allow")
        return _selected(oid)

    async def write_text_file(self, content, path, session_id, **kw) -> WriteTextFileResponse:
        self._guard(path)                     # raise on sandbox escape (fail-closed)
        p = self._resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content if content is not None else "")
        return WriteTextFileResponse()

    async def read_text_file(self, path, session_id, limit=None, line=None, **kw) -> ReadTextFileResponse:
        self._guard(path)
        data = self._resolve(path).read_text()
        if line is not None or limit is not None:      # ACP line/limit windowing
            lines = data.splitlines(keepends=True)
            start = (line - 1) if line else 0
            end = start + limit if limit else None
            data = "".join(lines[start:end])
        return ReadTextFileResponse(content=data)

    # ---- containment ---------------------------------------------------------------------------
    def _resolve(self, path) -> Path:
        rp = Path(path)
        return rp if rp.is_absolute() else Path(self.work) / rp

    def _guard(self, path) -> None:
        """Confine every client-mediated fs op to the task scratch — the same containment bwrap's
        `--bind work` gives, re-applied at the RPC layer so a future fs-capable toolset can't escape it."""
        rp = self._resolve(path).resolve()
        work = Path(self.work)
        if rp != work and work not in rp.parents:
            raise PermissionError(f"path escapes task sandbox: {path}")


def build_mcp_servers(cfg, env, task_id: str = "") -> list[HttpMcpServer]:
    """ACP `mcpServers` for new_session from an mcp_config.McpConfig (CUR-3025).

    Header values are read from `env` here, at session time. A server whose header env var is unset is
    left out and logged rather than sent without its credential: an unauthenticated call to a config
    server is a 401 at best, and at worst it reaches whatever that server allows anonymously."""
    import mcp_config
    out: list[HttpMcpServer] = []
    for spec in cfg.servers:
        headers, missing = mcp_config.resolve_headers(spec, env)
        if missing:
            if _LOG:
                rec = {"ts": round(time.time(), 3), "event": "mcp.server_skipped", "task_id": task_id,
                       "server": spec.name, "missing_header_env": missing}
                print(json.dumps(rec), flush=True)
                logsink.emit(rec)
            continue
        out.append(HttpMcpServer(type="http", name=spec.name, url=spec.url,
                                 headers=[HttpHeader(name=h, value=v) for h, v in headers]))
    return out


async def _acp_run(work: str, attempt_home: str, prompt: str, nonce, timeout_secs: float, buf, task, *,
                   sandbox_prefix: list[str], hermes_bin: str, model_env: dict,
                   model: str, provider: str, attempt: int,
                   verify_check: Callable[[], bool] | None = None,
                   repair_check: Callable[[str], tuple[bool, str]] | None = None,
                   repair_turn_prompt: Callable[[str], str] | None = None,
                   repair_turns: int = 0,
                   repair_exhausted_answer: str | None = None,
                   emit_token: bool = False, token_max_frames: int = 0,
                   tool_kinds: set[str] | None = None,
                   tool_failures: set[str] | None = None,
                   permission_policy: str = "allow",
                   policy_detail: dict | None = None,
                   confirm_timeout_secs: float = 45.0,
                   approval_mode: str = "ask",
                   auto_reviewer: Callable[[dict], Awaitable[dict]] | None = None,
                   on_confirmation_open: Callable[[dict], None] | None = None,
                   on_confirmation_close: Callable[[str], None] | None = None,
                   open_stdio: Callable[[list[str], dict], contextlib.AbstractAsyncContextManager] | None = None,
                   session_cwd: str | None = None,
                   mcp_servers: list[HttpMcpServer] | None = None,
                   ) -> tuple[str, str | None, int | None]:
    """Drive one `hermes acp` session end to end. Returns (final_text, stop_reason, returncode).

    Raises asyncio.TimeoutError on the wall-clock cap, asyncio.CancelledError on external cancel, or
    re-raises a JSON-RPC/transport error — the caller maps each onto the honest failure signal. Exiting
    the `spawn_agent_process` context manager closes stdin → terminate → kill, reaping the child; bwrap
    `--die-with-parent` tears the sandbox tree with it.

    `verify_check` (None unless AGENT_EARLY_EXIT is on and the task has a verify spec): a zero-arg callable
    the caller has already bound to this task's work dir + spec. Wired through _EarlyExitDebounce so 2
    consecutive passing checks — each on a separate completed tool call — cancel the prompt early instead
    of waiting for the model to decide to stop on its own. This is the one case where the cancel path is
    NOT a failure: the caller distinguishes it via the returned stop_reason == "early_exit".

    `repair_check`/`repair_turn_prompt`/`repair_turns` (inert unless all three are supplied): when a turn
    ends and the task's own acceptance test still fails, send the check's complaint back as another
    prompt ON THE SAME SESSION, up to `repair_turns` times. The model keeps the context in which it wrote
    the files. All the turns share ONE wall clock — see the `deadline` comment below.

    `repair_check` receives the turn's own answer text (`client.text`, the same value this function
    ultimately returns) — needed so it can catch a claim the model made in prose with nothing behind it
    on disk (CUR-226), not only a file the trace shows was never run.

    `repair_exhausted_answer` (CUR-705, inert if None): when the give-up branch's last repair_check still
    fails AND this attempt never once called "edit" (client.tool_kinds — no real write, ever, this whole
    attempt, repair turns included since tool_kinds is cumulative), this REPLACES client.text with the
    given string instead of shipping the model's own reply. Reaching that condition means the model had
    every repair chance and never grounded a single claim in a real edit; its prose at that point is not
    a draft worth a caveat, it is the defect. Scoped to "edit" specifically, same predicate app.py's
    _wrote_code_without_running_it already uses — an attempt with a real (even if failed, or read-only)
    tool call is a different, lesser bug and keeps its own text.

    `on_confirmation_open`/`on_confirmation_close` (CUR-218, inert unless `permission_policy="confirm"`):
    plain callables built by the CALLER (app.py's `_run`), not by this function — they need `State`/
    `_TERMINAL` from `app.py`, which this module cannot import (app.py imports acp_client, not the
    reverse). Forwarded onto the client below; see `_request_confirmation` for what they're called with.

    `mcp_servers` (CUR-3025, inert if empty): ACP MCP server entries from `build_mcp_servers`, passed on
    new_session. The caller decides whether this task gets them at all (app.py `_task_mcp_servers`)."""
    _write_acp_config(attempt_home, model, provider)
    _write_acp_toolsets(attempt_home, model_env.get("HERMES_ACP_TOOLSETS", ""))
    # On E2B, Hermes names its edits by guest path (/home/user/work/...), so the path check that
    # auto-approves an in-folder write has to measure against the guest's folder (CUR-4595); measured
    # against this machine's scratch, every such write would read as "outside" and go to a confirmation.
    client = _AgentClient(session_cwd or work, buf, attempt, emit_token=emit_token, token_max_frames=token_max_frames,
                          tool_kinds=tool_kinds, tool_failures=tool_failures,
                          permission_policy=permission_policy, confirm_timeout_secs=confirm_timeout_secs,
                          approval_mode=approval_mode, auto_reviewer=auto_reviewer)
    client.task_id = str(getattr(task, "id", "") or "")
    client.on_confirmation_open = on_confirmation_open
    client.on_confirmation_close = on_confirmation_close
    if policy_detail is not None:
        client.emit_policy(policy_detail)
    if open_stdio is not None and sandbox_prefix:
        raise ValueError("open_stdio owns where Hermes runs; pass no sandbox_prefix with it")
    command, args = _acp_argv(sandbox_prefix, hermes_bin)
    caps = ClientCapabilities(fs=FileSystemCapabilities(read_text_file=True, write_text_file=True))
    loop = asyncio.get_running_loop()
    prompt_task: asyncio.Task | None = None
    debounce = _EarlyExitDebounce(verify_check)

    def _cancel_soon() -> None:               # invoked from the DELETE thread
        def _do():
            if prompt_task is not None and not prompt_task.done():
                prompt_task.cancel()
            # prompt_task and a pending request_permission call are SIBLING tasks under the
            # acp library's own TaskSupervisor, not nested — cancelling prompt_task has no direct effect
            # on a confirmation someone is awaiting. Resolve those explicitly rather than relying on the
            # implicit TaskSupervisor.shutdown() cascade when the session closes. (CUR-218)
            for fut in list(client._pending_confirms.values()):
                if not fut.done():
                    fut.set_result("canceled")
        try:
            loop.call_soon_threadsafe(_do)
        except RuntimeError:                  # loop already closed between attempts — the _canceled flag covers it
            pass

    def _maybe_early_exit() -> None:          # invoked from session_update, already on this loop's thread
        if debounce.check() and prompt_task is not None and not prompt_task.done():
            client.early_exit = True
            prompt_task.cancel()

    client.on_step = _maybe_early_exit

    def _confirm_soon(confirm_id: str, decision: str) -> None:   # invoked from the POST /confirm thread
        def _do():
            fut = client._pending_confirms.get(confirm_id)
            if fut is not None and not fut.done():
                fut.set_result(decision)
        try:
            loop.call_soon_threadsafe(_do)
        except RuntimeError:                  # loop already closed between attempts
            pass

    # _AgentClient implements the handlers acp actually calls, but does not inherit acp.Client, so it
    # is a structural mismatch to the annotation while being the correct object to pass. Inheriting
    # would drag in the full abstract surface for no runtime gain.
    async with _agent_connection(client, command, args, model_env, work, open_stdio) as (conn, proc):
        task._acp_cancel = _cancel_soon
        task._acp_confirm = _confirm_soon
        stderr_task = loop.create_task(_drain_stderr(proc, task.id, attempt, nonce))
        resp = None
        clock: _AttemptClock | None = None   # set below; guarded in `finally` in case init/new_session raises first
        try:
            # The attempt's clock covers the handshake too. A guest Hermes that never answers `initialize`
            # would hold its agent slot forever (CUR-4535).
            clock = _AttemptClock(loop, timeout_secs)
            await asyncio.wait_for(conn.initialize(protocol_version=1, client_capabilities=caps),
                                   max(0.0, clock.deadline - loop.time()))
            # A guest Hermes starts every `terminal` command in the session's cwd. `work` is this machine's
            # folder, which does not exist in a sandbox, so a remote run passes the guest's own (CUR-4595).
            # operator-configured MCP servers ride new_session; Hermes registers them and adds an
            # `mcp-<name>` toolset per server. Empty means the exact call this line made before MCP existed. (CUR-3025)
            new_session = (conn.new_session(cwd=session_cwd or work, mcp_servers=list(mcp_servers)) if mcp_servers
                           else conn.new_session(cwd=session_cwd or work))
            sess = await asyncio.wait_for(new_session, max(0.0, clock.deadline - loop.time()))
            # ONE deadline for the whole attempt, not one per turn. A repair turn is another `prompt` on
            # the same session, and giving each its own `timeout_secs` would hand an attempt N times the
            # wall clock it was granted — the same denomination error _remaining_timeout was written to
            # fix one level up, and it would be invisible here because each individual turn looks bounded.
            #
            # The deadline lives in an _AttemptClock, not a bare float (CUR-218). A pending request_permission
            # confirmation is a SIBLING task (see _cancel_soon above), not nested inside prompt_task's await
            # chain, so a fixed compute deadline would silently kill a human-confirmation wait. _AttemptClock
            # makes the deadline mutable so request_permission's confirm branch can pause it for exactly as long as
            # the wait actually takes and resume with the identical remaining budget — see _AttemptClock.
            client._clock = clock   # _request_confirmation pauses/resumes this directly — see there
            turn_text, turns_left = prompt, max(0, repair_turns if repair_check else 0)
            while True:
                prompt_task = loop.create_task(
                    conn.prompt(prompt=[acp.text_block(turn_text)], session_id=sess.session_id))
                # The race, worked through explicitly rather than left as a bare wait_for: a watchdog
                # task sleeping against clock.deadline (mutable — request_permission pauses/resumes it)
                # races prompt_task. Whichever end state — the happy path (prompt_task wins), the
                # deadline firing (cancelled just below), or an EXTERNAL cancel via DELETE racing in
                # through _cancel_soon while asyncio.wait was still pending (prompt_task is already
                # done+cancelled by the time we get here) — funnels through the ONE `await prompt_task`
                # below, so there is exactly one exception surface, identical to what wait_for gave us.
                watchdog = loop.create_task(_deadline_watchdog(clock, loop))
                done, _ = await asyncio.wait({prompt_task, watchdog}, return_when=asyncio.FIRST_COMPLETED)
                if watchdog not in done:
                    watchdog.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await watchdog
                if prompt_task not in done:
                    prompt_task.cancel()      # deadline fired — mirrors what wait_for did internally on timeout
                try:
                    resp = await prompt_task
                # A real deadline firing raises CancelledError here, while a wait_for timeout raises
                # TimeoutError, so this except tuple has to catch both; narrowing it to just TimeoutError
                # would drop the deadline case.
                except (TimeoutError, asyncio.CancelledError):
                    try:
                        # tell Hermes to stop before we reap; bounded, since a paused guest never reads it
                        await asyncio.wait_for(conn.cancel(session_id=sess.session_id), _TEARDOWN_SECS)
                    except Exception:  # noqa: BLE001 — best-effort; the CM exit still reaps the child
                        pass
                    if not client.early_exit:  # a real timeout/external-cancel stays an exception for the
                        raise                  # caller's honest-failure path; early-exit falls through clean
                    break
                # The turn ended because the model decided it was done. That decision is not authority —
                # a forced tool choice can make it spend its one required call on `task_complete` and stop
                # with an empty directory. Ask the task's OWN acceptance test instead, and if it disagrees, say so and keep the session.
                #
                # Same session, deliberately. The cross-attempt repair in app.py hands the files to a
                # FRESH agent that has never seen them; this hands them back to the one that wrote them,
                # with its own reasoning still in context. Hermes' HERMES_DONE_VERIFY does the same job
                # one layer down and needs a hand-written `expect_file` to do it, and a gate becomes the spec: the
                # model can write only that file and stop. This one reads the spec that already decides the
                # verdict.
                if client.early_exit or task._canceled:
                    break
                if turns_left <= 0 or clock.deadline - loop.time() <= 0:
                    # Giving up either way (CUR-574) — the repair BUDGET is spent, or the wall clock ran
                    # out — but the turn that just ended has never itself been checked, and it is the turn
                    # that used the last of the budget or time, so it still gets one check.
                    # There is nothing left to retry with, so this does not feed turn_text/turns_left the
                    # way the normal branch below does — it only keeps the verdict, on task.unrun_detail,
                    # for _done_payload to hand the client instead of leaving it to re-derive a second,
                    # drifting copy of this same heuristic from the raw tool_call stream.
                    if repair_check is not None:
                        ok, detail = repair_check(client.text)
                        if not ok:
                            # detail can come from _verify()'s check_cmd, run inside the sandbox — the same
                            # nonce-in-environment exposure app.py's _scrub docstring describes, and every
                            # other consumer of that exact text (last_verify_detail, judge_reason,
                            # attempt_rejections, the repair-turn prompt itself) already scrubs before it
                            # becomes client-visible. This one crosses the _run/_acp_run boundary unscrubbed
                            # without it.
                            task.unrun_detail = _scrub(detail, nonce)
                            # Out of repair turns, the check still disagrees, and this attempt
                            # never once called "edit" — the model's own text at this point is confident
                            # prose with zero real grounding behind it (see repair_exhausted_answer's own
                            # doc). Replace it rather than ship it with only a
                            # caveat flag above it that the client renders separately from this text. (CUR-705)
                            if repair_exhausted_answer is not None and "edit" not in client.tool_kinds:
                                client.text_parts.clear()
                                client.text_parts.append(repair_exhausted_answer)
                # turns_left > 0 is only reachable with both of these set (see its init above), but that
                # is an invariant held in an int, so name the callables directly.
                    break
                if repair_check is None or repair_turn_prompt is None:
                    break
                ok, detail = repair_check(client.text)
                if ok:
                    break
                turns_left -= 1
                turn_text = repair_turn_prompt(detail)
                client.text_parts.clear()      # the final answer is the LAST turn's, not a concatenation
                # Unlike tool_kinds (deliberately cumulative — file state genuinely persists
                # across repair turns, so "something executed" should stay true for the rest of the
                # attempt), a FAILURE is this turn's fact, not the attempt's. Without this, one execute
                # call failing early would keep tripping the failed-tool check on every repair turn after
                # it, even once the model retries and the next turn is fully grounded — burning the whole
                # repair budget on a stale record instead of judging what the turn actually just did. (CUR-574)
                client.tool_failures.clear()
                if buf is not None:
                    buf.emit("repair", {"attempt": attempt, "turns_left": turns_left})
        finally:
            task._acp_cancel = None
            task._acp_confirm = None
            if clock is not None:
                task._confirm_wait_secs = clock.total_paused   # app.py reimburses _RUN_START with this
            stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_task
    stop_reason = "early_exit" if client.early_exit else getattr(resp, "stop_reason", None)
    return client.text, stop_reason, proc.returncode
