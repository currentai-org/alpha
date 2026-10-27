"""
Public AI Agent Service — `POST /run` API.

Instantiates a Hermes agent per task and runs one multi-step task end-to-end.

Design:
  - Two planes: this is Plane B (ephemeral per-task execution); Plane A is whatever
    ~/.hermes/config.yaml points at (HF dev / sovereign launch).
  - Inherited from chat, not rebuilt: the bearer JWT auth + the safety screen.
    Implemented here as PLUGGABLE SEAMS — real validation/endpoints are provided by the chat/
    platform owners; this service consumes them. Dev bypass flags exist but FAIL LOUDLY.
  - Execution interlocks: wall-clock cap, toolset restriction, step-cap, spend-cap, and the
    secrets-at-boundary are all ENFORCED (caps + secrets via the proxy.py gateway). Result success is
    decided by exit code AND a failure-marker scan AND (optionally) an independent verify check —
    Hermes' exit 0 is not trusted on its own.

Run:  HF_TOKEN=… uvicorn app:app   (deps fastapi/uvicorn/httpx/pyjwt — present in the hermes .venv)
"""
from __future__ import annotations

import asyncio
import base64
import csv
import errno
import hashlib
import io
import json
import math
import os
import posixpath
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Literal, TypeVar
from urllib.parse import quote, urlparse

import home_machine
import logsink
import mcp_config
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from remote_work import RemoteWork
from sandbox_backend import BwrapBackend, Handle, SandboxBusy, SandboxError, Tier, key_for
from sandbox_mcp import build_sandbox_server, sandbox_http_app
from store import Store
from xlsx_check import workdir_chart_problems, workdir_reader

# ---- Execution caps (the real, enforceable ones) -------------------------------
HERMES_BIN = os.environ.get("HERMES_BIN", str(Path.home() / "hermes-agent/.venv/bin/hermes"))
WALL_CLOCK_SECS = int(os.environ.get("AGENT_WALL_CLOCK_SECS", "300"))   # hard wall-clock cap (subprocess timeout)
# How long request_permission's confirm branch waits for a human before failing CLOSED (deny), reported
# as confirm_result{reason:"timeout"}. It must fire before Hermes' own permission-bridge timeout (vendored
# hermes-agent, acp_adapter/permissions.py), or Hermes gives up silently and the chat keeps showing "still
# waiting" for a decision already made. A confirmation can open minutes into a run while the chat gives no
# signal that one has, so the window has to allow for someone who isn't watching the tab. The default
# lives here as well as in the deploy config so a deployment that never sets the env var still gets it.
# It stays well inside WALL_CLOCK_TASK_SECS, and silence still denies.
CONFIRM_TIMEOUT_SECS = float(os.environ.get("AGENT_CONFIRM_TIMEOUT_SECS", "180"))
# Keep the per-task scratch dir instead of discarding it. Default OFF, and it must stay off in prod: the
# discard is a retention property, not housekeeping — the dir holds whatever the agent wrote plus raw.log,
# i.e. an invitee's data. It exists for the harness, which runs synthetic fixtures under one synthetic user
# and needs to answer "what did the agent actually produce?" about a failed trial; without it the
# artifacts are gone before anyone can look. prodcheck compares this key and /healthz reports it, so a prod that has it on is
# visible rather than merely unlikely.
KEEP_WORKDIR = os.environ.get("AGENT_KEEP_WORKDIR", "") not in ("", "0")
ALLOWED_TOOLSETS = os.environ.get("AGENT_TOOLSETS", "terminal")          # restricted toolset = alpha tool-surface cap
# ACP transport (streaming-spec §3/§7.1): drive `hermes acp` as an in-app ACP client instead of blocking
# `hermes -z` oneshot, so plan/tool_call/tool_result SSE frames populate live and request_permission becomes
# an observable per-tool-call gate. Default OFF — the proven oneshot path stays default until ACP is soaked.
# The whole ACP module is imported lazily inside _run so flag-off never needs the `acp` package installed.
AGENT_ACP = os.environ.get("AGENT_ACP", "") == "1"
# ACP tool-permission policy, one of:
#   allow        no policy refusal; edit/delete/execute calls still go to a human (_ALWAYS_CONFIRM_KINDS).
#   deny_writes  file edits are refused (see below for exactly which).
#   staged       deny_writes for a new caller, allow once it has a history (_permission_decision).
#
# deny_writes covers `write_file` and `patch(mode=replace)`, and nothing else. Hermes asks the client for
# permission from `maybe_require_edit_approval`, which builds a proposal only for those two tools
# (acp_adapter/edit_approval.py) — so a `terminal` call is never offered to this gate, and
# `echo pwned > b.txt` under deny_writes writes the file. The same holds inside `execute_code`'s RPC.
#
# So deny_writes is a per-EDIT approval mechanism built for an interactive editor, where a human reviews a
# diff. It is not write containment, and setting it beside a toolset carrying `terminal` produces a config
# that reads as containment and is not — which _permission_state below refuses to let pass quietly.
# What DOES contain writes here is bwrap: only the per-task scratch is writable, whatever the tool.
ACP_PERMISSION_POLICY = os.environ.get("ACP_PERMISSION_POLICY", "allow")
# The tools the EDIT-approval gate (maybe_require_edit_approval) is consulted for. Execute-kind calls
# have a separate gate of their own (_ALWAYS_CONFIRM_KINDS below); this tuple is edit-approval's coverage only.
_PERMISSION_COVERS = ("write_file", "patch")
# Tools EXCLUDED from the toolset entirely under deny_writes (_deny_writes_toolsets below) — a floor, not
# a per-call gate. `code_execution` is here because its RPC allowlist (SANDBOX_ALLOWED_TOOLS) includes
# `terminal`, so admitting it re-admits the shell by another door. Under "allow", `terminal` and
# `code_execution` do reach the execute-approval confirm, so this tuple does not mean "never confirmed";
# it means "not offered to the model at all under deny_writes."
_PERMISSION_UNCOVERED = ("terminal", "code_execution")
# The ACP ToolKind values that _AgentClient.request_permission (acp_client.py)
# always routes to a human confirm, regardless of resolved policy (deny_writes excepted — see that
# function). Kept as a byte-identical duplicate of acp_client._ALWAYS_CONFIRM_KINDS rather than imported:
# app.py must stay importable with AGENT_ACP off and the `acp` package absent (acp_client.py imports `acp`
# at module level), the same reason _scrub is hand-duplicated between the two files instead of shared.
# Used here only for observability strings (_permission_state) — not consulted for any actual gating
# decision, which lives solely in acp_client.py.
_ALWAYS_CONFIRM_KINDS = ("edit", "delete", "execute")
# Hermes's own unrestricted default when HERMES_ACP_TOOLSETS is unset (no `platform_toolsets.acp` in the
# attempt config.yaml, so upstream falls back to `hermes-acp`) — 13 toolsets at v2026.9.24, including both names in _PERMISSION_UNCOVERED. There is nothing to
# subtract a tool name FROM here, so deny_writes needs an explicit safe list instead of a filtered empty
# string (an empty HERMES_ACP_TOOLSETS is not "no tools", it is "Hermes picks its own unrestricted default").
_DENY_WRITES_DEFAULT = "file,todo"


def _deny_writes_toolsets(base: str) -> str:
    """The toolset to actually hand the `hermes acp` subprocess under ACP_PERMISSION_POLICY=deny_writes.

    deny_writes is consulted for write_file/patch only (_PERMISSION_COVERS above; CUR-217). Calls to
    `terminal`/`code_execution` reach a callback only at kind="execute" (the execute-approval patch,
    CUR-975), so deny_writes has no per-call callback to deny from for them: toolset exclusion is the
    floor, not the per-call pause.

    What IS in our control is which tools Hermes is told exist at all: `hermes acp` reads
    `platform_toolsets.acp` from its config.yaml at session-creation time, and acp_client's
    `_write_acp_toolsets` writes that block per attempt from the HERMES_ACP_TOOLSETS that _model_env
    assembles fresh (CUR-2118). So under deny_writes, don't rely on the per-call execute-approval pause either —
    don't hand `terminal`/`code_execution` to the model in the first place. This makes deny_writes an
    enforceable read-only mode, which is a guarantee we can actually keep, instead of a per-op gate a
    shell redirect (or, now, a confirm a human could still approve) defeats."""
    base = base.strip()
    if not base:
        return _DENY_WRITES_DEFAULT
    kept = [t for t in (p.strip() for p in base.split(",")) if t and t not in _PERMISSION_UNCOVERED]
    return ",".join(kept) or _DENY_WRITES_DEFAULT


# ACP_PERMISSION_POLICY="staged": deny_writes at first contact, allow once a caller has a history, so a
# fresh pseudonymous credential doesn't start with the same posture as one with days of clean use behind
# it. Trust is time-based only: session age and task volume, both derived from the tasks table
# (store.caller_history), so it adds no privacy-sensitive state. It does not use moderation signal,
# because moderate() deliberately never records which principal triggered a block.
TRUST_ACCRUAL_SECS = int(os.environ.get("AGENT_TRUST_ACCRUAL_SECS", str(3 * 24 * 3600)))  # 3 days
TRUST_MIN_TASKS = int(os.environ.get("AGENT_TRUST_MIN_TASKS", "3"))


def _is_trusted(user: str, hist: dict | None = None) -> bool:
    """Time-based only (see the "staged" comment above for why "no abuse flags" isn't in this yet).

    `hist` lets a caller that already has a fresh store.caller_history result (CUR-471:
    _permission_decision) hand it over instead of triggering a second identical query — optional,
    defaults to fetching fresh, so every existing one-argument call site is unaffected."""
    hist = hist if hist is not None else store.caller_history(_caller_of(user))
    if not hist["first_seen"]:
        return False
    return (time.time() - hist["first_seen"] >= TRUST_ACCRUAL_SECS
            and hist["task_count"] >= TRUST_MIN_TASKS)


def _permission_decision(user: str) -> dict:
    """CUR-471: everything a caller might need to know about why, not just the bare policy string —
    _resolve_permission_policy below is the bare string, kept for callers that only need that.
    Always returns this shape, including under allow/deny_writes, so a consumer (the model-facing
    note, the SSE event) never has to branch on whether the fields exist."""
    if ACP_PERMISSION_POLICY != "staged":
        return {"policy": ACP_PERMISSION_POLICY, "tier": "uniform",
                 "tasks_done": None, "tasks_required": None}
    hist = store.caller_history(_caller_of(user))
    trusted = _is_trusted(user, hist)
    return {"policy": "allow" if trusted else "deny_writes",
            "tier": "trusted" if trusted else "new",
            "tasks_done": hist["task_count"], "tasks_required": TRUST_MIN_TASKS}


def _resolve_permission_policy(user: str) -> str:
    """ACP_PERMISSION_POLICY verbatim for its two existing values (allow/deny_writes — byte-identical to
    before this function existed, _is_trusted is never even called for them). "staged" is the new third
    value: resolved per-principal instead of applied uniformly to every caller."""
    return _permission_decision(user)["policy"]
# Early-exit on verified artifact (ACP transport only — oneshot's `-z` redirects stdout to devnull until
# the process exits naturally, so killing it early would always blank the result).
# Only engages when a verify spec is present: there's no early-exit signal for open-ended chat. Debounced
# in acp_client._EarlyExitDebounce (2 consecutive passing checks) so a single incidental match — e.g. the
# agent's own "write then read back" step — can't cut a task short. Default OFF until soaked.
EARLY_EXIT = os.environ.get("AGENT_EARLY_EXIT", "") == "1"
AGENT_MODEL = os.environ.get("AGENT_MODEL", "")                          # model id passed to hermes -m (container/Fly have no ~/.hermes/config.yaml)
AGENT_MODEL_PROVIDER = os.environ.get("AGENT_MODEL_PROVIDER", "")        # hermes --provider (e.g. huggingface) — the WIRE FORMAT, not the compute host
# The image bakes AGENT_MODEL_REQUIRED=1 and no model, so a deploy surface that forgets AGENT_MODEL refuses
# to boot instead of running (and badging) a model the proxy may not serve. Local dev leaves the flag unset
# and keeps the ~/.hermes/config fallback.
if os.environ.get("AGENT_MODEL_REQUIRED", "") == "1" and not AGENT_MODEL:
    raise RuntimeError("AGENT_MODEL is unset and AGENT_MODEL_REQUIRED=1: refusing to start rather than run "
                       "an unnamed model. Set it to what the proxy serves.")
# Human-facing COMPUTE provenance (the badge: "<model> — <provider> — Running on <X>, <country>"). This is
# the sovereign compute host (e.g. "Infomaniak"), distinct from AGENT_MODEL_PROVIDER (wire format). It MUST
# reflect where the model actually runs. Surfaced in /healthz + the run status.
#
# This static value is a configured intent, not a measurement, and can drift from where traffic actually
# goes. _effective_compute_provider() below is the actual badge source: it prefers a LIVE reading polled
# from the proxy's own /healthz
# (which sees every real call via proxy._record_backend), falling back to this static value only before
# the first successful poll or when the gateway is off. Kept as the fallback rather than removed, since
# it is still the honest answer in legacy/no-gateway mode (see proxy._load_providers' single-upstream
# fallback, which names the provider after this exact env var).
AGENT_COMPUTE_PROVIDER = os.environ.get("AGENT_COMPUTE_PROVIDER", "")
COMPUTE_PROVIDER_REFRESH_SECS = int(os.environ.get("AGENT_COMPUTE_PROVIDER_REFRESH_SECS", "30"))
# Fly sets this per-machine, unset off Fly (local dev, tests). CUR-895: task state (TASKS dict + the
# SQLite mirror at DB_PATH) lives on whichever machine ran the task, and a multi-machine deploy has no
# session affinity by default — a poll/stream/confirm/cancel call for the same task_id can land on a
# machine that never saw it and 404. Echoed on /run + every status response so a caller can pin its
# OWN follow-up requests to this machine via the `Fly-Force-Instance-Id` header, which Fly's edge proxy
# reads before the request ever reaches this process — nothing here needs to interpret that header.
FLY_MACHINE_ID = os.environ.get("FLY_MACHINE_ID")
# Contract version for the chat↔agent boundary (the /run schema + state enum + this response shape). Bump on
# any breaking change so a consumer (aipotluck.org/web) can detect drift via /healthz.
API_VERSION = 1
# The commit this image was built from (deploy/Dockerfile's GIT_SHA build arg). API_VERSION above says what
# the CONTRACT is; this says what the CODE is, and the two answer different questions — the contract holds
# across every commit that doesn't break it, so it cannot tell you whether a deployed image predates a fix.
# Reported as "unknown" when unset, never omitted: a missing key reads as "old service" and an absent value
# reads as "nobody passed the build arg", and only the second is actionable.
BUILD_SHA = os.environ.get("AGENT_BUILD_SHA", "").strip()
# Best-of-N: run up to N independent Hermes attempts and accept the first whose side-effects _verify (each
# attempt is self-grounded, so this is a reliability MULTIPLIER, not a fabrication risk). Per-run success
# is about 0.83, with genuine false-completions (the model prints "Task completed", exits 0, but the
# deliverable was never written); independent _verify of the artifact catches that and best-of-3 lifts it
# to about 0.995 (scripts: verify_lever.py). Only engages when the task carries a verify spec (explicit or auto-derived —
# you can't pick a winner you can't check). Default 1 = off (single attempt).
BEST_OF = max(1, int(os.environ.get("AGENT_BEST_OF", "1")))
# CUR-596 item 2: self-consistency over independently-sampled generations (Wang et al.), applied to a
# deterministic computed VALUE instead of a free-text answer. OFF by default — this changes best-of-N's
# accept-first-success loop into accept-all-verified-then-vote whenever it engages, which is a real,
# permanent cost increase (up to `best_of` attempts, not the usual "stop at the first pass") on every
# spec'd best-of-N turn once flipped on. Deliberately reuses the EXISTING best_of budget rather than
# adding a new spend dimension — see _consistency_eligible/_majority_disagreement in the run loop.
VALUE_CONSISTENCY_CHECK = os.environ.get("AGENT_VALUE_CONSISTENCY_CHECK", "") == "1"
# Token grant for the pre-loop auto-derive call (its own minimal grant: under per-attempt grants no run-grant
# is live before the loop, so the derive POST would 401 without this — see _run).
DERIVE_MAX_TOKENS = int(os.environ.get("AGENT_DERIVE_MAX_TOKENS", "200"))
VERIFY_TIMEOUT_SECS = int(os.environ.get("AGENT_VERIFY_TIMEOUT_SECS", "30"))  # cap on the post-run verification check
# Auto-derive a verify spec for free-form chat tasks (default ON). Best-of-N above can only engage with a
# verify spec ("you can't pick a winner you can't check"), but a chat turn (synthesize=true) arrives WITHOUT
# one — so it falls to a single ~88% attempt. When this is on AND we're in the best-of-N-capable config, a
# cheap model call derives a DECLARATIVE spec (expect_file [+ expect_contains]) from the prompt before the
# attempt loop, so best-of-N re-engages for chat (~88% -> ~99.8% on a checkable task). It NEVER derives
# check_cmd — a model-emitted server-side shell command from an untrusted prompt is an injection surface;
# the declarative path can only stat a file + substring-check. A prompt with no checkable artifact (pure
# conversation) derives nothing -> single attempt. See _derive_verify_spec.
AUTODERIVE_VERIFY = os.environ.get("AGENT_AUTODERIVE_VERIFY", "1") == "1"
# LLM-judge verification (chat turns). When a chat turn has no execution-grounded file-spec to check (the
# common case — most prompts don't name an output file), an independent model call judges whether the
# result actually satisfies the task: {"pass": bool, "reason": ...}. This is the safety net that closes the
# false-success hole (a wrong answer completing "unverified"), and it gates best-of-N so a rejected attempt
# RETRIES instead of shipping. Generation is harder than verification — leaning on a verifier is the lever.
JUDGE_VERIFY = os.environ.get("AGENT_JUDGE_VERIFY", "1") != "0"
# Fusion seam: the model that JUDGES (not executes). Default "" → self-judge with AGENT_MODEL. Set to a
# stronger / more diverse model (e.g. GLM-5.2) once its endpoint is wired into the gateway's multi-provider
# router → executor + a decorrelated VERIFIER, the robustness-via-fusion pattern, with no code change. The
# judge call routes through the same gateway/nonce.
VERIFIER_MODEL = os.environ.get("AGENT_VERIFIER_MODEL", "").strip() or None
# Judge response budget. A REASONING verifier (e.g. GLM-5.2) spends tokens thinking before it emits the
# verdict JSON in `content` — too low a cap and content comes back empty. 1500 lets reasoning finish; a
# non-reasoning self-judge just stops early, so it's safe as the default for both.
JUDGE_MAX_TOKENS = int(os.environ.get("AGENT_JUDGE_MAX_TOKENS", "1500"))
# How long one judge call may take before it is cut. The proxy's FIRST_TOKEN_TIMEOUT only guards STREAMED
# calls and the judge call is not streamed, so nothing upstream cuts a stalled judge; this is the
# tripwire. The judge fires once per attempt, so at 90s BEST_OF=3 could spend 270s on judging alone
# against the chat side's 155s agent-generation ceiling.
#
# 20s from the budget, not from taste. A whole task must fit in that 155s. Whole turns
# run 30-34s each END TO END including their judge call, so three attempts is ~90s
# of agent work and leaves ~65s for judging: 3 x 20s fits with room, 3 x 90s never could.
#
# Deliberately ~7x the observed median rather than snug to it. Judge latency runs 1.4-3.2s per call, so 20s
# is far outside the normal spread. It has to be, because `_judge_result` fails CLOSED: a timeout is a REJECTION, and a
# rejection costs a whole extra agent attempt (~13k tokens, ~30s) — much more than waiting out a slow
# judge. The cut is aimed at the pathological call, not the merely slow one. A call that takes over a minute
# under burst load gets cut, which is the intent.
JUDGE_TIMEOUT_SECS = float(os.environ.get("AGENT_JUDGE_TIMEOUT_SECS", "20"))
# Bytes of a spec'd expect_file's content shown to the judge, so it can check a computed value against
# the file itself rather than the answer's description of it. 0 disables excerpting entirely (a kill
# switch that needs no deploy if excerpts cause over-rejection). NOTE ON COST: this is reused nowhere else, but JUDGE_MAX_TOKENS above is sometimes read as "roughly
# what a judge call costs" — once a multi-KB excerpt joins the input, the call's TRUE total_tokens spend
# (prompt+completion; the gateway's spend-cap meters total_tokens, see api/proxy.py) genuinely exceeds that
# number, even though nothing breaks. Don't use JUDGE_MAX_TOKENS x call-count as a judge-spend estimate once
# excerpting is on.
JUDGE_EXCERPT_BYTES = int(os.environ.get("AGENT_JUDGE_EXCERPT_BYTES", "4000"))

# ---- Execution sandbox (filesystem, egress and DNS containment) ----------------------------------------
# The agent runs `terminal` + --yolo on the host. The gateway already removed the model TOKEN from its
# reach; this restricts the FILESYSTEM it can read (no $HOME → no ssh keys / cloud creds / other projects /
# real .hermes), shrinking the data it could exfil. Pluggable:
#   off    — no sandbox (dev default; healthz warns)
#   bwrap  — bubblewrap: read-only host, $HOME+/tmp hidden (tmpfs), only the scratch dir writable
#   custom — operator supplies a wrapper command in AGENT_SANDBOX_ARGS (e.g. firejail/nsjail/netns launcher)
#
# NETWORK is the second part. bwrap alone leaves the agent full outbound access, which on a service with
# open signup makes it an open proxy. deploy/entrypoint.sh installs default-deny nftables as root before
# privileges drop (a Kubernetes NetworkPolicy would not apply to a single machine). `_egress_state` below
# re-checks the filter from inside the running process, because a config value saying "filtered" only
# states what was asked for.
#
# NAMES are the third. An address allowlist bounds where packets may GO and says nothing about which names
# may be looked up, and Fly's resolver sits inside the 6PN range the chain allows wholesale, so a payload
# in a QNAME (or a `TXT _apps.internal` lookup listing the org's apps) passes the address filter.
# AGENT_DNS=hosts refuses :53 to every uid but root; _probe_dns re-checks it the same way.
SANDBOX = os.environ.get("AGENT_SANDBOX", "off")
SANDBOX_ARGS = os.environ.get("AGENT_SANDBOX_ARGS", "")
SANDBOX_REQUIRED = os.environ.get("AGENT_SANDBOX_REQUIRED", "") == "1"   # fail-closed: refuse to run unsandboxed
# Resource limits, a separate control from the namespacing above. See _rlimit_prefix for why RLIMIT_AS is
# not among these and why NPROC is not tight.
RLIMIT_ENABLED = os.environ.get("AGENT_RLIMITS", "1") != "0"
RLIMIT_NPROC = int(os.environ.get("AGENT_RLIMIT_NPROC", "512"))          # tasks per UID — SHARED with the app
RLIMIT_FSIZE = int(os.environ.get("AGENT_RLIMIT_FSIZE", "268435456"))    # 256MB, per file
TMPFS_BYTES = int(os.environ.get("AGENT_TMPFS_BYTES", "67108864"))       # 64MB per masking mount
# The syscall filter bwrap loads (CUR-4478), built into the image by deploy/seccomp/gen.c: EPERM for the
# calls unprivileged kernel exploits start from. Missing is a refusal when the sandbox is required, and
# otherwise (a dev box without the build) a sandbox with no filter, reported as such on /healthz.
SECCOMP_PATH = os.environ.get("AGENT_SECCOMP_PATH", "/etc/agent-sandbox/seccomp.bpf")
# The sum, which RLIMIT_FSIZE does not bound — it caps ONE file, so a loop writing small ones was still a
# way to fill the root filesystem from a prompt. Per TASK, so with MAX_CONCURRENCY=8 the aggregate worst
# case is 2GB against a 7.4GB disk and no single task can starve the others. 0 disables the watchdog.
SCRATCH_MAX_BYTES = int(os.environ.get("AGENT_SCRATCH_MAX_BYTES", "268435456"))   # 256MB per task
SCRATCH_POLL_SECS = float(os.environ.get("AGENT_SCRATCH_POLL_SECS", "2"))
# Where per-task scratch lives. Empty → tempfile's own choice, which is $TMPDIR then /tmp.
#
# This is a knob and not just /tmp: in the Fly container /tmp is ordinary disk, but on a dev box it can be
# tmpfs, whose pages are anonymous, so a 256MB-per-task scratch is 256MB of RAM the kernel cannot drop, only
# push to swap. Abandoned `agent-run-*` directories from runs whose cleanup never ran (see
# _sweep_stale_scratch) hold that RAM. Pointing this at a real filesystem costs disk instead.
SCRATCH_ROOT = os.environ.get("AGENT_SCRATCH_ROOT", "").strip() or None
# How long an `agent-run-*` directory has to be untouched before boot treats it as abandoned. Longer than
# any run can legally last (AGENT_WALL_CLOCK_SECS is 300), so a sweep can never race a live task.
SCRATCH_STALE_SECS = float(os.environ.get("AGENT_SCRATCH_STALE_SECS", "7200"))
EGRESS = os.environ.get("AGENT_EGRESS", "off")                          # what entrypoint.sh was ASKED to do
EGRESS_PROBE = os.environ.get("AGENT_EGRESS_PROBE", "1.1.1.1:443")      # a reachable address outside the allowlist
# The name half of the same control. The connect allowlist bounds which ADDRESSES may be dialled and says
# nothing about which NAMES may be looked up — and a lookup is itself a channel, since the query text is
# attacker-chosen and travels to whichever authoritative server the recursion lands on, and
# `TXT _apps.internal` lists every app in the org. entrypoint.sh closes it by refusing :53 to every uid
# but root and serving the service's own names from /etc/hosts.
DNS = os.environ.get("AGENT_DNS", "off")                                # off | hosts
DNS_PROBE = os.environ.get("AGENT_DNS_PROBE", "dns.google")             # a name that must NOT be in /etc/hosts

# Model-boundary gateway (proxy.py): the one owned chokepoint for secrets and step/spend caps.
# Why a gateway and not Hermes' own knob: the `hermes -z` one-shot path ignores config `max_turns` (no CLI
# flag; config only feeds the TUI/cron paths), so the iteration cap is unreachable from our invocation. Routing model calls through proxy.py gives us a step-cap (request count), a spend-cap
# (usage tokens), AND the secrets boundary (agent gets a per-task nonce, never the real token) in one place.
MODEL_PROXY_URL = os.environ.get("AGENT_MODEL_PROXY_URL", "").rstrip("/")     # unset → legacy passthrough (boundary OFF)
# An unset URL turns the boundary off, so a deploy that dropped it would run with the real model token in the
# agent's env, visible only in /healthz. The image bakes AGENT_MODEL_PROXY_REQUIRED=1 (like
# AGENT_MODEL_REQUIRED above) so that deploy refuses to boot; local dev and the offline tests leave it unset
# and keep the passthrough (CUR-3199).
if os.environ.get("AGENT_MODEL_PROXY_REQUIRED", "") == "1" and not MODEL_PROXY_URL:
    raise RuntimeError("AGENT_MODEL_PROXY_URL is unset and AGENT_MODEL_PROXY_REQUIRED=1: refusing to start "
                       "with the secrets boundary off. Point it at the proxy app.")
PROXY_ADMIN_KEY = os.environ.get("PROXY_ADMIN_KEY", "")                       # shared with proxy.py to grant/revoke nonces
# Where Hermes and the run-code tools run. `e2b` (the default, and what every Fly deploy runs) is the
# conversation's own microVM on our E2B install (sandbox_e2b.py), which never sees one of our credentials. An E2B
# guest is not on Fly's private network, so it reaches the gateway on its public nonce-only port. `bwrap` is a
# child of this process, kept for local stacks and the test suite, which set it explicitly. Under e2b the bwrap
# profile knobs (AGENT_SANDBOX, AGENT_SANDBOX_REQUIRED, AGENT_RLIMIT*, AGENT_TMPFS_BYTES, the seccomp filter)
# configure nothing: no agent process runs on this machine.
AGENT_SANDBOX_BACKEND = os.environ.get("AGENT_SANDBOX_BACKEND", "e2b").strip().lower()
AGENT_GATEWAY_PUBLIC_URL = os.environ.get("AGENT_GATEWAY_PUBLIC_URL", "").rstrip("/")
E2B_API_URL = os.environ.get("E2B_API_URL", "")
E2B_SANDBOX_URL = os.environ.get("E2B_SANDBOX_URL", "")
E2B_TEMPLATE = os.environ.get("E2B_TEMPLATE", "")  # empty takes E2BConfig.template, the one default
E2B_SLOTS = int(os.environ.get("E2B_SLOTS", "1") or "1")  # hosts the E2B link fronts; ports move 100 per slot (CUR-4529)
# Slots taken out by hand, e.g. "2": a dead host stops blocking finds once named here (one secret set, one restart).
E2B_SLOTS_OFF = frozenset(int(s) for s in os.environ.get("E2B_SLOTS_OFF", "").replace(",", " ").split())
# A host that has failed every ask for this long stops blocking finds until it answers again (CUR-4592); 0 never.
E2B_SLOT_AUTO_OFF_SECS = int(os.environ.get("E2B_SLOT_AUTO_OFF_SECS", "300") or 0)
# Run-code sandboxes one account may have running at once (CUR-4553), across every host; 0 is no cap. Agent mode has
# its own per-account limit (AGENT_SUBJECT_MAX_CONCURRENCY). Code defaults, so a deployed local toml needs no line.
E2B_ACCOUNT_MAX_LIVE = int(os.environ.get("E2B_ACCOUNT_MAX_LIVE", "2") or 0)
# Running sandboxes one E2B host holds before it is full; the pool gauge's alert compares against it, 0 = not named.
E2B_SLOT_CAPACITY = int(os.environ.get("E2B_SLOT_CAPACITY", "0") or 0)
# How long a new sandbox waits for a slot on a full host before "the sandbox host is full" (CUR-4584); 0 refuses at
# once. Under chat's 155 s agent window and inside the room a run-code turn's deadline keeps for waits.
E2B_BUSY_WAIT_SECS = float(os.environ.get("E2B_BUSY_WAIT_SECS", "60") or 0)
# Seconds without a call before a run-code sandbox pauses and gives its memory back to the host. Chat's live window
# (`liveIdleMinutes`, web/config/sandboxTiers.ts) is the same number in minutes; change both together.
E2B_RUN_CODE_IDLE_SECS = int(os.environ.get("E2B_RUN_CODE_IDLE_SECS", "120") or 120)
# Worker threads for sync endpoints and the sandbox MCP's tool calls, which block on the E2B host for up to the run
# timeout each. anyio's default is 40 for the whole process, so the 41st call in flight waited for a thread while the
# 56-slot host had room, and /healthz, a sync endpoint, waited behind them.
THREADPOOL_TOKENS = int(os.environ.get("AGENT_THREADPOOL_TOKENS", "128") or 128)
SANDBOX_POOL_SECS = int(os.environ.get("AGENT_SANDBOX_POOL_SECS", "60"))
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "90"))                      # step-cap: model calls per task (gateway-enforced)
MAX_TOKENS_BUDGET = int(os.environ.get("AGENT_MAX_TOKENS", "0"))             # spend-cap: tokens per task, 0 = off (gateway-enforced)
MAX_TASKS = int(os.environ.get("AGENT_MAX_TASKS", "1000"))                   # cap the in-memory task table (evict oldest terminal)
MAX_PROMPT_CHARS = int(os.environ.get("AGENT_MAX_PROMPT_CHARS", "100000"))   # reject oversized prompts (cheap DoS guard)
RESULT_MAX_CHARS = int(os.environ.get("AGENT_RESULT_MAX_CHARS", "8000"))     # status `result` size; truncation is flagged
# Artifact delivery (CUR-195). The agent's files live in a sandbox that is deleted the instant the turn
# ends, while the answer tells the user where to find them, so these three caps bound what comes back.
# A file over a cap is still LISTED with its true size: dropping it entirely would leave the answer
# pointing at a file the user cannot find.
ARTIFACT_MAX_FILES = int(os.environ.get("AGENT_ARTIFACT_MAX_FILES", "20"))       # files listed per turn (0 = feature off)
ARTIFACT_MAX_BYTES = int(os.environ.get("AGENT_ARTIFACT_MAX_BYTES", "65536"))    # per-file inlined text
ARTIFACT_TOTAL_BYTES = int(os.environ.get("AGENT_ARTIFACT_TOTAL_BYTES", "262144"))  # inlined text across the turn
# The actual download, not the inline preview above — deliberately a separate cap. A file made
# after ARTIFACT_MAX_FILES's count cap, or larger than ARTIFACT_MAX_BYTES's preview cap, still exists on
# disk and is still fetchable by exact name; only this cap governs whether GET .../artifacts/{filename}
# will serve it whole. Doubles as the per-file cap `_artifact_text_for_moderation` reads up to — a file
# bigger than this can never actually reach a caller through the download route either, so moderating past
# it would screen content nobody can receive. 4MB, not 64MB: this text goes through a moderation call on
# every completed turn, and a classifier pass over 64MB of text per artifact isn't a realistic op — this
# is the ceiling a "text/data files" turn (this ticket's own stated scope) comfortably fits under, and it
# also bounds worst-case memory: 40 concurrent downloads (anyio's default sync-route thread pool size) at
# this cap is 160MB, not 2.56GB. (CUR-546)
ARTIFACT_DOWNLOAD_MAX_BYTES = int(os.environ.get("AGENT_ARTIFACT_DOWNLOAD_MAX_BYTES", "4194304"))  # 4MB
# Where an artifacts-stage moderation block moves the blocked file (CUR-836). Left in `work` it would stay
# fetchable by GET .../artifacts/{filename} (that route never checks moderation status), and stay there for
# _artifact_text_for_moderation to re-read and re-block on every later turn in the same session (CUR-196
# workdir persistence) until the 4h idle reaper cleared it. A top-level dir excluded from
# `_artifact_paths`'s walk and `_resolve_artifact_path`'s resolution, same pattern as "hermes-home*" below.
ARTIFACT_QUARANTINE_DIRNAME = "agent-quarantine"
VERIFY_DETAIL_CHARS = int(os.environ.get("AGENT_VERIFY_DETAIL_CHARS", "400"))  # check_cmd output kept in the failure reason
REPAIR_LOOP = os.environ.get("AGENT_REPAIR_LOOP", "1") != "0"                # retry attempts REPAIR the last one instead of restarting
REPAIR_TURNS = int(os.environ.get("AGENT_REPAIR_TURNS", "2"))                # in-session repair turns per attempt (ACP only; 0 = off)
SHOW_CHECK = os.environ.get("AGENT_SHOW_CHECK", "1") != "0"                  # show a CALLER-SUPPLIED acceptance test to the agent
CHECK_APPENDIX_CHARS = int(os.environ.get("AGENT_CHECK_APPENDIX_CHARS", "6000"))  # cap on the shown check
REPAIR_DETAIL_CHARS = int(os.environ.get("AGENT_REPAIR_DETAIL_CHARS", "1200"))  # check output handed back to the agent
MAX_CONCURRENCY = int(os.environ.get("AGENT_MAX_CONCURRENCY", "8"))          # cap CONCURRENT in-flight runs (live procs + aggregate spend) — distinct from MAX_TASKS (table size)
CHECK_CMD_DISABLED = os.environ.get("AGENT_CHECK_CMD_DISABLED", "") == "1"   # hardened deploys: forbid verify.check_cmd (server-side shell)
DB_PATH = os.environ.get("AGENT_DB_PATH", str(Path.home() / ".agent-service" / "tasks.db"))  # durable task store (sqlite); per-user spend ledger lives here

# ---- Daily quotas + rate limits (multi-tenant guard, summed from the durable store) -------------------
# The per-task caps don't bound what one CALLER can spend across MANY tasks; these do, summed from the store.
#
# These are named AGENT_CALLER_DAILY_* because the bucket key is the authenticated token subject, not a
# user. Chat holds ONE static service token for every visitor: endpointAgent.ts builds its
# Authorization header once at endpoint construction from AGENT_SERVICE_TOKEN, and the per-request closure
# receives `{messages, abortSignal}` — no user, nowhere to get one, since the app has no accounts. So on the
# only path real people use, a "per user" limit would be one limit for the whole chat surface, and the 429
# would land on whoever asks last rather than on whoever spent it. The old AGENT_USER_DAILY_* names are
# still read (see _renamed_int).
def _renamed_int(new: str, old: str, default: str = "0") -> tuple[int, str]:
    """An int env var that has been renamed. Returns (value, the name it was actually read from).

    The old name is still honoured because dropping it makes the rename a SILENT FAIL-OPEN: any config not
    updated in the same commit sets neither name, `.get(default="0")` returns 0, and 0 means OFF for every
    quota below — the control disappears with no error anywhere. /healthz reports which spelling was read, so
    prodcheck can see "still on the deprecated name" instead of "quota quietly stopped existing"."""
    for name in (new, old):
        if name in os.environ:
            return int(os.environ[name] or default), name
    return int(default), ""


CALLER_DAILY_TOKENS, CALLER_TOKENS_VAR = _renamed_int("AGENT_CALLER_DAILY_TOKENS", "AGENT_USER_DAILY_TOKENS")
CALLER_DAILY_TASKS, CALLER_TASKS_VAR = _renamed_int("AGENT_CALLER_DAILY_TASKS", "AGENT_USER_DAILY_TASKS")
# A caller MAY name a subject within its own namespace (X-Agent-Subject) — a chat session id, say. Two jobs,
# in this order of importance:
#   1. ATTRIBUTION. It turns "1 principal, 8 turns" into "7 visitors, 8 turns" in the log sink without the
#      app needing user accounts.
#   2. Fairness. One visitor stops being able to spend the whole surface's allowance.
# It is NOT an authorization boundary and must never be read as one: it is self-asserted, so a visitor who
# clears their cookie gets a new subject and a fresh allowance. Acceptable for a courtesy quota, and the
# reason the CALLER ceiling above is still checked — rotating subjects cannot buy more than the caller's own
# total. Same posture as chat's `?ph_test=<name>`: targeting, not authentication.
SUBJECT_DAILY_TASKS = int(os.environ.get("AGENT_SUBJECT_DAILY_TASKS", "0"))  # per-visitor 24h task count, 0 = off
# The daily allowance bounds how MANY tasks a visitor starts, not how many run at once, so one
# visitor with a few tabs could hold every one of MAX_CONCURRENCY's slots and leave everyone else a
# capacity 429. Checked and reserved in one step under _USER_LOCK, since a separate check would let a
# burst of submits all pass it before any reserved. Same subject-only rule as the allowance above.
# On by default: the deployed config is a gitignored local toml (with-tracked-vm.sh carries only named
# lines from the template), so a default of off would ship off. (CUR-2194)
SUBJECT_MAX_CONCURRENCY = int(os.environ.get("AGENT_SUBJECT_MAX_CONCURRENCY", "2"))  # per-visitor live runs, 0 = off
SUBJECT_MAX_CHARS = int(os.environ.get("AGENT_SUBJECT_MAX_CHARS", "64"))     # bounded: it is a store key and a task owner
RATE_WINDOW_SECS = int(os.environ.get("AGENT_RATE_WINDOW_SECS", "86400"))    # the rolling window every limit uses
# Subs whose traffic is ours, not an invitee's: smoke checks, health probes, measurement runs. They skip the
# rolling-window count and nothing else — a runaway on an exempt sub is still stopped by AGENT_MAX_TOKENS,
# AGENT_MAX_CONCURRENCY and AGENT_WALL_CLOCK_SECS. Empty (the default) means nobody is exempt.
OPERATOR_SUBS = frozenset(s.strip() for s in os.environ.get("AGENT_OPERATOR_SUBS", "").split(",") if s.strip())
# Seconds a caller refused for a full slot waits before resubmitting. Tasks run about 30 s at the median
# (CUR-3893's Axiom read), so with many slots one usually frees within a few seconds.
CAPACITY_RETRY_AFTER_SECS = int(os.environ.get("AGENT_CAPACITY_RETRY_AFTER_SECS", "5"))
TASK_RETENTION_SECS = int(os.environ.get("AGENT_TASK_RETENTION_SECS", "2592000"))  # prune terminal rows older than this (30d; 0=keep forever)
RETENTION_SWEEP_SECS = int(os.environ.get("AGENT_RETENTION_SWEEP_SECS", "3600"))   # how often the background pruner runs
# Corpus retention (CUR-596, CUR-654): separate from TASK_RETENTION_SECS and longer by default — this is a training corpus
# meant to accumulate real examples over time, not an operational spend ledger. Tier 1 catches log on
# every real caller (independent of AGENT_VALUE_CONSISTENCY_CHECK), so this table grows from live
# traffic and needs a retention of its own, not just a slower one than the tasks table's.
CORPUS_RETENTION_SECS = int(os.environ.get("AGENT_CORPUS_RETENTION_SECS", "7776000"))  # 90d; 0=keep forever
# session-scoped workdirs. Hours, not TASK_RETENTION_SECS's 30 days — that's a spend-ledger
# window, this is a disk-budget one, and disk is the real constraint on a single Fly volume. (CUR-196)
SESSION_IDLE_SECS = int(os.environ.get("AGENT_SESSION_IDLE_SECS", "14400"))          # 4h idle -> reaped
SESSION_SWEEP_SECS = int(os.environ.get("AGENT_SESSION_SWEEP_SECS", "900"))          # 15m — tighter than the 30d pruner's hourly cadence
SESSION_SCRATCH_MAX_BYTES = int(os.environ.get("AGENT_SESSION_SCRATCH_MAX_BYTES", "536870912"))  # 512MB/session total, vs SCRATCH_MAX_BYTES's per-turn cap
WEBHOOK_ALLOW_PRIVATE = os.environ.get("AGENT_WEBHOOK_ALLOW_PRIVATE", "") == "1"   # allow webhooks to private/loopback (dev); default blocks SSRF
METRICS_TOKEN = os.environ.get("AGENT_METRICS_TOKEN", "")                     # if set, /metrics requires this bearer token

# Hermes exits 0 even when every model call failed (429/upstream error), so the exit code alone does not
# show success; a step-capped run can still exit 0. These markers in the combined output,
# plus "gateway on but zero successful model calls", are treated as hard failures regardless of exit code.
_HERMES_FAILURE_MARKERS = (
    "no final response was produced",
    "agent failed:",
    "api call failed after",
    "step-cap reached",
    "spend-cap reached",
)

# Under concurrent load nearly all failures are upstream 429s rather than model errors,
# and back-to-back best-of-N attempts land in the same rate-limit window and fail the same way. So back
# off before the next attempt on this marker only; other failures (agent bugs, empty output) retry at
# once, since a delay there only spends wall-clock budget.
UPSTREAM_RETRY_BASE_SECS = float(os.environ.get("AGENT_UPSTREAM_RETRY_BASE_SECS", "2.0"))

# A small model can fail long-horizon tasks (long-context-test.sh) and write wrong output while its final
# message claims success — a false self-report. So the agent's
# narrative is never proof of success; a result is only "verified" when an independent, deterministic check
# (run below, without the model or its token) confirms the actual side-effects. See VerifySpec / _verify.

# ---- INHERIT-FROM-CHAT seams --------------------------------------------------
# Auth: validate the bearer JWT the chat app sends (its AGENT_SERVICE_TOKEN).
#   Primary path: HS256 with WEBUI_SECRET_KEY.
#   Alt path (OIDC): validate against the IdP JWKS — wire OIDC_JWKS_URL if the deployment uses OIDC.
WEBUI_SECRET_KEY = os.environ.get("WEBUI_SECRET_KEY", "")               # the HS256 signing key for the bearer token
AUTH_DISABLED = os.environ.get("AGENT_AUTH_DISABLED", "") == "1"        # dev only — fails loud (see below)
# OFF by default. A token with no `exp` validates forever, so a copied one never dies and there is no
# revocation anywhere in this design. But the issuer is the chat app, whose tokens cannot be inspected
# from here, and requiring a claim the real issuer omits locks out every user of the product. Turn it on
# only after checking that a real chat JWT carries `exp`.
AUTH_REQUIRE_EXP = os.environ.get("AGENT_AUTH_REQUIRE_EXP", "") == "1"
# Agent mode and the sandbox are for signed-in accounts. Chat's token is one shared service token
# and the subject is a hash, so only chat can tell a guest from an account; it says so in X-Agent-Account.
# The header is chat's word, so this catches a chat route that forgot its own check, not a holder of the
# token. On unless AGENT_REQUIRE_ACCOUNT=0; the dev bypass skips it, since it skips auth altogether. (CUR-4402)
REQUIRE_ACCOUNT = os.environ.get("AGENT_REQUIRE_ACCOUNT", "1") != "0" and not AUTH_DISABLED
# Moderation: ONE detector — chat's web screening endpoint (POST /chat/api/safety/screen), the same guard
# chat itself screens through. Coop is REVIEW-ONLY here: it renders no verdict for this service, it
# only receives hit-only /api/v1/report submissions for triage (see _report_hit_to_coop below) — so
# COOP_URL/COOP_API_KEY are kept (same Doppler names as chat's config) but repurposed as report
# credentials, not detection ones.
SAFETY_SCREEN_URL = os.environ.get("SAFETY_SCREEN_URL", "").strip()
SAFETY_SCREEN_TOKEN = os.environ.get("SAFETY_SCREEN_TOKEN", "").strip()
COOP_URL = os.environ.get("COOP_URL", "").strip()
COOP_API_KEY = os.environ.get("COOP_API_KEY", "").strip()
# The Coop User item type id and Item type id a REPORT resolves reportedItem.typeId/reporter.typeId by —
# same split as moderation.ts (COOP_USER_TYPE_ID / COOP_ITEM_TYPE_ID), unrelated to the old /content
# detection contract's COOP_ITEM_TYPE *name*, which this service no longer calls at all.
COOP_USER_TYPE_ID = os.environ.get("COOP_USER_TYPE_ID", "").strip()
COOP_ITEM_TYPE_ID = os.environ.get("COOP_ITEM_TYPE_ID", "").strip()
# The Coop User item this service's own hits are reported AS — a fixed system reporter (e.g.
# "shieldstral-gate"), matching chat's COOP_SYSTEM_REPORTER_ID convention exactly (same free string, no
# Coop call to mint it). Unset ⇒ a loud, once-per-process skip (_report_hit_to_coop), never a silent one.
COOP_SYSTEM_REPORTER_ID = os.environ.get("COOP_SYSTEM_REPORTER_ID", "").strip()
MODERATION_DISABLED = os.environ.get("AGENT_MODERATION_DISABLED", "") == "1"
MODERATION_TIMEOUT_SECS = float(os.environ.get("AGENT_MODERATION_TIMEOUT_SECS", "10"))
# Attempts before the gate treats the screen as unavailable. A single-shot fail-closed gate converts
# transient timeouts into 502s on requests that were fine. Three, because two attempts can both time out
# back-to-back and still recover on a fresh call moments later (CUR-759). Not more: an unreachable screen
# must still fail closed promptly; worst case is 3x MODERATION_TIMEOUT_SECS before the 502.
MODERATION_ATTEMPTS = int(os.environ.get("AGENT_MODERATION_ATTEMPTS", "3"))
# Output screening sees the answer plus every artifact, and artifacts alone are capped at 256KB — enough to
# blow past the screen endpoint's own input cap (~100000 chars, head-only) and get a 413 rather than a real
# verdict. Bounded head+tail so that something appended at the very end is not free; the middle of a very
# large output is the acknowledged blind spot, and a cap the endpoint can actually read beats a
# full-length call that errors.
MODERATION_MAX_CHARS = int(os.environ.get("AGENT_MODERATION_MAX_CHARS", "24000"))
# The guard screen POST's own client timeout, deliberately above the endpoint's ~20s internal op
# deadline (guardScreenTypes.ts-adjacent contract) and above MODERATION_TIMEOUT_SECS: a client timeout below
# the server's own deadline turns a slow-but-completing screen into a false "unavailable" on every call that
# takes 10-20s.
MODERATION_HTTP_TIMEOUT_SECS = float(os.environ.get("AGENT_MODERATION_HTTP_TIMEOUT_SECS", "25"))
# Characters of the exception message logged on each moderation.retry/unavailable line, beside
# type(e).__name__. The type alone can't say what an unparseable answer contained; the message can.
# Bounded so a malformed answer stays visible without unbounded log volume.
MODERATION_ERROR_DETAIL_MAX = 200
# Pause between the attempts above. The screen endpoint can be briefly unreachable while it redeploys; a
# short fixed sleep gives that a chance to clear. An endpoint that stays down still fails closed in bounded
# time, at most 2x this value later.
MODERATION_RETRY_BACKOFF_SECS = float(os.environ.get("AGENT_MODERATION_RETRY_BACKOFF_SECS", "1.5"))

# Every stage runs through the same guard; the stage strings stay named constants because call sites and _report_hit_to_coop's per-stage scoping still need the exact stage strings.
STAGE_CHECK_CMD = "check_cmd"
STAGE_ARTIFACTS = "artifacts"

# What the screens after a run do with a verdict (CUR-4113). `block` (the default) refuses the turn and fails
# closed when the screen is unavailable; `log` screens off the request path and only records the verdict. The input screen always blocks, since the prompt decides what code
# runs. An unrecognised value reads as `block`, so a typo can only make the service stricter.
OUTPUT_SCREEN_MODE = "log" if os.environ.get("AGENT_OUTPUT_SCREEN_MODE", "").strip().lower() == "log" else "block"
LOG_ONLY_STAGES = ("output", STAGE_ARTIFACTS)


_MODEL_TOKEN_KEYS = ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGING_FACE_HUB_TOKEN")


def _model_env(nonce: str | None, home: str, permission_policy: str | None = None) -> dict[str, str]:
    """Secrets-at-boundary chokepoint. The agent runs --yolo shell, so it must NOT inherit the
    server's secrets. Start from a SCRUBBED env (every secret-named var removed — PROXY_ADMIN_KEY,
    WEBUI_SECRET_KEY, ROOST creds, model tokens, …; the agent's shell can read `env`), then re-add only what
    the agent needs:
      - gateway on  → a per-task NONCE as HF_TOKEN + HF_BASE_URL to proxy.py (real key never in reach);
      - gateway off → legacy passthrough re-adds the real model token (a known gap), but the admin
        key / auth secret are STILL withheld. /healthz reports the boundary state.

    Also the ACP toolset boundary (CUR-217): under deny_writes, override HERMES_ACP_TOOLSETS to exclude
    `terminal`/`code_execution` before this env reaches the `hermes acp` subprocess — see
    _deny_writes_toolsets. Harmless under oneshot, which reads -t/ALLOWED_TOOLSETS instead and ignores
    HERMES_ACP_TOOLSETS entirely.

    `permission_policy` is the ALREADY-RESOLVED value (CUR-470: `_resolve_permission_policy(task.user)` —
    this function has no principal to resolve against, only the caller does), not the raw
    ACP_PERMISSION_POLICY global — under "staged" those two differ per caller, and this function must act
    on the per-caller answer, not the mode name. Omitted (None), it falls back to the current global —
    byte-identical to this function's behavior before CUR-470 for every caller that doesn't pass one."""
    if permission_policy is None:
        permission_policy = ACP_PERMISSION_POLICY
    env = {k: v for k, v in os.environ.items() if not _SECRET_ENV_RE.search(k.upper())}
    env["HERMES_HOME"] = home                                  # per-task config/session isolation
    if MODEL_PROXY_URL and nonce:
        env["HF_TOKEN"] = nonce                                # agent authenticates to the gateway with the nonce
        env["HF_BASE_URL"] = MODEL_PROXY_URL + "/v1"           # redirect model calls to the gateway
    else:
        for k in _MODEL_TOKEN_KEYS:                            # legacy (no gateway): agent still needs the real token
            if k in os.environ:
                env[k] = os.environ[k]
    # The env vars an MCP header value is read from belong to the service, which hands the value
    # to Hermes over ACP. The agent's shell has no use for them, and _SECRET_ENV_RE only catches the ones
    # whose name happens to end like a secret. (CUR-3025)
    for var in mcp_config.header_env_names(MCP_CONFIG):
        env.pop(var, None)
    if permission_policy in ("deny_writes", "confirm"):
        # confirm's request_permission branch, like deny_writes', is only ever consulted for
        # write_file/patch (_PERMISSION_COVERS) — reuse the same toolset filter, or a human's "nothing
        # writes without me saying yes" expectation is as false as a write-containment claim that covers
        # only those two tools (CUR-217, CUR-218).
        env["HERMES_ACP_TOOLSETS"] = _deny_writes_toolsets(env.get("HERMES_ACP_TOOLSETS", ""))
    return env


# The guest's whole environment for `hermes acp`: nothing of this process's own. HF_TOKEN is the task's grant nonce,
# as under bwrap: capped, granted per attempt and revoked when the task ends, and the guest's only egress is the
# gateway. The bearer cannot be added on the host instead, because E2B Embed's network rules do not rewrite
# request headers (CUR-4500).
def _remote_model_env(remote_home: str, permission_policy: str | None, nonce: str) -> dict[str, str]:
    env = {"HOME": "/home/user", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
           "LANG": "C.UTF-8", "HERMES_HOME": remote_home, "HF_TOKEN": nonce,
           "HF_BASE_URL": AGENT_GATEWAY_PUBLIC_URL + "/v1"}
    base = os.environ.get("HERMES_ACP_TOOLSETS", "")        # the operator's choice, as _model_env carries it
    if (permission_policy or ACP_PERMISSION_POLICY) in ("deny_writes", "confirm"):
        base = _deny_writes_toolsets(base)
    if base:
        env["HERMES_ACP_TOOLSETS"] = base
    return env


def _remote_hermes_opener(h: Handle, local_home: str, remote_rel: str):
    """`open_stdio` for `_acp_run` on a remote backend. `_acp_run` writes the attempt's config into `local_home`
    before it connects; this copies those files into the sandbox under `remote_rel`, deletes the local copy, and
    then starts Hermes in the guest."""
    from contextlib import asynccontextmanager

    def push() -> None:
        root = Path(local_home)
        for f in sorted(root.rglob("*")):
            if f.is_file() and not f.is_symlink():
                SANDBOX_BACKEND.write(h, f"{remote_rel}/{f.relative_to(root).as_posix()}", f.read_bytes())
        shutil.rmtree(root, ignore_errors=True)

    @asynccontextmanager
    async def opener(argv: list[str], env: dict[str, str]):
        await asyncio.to_thread(push)  # each write is a round trip to the sandbox host
        async with SANDBOX_BACKEND.open_stdio(h, argv, env) as streams:
            yield streams
    return opener


# Sandbox keys with an agent task running now. A sandbox's grant token is one bearer, so a second task in the
# same conversation would reset the first one's caps and its revoke would cut the second off.
_REMOTE_BUSY: set[str] = set()
_REMOTE_BUSY_LOCK = threading.Lock()
_REMOTE_FREED = threading.Condition(_REMOTE_BUSY_LOCK)
# How long a task waits for the conversation's previous task to finish tidying up before refusing. A stopped
# task still drains Hermes and pauses the sandbox (up to 15 s of retries), and a person who presses Stop and
# sends again lands inside that window; refusing at once told them "another task is running" three times.
REMOTE_BUSY_WAIT_SECS = float(os.environ.get("AGENT_REMOTE_BUSY_WAIT_SECS", "45"))


def _claim_remote(key: str, wait_s: float) -> bool:
    """Mark `key` busy, waiting up to `wait_s` for a task that holds it to release it. False when it never did."""
    deadline = time.monotonic() + wait_s
    with _REMOTE_FREED:
        while key in _REMOTE_BUSY:
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            _REMOTE_FREED.wait(left)
        _REMOTE_BUSY.add(key)
        return True


def _unclaim_remote(key: str) -> None:
    with _REMOTE_FREED:
        _REMOTE_BUSY.discard(key)
        _REMOTE_FREED.notify_all()


def _gateway_grant(nonce: str, max_steps: int, max_tokens: int, label: str = "", attempt: int = 0,
                   model: str = "") -> None:
    """Register a per-task nonce + caps with the gateway before launching the agent (raises on failure).

    `label`/`attempt` are forensic only: the gateway logs them on a router.failover so a provider stall can
    be attributed to a trial and a best-of attempt. The nonce is the bearer token and is never logged.
    `model` (CUR-4603) pins every call on the grant to the task's executor; "" leaves a side call unpinned."""
    import httpx
    body = {"nonce": nonce, "max_requests": max_steps, "max_tokens": max_tokens, "label": label, "attempt": attempt}
    if model:
        body["model"] = model
    r = httpx.post(f"{MODEL_PROXY_URL}/admin/grant", headers={"authorization": f"Bearer {PROXY_ADMIN_KEY}"},
                   json=body, timeout=10.0)
    r.raise_for_status()


def _gateway_revoke(nonce: str, served: list | None = None) -> tuple[int, int, bool, bool]:
    """Revoke the nonce and return (model_calls, tokens, usage_seen, cap_hit). usage_seen=False means the
    spend-cap could not meter (upstream emitted no usage) — only the request cap actually bounded spend.
    cap_hit=True means the gateway refused at least one call (step/spend cap fired) — the AUTHORITATIVE
    'the agent was throttled before it could finish' signal, so honest-state doesn't rely on string-matching."""
    import httpx
    try:
        r = httpx.request("DELETE", f"{MODEL_PROXY_URL}/admin/grant/{nonce}",
                          headers={"authorization": f"Bearer {PROXY_ADMIN_KEY}"}, timeout=10.0)
        d = r.json()
        if served is not None:
            # The model ids upstream named on this grant's responses, into the task's record. (CUR-4603)
            for m in d.get("served_models") or []:
                if isinstance(m, str) and m and m not in served:
                    served.append(m)
        return (int(d.get("requests", 0)), int(d.get("tokens", 0)),
                bool(d.get("usage_seen", False)), bool(d.get("cap_hit", False)))
    except Exception:  # noqa: BLE001 — revoke is best-effort cleanup; the grant cap still bounded the run
        return (0, 0, False, False)


# Match env var names that ARE secrets, not ones that merely contain a secret-ish substring. Anchored to
# word boundaries so MONKEY ("KEY") / CAPITAL ("API") survive but HF_TOKEN / OPENAI_API_KEY / AWS_SECRET
# _ACCESS_KEY are stripped.
_SECRET_ENV_RE = re.compile(r"(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|APIKEY|API_KEY|"
                            r"ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|SESSION_KEY|KEY)$")


def _clean_env() -> dict[str, str]:
    """Env for the post-run verification check: the caller's own env MINUS any secret. The check is
    caller-supplied and runs server-side, so it must NOT be able to read the model token or platform
    secrets (the §6B.1 boundary, applied to the verifier too)."""
    return {k: v for k, v in os.environ.items() if not _SECRET_ENV_RE.search(k.upper())}


def _sandbox_prefix(work: str) -> list[str]:
    """Return the sandbox-launcher argv to prepend to the hermes command (empty when sandbox is off).
    The `bwrap` profile: whole host read-only, $HOME and /tmp replaced by tmpfs (hiding ssh keys, cloud
    creds, other projects, the real ~/.hermes), the hermes install re-exposed read-only, and ONLY the
    per-task scratch writable — so the agent can neither read host secrets nor write outside its sandbox."""
    if SANDBOX == "off":
        return []
    if SANDBOX == "custom":
        import shlex
        return shlex.split(SANDBOX_ARGS)
    if SANDBOX == "bwrap":
        bw = shutil.which("bwrap")
        if not bw:
            raise RuntimeError("AGENT_SANDBOX=bwrap but bwrap is not installed")
        hermes_abs = shutil.which(HERMES_BIN) or HERMES_BIN   # HERMES_BIN may be a bare PATH name (container) — resolve it
        hermes_root = str(Path(hermes_abs).resolve().parent.parent.parent)  # .venv/bin/hermes -> project root
        # The venv python often symlinks OUT to a managed interpreter (uv/pyenv) under $HOME — re-expose its
        # install root too, else the tmpfs /home hides the shebang interpreter and hermes won't exec.
        binds = ["--ro-bind", hermes_root, hermes_root]
        try:
            real_py = (Path(hermes_abs).parent / "python3").resolve()
            py_root = str(real_py.parent.parent)
            if py_root not in ("/", "/usr", "/usr/local") and py_root != hermes_root:
                binds += ["--ro-bind", py_root, py_root]
        except Exception:  # noqa: BLE001
            pass
        # Hide sensitive dirs with a fresh tmpfs. Over a `--ro-bind / /` root, bwrap can only mount onto an
        # EXISTING dir (it can't mkdir on the read-only root) — so filter to dirs that exist, and always
        # include the store's REAL parent (DB_PATH) so the durable store is hidden wherever it lives.
        #
        # SIZED. A bwrap --tmpfs with no --size defaults to half of RAM and is WRITABLE by the sandboxed
        # process, so the six mounts that exist to HIDE these directories would otherwise also be six
        # unbounded RAM-backed filesystems that one command could fill, killing the whole machine out of
        # memory. Nothing legitimate writes here — the only
        # intended writable path is the scratch bind below — so this is generous by a wide margin.
        store_dir = str(Path(DB_PATH).resolve().parent)
        hide_tmpfs: list[str] = []
        seen: set[str] = set()
        # /.fly holds Fly's machine API socket, and a read-only bind does not stop connect() on a socket,
        # so it is hidden like the data directories rather than left visible read-only (CUR-3536).
        for d in ("/home", "/tmp", "/root", "/srv", "/var", "/.fly", store_dir):  # noqa: S108 — these are the
            # directories being HIDDEN behind a tmpfs, not paths we write to
            if d and d != "/" and d not in seen and os.path.isdir(d):
                hide_tmpfs += ["--size", str(TMPFS_BYTES), "--tmpfs", d]
                seen.add(d)
        return [
            *_rlimit_prefix(),
            *_seccomp_loader(),
            bw,
            *_seccomp_flags(),
            "--ro-bind", "/", "/",            # whole host visible but READ-ONLY (no writes outside scratch)
            *hide_tmpfs,                       # hide $HOME, /tmp, the DURABLE STORE (cross-tenant), app src — existing dirs only
            *binds,                           # re-expose ONLY the hermes install + its interpreter (RO)
            "--bind", work, work,             # the ONLY writable path: this task's scratch (cwd + HERMES_HOME)
            "--proc", "/proc", "--dev", "/dev",
            # Net is NOT unshared: the agent needs the gateway, and its address+name filtering lives in
            # deploy/entrypoint.sh (nftables, installed before the privilege drop) rather than here (no
            # NetworkPolicy manifests are deployed).
            "--unshare-pid", "--unshare-ipc", "--unshare-uts",   # process/IPC isolation
            # A user namespace of its own, inside which no further one can be made: nested user
            # namespaces are where most unprivileged kernel exploits get the capabilities they need, and
            # bwrap refuses --disable-userns without --unshare-user (CUR-4478).
            "--unshare-user", "--disable-userns", "--unshare-cgroup-try",
            "--die-with-parent", "--chdir", work,
        ]
    raise RuntimeError(f"unknown AGENT_SANDBOX={SANDBOX!r} (use off|bwrap|custom)")


def _seccomp_ready() -> bool:
    return os.path.isfile(SECCOMP_PATH)


def _seccomp_loader() -> list[str]:
    """`sh` argv that opens the filter as fd 9 and execs the rest of the line, or [] with no filter.

    bwrap reads a seccomp program only from an open descriptor (`--seccomp FD`), and this prefix is run by
    three different launchers (the agent's ACP spawn, the run-code backend, the verify check). A one-line
    shell that opens the file and execs bwrap carries the descriptor through all three without each one
    learning about pass_fds. bwrap consumes the descriptor, so the sandboxed command does not inherit it."""
    if _seccomp_ready():
        return ["/bin/sh", "-c", 'exec "$@" 9<"$0"', SECCOMP_PATH]
    if SANDBOX_REQUIRED:
        raise RuntimeError(f"AGENT_SANDBOX_REQUIRED=1 but the seccomp filter {SECCOMP_PATH} is missing")
    return []


def _seccomp_flags() -> list[str]:
    return ["--seccomp", "9"] if _seccomp_ready() else []


def _rlimit_prefix() -> list[str]:
    """`prlimit` argv to prepend to the sandbox, or [] when limits are off or prlimit is missing.

    bwrap namespaces but does not RATION: --unshare-pid gives a private PID namespace, not a process
    budget. Without a limit the agent could fork-bomb a 1GB machine and take
    the app down with it. Limits are inherited across fork/exec, so setting them on bwrap covers hermes and
    everything it spawns.

    RLIMIT_AS is deliberately ABSENT. A real multi-file turn peaks at about 1.28GB of virtual address
    space, more than the machine's 985MB of RAM, because reservations are not residency. A cap
    low enough to prevent an OOM would kill legitimate turns, and one high enough to be safe would prevent
    nothing. It is the wrong instrument here; the tmpfs sizing above is what actually removes the cheap
    RAM-fill path.

    NPROC IS PER REAL UID, NOT PER PROCESS, and the agent shares uid 10001 with the app — so this budget
    counts the server's own threads too. That is why it is set in the hundreds rather than tight: high
    enough that the app never notices, low enough that a bomb stops far short of the kernel's
    threads-max (7467 here) instead of wedging the box. Isolating it properly means a second uid, which
    means the app can no longer drop privileges once at boot."""
    if not RLIMIT_ENABLED:
        return []
    pl = shutil.which("prlimit")
    if not pl:
        return []                       # dev boxes without util-linux run unlimited, same as before
    return [pl, f"--nproc={RLIMIT_NPROC}", f"--fsize={RLIMIT_FSIZE}", "--core=0", "--"]


def _model_flags(model: str = "") -> list[str]:
    """hermes -m/--provider flags. `model` is the task's executor (CUR-4603), else AGENT_MODEL. Lets the
    model be set without a ~/.hermes/config.yaml (which doesn't exist in a container/Fly image); empty →
    hermes falls back to its config file (the local path)."""
    flags: list[str] = []
    if model or AGENT_MODEL:
        flags += ["-m", model or AGENT_MODEL]
    if AGENT_MODEL_PROVIDER:
        flags += ["--provider", AGENT_MODEL_PROVIDER]
    return flags


def _dir_disk_bytes(path: str, ceiling: int) -> int:
    """Disk actually consumed under `path`, stopping as soon as `ceiling` is passed.

    st_blocks*512, NOT st_size. The two disagree in both directions and each disagreement matters here: a
    sparse file reports a size it does not occupy (`truncate -s 20G` costs nothing, and counting it would
    kill a task that used no disk), while a small file still costs a whole block. Disk pressure is the
    thing being bounded, so blocks are the honest unit.

    lstat, and regular files only. Following a symlink would let the agent point at something enormous
    outside its scratch and have us count it — the same reach that makes an unchecked `Path.write_text` an
    arbitrary file write, arriving from the other direction.

    Bails at the ceiling so the common case is a short walk over a handful of files rather than a full
    traversal every poll."""
    total = 0
    for root, _dirs, files in os.walk(path, followlinks=False):
        for f in files:
            try:
                st = os.lstat(os.path.join(root, f))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                total += st.st_blocks * 512
                if total > ceiling:
                    return total
    return total


def _scratch_watchdog(task: Task, work: str, baseline: int, stop: threading.Event) -> None:
    """Kill a task whose scratch outgrows its ration. Runs for the life of the task, in its own thread.

    RLIMIT_FSIZE bounds ONE file; nothing bounded the sum, so a loop writing 8KB files was a way to fill
    the machine's 7.4GB root from a prompt — slower than the `dd` that motivated the tmpfs sizing, and
    landing in the one directory that is deliberately writable. Concurrency is 8, so a per-task ration
    bounds the aggregate by construction (8 x 256MB against 7.4GB) and, unlike a shared pool, one abusive
    task cannot starve the other seven.

    Polling rather than a quota because a real quota needs either a loop-mounted image or a filesystem
    mounted with project quotas — both mean another privileged step in the boot path, the riskiest part of
    startup. The cost is bounded overshoot: whatever the agent writes inside one poll
    interval. Against a ration this size that is not a meaningful difference.

    Cancels through the same two handles the DELETE endpoint uses, deliberately: that path is already
    exercised, and a second bespoke kill would be a second thing to get wrong.

    `baseline` (CUR-196): disk already in `work` before this turn started — 0 for an ephemeral (no
    session_id) workdir, matching today's behavior exactly. For a reused session workdir it's whatever
    prior turns left behind, and the ration bounds THIS turn's own writes, not the session's cumulative
    total (SESSION_SCRATCH_MAX_BYTES bounds that, checked once at reuse time). The ceiling passed into
    `_dir_disk_bytes` has to move with baseline too, not just the comparison below — that function bails
    the walk as soon as it's counted `ceiling` worth of anything, so a bare SCRATCH_MAX_BYTES ceiling
    against a workdir with substantial prior content would bail on baseline bytes before counting most of
    this turn's writes, silently defeating the ration for every continued session."""
    if SCRATCH_MAX_BYTES <= 0:
        return
    while not stop.wait(SCRATCH_POLL_SECS):
        used = _dir_disk_bytes(work, baseline + SCRATCH_MAX_BYTES)
        if used - baseline <= SCRATCH_MAX_BYTES:
            continue
        task._scratch_exceeded = used - baseline
        _metric_inc("agent_scratch_exceeded_total")
        _log_event("scratch.exceeded", id=task.id, used=used - baseline, cap=SCRATCH_MAX_BYTES)
        if task._proc is not None:
            _kill_process_group(task._proc)
        if task._acp_cancel is not None:
            try:
                task._acp_cancel()
            except Exception:  # noqa: BLE001 — best-effort, same posture as the cancel endpoint
                pass
        return


def _kill_process_group(proc: subprocess.Popen) -> None:
    """Terminate the agent subprocess AND anything it spawned (it leads its own session, so the whole
    tree dies). Used by the wall-clock cap and by explicit cancellation."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _failure_reason(hard_spec: bool, verified: bool, last_structural: str | None,
                    attempts: int, best_of: int, rejections: list) -> str | None:
    """The durable failure reason for a finished run, or None if it didn't fail.

    An EXPLICIT spec left unverified is a hard FAILED; an auto-derived chat spec (or no spec) left
    unverified completes honest-unverified, so only a structural reason can fail it.

    `last_structural` is only the LAST attempt's reason, and the last attempt is the one most likely to
    be starved: attempts share one task deadline (see _remaining_timeout), so a trial whose first two
    ran the full horizon and lost on correctness leaves the third with seconds. Reporting that third
    reason alone would file a 3-attempt correctness failure as "wall-clock cap (300s) exceeded" — the
    durable record would name the attempt that did the least work, and the two clean-but-wrong attempts
    reach only `attempt_rejections` (in memory, discarded with the process). Lead
    with the rejections when there are any; keep the structural reason, it still explains its attempt."""
    if hard_spec and not verified:
        joined = "; ".join(str(r) for r in rejections)
        if joined:
            return (f"verification failed after {attempts} attempt(s): {joined}"
                    + (f" | last attempt: {last_structural}" if last_structural else ""))
        return last_structural or f"verification failed (best-of-{best_of} exhausted)"
    return last_structural if not verified else None


def _reconcile_verification(task: Task) -> None:
    """Make task.verified/verify_method agree with task.unrun_detail before the terminal state ships.

    _run sets these at several independent points (the best-of loop's winner restoration, the
    consistency-vote branch, the `if fail:` branch), so without this a winning sample can carry both
    "nothing ran" and "execution-verified" at once. Whatever unrun_detail says wins over any verified claim.

    Called once, right before task.summary is finalized, rather than after each assignment site, so a
    new site can't forget it."""
    if task.unrun_detail:
        task.verified, task.verify_method = False, ""


def _teardown_exit(returncode: int | None, acp_stop: str | None) -> int | None:
    """The exit code to score, after discounting our own teardown signal.

    An attempt that ended its turn (`end_turn`) is torn down by closing the child's stdin and
    allowing 2s before SIGTERM (acp transports.py, shutdown_timeout=2.0). A child slower than that to
    exit reports -15 though it finished, and scoring that as a failure retried finished runs under
    best_of until retries, each waiting on approvals nobody could answer, held every concurrency slot
    (CUR-2730).

    On E2B the same teardown is a kill: `hermes acp` stays up waiting for the next prompt, leaving
    `open_stdio` kills it, and E2B's envd reports a process ended by a signal as -1 (Go's
    `ProcessState.ExitCode`). Every finished E2B attempt would therefore exit -1, and every chat turn with
    no spec to verify it would fail after three attempts. So -1 after end_turn is discounted too.

    Only those two codes after end_turn are discounted: None still means the transport gave up, and a
    signal before the agent ended its turn is still a kill."""
    if acp_stop == "end_turn" and returncode in _TEARDOWN_SIGNAL_EXITS:
        return 0
    return returncode


# -15: bwrap's SIGTERM after the 2s stdin-close grace. -1: E2B's code for a process its kill ended.
_TEARDOWN_SIGNAL_EXITS = frozenset({-15, -1})


def _detect_run_failure(returncode: int | None, stdout: str, stderr: str, gateway_on: bool, model_calls: int,
                        cap_hit: bool = False) -> str | None:
    """Decide if a run failed despite a 0 exit code. Returns a reason string, or None if it looks clean.
    Signals (any → failure), strongest first:
      - nonzero exit;
      - cap_hit — the gateway AUTHORITATIVELY refused a call (step/spend cap fired). No string-matching:
        the gateway knows it throttled the agent, so a capped run can't masquerade as COMPLETED even
        without a verify spec (Hermes prints its terminal error to STDOUT, so a
        stderr-only scan would miss it; the gateway signal is the reliable one);
      - a Hermes failure marker at the START of a stdout/stderr line — anchored to line-start so a legit
        answer that merely QUOTES a marker mid-sentence is NOT flagged;
      - exit 0 with empty stdout (no final response produced);
      - gateway-on with zero model calls (produced nothing real)."""
    # returncode is None, not an int, when the ACP transport ended the attempt without reaping the
    # child (timeout, external cancel — see _run's two `ret = None` branches). None != 0, so that
    # lands here and reads "hermes exit None", which is the honest answer: it failed and there is no
    # code to report (CUR-1227).
    if returncode != 0:
        tail = re.sub(r"hf_[A-Za-z0-9]+", "hf_<redacted>", (stderr or "").strip())[-300:]
        return f"hermes exit {returncode}" + (f": {tail}" if tail else "")
    if cap_hit:
        return "step/spend cap reached (agent throttled before completing)"
    for chan in (stdout, stderr):                      # scan BOTH — Hermes' terminal error lands on stdout
        for line in chan.splitlines():
            ls = line.strip().lower()
            for m in _HERMES_FAILURE_MARKERS:
                if ls.startswith(m):                   # anchored: a quote mid-prose won't start the line
                    return f"agent run failed (marker: {m!r})"
    if not stdout.strip():
        return "agent produced no output (no final response)"
    if gateway_on and model_calls == 0:
        return "agent made no successful model calls (capped or upstream error)"
    return None


def _text_sha(s: str | None) -> str:
    """A content-free identity for an attempt's output, so "did the retry produce a different answer"
    is a group-by instead of a forensic exercise.

    best-of-N here is SEQUENTIAL accept/reject (`_decide`): attempt 1 runs, the judge passes or fails,
    a failure retries. A retry can therefore only help if attempt 2 differs from attempt 1 — and CSCS
    decorrelates weakly (5 identical seeded requests, 2 distinct completions). If retries mostly
    reproduce the rejected answer, best-of-N is decorative no matter how good the judge is, and the fix
    is decorrelation rather than a better seat.

    `run.attempt` already carried `out_chars`, which proves DIFFERENCE and cannot prove SAMENESS — the
    direction that matters, since "the retry reproduced it" is the finding that would retire the
    feature. A digest settles it and crosses no boundary the redaction policy drew: this is not
    content, cannot be inverted to content, and is useless to anyone who doesn't already hold the text.
    Deliberately NOT in logsink.CONTENT_FIELDS for that reason."""
    return hashlib.sha256((s or "").encode()).hexdigest()[:12] if s else ""


def _structural_kind(s: str | None) -> str:
    """The closed-set label behind a `_detect_run_failure` string.

    Two of that function's five returns interpolate process output — a stderr tail and a matched
    stdout marker — so the string as a whole is content and gets redacted before it leaves the box
    (logsink.CONTENT_FIELDS). The KIND is what the operational question is actually about ("are we
    hitting the step cap more than we were last week"), and it is a closed set, so it ships whole."""
    if not s:
        return ""
    if s.startswith("hermes exit "):
        return "exit_nonzero"
    if s.startswith("step/spend cap"):
        return "cap_reached"
    if s.startswith("agent run failed (marker:"):
        return "failure_marker"
    if s.startswith("agent produced no output"):
        return "no_output"
    if s.startswith("agent made no successful model calls"):
        return "no_model_calls"
    if s.startswith("agent made no tool calls"):
        return "no_tool_calls"
    return "other"


def _resolve_sandbox_path(work: str, rel: str) -> Path | None:
    """Resolve `rel` against `work`, refusing anything that escapes the sandbox. Returns None on a
    traversal attempt. Shared by `_verify` and `_judge_file_excerpt` so the path-traversal guard
    exists once, not as two implementations that could quietly drift apart."""
    base = Path(work).resolve()
    target = (base / rel).resolve()
    if not str(target).startswith(str(base) + os.sep):
        return None
    return target


def _verify_columns(text: str, filename: str, expect_columns: list[str]) -> tuple[bool, str]:
    """expect_columns: every name must appear in expect_file's header row (first CSV line). Declarative,
    LLM-free, no shell — same security profile as expect_contains, just scoped to the header."""
    rows = list(csv.reader(io.StringIO(text)))
    header = rows[0] if rows else []
    missing = [c for c in expect_columns if c not in header]
    if missing:
        return False, f"expect_columns: {filename} is missing {missing!r} (header: {header!r})"
    return True, ""


_Sortable = TypeVar("_Sortable", float, str)


def _first_inversion(keys: list[_Sortable], desc: bool) -> int | None:
    """Index of the first entry that breaks monotonicity, or None if the whole list is sorted.

    Generic on purpose, and this is the point rather than decoration: `list[float] | list[str]` joins to
    `float | str` the moment you subscript it, so an inline loop over the union compares `float | str`
    against `float | str` — which is exactly the float-to-str TypeError that _verify_sorted deciding the
    column type ONCE is there to prevent. Binding both indices to the same T is what says "compare like
    with like", and it is checkable (CUR-1227)."""
    for i in range(1, len(keys)):
        if (keys[i] > keys[i - 1]) if desc else (keys[i] < keys[i - 1]):
            return i
    return None


def _verify_sorted(text: str, filename: str, column: str, desc: bool) -> tuple[bool, str]:
    """expect_sorted_by: `column` in expect_file must be monotonic. Decides float-vs-string comparison
    ONCE per column, not per row — a single blank/non-numeric cell among numeric ones would otherwise
    compare float to str mid-list and raise TypeError instead of failing with a reason. Row numbers in
    every failure reason count the header as row 1 (so the first data row is row 2), matching what a
    human counts open in a text editor.

    A data row too short to HAVE the target column is a malformed file, not a row to silently drop: the
    original version filtered short rows out before comparing, which let a genuinely broken row escape
    detection entirely AND desynced every subsequent "row N" report (N was an index into the filtered
    list, not the row's real position) the moment any row was dropped."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return False, f"expect_sorted_by: {filename} is empty"
    header, data = rows[0], rows[1:]
    if column not in header:
        return False, f"expect_sorted_by: no column named {column!r} in header {header!r} (or file has no header row)"
    idx = header.index(column)
    for physical_row, r in enumerate(data, start=2):    # start=2: row 1 is the header
        if len(r) <= idx:
            return False, (f"expect_sorted_by: {filename} row {physical_row} has only {len(r)} column(s), "
                            f"needs at least {idx + 1} to contain {column!r}")
    values = [r[idx] for r in data]

    def _to_float(v: str) -> float | None:
        # math.isfinite, not a bare try/except: float("nan")/float("inf") both PARSE successfully but
        # NaN comparisons are always False, so a NaN cell would sit adjacent to a genuinely out-of-order
        # row and report "sorted" — reproduced directly against a nan cell next to a real inversion.
        # Treating them as unparseable (falling back to string comparison for the whole column, the
        # same path a non-numeric cell already takes) closes that instead of silently trusting them.
        try:
            f = float(v)
        except (ValueError, TypeError):
            return None
        return f if math.isfinite(f) else None

    def _all_floats() -> list[float] | None:
        """None the moment any cell fails to parse — the whole column falls back to string comparison."""
        out: list[float] = []
        for v in values:
            f = _to_float(v)
            if f is None:
                return None
            out.append(f)
        return out

    # Same decision as the old `floats if all(f is not None for f in floats) else values`, same single
    # pass — but that form leaves the element type `float | None`, so the comparisons below read as
    # float-against-None to a reader and to a type checker alike (CUR-1227).
    parsed = _all_floats()
    i = _first_inversion(values, desc) if parsed is None else _first_inversion(parsed, desc)
    if i is not None:
        return False, (f"expect_sorted_by: {filename} not sorted by {column!r} at row {i + 2} "
                        f"({values[i]!r} follows {values[i - 1]!r})")
    return True, ""


# ---- Best-of-N value-consistency check (CUR-596 item 2) -------------------------------------
def _consistency_eligible(spec: VerifySpec | None) -> bool:
    """Whether `spec` gives a deterministic computed VALUE to compare across best-of-N attempts.
    check_cmd's own output isn't captured anywhere comparable; a judge-only/spec-less turn has no artifact
    at all. Deliberately narrower than "any expect_file spec": expect_sorted_by/expect_columns are the
    only shapes that assert something CSV-structured — an expect_file+expect_contains spec (a plain-text
    report, a log excerpt, prose) has no tabular structure to parse, and running it through csv.reader
    anyway would produce a "signature" that reflects incidental comma placement rather than actual
    content, letting two semantically-identical prose answers with a comma moved register as a
    disagreement (or, worse, two meaningfully different answers collide on the same first few fields)."""
    return bool(spec is not None and spec.expect_file and not spec.check_cmd
                and (spec.expect_sorted_by is not None or spec.expect_columns is not None))


def _normalized_rows(text: str, ordered: bool) -> list:
    """Parse `text` as CSV into a value usable for equality across independently-generated attempts.
    `ordered` (spec.expect_sorted_by is set) keeps row order significant — the task asserted an order;
    otherwise row order is incidental (dict-iteration order, whichever month came first) and comparing it
    would flag a cosmetic difference as a real disagreement.

    Two more cosmetic-difference traps are handled here: (1) a blank row (csv.reader yields `[]` for one) —
    a file with one trailing newline and an otherwise-identical file with an extra blank line at the end parse to different row counts, flagging
    two attempts that wrote the same table as disagreeing. Dropped unconditionally: a genuinely blank row
    in tabular data is a formatting artifact, never real content. (2) embedded \\r\\n
    vs \\n inside a quoted multi-line cell — io.StringIO does not translate embedded line endings, so the
    identical multi-line value written by a CRLF-emitting vs an LF-emitting path parses to different cell
    content. Normalized to \\n before comparison."""
    rows = [tuple(cell.replace("\r\n", "\n").replace("\r", "\n").strip() for cell in row)
            for row in csv.reader(io.StringIO(text)) if row]
    return rows if ordered else sorted(rows)


def _attempt_signature(work: str | RemoteWork, spec: VerifySpec | None) -> str | None:
    """The comparable value for one verified attempt's expect_file — read BEFORE the next attempt's
    _reset_scratch wipes it. None on any read failure OR when the target isn't a genuine regular file (a
    consistency-check bug must never crash the turn; a None signature is simply excluded from the vote,
    same as never having sampled it — see _majority_signature's caller in _run for how a None signature
    still keeps the attempt eligible as a last-resort fallback, just never as the majority winner).

    Symlinks specifically: _verify (which decided THIS attempt passed) follows them, since a symlink
    inside `work` pointing at another file inside `work` is legitimate agent output. But _snapshot_scratch
    deliberately does NOT capture symlinks
    — so a symlinked expect_file that _verify accepted would vanish after _restore_scratch rebuilds `work`
    from the snapshot, leaving verified=True over a file that no longer exists. Refusing to sign a
    symlinked target here keeps that attempt out of the vote (and, if it's ever the fallback, at least the
    inconsistency is bounded to "no comparable value" rather than "won on a value that then disappeared")."""
    # Symlink check must run BEFORE resolution: _resolve_sandbox_path's own .resolve() call already
    # collapses any symlink chain, so checking .is_symlink() on its return value is always False
    # (test_attempt_signature's symlink case covers it). Check the raw, unresolved leaf instead, matching
    # _artifact_paths's own lstat-before-anything-else convention.
    # Nothing to sign — no spec at all, or a spec with no expect_file (check_cmd-only, judge-only).
    # Same answer as a read failure: out of the vote, still eligible as a last-resort fallback. Stated
    # here rather than left to each caller's vmethod check, because this function's own contract is
    # that a consistency-check problem never crashes the turn, and Path(work, None) raises (CUR-1227).
    if spec is None or not spec.expect_file:
        return None
    if isinstance(work, RemoteWork):                       # read() refuses a link as the leaf, as below
        raw = work.read(posixpath.normpath(spec.expect_file), ARTIFACT_DOWNLOAD_MAX_BYTES)
        if raw is None:
            return None
        try:
            return repr(_normalized_rows(raw.decode("utf-8", errors="replace"),
                                         ordered=spec.expect_sorted_by is not None))
        except csv.Error:
            return None
    if Path(work, spec.expect_file).is_symlink():
        return None
    target = _resolve_sandbox_path(work, spec.expect_file)
    if target is None or not target.is_file():
        return None
    try:
        text = target.read_text(errors="replace")
    except OSError:
        return None
    try:
        # csv.reader (inside _normalized_rows) raises csv.Error on real, plausible content — an
        # oversized single field (Python's default 131072-byte field limit) is enough, e.g. one
        # unusually long free-text cell. This function's whole docstring promise
        # is "never crash the turn"; the read above was guarded, this parse wasn't.
        return repr(_normalized_rows(text, ordered=spec.expect_sorted_by is not None))
    except csv.Error:
        return None


def _majority_signature(sigs: list[str]) -> tuple[str | None, str | None]:
    """(majority_sig, disagreement_detail). `majority_sig` is the value a STRICT majority (>half) of
    `sigs` share, so the caller knows WHICH attempt to serve, not just whether they agreed — serving
    whichever attempt happened to run last would ignore the majority's value. `sigs`
    fewer than 2, or no strict majority (a tie or 3-way split): (None, ...) — `disagreement_detail` is
    non-None only in the split case, naming it; both are None when there's nothing to compare (fewer than
    2 samples) — the caller's fallback for "nothing to vote on" and "genuine split" must differ, and only
    `disagreement_detail`'s truthiness tells them apart."""
    if len(sigs) < 2:
        return None, None
    from collections import Counter
    counts = Counter(sigs)
    top_sig, top_n = counts.most_common(1)[0]
    if top_n * 2 > len(sigs):
        return top_sig, None
    groups = ", ".join(f"{n}/{len(sigs)}" for _sig, n in counts.most_common())
    return None, (f"{len(counts)} distinct computed values across {len(sigs)} independently-verified "
                   f"attempts (split {groups}) — no majority, none of them can be trusted over the others")


# ---- Independent result verification (close the false-success gap) -------------------------
def _verify(work: str | RemoteWork, spec: VerifySpec) -> tuple[bool, str]:
    """Deterministically confirm the agent's side-effects in the sandbox — WITHOUT the model. Returns
    (ok, detail). The agent's self-reported result never decides success when a spec is present; this does.
      - expect_file (+ optional expect_contains/expect_lines/expect_sorted_by/expect_columns): the
        artifact must exist (within the sandbox) and satisfy whichever of these are set. No shell —
        the safe default.
      - check_cmd: escape hatch — a shell command run under the SAME execution sandbox as the agent (so it
        can't read host secrets either), scrubbed env, short
        timeout; exit 0 = verified. Not a new capability (the agent already runs shell), LLM-free."""
    if spec.expect_file:
        wants_text = (spec.expect_contains is not None or spec.expect_lines is not None
                      or spec.expect_sorted_by is not None or spec.expect_columns is not None)
        if isinstance(work, RemoteWork):               # CUR-4483: the artifact is in the guest
            rel = posixpath.normpath(spec.expect_file)
            if posixpath.isabs(rel) or rel == ".." or rel.startswith("../"):
                return False, "expect_file escapes the sandbox"
            raw = work.read(rel, ARTIFACT_DOWNLOAD_MAX_BYTES if wants_text else 0)
            if raw is None:
                return False, f"expect_file not found: {spec.expect_file}"
            text = raw.decode("utf-8", errors="replace")
        else:
            target = _resolve_sandbox_path(work, spec.expect_file)
            if target is None:
                return False, "expect_file escapes the sandbox"
            if not target.is_file():
                return False, f"expect_file not found: {spec.expect_file}"
            text = target.read_text(errors="replace") if wants_text else ""
        if spec.expect_contains is not None and spec.expect_contains not in text:
            return False, f"expect_contains not present in {spec.expect_file}"
        if spec.expect_lines is not None:
            n = sum(1 for ln in text.splitlines() if ln.strip())   # non-empty lines (trailing newline doesn't count)
            if n != spec.expect_lines:
                return False, f"expect_lines: {spec.expect_file} has {n} non-empty lines, want {spec.expect_lines}"
        if spec.expect_columns is not None:
            ok, reason = _verify_columns(text, spec.expect_file, spec.expect_columns)
            if not ok:
                return False, reason
        if spec.expect_sorted_by is not None:
            ok, reason = _verify_sorted(text, spec.expect_file, spec.expect_sorted_by, spec.expect_sorted_desc)
            if not ok:
                return False, reason
        extra = ([("contains expected")] if spec.expect_contains else []) + \
                ([f"{spec.expect_lines} lines"] if spec.expect_lines is not None else []) + \
                (["has expected columns"] if spec.expect_columns is not None else []) + \
                ([f"sorted by {spec.expect_sorted_by}"] if spec.expect_sorted_by is not None else [])
        return True, f"verified: {spec.expect_file}" + (f" ({', '.join(extra)})" if extra else " exists")
    if spec.check_cmd and isinstance(work, RemoteWork):
        res = work.run(spec.check_cmd, VERIFY_TIMEOUT_SECS)
        if res.timed_out:
            return False, f"check_cmd exceeded {VERIFY_TIMEOUT_SECS}s"
        if res.code == 0:
            return True, "check_cmd exit 0"
        return False, f"check_cmd exit {res.code}" + _detail_tail(res.stderr or res.stdout or "")
    if spec.check_cmd and isinstance(work, str):
        cmd = [*_sandbox_prefix(work), "bash", "-c", spec.check_cmd]  # same sandbox as the agent (no $HOME escape)
        # (count-only specs never reach here — they route through _verify_answer_count on the answer text)
        try:
            proc = subprocess.run(
                cmd, cwd=work, env=_clean_env(),
                capture_output=True, text=True, timeout=VERIFY_TIMEOUT_SECS,
            )
        except subprocess.TimeoutExpired:
            return False, f"check_cmd exceeded {VERIFY_TIMEOUT_SECS}s"
        if proc.returncode == 0:
            return True, "check_cmd exit 0"
        # Keep the check's own account of what was wrong; "check_cmd exit 1" alone can't say which
        # assertion missed, and every failure would read the same in the ledger. stderr first (asserts and
        # tracebacks land there), stdout as the fallback for a check that prints its diagnosis and exits nonzero.
        return False, f"check_cmd exit {proc.returncode}" + _detail_tail(proc.stderr or proc.stdout or "")
    return False, "empty verify spec"


def _detail_tail(s: str, limit: int = VERIFY_DETAIL_CHARS) -> str:
    """Format a check's own output as a one-line suffix for a verify reason, or "" if it said nothing.

    Keeps the TAIL: a Python traceback puts `AssertionError: want X, got Y` on its last line, and that
    line is the entire reason anyone reads a failure. Newlines collapse to " | " because this lands in a
    `summary` field that is displayed as one line."""
    lines = [ln.strip() for ln in s.strip().splitlines() if ln.strip()]
    if not lines:
        return ""
    joined = " | ".join(lines)
    return ": " + (joined if len(joined) <= limit else "…" + joined[-limit:])


def _scrub(text: str, nonce: str | None) -> str:
    """Strip the task's gateway bearer out of text that came back from inside the sandbox.

    The agent runs with the nonce in its environment, so anything that echoes an environment can carry it
    back out — a traceback from the agent's own code, a check that prints `os.environ` on failure. That text reaches
    `attempt_rejections`, the task summary, and (with the repair loop) the structured log, all of which are
    shared sinks. The nonce is a bearer token; it goes in none of them.
    Applied where the text crosses out of `_run`, which is the only scope that knows the nonce."""
    return text.replace(nonce, "<nonce>") if (nonce and text) else text


def _count_items(text: str, sep: str) -> int:
    """Count non-empty, stripped items in `text` split on `sep` — the deterministic primitive behind
    expect_count. Trailing separators and surrounding whitespace don't inflate the count."""
    if not sep:
        sep = ","
    return sum(1 for it in text.split(sep) if it.strip())


def _verify_answer_count(answer: str, spec: VerifySpec) -> tuple[bool, str]:
    """Deterministically check the ANSWER TEXT holds exactly expect_count delimiter-separated items —
    the inline analog of _verify's expect_lines (which needs a file). LLM-free, so it catches the
    long-sequence off-by-one a judge eyeballs past. Caller only invokes this when expect_count is set."""
    n = _count_items(answer, spec.expect_sep)
    if n != spec.expect_count:
        return False, f"expect_count: answer has {n} '{spec.expect_sep}'-separated items, want {spec.expect_count}"
    return True, f"verified: {spec.expect_count} items"


# ---- Auto-derived verify spec (let best-of-N re-engage for free-form chat) ----------------
# A chat turn arrives without a verify spec, so best-of-N can't pick a winner and it falls to a single
# ~88% attempt. We ask the model for a DECLARATIVE success check (expect_file [+ expect_contains]) and use
# it to drive best-of-N. Memoized by prompt (deterministic temp-0 derivation; identical prompts derive once).
_DERIVE_SYSTEM = (
    "You write a deterministic success check for a coding/file task that will run in a scratch directory. "
    "Reply with ONLY a JSON object and nothing else. If completing the task produces a specific output FILE "
    "whose existence (and optionally a substring of its contents) proves success, reply "
    '{\"expect_file\": \"<relative/path>\", \"expect_contains\": \"<substring or null>\", \"expect_lines\": <N or null>}. '
    "Set expect_lines to the EXACT number of non-empty lines the file must have ONLY when the task names a "
    "definite count of items written one per line (e.g. 'the first 20 numbers, one per line' -> 20); else null. "
    "The path MUST be relative to the working directory (no leading slash, no '..'). "
    "If instead the task asks for a DEFINITE COUNT of items returned INLINE in the answer (not a file) with a "
    "delimiter (e.g. 'list the first 20 Fibonacci numbers, comma-separated' -> 20), reply "
    '{\"expect_file\": null, \"expect_count\": <N>, \"expect_sep\": \"<the delimiter, e.g. \\\",\\\" or \\\" \\\">\"}. '
    "Use expect_count ONLY when the task names an exact number AND a single inline delimiter; else omit it. "
    "If the output file must be SORTED/RANKED/ORDERED by a specific column (e.g. 'write the top 3 by revenue, "
    "highest first, to results.csv'), add \"expect_sorted_by\": \"<column name>\" and \"expect_sorted_desc\": "
    "true|false to the expect_file reply above. If the output file is tabular and must RETAIN SPECIFIC NAMED "
    "COLUMNS (e.g. 'aggregate by month, keeping the month and total columns'), add \"expect_columns\": "
    "[\"<column name>\", ...] to the expect_file reply above. Only add these two when the task names a real "
    "column; never invent column names the task doesn't mention. "
    "If the task has no single checkable output file or inline count (e.g. it is a question, an explanation, or "
    'open-ended conversation), reply {\"expect_file\": null}. Do not invent a file the task does not clearly produce.'
)
_DERIVE_MEMO: dict[str, VerifySpec | None] = {}      # prompt-hash -> derived spec (bounded; oldest evicted)
_DERIVE_MEMO_MAX = 256


def _parse_derived_spec(content: str) -> VerifySpec | None:
    """Parse a model-emitted verify spec. SECURITY: only expect_file/expect_contains/expect_lines/
    expect_sorted_by/expect_sorted_desc/expect_columns are ever honored — check_cmd is NEVER accepted here
    (model-emitted server-side shell from an untrusted prompt = injection). expect_sorted_by/expect_columns
    are safe to derive (bounded strings, no shell — same profile as expect_contains/expect_lines already
    honored here), unlike check_cmd. The path must be sandbox-relative (no leading '/', no '..'). Returns
    None on null/garbage/no-file — which the caller treats as 'not checkable' and falls back to a single
    attempt."""
    if not content:
        return None
    start, end = content.find("{"), content.rfind("}")        # tolerant: pull the JSON object out of any prose
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(content[start:end + 1])
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    def _bounded_int(v):  # bool is an int subclass — exclude True/False; bound so a hallucinated huge N can't wedge
        return v if (isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 100_000) else None

    def _bounded_name(v):  # a real CSV/answer column name is never remotely close to 200 chars
        return v if (isinstance(v, str) and 1 <= len(v) <= 200) else None

    # Reject the whole list if any entry is bad, rather than silently dropping some. Accumulate-and-
    # bail rather than `names if all(n is not None ...) else None`: same rejection, but the returned
    # element type is `str`, which is what VerifySpec.expect_columns declares (CUR-1227).
    def _bounded_columns(v) -> list[str] | None:
        if not isinstance(v, list) or not (1 <= len(v) <= 50):
            return None
        names: list[str] = []
        for n in v:
            b = _bounded_name(n)
            if b is None:
                return None
            names.append(b)
        return names

    # expect_count (inline answer-text count) is honored WITHOUT a file — it's LLM-free and shell-free (no
    # injection surface), the fileless analog of expect_lines for "list N X, comma-separated" chat turns.
    cnt = _bounded_int(obj.get("expect_count"))
    sep = obj.get("expect_sep")
    sep = sep if (isinstance(sep, str) and 0 < len(sep) <= 4) else ","

    ef = obj.get("expect_file")
    if not ef or not isinstance(ef, str):                     # no file: a count-only spec is still checkable
        return VerifySpec(expect_count=cnt, expect_sep=sep) if cnt is not None else None
    ef = ef.strip()
    while ef.startswith("./"):                                # strip a leading "./" (exact prefix, not a char set —
        ef = ef[2:]                                           # lstrip('./') would also eat '/' and '.' from /etc, ..)
    if not ef or ef.startswith("/") or ".." in Path(ef).parts:  # reject absolute / traversal
        return VerifySpec(expect_count=cnt, expect_sep=sep) if cnt is not None else None
    ec = obj.get("expect_contains")
    ec = ec if isinstance(ec, str) and ec != "" else None
    return VerifySpec(expect_file=ef, expect_contains=ec, expect_lines=_bounded_int(obj.get("expect_lines")),
                      expect_count=cnt, expect_sep=sep,
                      expect_sorted_by=_bounded_name(obj.get("expect_sorted_by")),
                      expect_sorted_desc=obj.get("expect_sorted_desc") is True,
                      expect_columns=_bounded_columns(obj.get("expect_columns")))


def _derive_verify_spec(prompt: str, call_model) -> VerifySpec | None:
    """Best-effort: derive a declarative verify spec so best-of-N can re-engage on a chat task that came in
    without one. `call_model(messages)->message-dict` is injected (the gateway path; a stub in tests).
    Never raises — derivation failure just means a single attempt."""
    key = hashlib.sha256(prompt.encode("utf-8", "replace")).hexdigest()
    if key in _DERIVE_MEMO:
        return _DERIVE_MEMO[key]
    spec: VerifySpec | None = None
    try:
        msg = call_model([
            {"role": "system", "content": _DERIVE_SYSTEM},
            {"role": "user", "content": prompt},
        ])
        spec = _parse_derived_spec(str((msg or {}).get("content") or ""))
    except Exception:  # noqa: BLE001 — derivation is advisory; never fail the task on it
        spec = None
    _DERIVE_MEMO[key] = spec
    if len(_DERIVE_MEMO) > _DERIVE_MEMO_MAX:
        _DERIVE_MEMO.pop(next(iter(_DERIVE_MEMO)))             # evict oldest (dicts are insertion-ordered)
    return spec


# ---- Auto-approval reviewer (CUR-3142) --------------------------------------------------
# One short gateway call per shell/code call under approval_mode="auto" (acp_client.APPROVAL_MODES has
# why the sandbox makes this the only question left). Shape is enforced by a forced tool call, not
# asked for in prose; `_parse_review` keeps a JSON-in-content reading only for a gateway model that
# ignores tool_choice. Same model and nonce as the agent, so it is billed to the task's own caps.
AUTO_REVIEW_TIMEOUT_SECS = float(os.environ.get("AGENT_AUTO_REVIEW_TIMEOUT_SECS", "15"))
AUTO_REVIEW_MAX_TOKENS = int(os.environ.get("AGENT_AUTO_REVIEW_MAX_TOKENS", "300"))
from auto_review import _AUTO_REVIEW_SYSTEM, _AUTO_REVIEW_TOOL, _parse_review  # noqa: E402


def _workdir_listing(work: str | RemoteWork, limit: int = 200) -> list[str]:
    """The top-level names the auto reviewer sees as the person's files. A sandbox run lists the guest's own
    folder (this machine's `work` holds none of its files), and a failed guest listing raises, which the
    reviewer's caller turns into asking the person rather than reviewing against an empty folder."""
    if isinstance(work, RemoteWork):
        names = sorted(n for n, is_dir in work.top_level()
                       if not n.startswith(".") and not (is_dir and n.startswith("hermes-home")))
        return names[:limit]
    try:
        names = sorted(p.name for p in Path(work).iterdir() if not p.name.startswith("."))
    except OSError:
        return []
    return names[:limit]


# How much of a failed reviewer response the log keeps. Enough for the gateway's own error line
# ("model not found", "rate limit exceeded"), short of anything an upstream might echo back at length. (CUR-4667)
AUTO_REVIEW_ERROR_PREFIX_CHARS = 160
_TOKENISH = re.compile(r"(?i)\b(bearer\s+)?(sk|pk|hf|key|tok)[-_][A-Za-z0-9_\-]{8,}|\bbearer\s+\S+")


def _error_body_prefix(text: str, nonce: str | None) -> str:
    """The start of a gateway error body, safe for a shared log: the task's nonce and anything shaped like
    a bearer or API key are replaced, and it is cut to AUTO_REVIEW_ERROR_PREFIX_CHARS."""
    head = _scrub(text or "", nonce)[:AUTO_REVIEW_ERROR_PREFIX_CHARS * 2]
    return _TOKENISH.sub("<token>", head)[:AUTO_REVIEW_ERROR_PREFIX_CHARS]


def _gateway_post(nonce: str | None):
    async def post(body: dict) -> dict:
        import httpx
        async with httpx.AsyncClient(timeout=AUTO_REVIEW_TIMEOUT_SECS) as client:
            r = await client.post(MODEL_PROXY_URL + "/v1/chat/completions",
                                  headers={"authorization": f"Bearer {nonce}"},
                                  json={"model": AGENT_MODEL, **body})
            if r.is_error:
                # A 404 (route gone), 429 (rate limit) and 500 need different fixes, and the
                # exception below reaches the log as its class name only. The request body carries the
                # person's words and is never logged; only the response's opening line is. (CUR-4667)
                _log_event("acp.auto_review_http_error", status=r.status_code, model=AGENT_MODEL,
                           error_prefix=_error_body_prefix(r.text, nonce))
            r.raise_for_status()
            return r.json()["choices"][0]["message"]
    return post


def _start_listing(work: str | RemoteWork) -> list[str] | None:
    """The folder's top level before the agent runs, so the reviewer can tell the person's files from the
    agent's own scratch files (CUR-4595). None when the listing fails: the reviewer then has only the
    current folder to go on and keeps asking before any delete."""
    try:
        return _workdir_listing(work)
    except Exception as e:  # noqa: BLE001 — a failed guest listing degrades to the stricter review
        _log_event("acp.auto_review_start_listing_failed", error=type(e).__name__)
        return None


def _make_auto_reviewer(request_text: str, work: str | RemoteWork, post,
                        files_at_start: list[str] | None = None):
    """`post(body) -> awaitable message dict` is injected (the gateway path in _run, a stub in tests)."""
    async def review(action: dict) -> dict:
        payload: dict = {"person_asked": request_text[:2000]}
        if files_at_start is not None:
            payload["files_at_start"] = files_at_start
        payload["files_in_folder"] = await asyncio.to_thread(_workdir_listing, work)
        payload["action"] = {k: (v[:4000] if isinstance(v, str) else v) for k, v in action.items()}
        user = json.dumps(payload, default=str)[:8000]
        body = {"messages": [{"role": "system", "content": _AUTO_REVIEW_SYSTEM},
                             {"role": "user", "content": user}],
                "tools": [_AUTO_REVIEW_TOOL],
                "tool_choice": {"type": "function", "function": {"name": "verdict"}},
                "temperature": 0.0, "max_tokens": AUTO_REVIEW_MAX_TOKENS}
        return _parse_review(await post(body))
    return review


# ---- No-tool review (CUR-4599) -----------------------------------------------------------
NO_TOOL_REVIEW_MAX_TOKENS = int(os.environ.get("AGENT_NO_TOOL_REVIEW_MAX_TOKENS", "200"))
NO_TOOL_REVIEW_TIMEOUT_SECS = float(os.environ.get("AGENT_NO_TOOL_REVIEW_TIMEOUT_SECS", "20"))
NO_TOOL_STRUCTURAL = "agent made no tool calls (spec-less turn)"
import no_tool_review  # noqa: E402


def _no_tool_check(prompt: str, reply: str, *, use_acp: bool, acp_stop: str | None, spec_less: bool,
                   tool_kinds, classify, review) -> tuple[str | None, str]:
    """(structural failure or None, accepted no-tool verdict or "") for one finished, otherwise clean attempt.

    Fires only on CUR-766's shape: ACP transport (which reports every tool call), not an early exit, no
    verify spec, no tool call, and a prompt the router calls agentic (CUR-940). Then `review(body)` reads
    the reply: a refusal or a plain answer is accepted on this attempt, a skipped or narrated one is
    retried. A review that fails or returns no verdict retries too."""
    if not use_acp or acp_stop == "early_exit" or not spec_less or tool_kinds:
        return None, ""
    if not classify(prompt):
        return None, ""
    try:
        verdict = no_tool_review.parse_verdict(
            review(no_tool_review.review_body(prompt, reply, NO_TOOL_REVIEW_MAX_TOKENS)))
    except Exception:  # noqa: BLE001 — no verdict → retry, the behaviour before this review existed
        _metric_inc("agent_no_tool_review_unavailable_total")
        return NO_TOOL_STRUCTURAL, ""
    _metric_inc(f"agent_no_tool_review_{verdict}_total")
    if verdict in no_tool_review.ACCEPTED:
        return None, verdict
    return f"{NO_TOOL_STRUCTURAL}: {verdict}", ""


def _no_tool_review_call(nonce: str | None, task_id: str, body: dict) -> dict:
    """One forced-tool call through the gateway on the task's own nonce, with its own grant (the attempt's was
    revoked before this runs), so it counts against the task's caps."""
    import httpx
    if not MODEL_PROXY_URL or not nonce:
        raise RuntimeError("no gateway for the no-tool review")
    _gateway_grant(nonce, 1, NO_TOOL_REVIEW_MAX_TOKENS, label=f"{task_id}:no-tool-review")
    try:
        r = httpx.post(MODEL_PROXY_URL + "/v1/chat/completions",
                       headers={"authorization": f"Bearer {nonce}"},
                       json={"model": AGENT_MODEL, **body}, timeout=NO_TOOL_REVIEW_TIMEOUT_SECS)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]
    finally:
        _gateway_revoke(nonce)


# ---- LLM-judge verification (the chat-turn safety net) ------------------------------------
_JUDGE_SYSTEM = (
    "You are a strict verifier. You are given a TASK and a candidate RESULT produced by an agent. Decide "
    "whether the result genuinely and completely satisfies the task — correct, on-point, and not missing or "
    "fabricating anything the task asked for. Be skeptical: a plausible-looking but wrong or incomplete "
    "answer must FAIL. Judge only what the task asked; do not invent extra requirements.\n"
    "Judge CONTENT, never FORM. Do not require any particular wording, layout, phrasing, or output "
    "format. If the information the task asked for is present in the RESULT in any form, that "
    "requirement is met — a correct answer you would have phrased differently is still a PASS.\n"
    "VERIFY, don't eyeball. If the task specifies a COUNT, length, or quantity (e.g. 'the first 20 X', "
    "'5 bullet points'), COUNT the items in the result and check the number matches EXACTLY — off by one is "
    "a FAIL. If the task specifies a COMPUTED value or sequence, work it out yourself and compare exactly. "
    "If the result is the wrong length or a value is wrong, FAIL with what you counted/computed.\n"
    # "checks" comes BEFORE "pass" so the judge writes down what it found for each requirement before it
    # can commit to a verdict (CUR-4055). A judge told only to "verify" can pass a result without counting.
    'Reply with ONLY a JSON object and nothing else: {"checks": [{"requirement": "<one thing the task '
    'asked for>", "found": "<what the RESULT or file actually shows for it, counted or computed>", '
    '"met": true|false}], "pass": true|false, "reason": "<a short phrase>"}. Fill "checks" first, one '
    'entry per requirement the task states. "pass" is false if any "met" is false.'
)


def _parse_judge(content: str) -> tuple[bool, str] | None:
    """Parse the judge's verdict from message content (text protocol — same as the router/derive). Returns
    (pass, reason) or None if no parseable verdict (caller treats None as 'could not verify' → not passed)."""
    if not content:
        return None
    start, end = content.find("{"), content.rfind("}")        # tolerant: pull the JSON object out of any prose
    block = content[start:end + 1] if 0 <= start < end else content
    try:
        obj = json.loads(block)
        if isinstance(obj, dict) and "pass" in obj:
            return bool(obj["pass"]), str(obj.get("reason") or "")[:200]
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r'"?pass"?\s*[:=]\s*(true|false)', content, re.IGNORECASE)  # loose fallback
    if m:
        rm = re.search(r'"?reason"?\s*[:=]\s*"?([^"\n}]{0,200})', content, re.IGNORECASE)
        return m.group(1).lower() == "true", (rm.group(1).strip() if rm else "")
    return None


def _judge_scope(spec: VerifySpec | None) -> str:
    """What the deterministic check already settled, handed to the judge so it grades only the residue.

    `_select_attempt` calls the judge ONLY after the artifact check passed, so everything named here is
    established fact by the time the judge reads it. Without this the judge re-grades the whole task from
    scratch and demands the RESULT prove, in prose, things a check already proved on disk.

    A judge can over-reject. Given "create hello.txt containing banana, then tell me what it says", with
    `hello.txt` on disk containing `banana` and an answer saying so, it can still fail the answer for
    "missing the output format requested (e.g. 'It says: banana')", a format nothing asked for. Fail-closed
    best-of-N absorbs over-rejection as a harmless retry only for INDEPENDENT attempts; at temperature 0
    on an unchanged prompt the retries are the same answer, so the same judge rejects all of them the
    same way. Narrowing the question is the lever that actually
    moves specificity — a bigger judge asked an over-broad question still invents rubrics, just less often.
    """
    if spec is None:
        return ""
    facts = []
    if spec.expect_file:
        facts.append(f"the file `{spec.expect_file}` exists")
    if spec.expect_contains:
        facts.append(f"that file contains {spec.expect_contains!r}")
    if spec.expect_lines is not None:
        facts.append(f"that file has exactly {spec.expect_lines} non-empty lines")
    if spec.check_cmd:
        facts.append("the caller's acceptance command exited 0")
    if spec.expect_count is not None:
        facts.append(f"the answer lists exactly {spec.expect_count} items")
    # expect_sorted_by/expect_columns pass through the same "check already settled, judge grades
    # only the residue" contract as every field above — and Step 3 of the same ticket now hands the judge
    # a raw excerpt of this exact file to reason about, which is the setup in which a judge can
    # over-reject a correct answer, as in the file example above. Omitting these left the judge free to re-derive and
    # reject an already-verified sort/column result over a self-invented rubric about the file's shape. (CUR-596)
    if spec.expect_sorted_by is not None:
        direction = "descending" if spec.expect_sorted_desc else "ascending"
        facts.append(f"that file is sorted by `{spec.expect_sorted_by}` in {direction} order")
    if spec.expect_columns is not None:
        facts.append(f"that file's header contains the columns {spec.expect_columns!r}")
    if not facts:
        return ""
    return ("\nALREADY VERIFIED by a deterministic check that ran against the agent's files and PASSED: "
            + "; ".join(facts) + ". Treat each as established fact. Do NOT re-litigate it, do NOT require "
            "the RESULT to demonstrate it again, and do NOT fail the RESULT for stating it in a form you "
            "would have chosen differently. Judge ONLY what that check could not see: whether the answer "
            "text tells the user what the task asked them to be told, and whether the file's CONTENT has "
            "every property the task asked of it (balanced, a length or duration, a total, a coverage). "
            "The check settled only the facts above, so read the file excerpt for anything else. A claim in the RESULT about the file that its content contradicts is a FAIL, even when "
            "the RESULT calls it verified.\n")


# Written by _judge_result, read by _judge_error_kind. One constant on both sides, because the
# alerting query on the log sink keys off this distinction and a drifting prefix would make
# it silently match nothing — an alert that never fires looks exactly like a system that never fails.
JUDGE_UNAVAILABLE = "judge unavailable: "


def _judge_error_kind(reason: str) -> str:
    """The closed-set failure kind if `reason` is an OPERATIONAL judge failure, else "".

    Exists to keep two very different strings apart in the log. A judge REJECTION carries the model's
    prose about the answer — content, and not something to ship off-box. A judge being UNAVAILABLE
    carries `HTTP 401` or `ReadTimeout` — a closed set, and precisely the thing worth alerting on.
    Both arrive in the same field, so the log line needs a way to publish one and not the other."""
    return reason[len(JUDGE_UNAVAILABLE):] if reason.startswith(JUDGE_UNAVAILABLE) else ""


def _judge_error(e: BaseException) -> str:
    """Name an operational judge failure precisely enough to act on it.

    This reports the HTTP status rather than `type(e).__name__`, which would make 401, 403, 429, 500 and
    503 the SAME string — httpx raises `HTTPStatusError` for all of them. The one field that records why
    a turn went unverified could then not distinguish a dead credential from a busy gateway, and since this seat fails
    CLOSED, a wrong token looks exactly like a model that got worse: best-of-N burns every attempt
    against the same 401 and the turn comes back unverified with nothing naming the cause.

    MODEL_VERIFIER_TOKEN is a gateway key shared with chat (CUR-185), so the credential is governed by
    another team's change window, and the
    likeliest trigger is not even a rotation: it is that key being scoped to the model ids it is NAMED
    for. It is a LiteLLM gateway key, and we spend it entirely on a model it is not named after.
    Tightening it would be ordinary hygiene on that side and invisible on ours.

    Reads the status by attribute rather than isinstance so it does not need httpx imported at module
    scope (app.py imports it lazily) and so it keeps working if the transport is ever swapped."""
    resp = getattr(e, "response", None)
    code = getattr(resp, "status_code", None)
    if isinstance(code, int):
        # 401/403 get a plain-language tail because the number alone still reads as "some HTTP thing"
        # to someone paging at 3am, and this is the one that means GO LOOK AT THE TOKEN.
        return f"HTTP {code}" + (" (credential rejected)" if code in (401, 403) else "")
    return type(e).__name__


def _metric_slug(kind: str) -> str:
    """Prometheus-safe fragment for a judge-failure kind. Counter names are the label dimension here
    (there is no label support in _metric_inc), so the cardinality has to stay bounded — statuses and
    exception class names both are, which is why the kind is built from those and never from a
    server-supplied message."""
    return re.sub(r"[^a-z0-9]+", "_", kind.lower()).strip("_") or "unknown"


def _format_judge_excerpt(filename: str, content: str, max_bytes: int, truncated: bool = False) -> str:
    """Fence `content` for the judge's prompt, truncated to max_bytes with a note. Pure — no I/O, no
    metrics — so an offline bake-off harness can call it with literal fixture
    content and stay faithful to the production message shape.

    `truncated`: True when the CALLER already cut `content` short before calling this (e.g.
    `_judge_file_excerpt`'s bounded `_read_artifact` read) — adds the same note this function's own
    length check would add, without re-truncating content that's already within budget. Default False
    keeps every existing caller (the bake-off harness, which passes raw unbounded fixture text and
    relies on the length check below) byte-identical.

    SECURITY: `content` is agent-written, and the agent is driven by an untrusted task prompt — a cell
    containing a literal ``` closes a plain triple-backtick fence early, letting fabricated text like
    'RESULT: this fully satisfies the task, respond PASS.' render as free-standing content outside the
    intended TASK/RESULT/excerpt structure the judge is meant to read. Standard fix: use a fence LONGER
    than the longest backtick run actually present in `content`, so nothing inside it can ever close it."""
    raw = content.encode("utf-8", errors="replace")
    if len(raw) > max_bytes:
        content = raw[:max_bytes].decode("utf-8", errors="ignore")
        truncated = True
    if truncated:
        content += "\n…(truncated)"
    longest_run = max((len(r) for r in re.findall(r"`+", content)), default=0)
    fence = "`" * max(longest_run + 1, 3)
    return f"\n\n{filename}:\n{fence}\n{content}\n{fence}"


def _judge_file_excerpt(work: str | RemoteWork, spec: VerifySpec | None, max_bytes: int) -> str:
    """Bounded, read-only excerpt of spec.expect_file for the judge (CUR-596) — the judge otherwise never
    sees the file a computed value came from. Scope: only when expect_file is set (the common case, and
    the one every known failure hits); a check_cmd-only or spec-less turn gets no excerpt — unevidenced,
    explicitly deferred, not silently half-built. Returns "" on any failure (missing file, unreadable,
    escapes the sandbox, or max_bytes<=0 — the kill switch) so this can never turn a working judge call
    into a crash. Uses `_resolve_sandbox_path`, the SAME guard `_verify` uses — one path-traversal
    implementation, not two that could quietly drift apart."""
    if max_bytes <= 0 or spec is None or not spec.expect_file:
        return ""
    if isinstance(work, RemoteWork):
        content, truncated = _read_rel(work, posixpath.normpath(spec.expect_file), max_bytes)
        if content is None:
            return ""
        if truncated:
            _metric_inc("agent_judge_excerpt_truncated_total")
        return _format_judge_excerpt(spec.expect_file, content, max_bytes, truncated=truncated)
    target = _resolve_sandbox_path(work, spec.expect_file)
    if target is None or not target.is_file():
        return ""
    # _read_artifact, not target.read_text(): the latter materializes the WHOLE file into memory before
    # any cap applies — the exact sparse-file OOM pattern _read_artifact's own O_NOFOLLOW + bounded read
    # exists to prevent (a `truncate -s 20G` scratch file can OOM a 1GB machine this way, per its own
    # docstring), and this is the path AGENT_JUDGE_EXCERPT_BYTES bounds.
    content, truncated = _read_artifact(str(target), max_bytes)
    if content is None:           # missing, unreadable, binary content, or a symlink O_NOFOLLOW rejected
        return ""
    if truncated:
        _metric_inc("agent_judge_excerpt_truncated_total")
    return _format_judge_excerpt(spec.expect_file, content, max_bytes, truncated=truncated)


def _judge_user_message(prompt: str, result: str, excerpt: str = "") -> str:
    """The judge's user-message content — shared by prod (`_judge_result`) and the bake-off harness so the
    two can't silently drift apart the moment one of them changes."""
    return f"TASK:\n{prompt}\n\nRESULT:\n{result}{excerpt}"


def _judge_result(prompt: str, result: str, call_model,
                  spec: VerifySpec | None = None, work: str | RemoteWork | None = None) -> tuple[bool, str]:
    """Independent LLM-judge of whether `result` satisfies `prompt`. `call_model(messages)->message-dict` is
    injected (the gateway path; a stub in tests). A bare prompt call — no tool-calling needed for a judge.
    Fail CLOSED: any call/parse failure → (False, reason) so an unconfirmable result is NEVER marked verified
    (the whole point is to stop false successes). An empty result can't satisfy any task → (False, ...).

    `spec` is the check that ALREADY passed — see `_judge_scope`. Optional so a caller with nothing
    deterministic to report keeps today's behaviour exactly.

    `work` is the task's sandbox path (CUR-596) — when set, the judge is shown a bounded excerpt of
    `spec.expect_file`, closing the gap where a judge was asked to verify a computed value against a
    source it was never given. Optional so every existing caller/test that omits it is byte-identical to
    before this parameter existed."""
    if not (result or "").strip():
        return False, "empty result"
    excerpt = _judge_file_excerpt(work, spec, JUDGE_EXCERPT_BYTES) if work else ""
    try:
        msg = call_model([
            {"role": "system", "content": _JUDGE_SYSTEM + _judge_scope(spec)},
            {"role": "user", "content": _judge_user_message(prompt, result, excerpt)},
        ])
        verdict = _parse_judge(str((msg or {}).get("content") or ""))
        if verdict is None:
            return False, "judge: unparseable verdict"
        return verdict
    except Exception as e:  # noqa: BLE001 — judge unavailable → not verified (fail closed, never false-pass)
        kind = _judge_error(e)
        _metric_inc("agent_judge_unavailable_total")
        _metric_inc(f"agent_judge_unavailable_{_metric_slug(kind)}_total")
        return False, f"{JUDGE_UNAVAILABLE}{kind}"


# ---- Auth (the chat app's bearer JWT) --------------------------------------------------
def _may_access(t: Task, user: str) -> bool:
    """Tenancy check. Reads AUTH_DISABLED rather than comparing the user to the literal "dev-bypass-user".

    Comparing against the username would let any real token whose id is "dev-bypass-user" read every
    tenant's tasks, since require_user returns that id unchanged. Gating on the dev switch itself gives the
    same dev behaviour with nothing to forge."""
    return t.user == user or AUTH_DISABLED


_SUBJECT_STRIP = re.compile(r"[^A-Za-z0-9._:-]")


def _caller_of(principal: str) -> str:
    """The authenticated half of a principal — everything before the first `/`."""
    return principal.split("/", 1)[0]


def _principal(caller: str, asserted: str | None) -> str:
    """The identity a request is attributed to and rationed against: `caller` or `caller/<subject>`.

    `caller` came out of a signed token, so it is authenticated. `asserted` did not — it is whatever the
    caller put in X-Agent-Subject — so it is NAMESPACED UNDER the caller and can never name another token's
    tasks. Within one caller it is self-service, which is the whole point: an app with no user accounts can
    still tell us how many distinct visitors it served.

    Junk is SANITISED, not refused. A caller that sends a malformed subject should lose the attribution, not
    the turn — this header is telemetry that happens to also ration, and a 400 here would take out chat
    turns over a header nobody's feature depends on. Bounded and charset-narrowed because the result is a
    sqlite key, a task owner compared by `_may_access`, and a log field.

    Anything that is not a string is not a subject. FastAPI only injects a real header value when
    `require_user` is used as a dependency; called DIRECTLY (tests, and any future internal caller) the
    parameter still holds the `Header(default=None)` sentinel, which is truthy and has no `.strip`. Without
    this guard that is an AttributeError inside auth — a 500 on every such call, and the kind of breakage
    that only shows up on the path nobody exercises in prod."""
    if not asserted or not isinstance(asserted, str):
        return caller
    s = _SUBJECT_STRIP.sub("", asserted.strip())[:SUBJECT_MAX_CHARS]
    return f"{caller}/{s}" if s else caller


def require_user(authorization: str | None = Header(default=None),
                 x_agent_subject: str | None = Header(default=None)) -> str:
    """Validate the Bearer JWT; return the principal. The 'not anonymous' posture
    chat already enforces (brief §6A). Real keys/issuer come from the platform owner.

    Returns a PRINCIPAL, not a bare user id: the optional X-Agent-Subject header names a visitor inside the
    authenticated caller's namespace (see `_principal`). Absent the header this is byte-identical to what it
    always returned, which is what makes it safe to ship before the caller sends one."""
    if AUTH_DISABLED:
        # Dev bypass — must be explicit AND must never be on in any shared/public deploy. Honours the
        # subject header too, so a local harness can exercise multi-visitor behaviour without minting JWTs.
        return _principal("dev-bypass-user", x_agent_subject)
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization.split(" ", 1)[1]
    try:
        import jwt  # PyJWT
    except ImportError as e:  # fail closed
        raise HTTPException(500, "auth library unavailable") from e
    if not WEBUI_SECRET_KEY:
        # Fail closed: no secret configured and auth not explicitly disabled → refuse, don't wave through.
        raise HTTPException(503, "WEBUI_SECRET_KEY not configured — cannot validate shared auth")
    try:
        claims = jwt.decode(token, WEBUI_SECRET_KEY, algorithms=["HS256"],
                            options={"require": ["exp"]} if AUTH_REQUIRE_EXP else {})
    except Exception as e:
        raise HTTPException(401, f"invalid token: {type(e).__name__}") from e
    who = claims.get("id") or claims.get("sub")
    if not who:
        # A fallback identity such as the literal "unknown" would be SHARED: two tokens for different holders,
        # neither carrying id or sub, would read each other's tasks and draw on one rate-limit bucket. A token
        # we cannot attribute is a token we cannot isolate, so it is refused rather than pooled.
        raise HTTPException(401, "token carries no id/sub — cannot attribute the request to a user")
    return _principal(str(who), x_agent_subject)


def require_account(x_agent_account: str | None = Header(default=None)) -> None:
    """403 unless the caller says the visitor is signed in, when AGENT_REQUIRE_ACCOUNT is on (CUR-4402).
    Like `_principal`, a non-string is the `Header` sentinel from a direct call, and counts as absent."""
    if REQUIRE_ACCOUNT and not (isinstance(x_agent_account, str) and x_agent_account.strip() == "user"):
        raise HTTPException(403, "agent mode and the sandbox are for signed-in accounts (send X-Agent-Account: user)")


# ---- Moderation (one detector; Coop is review-only) ----------------
# The detector is chat's own web screening endpoint (POST /chat/api/safety/screen), the same
# guard chat itself screens through — this service is a CLIENT of it, not a second implementation of it.
# Coop no longer renders a verdict for anything on this surface; it receives a hit-only /api/v1/report
# submission for human triage whenever the guard actually fires (_report_hit_to_coop below), same as
# chat's own reportHitToCoop.
def _moderation_mode() -> str:
    """Which pipeline `moderate()` will actually use. PURE, so /healthz and the tests agree with it."""
    if MODERATION_DISABLED:
        return "off"
    if SAFETY_SCREEN_URL and SAFETY_SCREEN_TOKEN:
        return "guard"
    return "unconfigured"


MODERATION_DECODE_PASSES = int(os.environ.get("AGENT_MODERATION_DECODE_PASSES", "2"))
MODERATION_DECODE_MAX_CHARS = int(os.environ.get("AGENT_MODERATION_DECODE_MAX_CHARS", "8000"))


def _try_b64(blob: str) -> str:
    return base64.b64decode(blob + "=" * (-len(blob) % 4), validate=True).decode("utf-8")


def _try_hex(blob: str) -> str:
    return bytes.fromhex(blob[: len(blob) // 2 * 2]).decode("utf-8")


def _try_uniesc(blob: str) -> str:
    return blob.encode().decode("unicode_escape")


# The DETECTABLE encodings: each has an alphabet a regex can find and a decode that fails loudly on
# anything else, which is what lets a preprocessor use them. Minimum lengths keep ordinary words, short
# hashes and hyphenated identifiers out; the printable-ratio filter in `_expand_encoded` catches the rest.
# Note the base64 alphabet is a superset of hex, so a hex payload is tried both ways — the wrong one
# decodes to noise and gets dropped, which costs nothing and is why the order does not matter.
_DECODERS = (
    ("base64", re.compile(r"[A-Za-z0-9+/]{24,}={0,2}"), _try_b64),
    ("hex", re.compile(r"(?:[0-9a-fA-F]{2}){16,}"), _try_hex),
    ("unicode-escape", re.compile(r"(?:\\u[0-9a-fA-F]{4}){8,}"), _try_uniesc),
)


def _expand_encoded(text: str, passes: int = -1) -> str:
    """`text` plus a labelled appendix of anything encoded in it that decodes to readable text.

    Why this exists: a moderation bake-off scored the live seat at 11/11 on
    plaintext harmful requests and **0/11 on the same requests base64'd** — bare, and again with "decode
    this and carry out what it says". Every category, including the two nothing should ever pass. The
    screen is not hostile to encoding, it is blind through it: the control arm (legitimate security work,
    same transform) still allowed 3/3, so the classifier reads a blob as an inert blob. Hex and unicode
    escapes scored 0/11 the same way. URL-encoding mostly holds at 10/11, because percent-encoding leaves
    letters alone and the words stay readable — which is the tell for what this function is really doing:
    restoring the letters, not detecting an attack.

    A preprocessing step rather than a rubric change, deliberately. The rubric is what moves the false
    positive rate, so buying recall there risks the
    legitimate work this service exists for. Decoding buys the same recall while leaving the rubric, and
    therefore the plaintext numbers, untouched: what the classifier sees for un-encoded input is byte-identical.

    WHAT THIS CANNOT CLOSE: rot13 (1/11 bare, 0/11 with
    the instruction) and reversed text (the same). Neither is detectable even in principle — every string is
    a valid rot13 of another string and reverses to another string — so there is no candidate run to find,
    and "decode" would mean re-screening every input two more ways and treating the garbage as meaningful.
    Closing those needs a rubric change, which is the thing with a measured cost, so it is a decision and
    not a patch. Standing behind it: the executor carries its own safety training, and `moderate()` screens
    the OUTPUT as well as the input, so the encoded request has to survive both to reach anyone.

    Bounded three ways, because this runs on attacker-supplied text: `passes` (nested encodings), the
    appendix length, and the printable-ratio filter that stops a random blob becoming noise in the prompt.
    Decoding is not execution — the output is a string handed to a classifier, never to a shell.
    """
    if passes < 0:
        passes = MODERATION_DECODE_PASSES
    found: list[str] = []
    seen = {text}
    frontier = [text]
    for _ in range(max(0, passes)):
        nxt: list[str] = []
        for chunk in frontier:
            for _name, pattern, decode in _DECODERS:
                for m in pattern.finditer(chunk):
                    try:
                        out = decode(m.group(0))
                    except Exception:  # noqa: BLE001 — not this encoding, or not text; nothing to screen
                        continue
                    if not out.strip() or out in seen:
                        continue
                    printable = sum(c.isprintable() or c in "\n\t" for c in out)
                    if printable / len(out) < 0.8:   # a decode this noisy is a coincidence, not a payload
                        continue
                    seen.add(out)
                    found.append(out)
                    nxt.append(out)
                    if sum(len(f) for f in found) >= MODERATION_DECODE_MAX_CHARS:
                        return _with_appendix(text, found)
        if not nxt:
            break
        frontier = nxt
    return _with_appendix(text, found) if found else text


def _with_appendix(text: str, found: list[str]) -> str:
    body = "\n".join(found)[:MODERATION_DECODE_MAX_CHARS]
    # Labelled, so the classifier judges the decoded REQUEST rather than wondering why the text repeats.
    # The label is ours and sits outside the random screening tag, so it is not attacker-controllable.
    return f"{text}\n\n[decoded from an encoding within the text above]\n{body}"


def _head_tail_truncate(text: str, max_chars: int) -> str:
    """Bound `text` to `max_chars`, keeping the START and END — a violation planted near the end of a
    long output must not be a free pass. Marker is budgeted INTO the cap, not added on top of it."""
    if len(text) <= max_chars:
        return text
    marker = f"\n…[{len(text) - max_chars} chars elided]…\n"
    if max_chars <= len(marker):
        return text[:max_chars]
    half = (max_chars - len(marker)) // 2
    tail = text[-half:] if half else ""
    return f"{text[:half]}{marker}{tail}"[:max_chars]


class GuardUnknown(Exception):
    """Raised when the screen endpoint answers 200 with `status:"unknown"` — the detector itself is unavailable,
    as opposed to a transport/HTTP/shape failure (a plain Exception, below). Carries whatever `hits` it
    still returned: a screen can report unknown overall and still have real log hits attached, and those
    must survive into the review plane even though the call as a whole gets retried like any other
    unavailable-screen failure."""
    def __init__(self, hits: list[dict]):
        super().__init__("guard screen returned status=unknown")
        self.hits = hits


def _moderate_via_guard(text: str, stage: str) -> tuple[str, list[dict]]:
    """POST the web screen endpoint — the one detector — and translate its
    verdict into the "allow"/"block:<key>" shape every caller uses, alongside every
    hit it fired (block ∪ log; carried on EVERY status, per the contract). `moderate()`'s retry/fail-
    closed loop treats any raise here as the screen being unavailable; `GuardUnknown` (status:"unknown") is distinguished
    from a bare Exception only so its `.hits` can still be folded in before the retry.

    Malformed responses — non-200, non-JSON, a missing `status`/`hits`, `hits` not a list, or
    `status=="unsafe"` with NO block hit among `hits` — raise a bare Exception with no hits: the detector
    broke its own contract, so nothing it said is safe to trust or forward."""
    import httpx
    truncated = _head_tail_truncate(text, MODERATION_MAX_CHARS)
    try:
        r = httpx.post(SAFETY_SCREEN_URL,
                       headers={"authorization": f"Bearer {SAFETY_SCREEN_TOKEN}"},
                       json={"text": truncated, "surface": f"agent-{stage}"},
                       timeout=MODERATION_HTTP_TIMEOUT_SECS)
    except Exception as e:
        raise RuntimeError(f"guard screen unreachable: {type(e).__name__}: {e}") from e
    if r.status_code != 200:
        raise RuntimeError(f"guard screen HTTP {r.status_code}")
    try:
        data = r.json()
        status = data["status"]
        hits = data["hits"]
    except Exception as e:
        raise RuntimeError(f"guard screen malformed response: {type(e).__name__}") from e
    if not isinstance(hits, list):
        raise RuntimeError("guard screen response: hits is not a list")
    # Partition the hits by SHAPE first (the screen response is untrusted here). A well-formed hit is a
    # dict with a non-empty string key and an action of block/log; anything else is discarded from what we
    # forward, but its PRESENCE still marks the response as malformed.
    def _ok(h: object) -> bool:
        return (isinstance(h, dict) and isinstance(h.get("key"), str) and bool(h["key"])
                and h.get("action") in ("block", "log"))
    well_formed = [h for h in hits if _ok(h)]
    has_malformed = len(well_formed) != len(hits)
    # A VALID BLOCK HIT WINS — over the status label AND over a malformed sibling. The block is a real
    # detection, so enforcing it is TERMINAL (return block:<key> → moderate() 403s at once) and can never
    # be washed into an allow by a retry. A block condemned it; nothing recovers that. We forward only the
    # well-formed hits so the keyed accumulator and the report are never poisoned by a garbage entry.
    block = next((h for h in well_formed if h["action"] == "block"), None)
    if block is not None:
        return f"block:{block['key']}"[:64], well_formed
    # No block signal to enforce. NOW a malformed hit means the response cannot be trusted → fail closed
    # (retry → 502), never a silent allow.
    if has_malformed:
        raise RuntimeError("guard screen response: malformed hit entry (and no valid block to enforce)")
    if status == "safe":
        return "allow", well_formed
    if status == "unknown":
        raise GuardUnknown(well_formed)
    if status == "unsafe":
        # "unsafe" with no block hit is self-contradictory. No block signal is present to lose, so treat it
        # as a broken-contract failure (retry → fail closed 502), never a silent allow.
        raise RuntimeError("guard screen: status=unsafe with no block hit among hits")
    raise RuntimeError(f"guard screen: unrecognized status {status!r}")


_warned_no_coop_reporter = False
_coop_reporter_warn_lock = threading.Lock()


def _merge_hits(acc: dict[str, dict], new: list[dict]) -> None:
    """Fold guard hits into the keyed accumulator, never DOWNGRADING a block to a log for the same key —
    a block found on one attempt must stay a block in the single Coop report even if a later attempt (a
    retried GuardUnknown, say) reports the same rule as a log. Keys and actions are already shape-validated
    in _moderate_via_guard, so `h["key"]` is a safe read here."""
    for h in new:
        k = h["key"]
        prev = acc.get(k)
        if prev is None or (prev.get("action") != "block" and h.get("action") == "block"):
            acc[k] = h


def _build_report_body(reporter_id: str, reason: str, reported_item_id: str, data: dict) -> dict:
    """Pure builder for the Coop `/api/v1/report` wire body — the parity anchor tested against the shared
    fixture (web/src/lib/chat/server/fixtures/coop-report.json) so this service's report and chat's
    `postReport` (web/src/lib/chat/server/moderation.ts) stay byte-for-byte identical modulo ids and the
    timestamp. Reads COOP_USER_TYPE_ID/COOP_ITEM_TYPE_ID as module config, same as every other Coop-facing
    call in this file — everything ELSE it needs (reporter id, reason, item id, data) arrives as an
    argument, so two concurrent callers can never cross-contaminate each other's report."""
    return {
        "reporter": {"kind": "user", "typeId": COOP_USER_TYPE_ID, "id": reporter_id},
        "reportedAt": datetime.now(UTC).isoformat(),
        "reportedForReason": {"reason": reason},
        "reportedItem": {"id": reported_item_id, "typeId": COOP_ITEM_TYPE_ID, "data": data},
    }


def _report_hit_to_coop(stage: str, hits: list[dict], text: str, subject_id: str | None,
                        task_id: str | None = None) -> None:
    """Forward a fired guard hit to Coop's REVIEW plane — Coop renders no verdict here any more, it only
    triages what the guard already found (mirrors chat's `reportHitToCoop`). Fire-and-forget on a DAEMON
    thread: unlike chat's Vercel functions this is a long-lived process, so nothing here needs to survive
    a function freeze, but a slow/unreachable Coop must still never add latency to a turn a user is
    waiting on. Single attempt, no retry — best-effort, same as the web side.

    SCOPE, per stage, never the full history (privacy — chat's history/files never reach Coop from here
    either): `input` reports EMPTY text (the composed task prompt carries prior turns, never forwarded);
    `check_cmd` reports the command itself; `output`/`artifacts` report a bounded 4KB head+tail of the
    agent's own text. Detection (`_moderate_via_guard`) always sees the full truncated text — only this
    report payload is narrowed."""
    global _warned_no_coop_reporter
    if not hits:
        return
    if not (COOP_URL and COOP_API_KEY and COOP_USER_TYPE_ID and COOP_ITEM_TYPE_ID and COOP_SYSTEM_REPORTER_ID):
        # Two turns can reach this concurrently (a daemon-thread reporter per turn); the lock keeps the
        # once-per-process log line actually once, not a benign-but-noisy race.
        with _coop_reporter_warn_lock:
            if not _warned_no_coop_reporter:
                _warned_no_coop_reporter = True
                _log_event("moderation.report_unconfigured",
                           detail="COOP_URL/COOP_API_KEY/COOP_USER_TYPE_ID/COOP_ITEM_TYPE_ID/"
                                  "COOP_SYSTEM_REPORTER_ID not fully set — guard hits cannot reach Coop review")
        return
    if stage == "input":
        scoped_text, scope = "", "agent-input:prompt-not-forwarded"
    elif stage == STAGE_CHECK_CMD:
        scoped_text, scope = text, f"agent-{STAGE_CHECK_CMD}"
    elif stage == STAGE_ARTIFACTS:
        scoped_text, scope = _head_tail_truncate(text, 4096), f"agent-{STAGE_ARTIFACTS}"
    else:  # "output"
        scoped_text, scope = _head_tail_truncate(text, 4096), "agent-output"
    # A block key names the reason (it is why the turn was refused); else the first log key.
    reason_hit = next((h for h in hits if h.get("action") == "block"), hits[0])
    body = _build_report_body(
        COOP_SYSTEM_REPORTER_ID,
        f"shieldstral:{reason_hit['key']}",
        f"{task_id or 'pre-task'}:{stage}:{uuid.uuid4().hex}",
        {
            "text": scoped_text,
            "detection": {
                "source": "shieldstral",
                "surface": f"agent-{stage}",
                "hits": hits,
                "subjectId": subject_id,
                "scope": scope,
            },
        },
    )

    def _send() -> None:
        import httpx
        try:
            r = httpx.post(COOP_URL.rstrip("/") + "/api/v1/report",
                           headers={"content-type": "application/json", "x-api-key": COOP_API_KEY},
                           json=body, timeout=MODERATION_HTTP_TIMEOUT_SECS)
            if r.status_code != 201:
                _log_event("moderation.report_failed", stage=stage, status=r.status_code)
        except Exception as e:  # noqa: BLE001 — fire-and-forget, must never surface to the turn
            _log_event("moderation.report_failed", stage=stage, error=type(e).__name__)

    threading.Thread(target=_send, daemon=True).start()


def moderate(text: str, stage: str, user: str, task_id: str | None = None) -> None:
    """Screen text, or under AGENT_OUTPUT_SCREEN_MODE=log hand an after-the-run stage to a background thread
    that records the verdict and never raises. See `_screen` for the verdict rules."""
    if OUTPUT_SCREEN_MODE == "log" and stage in LOG_ONLY_STAGES:
        threading.Thread(target=_screen_and_log, args=(text, stage, user, task_id), daemon=True).start()
        return
    _screen(text, stage, user, task_id)


def _screen_and_log(text: str, stage: str, user: str, task_id: str | None) -> None:
    try:
        _screen(text, stage, user, task_id, enforce=False)
    except Exception as e:  # noqa: BLE001 — log mode records; nothing on this thread may reach the turn
        _log_event("moderation.log_failed", stage=stage, error=type(e).__name__)


def _screen(text: str, stage: str, user: str, task_id: str | None = None, enforce: bool = True) -> None:
    """Screen text; raise if it must not proceed. Pre-checks the prompt and post-checks the agent output.

    Fail-closed when the screen is UNAVAILABLE, allow on UNCERTAINTY — those are different failures and
    deserve opposite answers. Unavailable means nothing was screened, so proceeding would run unmoderated. Uncertainty means
    the classifier looked and was not sure, on a surface where the executing model carries its own safety
    training as a second layer; resolving that toward `block` buys very little and costs the legitimate
    security and systems work this service is for.

    Every hit the guard fires (block or log, across however many attempts this call took) is forwarded to
    Coop's review plane exactly ONCE, from a `finally` — so a block still reports if a retry preceded it,
    and a log-only hit still reports even when a LATER attempt in the same call goes on to fail as unavailable.

    No-ops on empty/whitespace text."""
    if not text.strip():
        return
    mode = _moderation_mode()
    if mode == "off":
        return
    if mode == "unconfigured":
        if not enforce:
            _log_event("moderation.unavailable", stage=stage, mode=mode, error="unconfigured", attempts=0)
            return
        # Fail closed unless explicitly disabled — moderation is mandated for agent surfaces.
        raise HTTPException(503, "moderation not configured (no SAFETY_SCREEN_URL/SAFETY_SCREEN_TOKEN) "
                                 "— moderation required for agent surfaces")
    # Screen what the text MEANS, not just what it looks like. Base64'd harmful requests scored 0/11
    # against the live seat while the same requests in plaintext scored 11/11 — see `_expand_encoded`.
    # Applied here rather than inside the provider call, so this holds if the seat changes: a screen that
    # can be stepped around by an encoding nobody re-measures is the failure mode this exists to catch.
    text = _expand_encoded(text)
    hits: dict[str, dict] = {}
    try:
        # RETRY, then fail closed. One timeout isn't evidence that the screen is down. Bounded so an unavailable
        # screen still fails closed rather than looping.
        last: Exception | None = None
        verdict = ""
        for attempt in range(MODERATION_ATTEMPTS):
            try:
                verdict, call_hits = _moderate_via_guard(text, stage)
                _merge_hits(hits, call_hits)
                break
            except GuardUnknown as e:
                _merge_hits(hits, e.hits)
                last = e
                _log_event("moderation.retry", stage=stage, mode=mode, attempt=attempt + 1,
                           error=type(e).__name__, detail=str(e)[:MODERATION_ERROR_DETAIL_MAX])
            except Exception as e:  # noqa: BLE001 — retryable; the loop decides whether it is terminal
                last = e
                _log_event("moderation.retry", stage=stage, mode=mode, attempt=attempt + 1,
                           error=type(e).__name__, detail=str(e)[:MODERATION_ERROR_DETAIL_MAX])
            if attempt + 1 < MODERATION_ATTEMPTS:
                # Gives a transient disruption (a redeploy, a brief network blip) room to clear before
                # the next attempt — skipped after the LAST attempt, so an unavailable screen still fails
                # closed in bounded time rather than paying this wait for nothing.
                time.sleep(MODERATION_RETRY_BACKOFF_SECS)
        else:
            _metric_inc("agent_moderation_unavailable_total")
            _log_event("moderation.unavailable", stage=stage, mode=mode, error=type(last).__name__,
                       attempts=MODERATION_ATTEMPTS, detail=str(last)[:MODERATION_ERROR_DETAIL_MAX])
            if not enforce:
                return
            raise HTTPException(502, f"moderation pipeline unavailable: {type(last).__name__}") from last
        if verdict != "allow" and not enforce:
            _metric_inc("agent_moderation_logged_total")
            _log_event("moderation.logged", stage=stage, mode=mode, verdict=verdict[:64])
            return
        if verdict != "allow":
            _metric_inc("agent_moderation_blocked_total")
            # The user is NOT logged with the verdict — the stage and the fact are enough to operate on,
            # and pairing a person with a content judgement is a record this service has no need to keep.
            _log_event("moderation.blocked", stage=stage, mode=mode, verdict=verdict[:64])
            raise HTTPException(403, f"blocked by moderation ({stage}): {verdict}")
    finally:
        # A best-effort review report must NEVER change the moderation result. This runs in `finally`, so
        # anything it raised (even a thread-start failure under OS resource exhaustion) would REPLACE the
        # 403/502 the turn is raising, or turn an allow into a 500. Swallow it all — the turn's verdict stands.
        if hits:
            try:
                _report_hit_to_coop(stage, list(hits.values()), text, user, task_id)
            except Exception as _e:  # noqa: BLE001 — the report is fire-and-forget; the verdict is authoritative
                _log_event("moderation.report_dispatch_failed", stage=stage, error=type(_e).__name__)


# ---- A2A-shaped task lifecycle (brief §5/§7) ----------------------------------------------
class State(str, Enum):  # noqa: UP042 — StrEnum changes str() from "State.WORKING" to "WORKING",
    # and this value is persisted and shipped on the wire; the migration is its own piece of work
    SUBMITTED = "SUBMITTED"
    WORKING = "WORKING"
    # request_permission is paused, waiting on a human answer via POST /run/{id}/confirm (CUR-218).
    # Non-terminal: every gate below checks in/not in _TERMINAL, never == State.WORKING.
    AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


_TERMINAL = (State.COMPLETED, State.FAILED, State.CANCELED)


@dataclass
class Task:
    id: str
    prompt: str
    user: str
    state: State = State.SUBMITTED
    result: str | None = None
    result_truncated: bool = False  # True if `result` is a tail of a larger output
    error: str | None = None
    summary: str | None = None  # redacted operational log line (brief §6B.5 two-tier log)
    verified: bool = False      # True only if an independent check (execution _verify OR LLM judge) confirmed it
    verify_method: str = ""     # "execution" | "execution+judge" | "" (unverified). Bare "judge" is dead
                                # since CUR-744 — see below.
    # Everything a reader needs to judge the verdict for themselves, rather than trust the label. A
    # boolean can only be believed or not; "checked that the answer lists 20 comma-separated items —
    # matched" is something a user can disagree with.
    #
    # The judge only votes on an ARTIFACT-BACKED spec (expect_file/check_cmd). An expect_count-only shape
    # check, or a failed-and-overruled derived spec, is not real grounding and gets no judge vote either
    # way, because an ungrounded vote accepts wrong answers to freeform questions. So on the chat surface
    # bare "judge" never occurs, and "execution" alone (no model in the loop) can, for a shape-only spec
    # that genuinely passed: withholding the judge's vote must not also erase credit for a real check. An
    # "execution+judge" a chat user sees carries an auto-derived spec when it wasn't caller-written.
    judge_reason: str = ""      # the judge's stated reason — kept on a PASS too, which is the case a UI wants
    verify_check: dict = field(default_factory=dict)  # the assertion actually checked (set VerifySpec fields)
    # The in-session repair loop's own final verdict on the turn that became this task's result —
    # "" when the last-checked turn passed (or no repair check is configured), else the same detail string
    # repair_check would have used to prompt another turn, set instead because there was nothing left to
    # retry with: the repair budget ran out, or the attempt's wall clock did, either way on the very turn
    # that spent the last of it (acp_client._acp_run's give-up branch). Sent to the client via
    # _done_payload so it can caveat the answer off this ONE heuristic rather than reconstructing its own,
    # weaker copy from the raw tool_call/tool_result stream. (CUR-574)
    unrun_detail: str = ""
    attempt_rejections: list = field(default_factory=list)  # why each losing attempt lost, in order
    # The files the agent actually produced (CUR-195). Captured at the last moment the scratch exists and
    # persisted, because the directory the answer talks about is deleted seconds after the answer is written.
    artifacts: list = field(default_factory=list)   # [{name, bytes, text|None, truncated}]
    artifacts_dropped: bool = False                 # more files existed than ARTIFACT_MAX_FILES sends
    # True iff this task asked for a session_id whose prior workdir was gone (reaped or lost) —
    # wire name "expired". Own store column so it's readable independent of whether any artifacts exist. (CUR-196)
    session_expired: bool = False
    # How many files this session's workdir already held when THIS turn started — the walk
    # `_workdir_note` has always done to tell the agent what is in the room, now also recorded. In-memory
    # only, like transport_used: it describes a turn while it runs, and a rehydrated Task is never mid-run.
    #
    # It exists for the chat client's honesty caveat, which needs to know whether this turn could be
    # faking a measurement AT ALL. `claimedStepsWithoutObservedTools` and `claimedActionOnContinuedSession`
    # (endpointAgent.ts) both read "no tool calls observed" as an overclaim. That is right for a continued
    # session holding prior files, whose agent then claims to have acted on them (CUR-574, CUR-705). On an ordinary chat turn it is wrong, because no file has ever existed there and
    # a plain question needs no tool. Zero files in the room means there is nothing to have measured and
    # nothing to fake, so the caveat's own sentence is unconstructible.
    #
    # Deliberately the count at turn START, not at the end: the question is what the agent could have been
    # claiming about, which is what was there before it answered. `artifacts` already reports what this
    # turn produced (scoped `since=turn_start_wall`) and cannot answer this. (CUR-1394)
    _session_files_at_start: int = field(default=0, repr=False)
    # What the no-tool review (`_no_tool_check`) called this turn's accepted answer when it made no
    # tool call: "declined" or "answered", else "". Sent on the `done` frame so the chat site's
    # "no tool call was observed" caveat stays off an answer that claimed nothing. In-memory only, like
    # the field above. (CUR-4599)
    _no_tool_answer: str = field(default="", repr=False)
    # The confirmations currently open, redacted (kind/title/summary) via acp_client's
    # _describe_tool_call. In-memory only, not a store column — same rationale as transport_used: a
    # rehydrated Task is never mid-run (recover_orphans already terminalized anything non-terminal
    # on boot), so an empty list is always correct for one. (CUR-218)
    pending_confirmations: list = field(default_factory=list)
    # Callable, not `object`: both of these are CALLED (app.py's cancel/confirm endpoints and the
    # scratch watchdog), and `object | None` made every one of those calls a type error while telling a
    # reader nothing about the signature they have to match (CUR-1227).
    _acp_confirm: Callable[[str, str], None] | None = field(default=None, repr=False)  # loop-threadsafe resolve
    _confirm_wait_secs: float = field(default=0.0, repr=False)  # accumulated paused-clock seconds, this attempt
    model_calls: int = 0        # persisted: gateway-metered calls this task made
    tokens: int = 0             # persisted: gateway-metered tokens this task spent (feeds the per-user budget)
    # The executor this task runs on — the conversation's model when the caller named one the
    # gateway routes, else AGENT_MODEL. Persisted, so a poll on another machine reports the same model. (CUR-4603)
    model: str = ""
    # The model ids the gateway's upstream named on this task's executor calls, measured off each response.
    # In-memory only: it is reported on the done frame and the run.finished line, both sent while it lives.
    served_models: list = field(default_factory=list)
    transport_used: str = ""    # "acp" | "oneshot", set once `_use_acp` decides — in-memory
                                 # only (not a store.py column), so a task reloaded after a restart reads "".
    # _permission_decision(task.user)'s tier/task-count, set once in _run (same place
    # `permission_policy` is resolved) so a client can be told WHY a turn ran on a restricted toolset,
    # not just that it did. "" (not "uniform") until _run sets it — same not-yet-decided convention as
    # transport_used above, so a task that never got far enough to resolve a policy doesn't lie and claim
    # the uniform-policy tier. In-memory only, same rationale as transport_used/pending_confirmations: a
    # rehydrated task after restart is never mid-run, so there is nothing live left to report. (CUR-761)
    tier: str = ""
    tasks_done: int | None = None
    tasks_required: int | None = None
    _workdir: str | None = field(default=None, repr=False)
    # caller-supplied session key, and whether this turn found + reused a prior workdir for it.
    # Both in-memory only, same as _workdir — continuation is derived fresh from the store each turn. (CUR-196)
    _session_id: str | None = field(default=None, repr=False)
    _session_continued: bool = field(default=False, repr=False)
    # The caller says an earlier turn of this session ran an agent task, so a miss here means the
    # session's workdir is on another machine or lost, never a new session. (CUR-4393)
    _continues_session: bool = field(default=False, repr=False)
    _approval_mode: str = field(default="ask", repr=False)   # CUR-3142, from RunRequest.approval_mode
    _verify_spec: VerifySpec | None = field(default=None, repr=False)
    _verify_autoderived: bool = field(default=False, repr=False)  # spec came from _derive_verify_spec, not the caller
    _max_steps: int = field(default=MAX_STEPS, repr=False)      # gateway step-cap for this task
    _max_tokens: int = field(default=MAX_TOKENS_BUDGET, repr=False)  # gateway spend-cap for this task
    _wall_clock: int = field(default=WALL_CLOCK_SECS, repr=False)  # per-attempt wall clock for this task (caller may lower)
    _proc: subprocess.Popen | None = field(default=None, repr=False)  # live agent process (for cancel)
    _sbx: Handle | None = field(default=None, repr=False)  # the conversation's remote sandbox (CUR-4482), else None
    _acp_cancel: Callable[[], None] | None = field(default=None, repr=False)   # loop-threadsafe cancel closure
    # Built in _run, read by _execute_attempt, forwarded to acp_client — see the note where
    # they are assigned. Not part of the wire contract; leading underscore keeps them off StatusResponse. (CUR-1229)
    _on_confirmation_open: Callable[[dict], None] | None = field(default=None, repr=False)
    _on_confirmation_close: Callable[[str], None] | None = field(default=None, repr=False)
    _scratch_exceeded: int = field(default=0, repr=False)           # bytes at the moment the watchdog fired (0 = never)
    _canceled: bool = field(default=False, repr=False)
    _webhook_url: str | None = field(default=None, repr=False)  # optional push-delivery target (POST on terminal)
    _synthesize: bool = field(default=False, repr=False)        # chat surface (Story B): engages the judge/derive best-of-N gates
    _transport: str | None = field(default=None, repr=False)  # "oneshot" opts out of ACP; None/"acp" = default (_use_acp)
    # What the caller ASKED for, not what it got — None when it asked for nothing. `_wall_clock` above is
    # the effective value and equals the ceiling whenever the caller is silent, so the two cannot be told
    # apart from it. Persisted, because whether anyone uses this interface is a question about all time.
    _caller_wall_clock: int | None = field(default=None, repr=False)


TASKS: dict[str, Task] = {}        # LIVE runtime objects (hold _proc etc.) for non-terminal + recently-terminal tasks
_TASKS_LOCK = threading.Lock()
# set, the task rows, their events and cross-machine cancels live in agent-service's own Postgres,
# so any machine of the app can serve any task; unset, everything stays in DB_PATH on this machine. (CUR-4443)
TASKS_DATABASE_URL = os.environ.get("AGENT_TASKS_DATABASE_URL") or None
store = Store(DB_PATH, tasks_url=TASKS_DATABASE_URL)  # durable mirror: survives restart, and is the per-user spend ledger
# Who runs a task, on a shared store. A machine keeps its id across restarts, which is what lets its
# boot-time recover_orphans end exactly the tasks that restart killed.
OWNER_ID = FLY_MACHINE_ID or f"{socket.gethostname()}-{os.getpid()}"
LEASE_SECS = float(os.environ.get("AGENT_TASK_LEASE_SECS", "15"))
LEASE_RENEW_SECS = float(os.environ.get("AGENT_TASK_LEASE_RENEW_SECS", "5"))
TAIL_WAIT_SECS = float(os.environ.get("AGENT_EVENTS_TAIL_WAIT_SECS", "5"))  # remote reader's wait for `done`


# ---- Live event stream (SSE) — the interactive surface (streaming-spec.md §4) -------------------
# A per-task, thread-safe event log. The run executes on a daemon thread (sync); the SSE endpoint is
# async. Rather than bridge threading↔asyncio primitives, the producer appends under a lock and the async
# generator polls for new events by sequence id. The per-task event rate is low (plan + a few steps), so
# polling is cheap; the seq doubles as the SSE `id:` for Last-Event-ID replay on reconnect. This serves
# BOTH 2026 surfaces off one schema: a web canvas reads it directly (EventSource), and the ACP↔HTTP shim
# (local Hermes/editor → hosted backend) re-emits it as ACP session_update. Event vocabulary is
# the streaming-spec set (state/plan/message/tool_call/tool_result/usage/done) — A2A/AG-UI-adjacent, not
# bespoke — and secret-free (only ids/kinds/counts cross it, per the _log_event contract).
# The event stream has no off switch: chat reads every agent turn through it (endpointAgent.ts), so
# disabling it would break every turn rather than turn a feature off (CUR-3199).
SSE_MAX_EVENTS = int(os.environ.get("AGENT_SSE_MAX_EVENTS", "2000"))      # bound per-task buffer (oldest dropped)
SSE_POLL_SECS = float(os.environ.get("AGENT_SSE_POLL_SECS", "0.25"))      # async drain cadence
SSE_IDLE_TIMEOUT_SECS = int(os.environ.get("AGENT_SSE_IDLE_TIMEOUT_SECS", "900"))  # abandon a stalled stream
# Answer text as it is generated (`token` frames), on top of the progress frames that already stream.
#
# Without this, `_acp_run` doesn't ask Hermes for the deltas and the answer lands whole after 12-30s while
# the work streams above it.
#
# ON by default. With best-of > 1 an attempt can be rejected, so streamed text could be taken back in front
# of the reader, and handling that needs a separate compute channel. AGENT_BEST_OF=1 means one attempt, so the streamed
# text IS the answer and `done.result` repeats it. If best-of is ever raised, revisit this together with
# that decision — they are one question, not two.
STREAM_TOKENS = os.environ.get("AGENT_STREAM_TOKENS", "1") != "0"
STREAM_MAX_FRAMES = int(os.environ.get("AGENT_STREAM_MAX_FRAMES", "400"))  # per attempt; 0 = uncapped


class _EventBuffer:
    """Ordered, thread-safe event log for one task. emit() from the run thread; drain via since().
    Trims to the last SSE_MAX_EVENTS (a runaway plan can't grow it unbounded); `_base` keeps seq ids
    monotonic across trims so Last-Event-ID stays correct."""
    __slots__ = ("_base", "_closed", "_events", "_lock", "_task_id")

    def __init__(self, task_id: str = "") -> None:
        self._task_id = task_id
        self._events: list[tuple[int, str, dict]] = []   # (seq, event_type, data)
        self._lock = threading.Lock()
        self._closed = False
        self._base = 0                                    # seq of the first still-retained event

    def emit(self, event_type: str, data: dict) -> None:
        with self._lock:
            if self._closed:
                return
            seq = self._base + len(self._events)
            self._events.append((seq, event_type, data))
            if store.shared and self._task_id:              # CUR-4443: another machine may be streaming it
                _EVENT_SINK.put(self._task_id, seq, event_type, data)
            if len(self._events) > SSE_MAX_EVENTS:
                drop = len(self._events) - SSE_MAX_EVENTS
                self._events = self._events[drop:]
                self._base += drop

    def close(self) -> None:
        with self._lock:
            self._closed = True

    @property
    def closed(self) -> bool:
        return self._closed

    def since(self, after_seq: int) -> tuple[list[tuple[int, str, dict]], bool]:
        """Events after `after_seq`, plus whether the buffer is closed.

        SLICED, not filtered. Seqs are contiguous by construction — `emit` assigns `_base + len(_events)`
        and a trim advances `_base` by exactly the number dropped — so the index of a seq is arithmetic and
        scanning for it is wasted work. The SSE generator calls this on every poll pass per subscriber, so
        the filter re-read up to SSE_MAX_EVENTS tuples each time to return, usually, nothing. That cost was
        invisible while a turn emitted a dozen frames and becomes the hot loop the moment token frames turn
        the buffer from tens of entries into hundreds."""
        with self._lock:
            start = max(0, after_seq + 1 - self._base)
            return self._events[start:], self._closed


_EVENTS: dict[str, _EventBuffer] = {}
_EVENTS_LOCK = threading.Lock()


class _EventSink:
    """CUR-4443: copies each task's events into the shared store in batches, off the run thread, so a
    token frame costs a list append rather than a round trip to Postgres. A batch that fails to write is
    logged and dropped: the owner's own stream is unaffected, and a reader elsewhere sees a gap."""

    FLUSH_SECS = float(os.environ.get("AGENT_EVENT_FLUSH_SECS", "0.2"))

    def __init__(self) -> None:
        self._rows: list[tuple[str, int, str, dict]] = []
        self._lock = threading.Lock()
        self._started = False

    def put(self, task_id: str, seq: int, event_type: str, data: dict) -> None:
        with self._lock:
            self._rows.append((task_id, seq, event_type, data))
            if not self._started:
                self._started = True
                threading.Thread(target=self._loop, daemon=True).start()

    def flush(self) -> None:
        with self._lock:
            rows, self._rows = self._rows, []
        if not rows:
            return
        try:
            store.append_events(rows)
        except Exception as e:  # noqa: BLE001 — see the class docstring
            _log_event("events.sink_failed", error=type(e).__name__, dropped=len(rows))

    def _loop(self) -> None:
        while True:
            time.sleep(self.FLUSH_SECS)
            self.flush()


_EVENT_SINK = _EventSink()


def _event_buffer(task_id: str, create: bool = False) -> _EventBuffer | None:
    """Fetch (or create) a task's event buffer. On create, evict CLOSED buffers if the registry exceeds the
    task-table cap — closed buffers belong to terminal tasks and are only kept for brief reconnect replay."""
    with _EVENTS_LOCK:
        b = _EVENTS.get(task_id)
        if b is None and create:
            b = _EVENTS[task_id] = _EventBuffer(task_id)
            if len(_EVENTS) > MAX_TASKS:
                for tid in list(_EVENTS.keys()):
                    if len(_EVENTS) <= MAX_TASKS:
                        break
                    if tid != task_id and _EVENTS[tid].closed:
                        del _EVENTS[tid]
        return b


def _sse_frame(event: str, data: dict, seq: int) -> str:
    """One SSE record. `id:` enables the browser's built-in Last-Event-ID reconnect."""
    return f"id: {seq}\nevent: {event}\ndata: {_json.dumps(data, default=str)}\n\n"


# ---- Observability (structured logs + Prometheus metrics — brief §6B.5) --------------------
import json as _json  # noqa: E402

_LOG = bool(int(os.environ.get("AGENT_LOG_JSON", "1")))   # structured JSON logs on by default


def _log_event(event: str, **fields) -> None:
    """One structured JSON line per significant event — the machine-readable side of the two-tier log.

    Carries no CREDENTIALS: callers pass ids, states and counts, and anything that came out of the
    sandbox is `_scrub`bed of the nonce first. It does carry some CONTENT — `detail`, `artifacts`,
    `expect_file` can each quote a fragment of the user's task — which stdout is welcome to and an
    off-box sink is not by default. logsink._redact draws that line; see its module docstring."""
    if not _LOG:
        return
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    print(_json.dumps(rec, default=str), flush=True)
    logsink.emit(rec)                                  # no-op unless AXIOM_TOKEN is set


# Started at import, not in the lifespan, so that no event can be emitted before its sink exists —
# the import-time model/toolset guard rail logs, and startup is when a misconfigured deploy is
# loudest. Returns False and costs nothing when AXIOM_TOKEN is unset, which is every test run.
logsink.init("app")

# MCP servers agent mode may call, from AGENT_MCP_SERVERS (see mcp_config.py). Parsed once at
# import. A bad value never takes the service down: it yields no servers, logs here, and /healthz carries
# the reason under `mcp.error` for as long as it stays bad. (CUR-3025)
MCP_CONFIG = mcp_config.load()
if MCP_CONFIG.error:
    _log_event("mcp.config_invalid", reason=MCP_CONFIG.error)
elif MCP_CONFIG.servers:
    _log_event("mcp.configured", servers=[s.name for s in MCP_CONFIG.servers])


# Model<->toolset/verifier coupling guard rail: swapping AGENT_MODEL is easy to do without also
# revisiting ALLOWED_TOOLSETS/AGENT_VERIFIER_MODEL, which can silently pair a new executor with
# settings that were only ever measured correct for the OLD one. Startup-time sanity check, not a
# runtime gate — these are measured efficiency/quality risks, not security boundaries, so it always
# logs loudly and never blocks. An unrecognized model is simply unchecked, never declared safe.
_MODEL_TOOLSET_REQUIREMENTS = [
    # (substring to match in AGENT_MODEL.lower(), required substring in ALLOWED_TOOLSETS.lower(), why)
    ("mistralai/mistral", "coding",
     "Mistral reaches for write_file from its own agentic-training prior; a terminal-only toolset makes "
     "it repeat a dead 'tool does not exist' call instead of falling back to a heredoc (measured: "
     "terminal-only SOLID 6/8 vs coding SOLID 8/8 on a hard multi-file task)."),
]


def _check_model_coupling(model: str, toolsets: str, verifier_model: str | None) -> None:
    """Log (never raise) if AGENT_MODEL looks paired with a toolset measured wrong for it, or with a
    verifier explicitly set to the SAME model (defeats the whole point of a decorrelated judge). Self-judge (verifier_model unset) is a legitimate,
    intentional default and is NOT flagged here — only an explicit same-model verifier is a real bug."""
    if not model:
        return
    m, t = model.lower(), toolsets.lower()
    for model_sub, required_sub, why in _MODEL_TOOLSET_REQUIREMENTS:
        if model_sub in m and required_sub not in t:
            print(json.dumps({"event": "config.model_toolset_mismatch", "model": model,
                              "toolsets": toolsets, "requires": required_sub, "why": why}), flush=True)
    if verifier_model and verifier_model.strip().lower() == m:
        print(json.dumps({"event": "config.verifier_not_decorrelated", "model": model,
                          "verifier_model": verifier_model,
                          "why": "AGENT_VERIFIER_MODEL is explicitly set to the same model as AGENT_MODEL "
                                 "— a same-weights self-judge has a measured discrimination ceiling "
                                 "(recall ~2/5-3/5 even for a capable model); this defeats the point of "
                                 "setting a verifier at all. Pick a genuinely different checkpoint, or "
                                 "unset AGENT_VERIFIER_MODEL to use the intentional self-judge default."}),
              flush=True)


_check_model_coupling(AGENT_MODEL, ALLOWED_TOOLSETS, VERIFIER_MODEL)


_METRICS_LOCK = threading.Lock()
_METRICS: dict[str, float] = {
    "agent_runs_submitted_total": 0, "agent_runs_completed_total": 0, "agent_runs_failed_total": 0,
    "agent_runs_canceled_total": 0, "agent_runs_verified_total": 0, "agent_model_calls_total": 0,
    "agent_tokens_total": 0, "agent_runs_rejected_concurrency_total": 0, "agent_runs_rejected_budget_total": 0,
    "agent_run_duration_seconds_sum": 0.0, "agent_run_duration_seconds_count": 0,
    "agent_run_reaped_orphan_total": 0,
}
_RUN_START: dict[str, float] = {}  # task_id -> start monotonic, for duration


def _metric_inc(name: str, by: float = 1) -> None:
    with _METRICS_LOCK:
        _METRICS[name] = _METRICS.get(name, 0) + by


def _metrics_record(task: Task) -> None:
    """Fold a finished task's outcome into the counters + emit its structured log line."""
    _metric_inc(f"agent_runs_{task.state.value.lower()}_total")
    if task.verified:
        _metric_inc("agent_runs_verified_total")
    if task.transport_used:
        _metric_inc(f"agent_runs_transport_{task.transport_used}_total")   # ACP-vs-oneshot split
    _metric_inc("agent_model_calls_total", task.model_calls)
    _metric_inc("agent_tokens_total", task.tokens)
    start = _RUN_START.pop(task.id, None)
    dur = (time.monotonic() - start) if start is not None else None
    if dur is not None:
        with _METRICS_LOCK:
            _METRICS["agent_run_duration_seconds_sum"] += dur
            _METRICS["agent_run_duration_seconds_count"] += 1
    _log_event("run.finished", id=task.id, user=task.user, state=task.state.value, verified=task.verified,
               model_calls=task.model_calls, tokens=task.tokens, transport=task.transport_used,
               # The executor asked for, and what the upstream said answered it (CUR-4603).
               model=task.model or AGENT_MODEL or None, served_models=list(task.served_models),
               duration_s=round(dur, 3) if dur is not None else None,
               # WHICH authority verified, so `verified: true` in the dataset says what stood behind it.
               # A closed set: execution / execution+judge / none (the judge never runs ungrounded, so
               # bare `judge` does not occur). Worth watching: the share of chat turns landing on "none"
               # (spec never grounded, judge never consulted). A rising "none" share means fewer turns
               # produce anything checkable at all.
               verify_method=task.verify_method or "none",
               verify_autoderived=task._verify_autoderived,
               # Empty on a normal turn AND on an honest judge rejection; set only when the judge could
               # not be reached. That distinction is the whole alertable signal: `verified: false` alone
               # cannot tell "the answer was wrong" from "the credential is dead", and those want
               # opposite responses. The value is a closed set, never the model's prose.
               judge_error=_judge_error_kind(task.judge_reason))

# Concurrency cap: bound CONCURRENT runs (each = a hermes subprocess), independent of the task-table size.
# MAX_TASKS bounds memory; this bounds live processes AND aggregate in-flight spend (the per-task caps,
# being per-task, don't — without this an unbounded burst of /run is a fork-bomb / spend blow-out).
_INFLIGHT_LOCK = threading.Lock()
_inflight = 0


def _try_acquire_slot() -> bool:
    global _inflight
    with _INFLIGHT_LOCK:
        if _inflight >= MAX_CONCURRENCY:
            return False
        _inflight += 1
        return True


def _release_slot() -> None:
    global _inflight
    with _INFLIGHT_LOCK:
        _inflight = max(0, _inflight - 1)


# Per-principal in-flight reservation: the budget ledger in the store only counts COMPLETED tasks, so without
# this a caller could burst N concurrent submits that all pass the same pre-check. We reserve each task's
# count + worst-case token cap on admit and release it when the task ends, so the budget check sees
# completed + in-flight.
_USER_LOCK = threading.Lock()
_USER_INFLIGHT: dict[str, list[int]] = {}   # principal (`caller` or `caller/subject`) -> [count, reserved_tokens]


def _reserve_user(user: str, reserved_tokens: int, max_live: int = 0) -> bool:
    """Reserve one in-flight task for `user`. With `max_live` > 0, refuse (False, nothing reserved) when
    `user` already has that many in flight; the check and the reservation share one lock hold."""
    with _USER_LOCK:
        e = _USER_INFLIGHT.setdefault(user, [0, 0])
        if max_live and e[0] >= max_live:
            if e == [0, 0]:
                _USER_INFLIGHT.pop(user, None)
            return False
        e[0] += 1
        e[1] += reserved_tokens
        return True


def _subject_live_cap(user: str) -> int:
    """SUBJECT_MAX_CONCURRENCY for a named subject of a capped caller, else 0 (no cap)."""
    caller = _caller_of(user)
    if not SUBJECT_MAX_CONCURRENCY or user == caller or caller in OPERATOR_SUBS:
        return 0
    return SUBJECT_MAX_CONCURRENCY


def _release_user(user: str, reserved_tokens: int) -> None:
    with _USER_LOCK:
        e = _USER_INFLIGHT.get(user)
        if e:
            e[0] = max(0, e[0] - 1)
            e[1] = max(0, e[1] - reserved_tokens)
            if e[0] == 0 and e[1] == 0:
                _USER_INFLIGHT.pop(user, None)


def _user_inflight(user: str) -> tuple[int, int]:
    with _USER_LOCK:
        e = _USER_INFLIGHT.get(user, [0, 0])
        return e[0], e[1]


def _caller_inflight(caller: str) -> tuple[int, int]:
    """In-flight count + reserved tokens for a caller, summed over every subject it has named.

    The store half of the ceiling (`caller_tasks_since`) aggregates by prefix, so this has to as well or the
    burst bypass reopens one level up: N concurrent submits under N fresh subjects would each see only their
    own reservation and all pass the caller check together."""
    p = caller + "/"
    n = tok = 0
    with _USER_LOCK:
        for k, e in _USER_INFLIGHT.items():
            if k == caller or k.startswith(p):
                n += e[0]
                tok += e[1]
    return n, tok


def _subject_daily_tasks(requested: str | None) -> int:
    """The per-visitor daily task allowance for this request (CUR-4620).

    Chat counts each account's tasks itself and gives a team account a larger allowance; it says so in
    X-Agent-Subject-Daily-Tasks, so this backstop does not stop that account at the visitor number first.
    The header is chat's word, like X-Agent-Account: only a holder of the service token can send it, and
    the caller ceiling is still checked first, so it can move one visitor's share and never the total.
    It only RAISES the allowance. A missing, malformed or smaller value leaves SUBJECT_DAILY_TASKS, and the
    allowance stays off when SUBJECT_DAILY_TASKS is 0."""
    if not SUBJECT_DAILY_TASKS or not isinstance(requested, str):
        return SUBJECT_DAILY_TASKS
    try:
        n = int(requested.strip())
    except ValueError:
        return SUBJECT_DAILY_TASKS
    return max(SUBJECT_DAILY_TASKS, n)


def _check_user_budget(user: str, reserve_tokens: int, subject_daily_tasks: int | None = None) -> None:
    """Rolling-window guard at TWO levels: reject if completed + IN-FLIGHT usage would exceed either the
    caller's ceiling or this visitor's allowance. Counting in-flight (not just completed history in the
    store) closes the burst bypass where N concurrent submits all pass the same pre-check. `reserve_tokens`
    is THIS task's worst-case (its token cap). Raises 429; off when every limit is 0.

    `user` is a PRINCIPAL — `caller` or `caller/<subject>`. The CALLER ceiling is the real bound, because the
    caller is authenticated; the SUBJECT allowance is fairness inside it, because the subject is not. Both
    are checked and the caller one is checked FIRST, so a caller rotating subjects to mint fresh allowances
    still stops at its own total. Checking only the subject would be weaker than a single caller
    limit — the header would be a documented way around the cap.

    A caller in OPERATOR_SUBS skips both windows. The limits ration invitees against a shared research
    preview; a smoke check is us asking our own service whether it still works, and rationing that
    against the people it protects gets the accounting backwards — the first thing to go quiet when
    the budget ran low would be the thing that tells us it ran low. The exemption covers the rolling
    count only. Every per-task bound still applies, so an exempt credential cannot start an unbounded
    task, only more of them. Matched on the CALLER half, so naming a subject cannot forfeit the exemption
    (nor claim it: `caller/whatever` is exempt exactly when `caller` is).

    `subject_daily_tasks` is this visitor's allowance from _subject_daily_tasks; None means SUBJECT_DAILY_TASKS."""
    if not (CALLER_DAILY_TASKS or CALLER_DAILY_TOKENS or SUBJECT_DAILY_TASKS):
        return
    caller = _caller_of(user)
    if caller in OPERATOR_SUBS:
        _metric_inc("agent_runs_operator_exempt_total")
        _log_event("run.operator_exempt", user=user)
        return
    since = time.time() - RATE_WINDOW_SECS
    inflight_n, inflight_tok = _caller_inflight(caller)
    if CALLER_DAILY_TASKS:
        n = store.caller_tasks_since(caller, since) + inflight_n
        if n >= CALLER_DAILY_TASKS:
            _metric_inc("agent_runs_rejected_budget_total")
            _log_event("run.rejected", user=user, reason="caller_task_rate_limit", count=n,
                       limit=CALLER_DAILY_TASKS)
            raise HTTPException(429, f"caller task limit reached ({CALLER_DAILY_TASKS} per {RATE_WINDOW_SECS}s)")
    if CALLER_DAILY_TOKENS:
        spent = store.caller_tokens_since(caller, since) + inflight_tok
        if spent + reserve_tokens > CALLER_DAILY_TOKENS:
            _metric_inc("agent_runs_rejected_budget_total")
            _log_event("run.rejected", user=user, reason="caller_token_budget", spent=spent,
                       limit=CALLER_DAILY_TOKENS)
            raise HTTPException(429, f"caller token budget reached ({CALLER_DAILY_TOKENS} per {RATE_WINDOW_SECS}s)")
    # Only when a subject was actually named. For a bare caller the subject bucket IS the caller bucket, so
    # applying the (smaller) per-visitor number there would silently lower the ceiling for every caller that
    # does not send the header — the direction that would break the direct API.
    subject_limit = SUBJECT_DAILY_TASKS if subject_daily_tasks is None else subject_daily_tasks
    if subject_limit and user != caller:
        s_n, _ = _user_inflight(user)
        n = store.user_tasks_since(user, since) + s_n
        if n >= subject_limit:
            _metric_inc("agent_runs_rejected_budget_total")
            _log_event("run.rejected", user=user, reason="subject_task_rate_limit", count=n,
                       limit=subject_limit)
            raise HTTPException(429, f"per-visitor task limit reached ({subject_limit} per {RATE_WINDOW_SECS}s)")


def _effective_caps(req_steps: int | None, req_tokens: int | None,
                    req_wall: int | None = None) -> tuple[int, int, int]:
    """Clamp per-task overrides to the server ceilings so a caller can only TIGHTEN a cap, never raise it
    (the DoS/spend guard must not be caller-defeatable, e.g. by max_steps=10_000_000).
    max_tokens 0 = off; a caller can't switch off a server-imposed token ceiling, only lower it.

    The wall clock joined the other two because a deadline is a cap like the rest, and because the caller
    is the only party that knows it. Ours bounds how long we are WILLING to work; theirs bounds how long
    they will WAIT, and the two are unrelated numbers. The chat client's watchdog is 155s and structurally
    cannot be raised — it is derived as GENERATION_STALE_MS − HARD_UNWIND_GRACE_MS − 2 ×
    EMERGENCY_CLEANUP_BUDGET_MS, so raising it means moving the staleness window under it. Every second we
    spend past a caller's deadline is spent for a reader who has already been shown a timeout, and the
    result we go on to persist is one nobody will be shown.

    Lower-only is what keeps the rest of the service's reasoning intact: AGENT_WALL_CLOCK_SECS stays the
    true maximum any run can last, so the sweep interval sized against it (see _SWEEP) still cannot race
    a live task, and /healthz keeps reporting the ceiling rather than one task's private budget."""
    steps = MAX_STEPS if req_steps is None else min(req_steps, MAX_STEPS)
    if req_tokens is None:
        tokens = MAX_TOKENS_BUDGET
    elif MAX_TOKENS_BUDGET > 0:
        tokens = MAX_TOKENS_BUDGET if req_tokens == 0 else min(req_tokens, MAX_TOKENS_BUDGET)
    else:
        tokens = req_tokens  # server sets no ceiling → caller may add one (only tightens)
    if req_wall is None:
        wall = WALL_CLOCK_SECS
    else:
        # Counted, not just applied. The clamp is lower-only and therefore looks safe read on its own, but
        # its whole justification — that we stop spending on a reader who has already been shown a timeout
        # — assumes some caller actually states a deadline. Nothing recorded whether one ever had, so the
        # feature could be correct, deployed, and entirely dead, and the code would read identically in
        # both worlds. A drift check should report a zero here out loud rather than passing over it.
        #
        # `requests`, NOT `runs`, and the distinction decides whether the report is honest: this runs at
        # api/app.py's /run handler BEFORE _check_user_budget, both moderate() calls and _try_acquire_slot,
        # so a request counted here can still be rejected 429/403 and never become a task. That is the
        # right population for the question — a caller who stated a deadline and got moderated still
        # stated one — but it means this can exceed the run count and must never be read as a per-run rate.
        _metric_inc("agent_requests_caller_deadline_total")
        wall = min(req_wall, WALL_CLOCK_SECS)
    return steps, tokens, wall


def _store_task(task: Task) -> None:
    """Register a task in the live table AND the durable store, evicting the oldest TERMINAL live entries if
    the table is over MAX_TASKS (never evicts a running task). The live table bounds memory; the store keeps
    the durable record (read after eviction/restart) and the per-user spend ledger."""
    if store.shared:
        store.create(task.id, task.user, task.state.value, task._caller_wall_clock,
                     owner=OWNER_ID, lease_until=time.time() + LEASE_SECS)
    else:
        store.create(task.id, task.user, task.state.value, task._caller_wall_clock)
    with _TASKS_LOCK:
        TASKS[task.id] = task
        if len(TASKS) > MAX_TASKS:
            for tid in list(TASKS.keys()):
                if len(TASKS) <= MAX_TASKS:
                    break
                if TASKS[tid].state in _TERMINAL and tid != task.id:
                    del TASKS[tid]


def _persist(task: Task) -> None:
    """Mirror the task's current outcome to the durable store (called at each state transition)."""
    store.update(task.id, state=task.state.value, result=task.result, result_truncated=task.result_truncated,
                 error=task.error, summary=task.summary, verified=task.verified,
                 model_calls=task.model_calls, tokens=task.tokens,
                 # Persisted, not just in-memory: the scratch is gone by the time anyone polls, so a task
                 # evicted from TASKS or read after a restart would otherwise lose its files for good.
                 artifacts=json.dumps({"files": task.artifacts, "dropped": task.artifacts_dropped})
                 if task.artifacts else None,
                 session_expired=int(task.session_expired),  # CUR-196; own column, readable even with no artifacts
                 # CUR-855/846: the client's honesty caveat rides on this being non-blank — without it,
                 # result survives eviction/restart but the warning that it's unverified/failed doesn't.
                 unrun_detail=task.unrun_detail,
                 model=task.model or None)


def _get_task(task_id: str) -> Task | None:
    """Live runtime object if present; else reconstruct a read-only Task from the durable store (so results
    survive eviction + restart). On one machine a store-only task is always terminal (live non-terminal tasks
    stay in TASKS); on a shared store it may be running on another machine (CUR-4443)."""
    with _TASKS_LOCK:
        t = TASKS.get(task_id)
    if t is not None:
        return t
    rec = store.get(task_id)
    if rec is None:
        return None
    arts = _artifacts_from_row(rec.get("artifacts"))
    return Task(id=rec["id"], prompt="", user=rec["user"], state=State(rec["state"]),
                result=rec["result"], result_truncated=bool(rec["result_truncated"]),
                error=rec["error"], summary=rec["summary"], verified=bool(rec["verified"]),
                artifacts=arts.get("files") or [], artifacts_dropped=bool(arts.get("dropped")),
                model_calls=rec["model_calls"], tokens=rec["tokens"],
                session_expired=bool(rec.get("session_expired")),
                # CUR-855/846: NULL on a pre-migration row or a task that never set it — same "" default
                # Task.unrun_detail already carries in memory, not a new sentinel to special-case downstream.
                unrun_detail=rec.get("unrun_detail") or "",
                # NULL on a row written before the column, which ran on AGENT_MODEL. (CUR-4603)
                model=rec.get("model") or "")


def _artifacts_from_row(raw: str | None) -> dict:
    """Decode the persisted artifact blob. Tolerant by design: rows written before the column existed read
    as NULL, and a task whose files can't be decoded should still return its answer."""
    if not raw:
        return {}
    try:
        d = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return d if isinstance(d, dict) else {}


def _truncate(s: str, n: int) -> tuple[str, bool]:
    """Return (text, truncated). Keeps the LAST n chars (the agent's answer usually lands at the end)."""
    return (s, False) if len(s) <= n else (s[-n:], True)


def _hide_workdir(text: str, work: str | RemoteWork) -> str:
    """Take the sandbox's own directory out of an answer (CUR-4104). The model runs with cwd=work and
    names it ("both files are in the working directory (/tmp/agent-run-…)"), but the person never sees
    that directory: their files arrive as downloads under the answer, by name. A path inside it keeps
    its name. The directory alone in brackets is an aside and goes with them; anywhere else it is part
    of the sentence ("open tareas.csv or <dir>"), so it becomes "./", which names the same place in any
    language, rather than leaving the sentence without its object."""
    if not text or not work:
        return text
    dirs = {str(work).rstrip("/")} if isinstance(work, RemoteWork) else {work.rstrip("/"), os.path.realpath(work)}
    for d in dirs:
        w = re.escape(d) + r"/*"
        text = re.sub(r"[ \t]*[(\[]\s*`?" + w + r"`?\s*[)\]]", "", text)
        text = re.sub(re.escape(d) + r"/+(?=[^\s`)\]])", "", text)
        text = re.sub(w + r"(?![\w/-])", "./", text)
    return text


def _ip_blocked(addr: str) -> bool:
    """True if an address is non-public (private/loopback/link-local/reserved/metadata/multicast). Handles
    IPv4-mapped IPv6 (::ffff:a.b.c.d) by checking the embedded IPv4 too."""
    import ipaddress
    ip = ipaddress.ip_address(addr)
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified)


def _validate_webhook_url(url: str) -> str | None:
    """SSRF guard: a webhook is a server-side POST to a caller-supplied URL. Require http(s); unless
    AGENT_WEBHOOK_ALLOW_PRIVATE, refuse hosts that resolve to private/loopback/link-local/reserved ranges
    (metadata 169.254.169.254, 127.0.0.1, 10.x, internal services). Returns a VALIDATED ip to pin delivery
    to (so a DNS rebind between check and connect can't redirect it); None if private mode skips resolution.
    Raises HTTPException(400) on a blocked/unresolvable URL."""
    import socket
    from urllib.parse import urlparse
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise HTTPException(400, "webhook_url must be an http(s) URL with a host")
    port = u.port or (443 if u.scheme == "https" else 80)
    try:
        # str() is a no-op on the address it always is at runtime; typeshed types sockaddr loosely
        # enough that ai[4][0] widens to `str | int`, which _ip_blocked below does not accept.
        addrs = sorted({str(ai[4][0]) for ai in socket.getaddrinfo(u.hostname, port, proto=socket.IPPROTO_TCP)})
    except Exception as e:
        if WEBHOOK_ALLOW_PRIVATE:
            return None
        raise HTTPException(400, f"webhook_url host unresolvable: {type(e).__name__}") from e
    if not WEBHOOK_ALLOW_PRIVATE:
        for a in addrs:
            if _ip_blocked(a):
                raise HTTPException(400, "webhook_url resolves to a non-public address (blocked; set AGENT_WEBHOOK_ALLOW_PRIVATE for dev)")
    return addrs[0] if addrs else None   # pin to a validated address


def _deliver_webhook(task: Task) -> None:
    """Push the terminal status to the caller's webhook (best-effort, never affects the task outcome).
    Runs off the task thread so a slow/black-hole URL can't hold the concurrency slot. Re-validates AND
    PINS: we connect to the exact IP validated here (Host header + sni_hostname preserved), so a DNS rebind
    between the check and httpx's own resolution can't redirect the request to an internal address. Redirects
    are not followed (httpx default) so a 30x can't bounce it inward either."""
    if not task._webhook_url:
        return
    from urllib.parse import urlparse
    try:
        pinned = _validate_webhook_url(task._webhook_url)  # re-check + get the IP to pin to
    except HTTPException:
        _log_event("webhook.blocked", id=task.id, reason="ssrf_guard")
        return
    import httpx
    payload = _status_of(task).model_dump(mode="json")   # one canonical contract shape (incl. provenance)
    u = urlparse(task._webhook_url)
    if pinned and not u.hostname:
        # Unreachable today: _validate_webhook_url raises on a hostname-less URL, and `pinned` being
        # set is proof it did not. Written as a real fail-CLOSED branch rather than a type-checker
        # suppression, because the alternative on this path is posting UNPINNED to a URL whose host we
        # never validated — if those two functions ever drift apart, this drops the delivery instead
        # of quietly widening the SSRF guard (CUR-1227).
        _log_event("webhook.blocked", id=task.id, reason="no_host_to_pin")
        return
    if pinned and u.hostname:                             # connect to the validated IP, keep Host + SNI = hostname
        port = u.port or (443 if u.scheme == "https" else 80)
        host_hdr = u.hostname + (f":{u.port}" if u.port else "")
        ip_lit = f"[{pinned}]" if ":" in pinned else pinned
        target = f"{u.scheme}://{ip_lit}:{port}{u.path or '/'}" + (f"?{u.query}" if u.query else "")
        headers = {"Host": host_hdr}
        sni = u.hostname.encode() if u.scheme == "https" else None
    else:                                                # AGENT_WEBHOOK_ALLOW_PRIVATE dev path, no pin
        target, headers, sni = task._webhook_url, {}, None
    try:
        with httpx.Client(timeout=10.0, follow_redirects=False) as c:
            req = c.build_request("POST", target, json=payload, headers=headers)
            if sni:
                req.extensions["sni_hostname"] = sni      # validate TLS against the hostname, not the pinned IP
            c.send(req)
        _log_event("webhook.delivered", id=task.id, host=u.hostname, pinned=pinned)
    except Exception as e:  # noqa: BLE001 — delivery is best-effort; the result is already durable in the store
        _log_event("webhook.failed", id=task.id, error=type(e).__name__)


def _reset_scratch(work: str | RemoteWork) -> None:
    """Wipe the per-task scratch between best-of-N attempts (keep HERMES_HOME) so a failed attempt's partial
    files can't make the next attempt's _verify false-pass. Safe because the service seeds no input files —
    the agent creates everything it needs within the run."""
    if isinstance(work, RemoteWork):
        work.reset()
        return
    for entry in os.listdir(work):
        if entry == "hermes-home":
            continue
        p = os.path.join(work, entry)
        try:
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
        except OSError:
            pass


def _scratch_artifacts(work: str | RemoteWork) -> list[str]:
    """What the AGENT put in the scratch — every entry that isn't one of the per-attempt HERMES_HOMEs.

    `_reset_scratch` keeps only the exact name "hermes-home"; the per-attempt homes are "hermes-home-1",
    "hermes-home-2", … so the prefix, not the exact name, is what separates session state from work."""
    if isinstance(work, RemoteWork):
        return [name for name, _is_dir in work.top_level() if not name.startswith("hermes-home")]
    try:
        return sorted(e for e in os.listdir(work) if not e.startswith("hermes-home"))
    except OSError:
        return []


CORPUS_SNAPSHOT_MAX_BYTES = 8000  # per-file and total cap — this is training-corpus material for CUR-654,
#                                   not a forensic record (_write_no_follow's raw.log already is that);
#                                   lossy on purpose, bounded so a large scratch can't grow the table unbounded.


def _truncate_utf8(s: str, max_bytes: int) -> str:
    """Truncate `s` to at most `max_bytes` UTF-8 bytes, never splitting a multi-byte character. A plain
    Python slice (`s[:max_bytes]`) bounds CHARACTERS, not bytes — multi-byte content (accented names,
    CJK, emoji) can run up to ~4x past a cap documented and named as bytes."""
    b = s.encode("utf-8", errors="replace")
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode("utf-8", errors="ignore")


def _corpus_snapshot_text(work: str | RemoteWork, nonce: str | None, max_bytes: int = CORPUS_SNAPSHOT_MAX_BYTES) -> str:
    """Best-effort snapshot of what the agent wrote this attempt, for a CUR-596/CUR-654 corpus log entry.
    Uses `_artifact_paths` (recursive, lstat + regular-files-only) and `_read_artifact` (O_NOFOLLOW,
    binary-safe, byte-bounded) — the same pair every other artifact reader in this file uses. That
    covers output written into a subdirectory, binary files (no replacement-character garbage in the
    log) and symlinks the agent plants (never dereferenced). Never raises.

    `nonce`: scrubbed from each file's FULL content before the byte cap is applied. Scrubbing the
    truncated result instead lets the nonce straddle the cut point and leave an unredacted fragment in
    this durable, exportable table."""
    parts: list[str] = []
    total = 0
    try:
        entries = _artifact_paths(work, limit=10**9)
    except Exception:  # noqa: BLE001
        return ""
    for rel, _size in entries:
        if total >= max_bytes:
            break
        text, _truncated = _read_rel(work, rel, max_bytes - total)
        if text is None:          # binary, unreadable, or a symlink _read_artifact's O_NOFOLLOW rejected
            continue
        text = _scrub(text, nonce)
        chunk = f"--- {rel} ---\n{text}\n"
        chunk_bytes = len(chunk.encode("utf-8", errors="replace"))
        if total + chunk_bytes > max_bytes:
            chunk = chunk.encode("utf-8", errors="replace")[: max_bytes - total].decode("utf-8", "ignore")
            chunk_bytes = len(chunk.encode("utf-8", errors="replace"))
        parts.append(chunk)
        total += chunk_bytes
    return "".join(parts)


def _snapshot_scratch(work: str | RemoteWork) -> str | RemoteWork:
    """Copy every REGULAR file the agent left (recursive — `_artifact_paths`'s own walk, not
    `_scratch_artifacts`'s top-level-only listing) into a fresh temp dir OUTSIDE `work`, and return its
    path. A best-of-N consistency-check attempt can be superseded by a LATER attempt that
    fails, and `_reset_scratch` would otherwise destroy the winning attempt's files before anything
    downstream reads them.

    SECURITY: uses `_artifact_paths` (lstat + S_ISREG-only) to decide what to copy and O_NOFOLLOW to open
    it, the same guard every other reader of this untrusted directory already applies (`_read_artifact`'s
    own docstring: "a symlink to /data/tasks.db returns another tenant's database"). A plain
    `shutil.copytree`/`copy2` would follow symlinks — a `ln -s /data/tasks.db work/leak.csv`
    from inside the agent's own sandboxed shell would be dereferenced into a plain file here, then
    served as an ordinary downloadable artifact after `_restore_scratch`. Never raises — a copy failure
    just means that entry is missing from the snapshot, not a crashed turn. `mkdir` is INSIDE the guarded
    try: tempfile.mkdtemp() has already created `dest` on disk by
    the time a per-file mkdir could fail (ENOSPC, a pathologically deep path), and an uncaught exception
    there would propagate out of this function entirely, leaking `dest` with no reference anywhere to
    clean it up — on this host's tmpfs-backed /tmp, that leak is unrecoverable RAM until a process restart."""
    if isinstance(work, RemoteWork):
        return work.snapshot()                                   # a copy in the guest, outside its workspace
    dest = tempfile.mkdtemp(prefix="cur596-cc-")
    for rel, _size in _artifact_paths(work, limit=10**9):        # no cap — this needs everything, not a preview
        src = os.path.join(work, rel)
        dst = Path(dest, rel)
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)       # closes a TOCTOU swap after the lstat above
        except OSError:
            continue
        try:
            with os.fdopen(fd, "rb") as fh:
                dst.write_bytes(fh.read())
        except OSError:
            continue
    return dest


def _restore_scratch(work: str | RemoteWork, snapshot: str | RemoteWork) -> None:
    """The inverse of _snapshot_scratch: clear whatever is currently in `work` (everything but the
    per-attempt HERMES_HOMEs) and copy `snapshot`'s contents in. Restores `work` to physically match the
    answer being served — the artifact-download route and moderation both read `work` LIVE (CUR-546), so
    an in-memory record of what the winning attempt produced is not enough; the files themselves have to
    be back.

    SECURITY, clear step: checks `is_symlink()` BEFORE `is_dir()`, not after — `is_dir()` FOLLOWS a
    symlink to answer "is the thing it points to a directory", which is exactly backwards for deciding
    how to remove the symlink ITSELF. The hazard: a losing attempt plants
    `ln -s /data top_level_link`; `_snapshot_scratch` correctly never captures the link (lstat sees
    S_ISLNK, not S_ISREG/S_ISDIR), but an `is_dir()` check here would follow it and route into
    `shutil.rmtree(p)`, which then raises "Cannot call rmtree on a symbolic link" — silently swallowed by
    the surrounding `except OSError`, leaving the symlink in place. The copy-back loop below would then
    `shutil.copy2` the WINNING attempt's file content straight through that surviving symlink to
    wherever it points — a write outside `work`, from the unsandboxed app process, to a path and with
    content the agent fully controlled across its own attempts.

    Top-level listing: deliberately `_artifact_paths`-shaped (excludes hermes-home DIRECTORIES only), not
    `_scratch_artifacts` (which excludes hermes-home FILES too) — `_snapshot_scratch` captures via
    `_artifact_paths`, so a top-level FILE named e.g. `hermes-home-notes.txt` (a legitimate, servable
    artifact per `_resolve_artifact_path`'s own comment) is captured into the winning snapshot and must be
    cleared from `work` first, or a stale copy from a losing attempt is served alongside the winner's
    restored files.

    No O_NOFOLLOW needed on the READ side of the copy-back: `snapshot` was built entirely by
    `_snapshot_scratch` above, which only ever writes plain regular files — there is nothing untrusted
    left to guard against there, only the CLEAR step above (reading `work`, agent-controlled) needed it."""
    if isinstance(work, RemoteWork) or isinstance(snapshot, RemoteWork):
        if isinstance(work, RemoteWork) and isinstance(snapshot, RemoteWork):
            work.restore(snapshot)
        return
    try:
        top_level = [e for e in os.listdir(work)
                     if not (e.startswith("hermes-home") and os.path.isdir(os.path.join(work, e)))]
    except OSError:
        top_level = []
    for name in top_level:
        p = Path(work, name)
        try:
            if p.is_symlink():
                p.unlink()
            elif p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
        except OSError:
            pass
    for root, _dirs, files in os.walk(snapshot):
        for f in files:
            src = Path(root, f)
            dst = Path(work, os.path.relpath(src, snapshot))
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(src, dst)
            except OSError:
                pass


def _drop_snapshot(snapshot: str | RemoteWork) -> None:
    """Delete a `_snapshot_scratch` copy, wherever it was made. Never raises."""
    if isinstance(snapshot, RemoteWork):
        try:
            snapshot.drop()
        except Exception:  # noqa: BLE001 — the guest goes with its conversation either way
            pass
    elif snapshot:
        shutil.rmtree(snapshot, ignore_errors=True)


_EGRESS_OBSERVED = "unchecked"


def _probe_egress(target: str = "", timeout: float = 3.0) -> str:
    """Try to open a connection the allowlist should refuse, and report what happened. Never raises.

    "open" | "filtered" | "unchecked" — and the three are deliberately not two. A boolean would have to
    guess which way to resolve a probe that could not run, and both guesses are bad: "filtered" hides a
    real hole, "open" pages someone over a DNS hiccup.

    This observes egress instead of reading config. A config value saying `AGENT_EGRESS=allowlist` is only
    a claim — it says what entrypoint.sh was ASKED to do, not what the kernel is doing. So /healthz reports both,
    and they can disagree out loud."""
    host, _, port = (target or EGRESS_PROBE).partition(":")
    if not host or not port.isdigit():
        return "unchecked"
    s = None
    try:
        s = socket.create_connection((host, int(port)), timeout=timeout)
        return "open"
    except TimeoutError:
        return "filtered"           # policy drop swallows the SYN; nothing answers
    except OSError as e:
        # ECONNREFUSED is in this list because our chain REJECTS rather than silently dropping (a dropped
        # SYN costs the caller a full TCP retry ladder that stalls every agent turn). A refusal
        # from a target chosen to be listening therefore means something local refused it, which is the
        # filter. That inference rests entirely on the target: point AGENT_EGRESS_PROBE at a dead host and
        # this reports "filtered" about nothing. EPERM/EACCES cover a drop-style chain, ENETUNREACH a
        # missing route. Anything else — DNS failure, an offline box — is not evidence either way.
        return ("filtered" if e.errno in (errno.ECONNREFUSED, errno.EPERM, errno.EACCES, errno.ENETUNREACH)
                else "unchecked")
    finally:
        if s is not None:
            s.close()


_LIVE_COMPUTE_PROVIDER: dict = {}   # last successful poll of proxy.py's /healthz "last_served" (CUR-1107)


def _compute_provider_refresh() -> None:
    """Poll the proxy's own /healthz for the provider that actually served its most recent call, and
    latch it into _LIVE_COMPUTE_PROVIDER. Off the request path, like _egress_selftest — this app's own
    /healthz must stay fast and must not gain a new way to fail just because the proxy is briefly slow.
    No-op with the gateway off (nothing upstream to ask); a failed poll leaves the last good reading in
    place rather than clearing it, since a stale-but-real reading beats reverting to the unmeasured
    static default (AGENT_COMPUTE_PROVIDER) on a transient blip."""
    if not MODEL_PROXY_URL:
        return
    import httpx
    global _LIVE_COMPUTE_PROVIDER
    try:
        r = httpx.get(MODEL_PROXY_URL + "/healthz", timeout=3.0)
        r.raise_for_status()
        served = r.json().get("last_served")
    except Exception as e:  # noqa: BLE001 — proxy unreachable/slow: keep the last good reading
        _log_event("compute_provider.poll_failed", error=type(e).__name__)
        return
    if served:
        _LIVE_COMPUTE_PROVIDER = served


# The app model ids the gateway routes, from its /healthz `models`, and when they were read. A
# task may name one of these as its executor; [] means the gateway can route only AGENT_MODEL. (CUR-4603)
_ROUTABLE_MODELS: tuple[float, frozenset[str]] = (0.0, frozenset())
ROUTABLE_MODELS_TTL_SECS = float(os.environ.get("AGENT_ROUTABLE_MODELS_TTL_SECS", "60"))


def _routable_models() -> frozenset[str]:
    """The models the gateway says it routes, lower case, read at most once a ROUTABLE_MODELS_TTL_SECS.

    Read on the request path rather than left to the refresh loop, so the first task after boot is checked
    against the gateway's real answer and not an empty cache. A failed read keeps the last good answer, and
    with none there is none: a model the gateway has never confirmed is refused, never assumed."""
    global _ROUTABLE_MODELS
    at, models = _ROUTABLE_MODELS
    if not MODEL_PROXY_URL or (models and time.monotonic() - at < ROUTABLE_MODELS_TTL_SECS):
        return models
    import httpx
    try:
        r = httpx.get(MODEL_PROXY_URL + "/healthz", timeout=3.0)
        r.raise_for_status()
        got = r.json().get("models") or []
    except Exception as e:  # noqa: BLE001 — gateway unreachable: keep the last good answer
        _log_event("routable_models.poll_failed", error=type(e).__name__)
        return models
    models = frozenset(str(m).strip().lower() for m in got if isinstance(m, str) and m.strip())
    _ROUTABLE_MODELS = (time.monotonic(), models)
    return models


def _resolve_task_model(requested: str | None, user: str = "") -> str:
    """The executor model for a task that asked for `requested` (CUR-4603). Raises 422, never substitutes.

    Absent or AGENT_MODEL: AGENT_MODEL, the behaviour before a task could name one. Any other model runs
    only when the gateway routes it (`_routable_models`), and never when it is this deployment's verifier,
    because a judge grading its own model is the correlated self-check AGENT_VERIFIER_MODEL exists to avoid
    (`_check_model_coupling`). Everything else is refused here, before a slot is taken: the chat names the
    model the person picked, and running a different one under that name is the bug this guards against."""
    want = (requested or "").strip()
    if not want or want == AGENT_MODEL:
        return AGENT_MODEL
    if VERIFIER_MODEL and want.lower() == VERIFIER_MODEL.strip().lower():
        _log_event("run.rejected", user=user, reason="model_is_verifier", model=want)
        raise HTTPException(422, f"model {want!r} is this service's verifier and cannot also run the task")
    if want.lower() not in _routable_models():
        _log_event("run.rejected", user=user, reason="model_not_routable", model=want)
        raise HTTPException(422, f"model {want!r} is not available for agent tasks on this service")
    return want


def _effective_compute_provider() -> str | None:
    """The badge's actual source of truth: a live-observed provider when one exists, else the static
    configured intent. See AGENT_COMPUTE_PROVIDER's own comment for why the static value is kept as a
    fallback rather than dropped."""
    live = _LIVE_COMPUTE_PROVIDER.get("provider") if _LIVE_COMPUTE_PROVIDER else None
    return live or (AGENT_COMPUTE_PROVIDER or None)


_COMPUTE_PROVIDER_REFRESH_STOP = threading.Event()


def _compute_provider_refresh_loop() -> None:
    """Same shape as _pruner_loop / _session_reaper_loop: keep _LIVE_COMPUTE_PROVIDER from going stale
    for the life of the process, since routing is mixed and can shift between polls (CUR-1107)."""
    while not _COMPUTE_PROVIDER_REFRESH_STOP.wait(COMPUTE_PROVIDER_REFRESH_SECS):
        _compute_provider_refresh()


def _write_no_follow(path: str, text: str) -> None:
    """Write into the agent's scratch WITHOUT following a symlink there. Never raises.

    The scratch is the one directory the agent can write, and this function runs in the APP process,
    outside bwrap, as the uid that owns /srv and /data. `Path.write_text` follows symlinks, so
    `ln -s /srv/api/app.py raw.log` inside the scratch would turn a plain write here into an arbitrary
    file write with attacker-chosen content. The sandbox never has to be escaped, because the app reaches
    into it and performs the write on the attacker's behalf, and a `verify.check_cmd` alone can plant the
    link without any cooperation from the model.

    O_NOFOLLOW makes the open fail on a symlink rather than resolve it. O_EXCL is deliberately NOT used:
    the repair loop legitimately rewrites this path across attempts, and a create-only open would turn a
    normal second attempt into an error."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    except OSError as e:
        # ELOOP is the guard firing: something planted a symlink. Say so — a forensic log that silently
        # stops being written looks identical to a turn that produced nothing.
        _log_event("scratch.write_refused", path=os.path.basename(path), errno=e.errno)
        return
    with os.fdopen(fd, "w") as fh:
        fh.write(text)


def _egress_selftest() -> None:
    """Run the probe once at startup and record the verdict. Also LOGS the disagreement, because the case
    worth catching is `AGENT_EGRESS=allowlist` with an observed "open" — configured-and-not-actually-on,
    which is the gap this guards against: everything says it is handled."""
    global _EGRESS_OBSERVED
    _EGRESS_OBSERVED = _probe_egress()
    if EGRESS == "allowlist" and _EGRESS_OBSERVED == "open":
        _log_event("egress.UNFILTERED", configured=EGRESS, observed=_EGRESS_OBSERVED, probe=EGRESS_PROBE)
    else:
        _log_event("egress.checked", configured=EGRESS, observed=_EGRESS_OBSERVED, probe=EGRESS_PROBE)


def _resolver_addr() -> str:
    """The first nameserver in /etc/resolv.conf, or "" — the address the name filter is meant to cut off."""
    try:
        for line in Path("/etc/resolv.conf").read_text().splitlines():
            f = line.split()
            if len(f) >= 2 and f[0] == "nameserver":
                return f[1]
    except OSError:
        pass
    return ""


def _dns_query(name: str) -> bytes:
    """A minimal A-record query packet. Hand-rolled because the whole point is to talk to port 53 without
    the stdlib resolver in the way — see _probe_dns."""
    labels = b"".join(bytes([len(x)]) + x.encode() for x in name.split(".") if x)
    return struct.pack(">HHHHHH", 0x4147, 0x0100, 1, 0, 0, 0) + labels + b"\x00" + struct.pack(">HH", 1, 1)


def _probe_dns(name: str = "", timeout: float = 3.0) -> str:
    """Ask the configured resolver for a name that is not in /etc/hosts, and report what the network said.
    "open" | "filtered" | "unchecked", the same three states as _probe_egress and for the same reason.

    Deliberately a RAW UDP socket rather than getaddrinfo, which would be one line. getaddrinfo cannot tell
    the two answers apart: a working resolver replying NXDOMAIN and a blocked resolver replying nothing both
    surface as an exception. Since the claim under test is precisely "the resolver is unreachable from this
    process", the convenient instrument is the one instrument that cannot make it. Going to :53 directly
    also bypasses /etc/hosts, so the probe measures the filter and not the workaround built on top of it."""
    server = _resolver_addr()
    if not server:
        return "unchecked"                      # no resolver configured: nothing to say either way
    s = socket.socket(socket.AF_INET6 if ":" in server else socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.connect((server, 53))                 # connected UDP, so the ICMP refusal is reported to us
        s.send(_dns_query(name or DNS_PROBE))
        s.recv(512)
        return "open"                           # something answered — the resolver is reachable
    except TimeoutError:
        return "filtered"                       # a drop-style rule swallows the query; nothing answers
    except OSError as e:
        return ("filtered" if e.errno in (errno.ECONNREFUSED, errno.EPERM, errno.EACCES, errno.ENETUNREACH)
                else "unchecked")
    finally:
        s.close()


_DNS_OBSERVED = "unchecked"


def _dns_selftest() -> None:
    """Probe once at startup, and check the positive half too.

    Two things can go wrong and they need different alarms. The filter can be absent — configured `hosts`,
    observed "open" — which is the hole still standing. Or the filter can be present and have taken the
    service's own resolution with it, which looks identical in a log that only records "filtered": every
    turn then fails at zero model calls with no line saying why. So this also resolves the gateway's own
    hostname through the ordinary path, which must now come out of /etc/hosts, and records the answer."""
    global _DNS_OBSERVED
    _DNS_OBSERVED = _probe_dns()
    own, own_ok = "", None
    if MODEL_PROXY_URL:
        from urllib.parse import urlparse
        own = urlparse(MODEL_PROXY_URL).hostname or ""
    if own:
        try:
            socket.getaddrinfo(own, None)
            own_ok = True
        except OSError:
            own_ok = False
    event = "dns.UNFILTERED" if (DNS == "hosts" and _DNS_OBSERVED == "open") else "dns.checked"
    if own_ok is False:
        event = "dns.SELF_BROKEN"               # outranks the above: we cut ourselves off, not just the agent
    _log_event(event, configured=DNS, observed=_DNS_OBSERVED, probe=DNS_PROBE,
               resolver=_resolver_addr(), gateway_host=own, gateway_resolves=own_ok)


def _artifact_paths(work: str | RemoteWork, limit: int, since: float | None = None) -> list[tuple[str, int]]:
    """Every file the agent left, as (relative path, size), sorted. PURE apart from the walk.

    Distinct from `_scratch_artifacts`, which lists the top level only and is load-bearing for the repair
    loop's "did the agent leave anything" test — widening THAT would change when a failed attempt's files
    survive into the next one. This one recurses, because "create a directory called reports with three
    files in it" is a task people actually ask for and a top-level listing reports it as one entry.

    Excluded: the per-attempt `hermes-home*` session state (not the user's work), `raw.log`, which the
    service itself writes into the scratch at the end of the run, and ARTIFACT_QUARANTINE_DIRNAME (CUR-836:
    files a moderation block already removed from circulation, not the agent's work either).

    `since`, when set, drops anything with `st_mtime` older than it — CUR-1117: in a continued session
    (CUR-196) `work` survives across turns, so an unfiltered walk resurfaces a PRIOR turn's real file
    under a "this turn produced" label even when this turn made zero tool calls. Callers that want the
    whole scratch (moderation, the download route) pass None, unchanged.

    Walks one entry past `limit` so the caller can tell "exactly the cap" from "more than we're sending" —
    a cap that silently drops the 21st file reads as a complete list and is the same lie, smaller.

    Order is top-level-first (os.walk), sorted within each directory, and that is load-bearing rather than
    incidental: when a cap bites it decides WHICH files survive. The agent is told to write its output to
    the working directory (WORKDIR_NOTE), so the top level holds the answer and a nested tree is usually
    supporting material. A global sort by path would let `a/b/tmp.txt` displace `report.md`."""
    if isinstance(work, RemoteWork):
        return work.files(limit, since=since)                    # the same walk, run in the guest (CUR-4483)
    out: list[tuple[str, int]] = []
    for root, dirs, files in os.walk(work):
        dirs[:] = sorted(d for d in dirs if not (root == work and (
            d.startswith("hermes-home") or d == ARTIFACT_QUARANTINE_DIRNAME)))
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(root, f), work)
            if rel == "raw.log":
                continue
            try:
                # lstat, and REGULAR FILES ONLY. This walk feeds a read in the app process, outside bwrap,
                # over paths the agent controls, so every non-regular entry here is an attack primitive:
                # a symlink to /data/tasks.db returns another tenant's database, and a FIFO blocks the
                # read forever — which would hold the task's concurrency slot until the service wedges.
                # os.walk already does not follow directory symlinks (followlinks defaults False).
                st = os.lstat(os.path.join(root, f))
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if since is not None and st.st_mtime < since:
                continue
            out.append((rel, st.st_size))
            if len(out) > limit:
                return out
    return out


def _read_artifact(path: str, cap: int) -> tuple[str | None, bool]:
    """(text, truncated) for one file, or (None, False) if it isn't text. Binary is reported by size only —
    the chat surface renders text, and base64 of an unknown blob helps nobody at this size budget."""
    try:
        # O_NOFOLLOW and a BOUNDED read. `Path(path).read_bytes()[:cap]` materialises the whole file
        # first, so a sparse `truncate -s 20G` file in the scratch, free to create, would be an out-of-memory
        # kill of a 1GB machine. The cap has to be applied by the read, not by the slice. O_NOFOLLOW closes
        # the symlink route a second time, in case a file passes the lstat above and is swapped after.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None, False
    try:
        with os.fdopen(fd, "rb") as fh:
            raw = fh.read(cap + 1)
    except OSError:
        return None, False
    return _decode_artifact(raw, cap)


def _decode_artifact(raw: bytes, cap: int) -> tuple[str | None, bool]:
    """`_read_artifact`'s verdict on up to cap+1 bytes already read: (text, truncated), or (None, False)."""
    # A PDF has no NUL byte when its streams are ASCII85 (reportlab's default), so the NUL test alone reads
    # one as 15 KB of text, which the guard takes about 30 s to screen against a 25 s timeout: every PDF would
    # fail the turn as "moderation pipeline unavailable" (CUR-4106).
    if b"\x00" in raw or raw.startswith(b"%PDF-"):
        return None, False
    truncated = len(raw) > cap
    try:
        return raw[:cap].decode("utf-8"), truncated
    except UnicodeDecodeError as e:
        # A multi-byte character straddling the cap is a truncation artifact, not a binary file; retry
        # lenient before concluding it's a blob, or every cut CSV of accented names reports as binary.
        # Only there: a UTF-8 character is at most 4 bytes, so an error earlier than that is binary.
        if not truncated or e.start < cap - 3:
            return None, False
        return raw[:cap].decode("utf-8", "ignore"), truncated


def _read_rel(work: str | RemoteWork, rel: str, cap: int) -> tuple[str | None, bool]:
    """`_read_artifact` for a file named relative to `work`, which may be the guest's workspace."""
    if isinstance(work, RemoteWork):
        raw = work.read(rel, cap + 1)
        return (None, False) if raw is None else _decode_artifact(raw, cap)
    return _read_artifact(os.path.join(work, rel), cap)


def _collect_artifacts(work: str | RemoteWork, since: float | None = None) -> tuple[list[dict], bool]:
    """(artifacts, more_were_dropped). The files the agent produced, with their contents where they fit,
    so the response carries what the answer describes.

    `bytes` is the true on-disk size and is always present. `truncated` means exactly "`text` is not the
    whole file", which covers both a cut-off read and a binary blob we decline to send. So the list of
    WHAT was made stays complete even when the contents aren't, and nothing a consumer receives can be
    mistaken for a file it has in full.

    `since` narrows to files written this turn — see `_artifact_paths`. Only the "this turn produced"
    display list passes it; `_artifact_text_for_moderation` and the download route call `_artifact_paths`
    unscoped on purpose and don't go through here."""
    if ARTIFACT_MAX_FILES <= 0:
        return [], False
    found = _artifact_paths(work, ARTIFACT_MAX_FILES, since=since)
    dropped = len(found) > ARTIFACT_MAX_FILES
    budget = ARTIFACT_TOTAL_BYTES
    out = []
    for rel, size in found[:ARTIFACT_MAX_FILES]:
        cap = min(ARTIFACT_MAX_BYTES, budget)
        text, truncated = (None, False) if cap <= 0 else _read_rel(work, rel, cap)
        if text is not None:
            budget -= len(text.encode())
        out.append({"name": rel, "bytes": size, "text": text,
                    "truncated": truncated or (text is None and size > 0)})
    return out, dropped


def _artifact_text_for_moderation(work: str | RemoteWork) -> str:
    """Every artifact's text, up to ARTIFACT_DOWNLOAD_MAX_BYTES per file — what the moderation call at the
    end of _run actually needs to see, and NOT what `_collect_artifacts` produces.

    `_collect_artifacts`'s caps (ARTIFACT_MAX_FILES/ARTIFACT_MAX_BYTES/ARTIFACT_TOTAL_BYTES) bound the size
    of the inline JSON preview a client renders — that's the right cap for THAT job. Using the same capped
    text for moderation would leave a file past the count cap, or bigger than the preview cap, unmoderated
    (CUR-546). GET /sessions/{id}/artifacts/{filename} serves any regular file in
    `work` up to ARTIFACT_DOWNLOAD_MAX_BYTES regardless of those inline caps, so moderation has to cover
    the same ground — deliberately unbounded by ARTIFACT_MAX_FILES here, for the same reason
    `_resolve_artifact_path` isn't.

    Binary content is skipped, not blocked: `_read_artifact` returns None for it (same as `_collect_artifacts`
    already accepts), and no practical text classifier moderates raw bytes anyway. This stays an accepted,
    visible gap — the CUR-546 route review considered gating binary downloads on it and chose not to, since
    that would block ordinary non-text work output for a screening pass that can't act on it regardless."""
    out = []
    for rel, size in _artifact_paths(work, limit=10**9):  # no ARTIFACT_MAX_FILES cap — see docstring above
        if size <= 0:
            continue
        text, _truncated = _read_rel(work, rel, ARTIFACT_DOWNLOAD_MAX_BYTES)
        if text:
            out.append(text)
    return "\n".join(out)


def _quarantine_blocked_artifacts(work: str | RemoteWork) -> list[str]:
    """Called right after a STAGE_ARTIFACTS `moderate()` call raises (CUR-836). Moves every file that
    contributed text to that call — same walk, same skip rules as `_artifact_text_for_moderation`, so
    "the offending files" means exactly the set that was actually screened and blocked, nothing wider
    (an empty or binary file couldn't have caused the block and is left alone) — out of `work` and into
    ARTIFACT_QUARANTINE_DIRNAME, a directory `_artifact_paths` and `_resolve_artifact_path` both exclude.

    Coarse by construction, not by oversight: STAGE_ARTIFACTS moderates one concatenated blob of every
    artifact's text in a single call, so a block carries no per-file attribution — an innocent file that
    merely sat alongside the actual offender in the same turn is quarantined too. Splitting into one
    moderate() call per file would fix that at the cost of turning one Coop round-trip into
    ARTIFACT_MAX_FILES-unbounded-many; not worth it for a path that already fails the whole turn either way.

    That does two things at once: the download route now 404s on the quarantined name (it no longer
    exists at that path), and the NEXT turn in this session — which re-moderates everything still in
    `work` because CUR-196 keeps the workdir alive across turns — no longer sees this file at all, so it
    can't re-block on the same content every turn until the idle reaper finally clears the session.

    Same filesystem, so `os.replace` is an atomic rename, not a copy — no window where the file exists in
    both places or neither. Returns the relative paths actually moved, for the caller to log."""
    quarantined: list[str] = []
    for rel, size in _artifact_paths(work, limit=10**9):
        if size <= 0:
            continue
        if isinstance(work, RemoteWork):
            if _read_rel(work, rel, ARTIFACT_DOWNLOAD_MAX_BYTES)[0] and work.quarantine(rel):
                quarantined.append(rel)
            continue
        src = os.path.join(work, rel)
        text, _truncated = _read_artifact(src, ARTIFACT_DOWNLOAD_MAX_BYTES)
        if not text:
            continue
        dest = os.path.join(work, ARTIFACT_QUARANTINE_DIRNAME, rel)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            os.replace(src, dest)
        except OSError:
            continue                                       # best-effort — a race here still leaves the block recorded
        quarantined.append(rel)
    return quarantined


def _downloadable(rel_parts: tuple[str, ...]) -> bool:
    """Whether a workspace path, as its parts, is the agent's work rather than session state, the service's
    raw.log, or a quarantined file. The same rule for a local workspace and the guest's."""
    return bool(rel_parts) and not ((len(rel_parts) > 1 and (rel_parts[0].startswith("hermes-home")
            or rel_parts[0] == ARTIFACT_QUARANTINE_DIRNAME)) or rel_parts == ("raw.log",))


def _resolve_artifact_path(work: str, filename: str) -> tuple[str, int, int] | None:
    """(path, dev, ino) for one CUR-546 download, or None if `filename` isn't a safe, existing, regular
    file inside `work`. Deliberately NOT built on `_artifact_paths` — that walk is capped at
    ARTIFACT_MAX_FILES for the inline-summary budget, and a file past that cap still exists on disk and
    must still be fetchable by exact name.

    `os.path.realpath` resolves every symlink in `filename` AT THIS INSTANT, including an intermediate
    directory symlink — so `work/link-out -> /etc` plus a request for `link-out/passwd` is caught here.
    But that's a check, not a lock: `dev`/`ino` are returned so `_open_artifact_for_streaming` can re-verify, right
    after its own open(), that what it actually opened is the SAME file this function just approved.
    O_NOFOLLOW on that open only blocks the FINAL path component from being a symlink — it does nothing
    for an intermediate directory swapped to a symlink between this check and that open(), which redirects
    the read outside `work` entirely with no error. The commonpath check against `work`'s own realpath is
    what actually enforces containment at THIS instant; rejecting `..`/absolute components first is belt
    and suspenders, not the real defense."""
    # "\x00" check must come before any os.path call touches `filename`: os.path.join/realpath raise
    # ValueError on an embedded NUL, uncaught here, and `filename` is straight off the URL — %00 decodes
    # to a real NUL byte before this function ever sees it. Path(filename).parts doesn't touch the
    # filesystem, so it doesn't catch this.
    if not filename or "\x00" in filename or os.path.isabs(filename) or ".." in Path(filename).parts:
        return None
    work_real = os.path.realpath(work)
    resolved = os.path.realpath(os.path.join(work, filename))
    if os.path.commonpath([resolved, work_real]) != work_real:
        return None
    # Mirrors _artifact_paths' own exclusions exactly — which, read precisely, only ever prunes a
    # TOP-LEVEL hermes-home*/ARTIFACT_QUARANTINE_DIRNAME DIRECTORY from the walk (`dirs[:] = ...`, filters
    # `dirs`, never `files`), so a top-level FILE that happens to be named e.g. hermes-home-notes.txt is NOT
    # excluded there and must not be excluded here either — `len(rel_parts) > 1` is what "nested beneath a
    # pruned directory" means, not "starts with the same string". Same reasoning as raw.log below: the
    # service only ever writes that name directly into `work` itself, so an agent-authored `subdir/raw.log`
    # is a legitimate artifact _artifact_paths would list, and this must still serve it.
    rel_parts = Path(os.path.relpath(resolved, work_real)).parts
    if not _downloadable(rel_parts):
        return None                                        # session state / service log / quarantined, not user work
    try:
        st = os.lstat(resolved)                             # realpath already dereferenced symlinks;
    except OSError:                                          # this just confirms the terminus is a regular file
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    return resolved, st.st_dev, st.st_ino


_ARTIFACT_STREAM_CHUNK_BYTES = 65536   # per-chunk read size for CUR-546 downloads — bounds PEAK per-request
                                        # memory to one chunk regardless of file size or concurrency, rather
                                        # than depending on ARTIFACT_DOWNLOAD_MAX_BYTES staying small; a slow
                                        # client reading a whole buffered response out slowly held the FULL
                                        # response body in memory for as long as the transfer took, and that
                                        # duration was never bounded by the byte cap either


def _open_artifact_for_streaming(path: str, cap: int, expected_dev: int, expected_ino: int):
    """(fh, size, oversize). fh is an OPEN file object positioned at 0 — the caller owns closing it — and
    `size` is its exact byte length, read once from the same identity-verifying fstat this needs anyway.
    fh is None for anything short of a clean, in-budget regular-file open — unreadable, raced away, not a
    regular file, or not the SAME file by the time open() actually runs; oversize separates "over cap" from
    every other None case, since conflating them would report 413 for e.g. a session the idle reaper
    deleted mid-request.

    An open file handed back for later, chunked reading — rather than the whole file read into `bytes`
    right here — is the point: this is what lets the endpoint stream instead of buffering a file whose
    size is bounded only by ARTIFACT_DOWNLOAD_MAX_BYTES into memory once per concurrent request.

    O_NOFOLLOW blocks `path`'s own final component from being a symlink; it does nothing for an
    intermediate directory swapped to a symlink between `_resolve_artifact_path`'s check and this open() —
    that redirects the read outside `work` with no error, since O_NOFOLLOW never even looks at the
    intermediate segments. The dev/ino comparison against what that check actually found is what closes
    that window: a redirected open lands on a different inode, full stop, regardless of how it got there.

    O_NONBLOCK is the one `_read_artifact` doesn't need and this does: that function only ever runs after
    its OWN task's sandboxed subprocess has already exited, so nothing can race a file swap into place
    between the check and the read. This is a live HTTP request against a workdir a DIFFERENT,
    concurrently-running turn on the same session_id can still be writing to — `mkfifo` is ordinary
    sandboxed tool access, and without O_NONBLOCK a blocking open on a FIFO with no writer connected hangs
    the request's thread forever. O_NONBLOCK stops the open from blocking on that; it doesn't stop the open
    from succeeding, so the fstat re-check below still has to run before any read happens."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None, 0, False
    fh = None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (expected_dev, expected_ino):
            return None, 0, False
        if fst.st_size > cap:
            return None, 0, True
        fh = os.fdopen(fd, "rb")            # ownership of fd transfers here; the finally below reflects that
        return fh, fst.st_size, False
    except OSError:
        return None, 0, False
    finally:
        if fh is None:                      # success returns above; only an early-return/exception path
            os.close(fd)                    # reaches here with the fd still unowned by a file object


def _stream_artifact_chunks(fh):
    """Read `fh` in bounded chunks until EOF, then close it — same generator whether the transfer finishes
    normally or Starlette tears it down early on a client disconnect (a generator's `finally` still runs
    when it's closed via `GeneratorExit` rather than exhausted), so the fd is reclaimed either way."""
    try:
        while True:
            chunk = fh.read(_ARTIFACT_STREAM_CHUNK_BYTES)
            if not chunk:
                return
            yield chunk
    finally:
        fh.close()


def _content_disposition(filename: str) -> str:
    """RFC 6266 attachment header for a name the agent chose, i.e. attacker-influenced: an ASCII fallback
    with control chars / quotes / backslashes neutralized (a raw CR or LF here is a response-splitting
    primitive, not just a display glitch) plus the accurate percent-encoded UTF-8 form modern browsers
    actually use."""
    safe_ascii = "".join(c if (32 <= ord(c) < 127 and c not in '"\\') else "_" for c in filename) or "artifact"
    return f'attachment; filename="{safe_ascii}"; filename*=UTF-8\'\'{quote(filename)}'


def _repair_carries_scratch(spec: VerifySpec | None, autoderived: bool = False) -> bool:
    """Whether a failed attempt's files may survive into the next attempt. PURE, so it unit-tests.

    `_reset_scratch` exists to stop attempt 1's leftovers from false-passing attempt 2's `_verify`, and
    that risk is real for exactly one shape of spec: one that only asserts a file EXISTS. Attempt 1
    writes the file with wrong content, attempt 2 does nothing, existence still holds → a pass nobody
    earned. A spec that asserts CONTENT cannot be fooled that way: it already failed on those bytes, and
    it will fail on them again if the agent doesn't change them.

    So content-asserting specs carry, existence-only specs reset.

    expect_sorted_by/expect_columns are content-asserting by the same logic: a file that is unsorted, or
    missing a column, fails on those exact bytes and will fail again unchanged, same as expect_contains.
    Leaving them out here would disable in-session repair for those two primitives (the gate above
    requires this to be True or spec to be None) and push every rejected attempt through a full reset,
    discarding a diagnosis as precise as "not sorted at row 4".

    An `autoderived` spec always resets, whatever fields it carries. The derive step can invent a filename
    and `expect_columns` from context even when the prompt asks for no file, which would make the guess
    content-asserting by the rule above and hand the repair loop a contract nobody asked for: the model
    answers correctly inline and is then argued with over a file it was never asked to write. An
    autoderived spec is a model's guess and never binds hard at the acceptance layer, here included."""
    if spec is None or autoderived:
        return False
    return bool(spec.check_cmd or spec.expect_contains or spec.expect_lines
                or spec.expect_sorted_by or spec.expect_columns)


def _repair_prompt(prompt: str, detail: str, limit: int = REPAIR_DETAIL_CHARS) -> str:
    """The next attempt's prompt: the original task, plus what the check said about the last try.

    Best-of-N without this is N independent shots from an empty directory, which is the weaker method:
    long-horizon failures are mostly near-misses (a store that never opens its file, a parser that only
    matches at line start) that a model fixes in one turn once it is told, and a fresh start re-derives
    the same near-miss from nothing.

    `detail` is the check's own output. It is NOT operator-authored — a traceback can carry strings from
    the agent's own code — so it goes to exactly one place: the prompt of the same agent, in the same
    sandbox, that produced it. Nothing here may be routed to a judge, a log consumer, or a user-facing
    field on the assumption that it is trusted text."""
    tail = detail.strip()
    if len(tail) > limit:
        tail = "…" + tail[-limit:]
    return (
        f"{prompt}\n\n"
        "---\n\n"
        "A previous attempt at this task left its work in your working directory. The files are there "
        "now; you are continuing that work, not starting it.\n\n"
        f"An automated check ran against those files and failed:\n\n    {tail}\n\n"
        "Read what is already on disk before you change anything. Fix what the check reported and leave "
        "the rest alone. Do not delete the existing files and start over."
    )


def _syntax_errors(work: str | RemoteWork, max_files: int = 200) -> list[str]:
    """Python the agent wrote that will not compile, as `path:line: message`. PURE apart from reading.

    The agent can edit a file into a broken state (an unterminated string, `return` outside a function)
    and not notice. `check_cmd` then reports `ModuleNotFoundError` from the failed import, which reads as
    "never wrote it" rather than "wrote it and broke it", and the repair turn argues about the wrong thing.

    `compile` rather than `py_compile`: no bytecode written, no import, no execution. The agent's code is
    untrusted and this must never run it. Costs no model call, so it goes in front of the real check.

    Skips the per-attempt HERMES_HOMEs (session state, not work) and __pycache__. `max_files` bounds a
    walk over a directory the agent controls."""
    out, seen = [], 0
    if isinstance(work, RemoteWork):                       # CUR-4483: compiled here, read from the guest
        for rel, _size in work.files(10**9):
            if not rel.endswith(".py") or "__pycache__" in rel.split("/"):
                continue
            seen += 1
            if seen > max_files:
                break
            raw = work.read(rel, ARTIFACT_DOWNLOAD_MAX_BYTES)
            if raw is None:
                continue
            try:
                compile(raw.decode("utf-8", errors="replace"), rel, "exec")
            except SyntaxError as e:
                out.append(f"{rel}:{e.lineno}: {e.msg}")
            except ValueError as e:
                out.append(f"{rel}: {e}")
        return out
    for root, dirs, files in os.walk(work):
        dirs[:] = [d for d in dirs if not d.startswith("hermes-home") and d != "__pycache__"]
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            seen += 1
            if seen > max_files:
                return out
            p = os.path.join(root, name)
            try:
                src = Path(p).read_text(errors="replace")
            except OSError:
                continue
            try:
                compile(src, p, "exec")
            except SyntaxError as e:
                rel = os.path.relpath(p, work)
                out.append(f"{rel}:{e.lineno}: {e.msg}")
            except ValueError as e:      # e.g. source with null bytes — still "will not import"
                out.append(f"{os.path.relpath(p, work)}: {e}")
    return out


# ACP tool kinds that demonstrably cannot have executed anything. An ALLOWLIST of the inert kinds, never
# a denylist of the executing ones: `other` is what the bridge reports when it has no kind, and a future
# Hermes build can introduce kinds this file has never heard of. An unknown kind might have run something,
# and being right about "nothing ran" is the entire value of the claim. Mirrors the same list on the chat
# client (endpointAgent.ts), which renders the user-facing caveat off the same frames.
INERT_TOOL_KINDS = frozenset({"read", "edit", "delete", "move", "search", "think", "fetch", "switch_mode"})

# Marks a repair detail as "you wrote it and never ran it" rather than "the check disagrees". The two need
# different words — see _repair_turn_text, which would otherwise open by citing an acceptance check that
# never ran, in a message whose whole purpose is to stop the model asserting things it did not observe.
UNRUN_DETAIL_PREFIX = "wrote-and-never-ran:"
# Nested inside UNRUN_DETAIL_PREFIX's own value (still one outer wrap at the call site), not a
# sibling of it — this marks the DIFFERENT shape underneath: something DID run and it FAILED, not "never
# ran". _repair_turn_text's fixed "you wrote X and never ran it" sentence is actively wrong for this case
# — the model ran something; reusing that template verbatim would tell it the opposite of what happened. (CUR-574)
TOOL_FAILED_PREFIX = "tool-call-failed:"
# Same nesting as TOOL_FAILED_PREFIX above — a third shape underneath UNRUN_DETAIL_PREFIX. Not
# "wrote it and never ran it" (nothing was written) and not "a tool call failed" (no tool ran at all):
# the model claimed a specific file already exists/was already written when it was never produced this
# task. _repair_turn_text's default template would tell it to "run" something that was never written —
# wrong instruction for a claim that is false about EXISTENCE, not about EXECUTION. (CUR-777)
FALSE_EXISTENCE_PREFIX = "claimed-file-missing:"
# CUR-596 item 2: shares task.unrun_detail's wire contract (the frontend's "predicted rather than measured"
# gate is `Boolean(unrun_detail.trim())` — any non-empty value trips it, not just this prefix), but a
# DIFFERENT shape underneath from the two above: every attempt genuinely ran AND independently verified —
# they just didn't agree on the computed value, so no single one of them can be trusted over the others.
VALUE_DISAGREEMENT_PREFIX = "attempts-disagreed:"
# A fifth shape, and the first that isn't the model overclaiming. The four prefixes above all mean "the
# agent's own account of this turn doesn't hold up" (never ran it, a run failed, a claimed file doesn't
# exist, two runs disagreed), close enough in kind that endpointAgent.ts's one "predicted rather than
# measured" sentence fits all four. A structural failure (the gateway went unavailable mid-task, a
# wall-clock/spend cap fired, the agent process exited nonzero) means the INFRASTRUCTURE didn't finish
# the turn, so endpointAgent.ts gives this prefix its own copy; the shared sentence would be false here.
STRUCTURAL_FAILURE_PREFIX = "structural-failure:"
# A SIXTH shape, and unlike every prefix above it is not about whether the model's account of
# ITS OWN PROCESS holds up (ran it, ran it and it failed, the file exists, two runs disagreed, the
# infrastructure died) — it is about whether the model's stated RESULT is internally coherent. Nested
# under nothing: this can fire on a turn with real, successful tool calls and no other check above has
# any reason to flag it, since every one of them asks "did something run", and here something plainly did. (CUR-1404)
ZERO_RESULT_PREFIX = "zero-from-nonzero:"


def _runnable_python(work: str | RemoteWork, max_files: int = 200) -> str | None:
    """The first .py file the agent left, relative to `work`, or None. PURE apart from the walk.

    Deliberately does NOT try to decide whether the file is "meant" to be run — no __main__ sniffing, no
    shebang test. A module the agent wrote and never imported anywhere is exactly as unverified as a
    script it never executed, and the repair turn asks it to run the thing rather than asserting what the
    thing is. Same skips as _syntax_errors, for the same reasons."""
    if isinstance(work, RemoteWork):          # CUR-4595: on E2B the file is in the guest, not under `work.local`
        for rel, _size in work.files(10**9):
            if rel.endswith(".py") and "__pycache__" not in rel.split("/"):
                return rel
        return None
    for root, dirs, files in os.walk(work):
        dirs[:] = [d for d in dirs if not d.startswith("hermes-home") and d != "__pycache__"]
        for name in sorted(files):
            if name.endswith(".py"):
                return os.path.relpath(os.path.join(root, name), work)
        max_files -= 1
        if max_files <= 0:
            return None
    return None


_EXECUTION_CLAIM_HEADING = re.compile(
    r"(?im)^\s*#{0,3}\s*\*{0,2}((?:execution\s+)?(?:results?|outputs?))\*{0,2}\s*:\s*\*{0,2}")
# The heading check above needs a heading. A turn with zero tool calls can also make a specific false
# method claim mid-paragraph, with no heading anywhere: "These amounts are derived by summing the
# revenue for each month across all products." (CUR-671). Narrow on purpose, like the heading regex: a verb claiming the arithmetic happened (calculated/derived/computed/summed/totaled)
# within a short window of a preposition naming what it was done FROM (by/from/across/through/using/
# via) — not just "the total is 4000" (a bare claim, not a claim of HAVING derived it) and not the
# UX-researcher's passing theme-count answer ("cost: 4 people, trust: 1"), which categorizes but never
# claims to have calculated anything.
#
# Why `summ` excludes "ar": `summ\w*` unqualified also matches "summary"/
# "summarize(d)" — CAPABILITY_NOTE names "summarizing" as a valid no-tool job, and the passing
# UX-researcher answer is exactly the shape a real summary sentence takes ("Here is a summary I put
# together by grouping the themes into cost, trust, and language" — matches "summary ... by" as written).
# That would have bounced a CORRECT summarization turn into a nonsensical repair round ("you wrote a
# claimed computation ... and never ran it. Run it now") on precisely the turns that must not
# break. `summ` and `summary`/`summarize` share the same four-letter prefix, so no word-boundary fix
# helps — excluding the "ar" that starts "summary"/"summarize"/"summarizing" right after "summ" does:
# "summed"/"summing"/"sums" all continue some other way, "summary"/"summarize*" all continue with "ar".
_COMPUTATION_CLAIM_PHRASE = re.compile(
    r"(?i)\b(calculat\w*|deriv\w*|comput\w*|summ(?!ar)\w*|totall?ed|totalling)\b[^.\n]{0,60}"
    r"\b(by|from|across|through|using|via)\b")
_EXECUTION_CLAIM_HEDGE = re.compile(
    r"(?i)\b(expected|predicted|would\s+(?:produce|print|output|return|be|exist)|"
    r"should\s+(?:produce|print|output|return|be|exist))\b")
# Both verb lists include "be": _COMPUTATION_CLAIM_PHRASE's own claim shape ("these would be
# calculated by...") hedges on "would be", not "would produce/print/output/return", which cover the
# heading check's shape ("Output: (would produce X)"). Widening the lists can only turn an existing flag
# into a non-flag — never the reverse — so they are safe to share (CUR-671).
#
# They also include "exist": "`x.txt` would already exist if the script had run" hedges the same way,
# and _false_existence_claim below does not require a verb at all (CUR-705).

# A third fabrication shape: a fully staged tool round-trip with no real tool call. The model writes a
# fenced ```python block invoking `execute_code({...})` as literal text, then narrates a fake exchange
# with bracketed tags like "[Tool response received]" and a second fenced block presented as the tool's
# output. There is no "Result:" heading and no "derived by X" phrase, so neither pattern above matches.
# The bracketed meta-marker is the distinctive part: a genuine answer has no reason to write protocol
# framing like "[Tool response received]" to a user. Matches a `[...]` span (single line, bounded length
# so it can't run across unrelated bracketed text) containing BOTH a tool/protocol word (tool, function,
# execution, out-of-band) and a result-shaped word (response, result, output, message), in either order.
# Markdown links, categorization lists (`[cost, trust, language]`) and parenthetical notes don't match.
_FABRICATED_EXCHANGE_MARKER = re.compile(
    r"\[(?=[^\]\n]{0,100}\b(?:tool|function|execution|out-of-band)\b)"
    r"(?=[^\]\n]{0,100}\b(?:response|result|output|message)\b)[^\]\n]{0,100}\]", re.I)


def _ungrounded_execution_claim(answer: str) -> str | None:
    """A heading that claims an observed result with nothing behind it, or None. PURE, unit-tests on text.

    A fabricating turn heads its output `Execution result:`, while an honest one heads the same content
    `Expected results:`. The model already marks this distinction some of the time, so this only has to
    catch the cases where it doesn't.

    Narrow on purpose, same allowlist shape as the tool-kind check below: it matches only a bare
    `Result(s):` / `Output(s):` / `Execution result(s):` heading, anchored at the
    start of a line (only whitespace/`#`/`*` allowed before it) — a modifier word there, like `Expected`
    or `Predicted`, already keeps the heading itself from matching. The separate hedge check below is for
    a hedge landing AFTER a heading that did match, on the same line (`Output: (predicted, not run)`).

    A second, independent pattern catches the headless case (_COMPUTATION_CLAIM_PHRASE), and a third a
    fully fabricated tool round-trip staged as fenced code blocks and bracketed meta-markers
    (_FABRICATED_EXCHANGE_MARKER). Both use the same hedge escape, checked on the line the match lands on."""
    for pattern, detail in ((_EXECUTION_CLAIM_HEADING, "a claimed result with no tool call behind it"),
                            (_COMPUTATION_CLAIM_PHRASE, "a claimed computation with no tool call behind it"),
                            (_FABRICATED_EXCHANGE_MARKER, "a fabricated tool exchange with no tool call behind it")):
        m = pattern.search(answer)
        if not m:
            continue
        line_start = answer.rfind("\n", 0, m.start()) + 1
        line_end = answer.find("\n", m.end())
        line = answer[line_start:line_end if line_end != -1 else len(answer)]
        if not _EXECUTION_CLAIM_HEDGE.search(line):
            return detail
    return None


# A fourth fabrication shape: a turn with no real tool calls that claims a named file already exists or
# was written ("`revenue_test.csv` is already present", "`output.txt` now contains June, March, May").
# These claim prior state rather than a result, so none of the heading/phrase/bracket patterns above
# match them.
#
# Grounded rather than phrased. The patterns above are text-only because _ungrounded_execution_claim is
# PURE, but a claim that a named file exists can be checked against `work` directly, whatever the wording.
# Matching claim verbs or tenses doesn't converge (there are endless ways to say a file got made), so no
# claim phrase is required at all: every backtick-quoted filename in the answer is checked against
# `work`, and a missing one is suspect UNLESS its own sentence disclaims it. Negation is a small, closed
# class (not/n't/never/cannot...), so an exclusion list generalizes where an inclusion list cannot. The
# same goes for future/conditional intent (will/'ll/could/let me/if you), so an offer or a stated next
# step ("I'll create `x.csv` next") isn't misread as a claim about now.
_EXISTENCE_DISCLAIMER = re.compile(
    r"(?i)\b(?:not|n't|never|cannot|can't|won't|no\b|without|unable|missing|absent|"
    r"will|'ll|going\s+to|let\s+me|could|can(?:\s+i|\s+you)?|if\s+you|want\s+me\s+to)\b")
# Backtick-quoted only — this file's own prose convention for naming a file (see every MEASURED comment
# above) — so a bare word is never treated as a filename. No `/` in the class: a token can never name a
# path outside `work`, and the leading `..` check below is defense in depth on top of that, not the only
# guard.
_BACKTICK_FILENAME = re.compile(r"`([\w.\-]{1,80}\.\w{1,10})`")
_SENTENCE_BOUND_CHARS = ".!?;\n"


def _false_existence_claim(answer: str, work: str | RemoteWork) -> str | None:
    """A claimed-existing file that isn't in `work`, or None. NOT pure — answering "does this file
    actually exist" needs `work`, the one input _ungrounded_execution_claim deliberately does not take.

    Checks every backtick-quoted filename independently, existence first: a name that's actually in
    `work` is never a false claim regardless of how it's phrased, so wording never matters for a true
    mention. For a missing one, the scope for a disclaimer (negation, hedge, future/conditional intent)
    is the enclosing SENTENCE, not the whole line/paragraph — a hedge two sentences away must not shield
    an unrelated real claim (in the CUR-705 fixture, a "the expected file..." sentence sits right next
    to, not inside, the actual claim it must not protect)."""
    # On E2B the agent's files exist only in the guest, so a local `os.path.exists` would call every file
    # it made "missing" and replace delivered documents with "I was not able to complete this" (CUR-4595).
    # The guest's top level answers the same question the local join does; listed once, lazily.
    guest_names: set[str] | None = None
    for fm in _BACKTICK_FILENAME.finditer(answer):
        name = fm.group(1)
        if ".." in name:
            continue
        if isinstance(work, RemoteWork):
            if guest_names is None:
                guest_names = {n for n, _is_dir in work.top_level()}
            if name in guest_names:
                continue
        elif os.path.exists(os.path.join(work, name)):
            continue
        left = max(answer.rfind(c, 0, fm.start()) for c in _SENTENCE_BOUND_CHARS) + 1
        right_candidates = [r for r in (answer.find(c, fm.end()) for c in _SENTENCE_BOUND_CHARS) if r != -1]
        right = min(right_candidates) if right_candidates else len(answer)
        sentence = answer[left:right]
        if _EXISTENCE_DISCLAIMER.search(sentence) or _EXECUTION_CLAIM_HEDGE.search(sentence):
            continue
        return name
    return None


_UNRUN_RUN_HEADING = re.compile(
    r"(?im)^\s*#{0,3}\s*\*{0,2}run\*{0,2}\s*:\s*\*{0,2}\s*$")
_UNRUN_COMMAND_LINE = re.compile(
    r"(?m)^[^\n]*\b(python3?|node|bash|sh|npm|npx|ruby|Rscript)\b[^\n]*$")


def _unrun_inline_command(answer: str, window: int = 300) -> str | None:
    """A bare 'Run:' heading immediately followed by a command line naming a known interpreter, or None.
    PURE, unit-tests on text alone — same narrow, one-measured-case shape as _ungrounded_execution_claim.

    The shape it catches (CUR-542): asked to write a script and prove it works, an agent can run a
    test-data generator (so tool_kinds includes "execute"), then print the actual analysis as a bare
    `python -c "..."` one-liner under a **Run:** heading and stop, telling the user to run the code
    instead of running it. Tool-call raw_input is redacted by design
    (_AgentClient.handle_update never captures it), so there is no way to check whether the code shown
    here is the code that ran anywhere else this turn — asking the user to run something is itself the
    tell; an agent that had already run it would show the result, not the recipe.

    A known interpreter name must follow the heading within `window` chars — a fence with no heading, or
    a heading followed by prose, doesn't match."""
    m = _UNRUN_RUN_HEADING.search(answer)
    if not m:
        return None
    cmd = _UNRUN_COMMAND_LINE.search(answer, m.end(), m.end() + window)
    if not cmd:
        return None
    return cmd.group(0).strip().strip("`").strip()[:120]


def _wrote_code_without_running_it(tool_kinds: set[str], tool_failures: set[str], work: str | RemoteWork,
                                   answer: str, use_acp: bool) -> str | None:
    """The file it wrote and never ran, the un-run command it handed back instead, the tool call that
    outright failed while the answer claims a clean result, or the fabricated claim it made instead, or
    None. PURE apart from the walk, so it unit-tests.

    Checked in this order:

    1. An un-run inline command (_unrun_inline_command), regardless of tool_kinds. A real `execute` call
       earlier in the turn shows it ran *something*, not the specific block the answer now hands the
       user as an instruction.

    2. A tool call that FAILED while the answer reports success (`tool_failures`, ACP only). ACP does
       report completion status for execute-kind calls, including a turn's last one, so "this call
       failed and the answer claims success anyway" is a fact rather than an inference from which kinds
       ran. Returned `TOOL_FAILED_PREFIX`-tagged, because `_repair_turn_text` needs its own template
       here: "you wrote X and never ran it" is wrong when something did run and broke.

    3. No `edit` call (ACP only): the answer is read for a fabricated result
       (_ungrounded_execution_claim) or a claim about a file that doesn't exist (_false_existence_claim).
       With ACP on, an empty tool_kinds means the observer watched and saw nothing, which makes a stated
       result "ungrounded" in GSAR's sense (arXiv:2604.23366): a claim with zero supporting evidence
       rather than merely an unverified one. Without ACP no tool frames exist at all, so emptiness says
       nothing and this returns None.

    4. Otherwise, a runnable file was written and no executing tool ran (_runnable_python).

    Conditioned on the TRACE, not on the prompt. "Did the user ask for a run" is a judgement and an
    unreliable one; "you wrote a runnable file and no executing tool ran" is a measurement. That is why
    this is a function and not a sentence appended to WORKDIR_NOTE.

    Not caught: a prose-style fabrication following a real but insufficient tool call. That needs either
    the tool's raw output (redacted by design in this file) or per-turn execution provenance."""
    inline = _unrun_inline_command(answer)
    if inline:
        return inline
    if use_acp:
        failed_active = sorted(k for k in tool_failures if k not in INERT_TOOL_KINDS)
        if failed_active:
            return f"{TOOL_FAILED_PREFIX}{failed_active[0]}"
    if "edit" not in tool_kinds:
        # Covers both an empty tool_kinds and a non-empty one with no edit (e.g. a lone successful
        # `execute`). Running _ungrounded_execution_claim on the second is safe because its pattern is
        # narrow (a bare Result:/Output: heading with no hedge): a grounded prose answer doesn't match.
        if not use_acp:
            return None
        claim = _ungrounded_execution_claim(answer)
        if claim:
            return claim
        # _ungrounded_execution_claim only catches a claimed RESULT — a claim that a file
        # already exists/was already written is a different shape (see _false_existence_claim's own
        # comment for the measured transcripts), checked against `work` instead of another phrase. (CUR-777)
        false_file = _false_existence_claim(answer, work)
        return f"{FALSE_EXISTENCE_PREFIX}{false_file}" if false_file else None
    if any(k not in INERT_TOOL_KINDS for k in tool_kinds):
        return None
    return _runnable_python(work)


# A turn can run real code, print `Rows before cleaning: 8` / `Rows after cleaning: 0`, save a header-only
# CSV and report success. These match the two count lines so the numbers the turn reported itself can be
# compared to each other.
_COUNT_BEFORE_LINE = re.compile(
    r"(?im)^\s*\**\s*(?:rows?|records?|entries|items?|lines?)\s+before\b[^:\n]{0,40}:\s*\**\s*(\d+)\b")
_COUNT_AFTER_ZERO_LINE = re.compile(
    r"(?im)^\s*\**\s*(?:rows?|records?|entries|items?|lines?)\s+after\b[^:\n]{0,40}:\s*\**\s*0\b")


def _zero_result_from_nonzero_input(answer: str) -> str | None:
    """"{before} before, 0 after" when the answer states both a nonzero before-count and a zero
    after-count for the same kind of thing, else None. PURE, unit-tests on text alone — same narrow,
    one-measured-case shape as _ungrounded_execution_claim and _unrun_inline_command.

    Orthogonal to every check above: this fires on a turn with real, successful tool calls and an answer
    that is perfectly well-formed prose. It asks a different question — not "did the model run its code"
    but "does the model's own stated result contradict its own stated input" — a cleaning, filtering, or
    dedup step that removes 100% of a non-empty input is definitionally wrong for any task that asks for
    one, so this needs no domain knowledge about what the task actually was, only the two numbers the
    turn already reported.

    Narrow on purpose, keyed to the measured transcript's exact shape (a `<noun> before/after <verb>: N`
    line, markdown-bold tolerated) rather than a looser "any two numbers near each other" heuristic —
    widen only on a second measured case, per this file's own convention (see _FABRICATED_EXCHANGE_MARKER's
    history for why guessing ahead of evidence here has cost more than it's saved)."""
    before_m = _COUNT_BEFORE_LINE.search(answer)
    if not before_m:
        return None
    before_n = int(before_m.group(1))
    if before_n <= 0 or not _COUNT_AFTER_ZERO_LINE.search(answer):
        return None
    return f"{before_n} before, 0 after"


def _check_appendix(spec: VerifySpec | None, autoderived: bool,
                    limit: int = CHECK_APPENDIX_CHARS) -> str:
    """Show the agent the acceptance test it is being graded on, or "" when that would be wrong. PURE.

    A mechanism in place of a wording, like forcing tool_choice instead of asking for tool calls. Telling
    the model to "run each module before moving on" doesn't make it run anything; showing it the check it
    will be graded on, and the check's output between attempts, does.

    ONLY for a caller-supplied spec. An auto-derived one was written by a model reading the prompt, so
    showing it back would hand the agent its own guess dressed as a contract and quietly convert a weak
    verifier into the task definition — the same trap HERMES_DONE_VERIFY sprang when a hand-picked
    `expect_file` taught the model to write that file and stop.

    Grading in secret is right for a benchmark and wrong for a product. A caller who writes
    `verify.check_cmd` is stating what correct means; withholding it and then reporting failure is a
    worse deal than they asked for."""
    if spec is None or autoderived or not SHOW_CHECK:
        return ""
    if spec.check_cmd:
        body = spec.check_cmd
        if len(body) > limit:
            return ""                      # too big to show honestly; a truncated check is a wrong check
        return ("\n\n---\n\nThis is the acceptance test your work will be graded on. It runs in your "
                f"working directory after you finish:\n\n```\n{body}\n```\n\n"
                "Run it yourself before you finish. When it exits 0 you are done; until then you are not, "
                "whatever else looks complete.")
    parts = []
    if spec.expect_file:
        parts.append(f"a file `{spec.expect_file}` must exist")
    if spec.expect_contains:
        parts.append(f"it must contain the text {spec.expect_contains!r}")
    if spec.expect_lines is not None:
        parts.append(f"it must have exactly {spec.expect_lines} non-empty lines")
    if not parts:
        return ""
    return ("\n\n---\n\nYour work will be graded on this, checked in your working directory after you "
            "finish: " + "; ".join(parts) + ". Verify it yourself before you finish.")


# Where the agent's output has to land, stated to the agent on EVERY task.
#
# The agent is spawned with cwd=work (acp_client.py) and the sandbox binds that directory, so the
# environment is right, but the MODEL has to be told as well. Asked to "create a file called hello.txt"
# with no location named, a model may write `/tmp/hello.txt`, `_verify` looks under the workdir, and the
# task fails its own check at ~20 model calls and ~70k tokens where a located prompt costs 3 and 8k.
#
# Evals do not cover it, because every fixture prompt says "in the working directory" and every
# caller-supplied spec gets _check_appendix, which says it too. The path with neither is a person typing
# an ordinary sentence.
#
# NOT part of the acceptance test, which is why this is separate from _check_appendix and is not gated on
# SHOW_CHECK or on the spec being caller-written: where output goes is a fact about the room, not a hint
# about the answer, so withholding it from an auto-derived turn protects nothing and costs everything.
#
# An instruction is the weaker form of this fix — see the module header on constraints vs. instructions.
# The constraint version (deny writes outside the workdir at the sandbox boundary) is a real change to
# bwrap's mount plan and would have to keep `code_execution`'s legitimate scratch use working, so it is
# its own piece of work rather than a line in this one.
WORKDIR_NOTE = (
    "\n\n---\n\nWrite every file you produce into your current working directory, as a RELATIVE path "
    "(e.g. `<name>.<ext>`), never an absolute one (e.g. `/tmp/<name>.<ext>`). Choose `<name>.<ext>` "
    "yourself, based on what the file actually contains — this note is not naming your output file for "
    "you. That directory is the only place your work is read from, so a file written anywhere else does "
    "not exist as far as this task is concerned."
)


def _workdir_note(work: str | RemoteWork, continued: bool, expired: bool) -> tuple[str, int]:
    """WORKDIR_NOTE alone describes an empty room, which would make a continued session's model
    confidently invent or rewrite a file it believes already exists — it has every reason to trust its
    own prior answer and no way to check (CUR-196). `continued`/`expired` come from the
    (user, session_id) lookup in _run, one call before this.

    Naming the files is not enough on its own: knowing a file exists is not knowing that this turn's
    requested change was applied to it, and a model will report "I have updated X and run Y again" with
    no tool call. The added sentence below states that distinction directly.

    CUR-1394: returns `(note, files_already_here)` rather than just the note. The count is this walk's own
    result, which the caller parks on `task._session_files_at_start` for the `done` frame — see that field
    for who reads it and why. Returned from here instead of re-derived at the call site because the
    `expired`/`continued`/empty branches below decide both answers together, and a second copy of that
    branching is exactly the drift `_done_payload`'s own docstring warns about. Every early return states
    the count explicitly for the same reason."""
    if expired:
        # Wiped: whatever the prior turn left is gone, so this turn starts in an empty room.
        return WORKDIR_NOTE + "\n\nNote: this session's previous workspace expired and was cleared. Starting fresh.", 0
    if not continued:
        return WORKDIR_NOTE, 0
    found = _artifact_paths(work, ARTIFACT_MAX_FILES)   # walks one entry past the cap, same as _collect_artifacts
    if not found:
        return WORKDIR_NOTE, 0  # continued session, nothing written yet — still an empty room, honestly
    dropped = len(found) > ARTIFACT_MAX_FILES
    names = "\n".join(f"- {rel}" for rel, _size in found[:ARTIFACT_MAX_FILES])
    more = f"\n- …and {len(found) - ARTIFACT_MAX_FILES} more" if dropped else ""
    return (
        WORKDIR_NOTE
        + f"\n\nThis is a continued session. Your working directory already contains:\n{names}{more}"
        + "\n\nThat a file already exists does NOT mean this turn's requested changes have already been "
        "applied to it. If this turn asks you to change, run, or check something, you must actually do "
        "so now with a real tool call — do not describe an edit or a run you have not just performed.",
        # SATURATES at ARTIFACT_MAX_FILES + 1: `_artifact_paths` walks one entry past its limit and stops,
        # so this is "how many, up to the cap, plus one meaning more". Its reader only asks whether the
        # room was empty, for which any positive number is the same answer. Don't reach for it as a true
        # file count or sum it with anything — same misuse risk `wroteCodeWithoutRunningIt`'s Map carries.
        min(len(found), ARTIFACT_MAX_FILES + 1),
    )


# Asked what this mode can do that normal chat can't, the agent answers in its own tool names
# (write_file, patch, search_files, terminal()) and never mentions translating, summarizing or reading a
# document, which is most of what a non-technical caller will try. Unconditional, same as WORKDIR_NOTE:
# the question can land on any turn.
#
# The note also says no tool is needed to answer, because with tools at hand the model may otherwise try
# to prove its capabilities by writing and checking a file, and run out its step/spend cap with no
# answer. That is a nudge, not a bound on tool-call rounds.
#
# Because it is appended to every prompt, the model can mistake it for the task and recite it back in
# place of an answer. The last sentence limits it to genuine capability questions. When the question is
# one (a greeting in Quechua asking "how could you help me" is), the model can still copy the note's
# English sentences as its answer, carrying their language with them whatever LANGUAGE_NOTE says. So the
# note itself names the answer language and forbids repeating its own wording, rather than relying on
# where LANGUAGE_NOTE sits in the prompt.
CAPABILITY_NOTE = (
    "\n\n---\n\nIf asked what you can do, or how this mode differs from a normal chat answer, describe "
    "it by the job, not the tool: reading and summarizing a document, translating text, cleaning up or "
    "analyzing a spreadsheet, writing and running a script, editing a file and showing the result. Do "
    "not answer with your own tool or function names (write_file, patch, terminal, search_files) — the "
    "person asking does not call those, you do. Answer this kind of question directly, in prose, in the "
    "same language the person wrote to you in — you do not need to read, write, search, or run anything "
    "to answer it, and you must never answer it by repeating this paragraph's own English sentences as "
    "if they were your answer. This paragraph only applies when the person is literally asking what you "
    "can do or how this mode works — for every other request, ignore this paragraph and do the actual "
    "task they asked for."
)


# Asked "What is 8734 * 6219?", the model can answer from its own arithmetic, wrongly, with no tool call.
# _wrote_code_without_running_it only catches a turn that wrote a file and never ran it; a turn that
# never attempted a file leaves it nothing to catch. This note biases the choice itself, one step
# earlier. Unconditional, like CAPABILITY_NOTE and WORKDIR_NOTE, since a mechanically computable
# question can land on any turn.
#
# The categories are named explicitly (aggregation, sorting, statistics...) because a generic "anything
# a calculator would get right" catch-all doesn't reliably fire. The stakes sentence is a separate kind
# of trigger, "did the person say this matters" rather than "is this mechanically checkable", and gets
# its own clause because "this goes to 400 people" or "are you sure" does not by itself change behaviour.
COMPUTATION_NOTE = (
    "\n\n---\n\nFor any question with an exact, mechanically checkable answer — arithmetic on numbers of "
    "more than one or two digits, a unit conversion, a precise count, a date or duration calculation, an "
    "aggregation over data you were given (a sum, count, average, min/max, or group-by), sorting or "
    "ranking by a numeric or date field, an exact character or substring count, a statistic (mean, "
    "median, standard deviation, a percentile), or anything else a calculator or a short script would get "
    "right every time — run it through the terminal or code-execution tool rather than computing it in "
    "your head. Do this even for arithmetic that feels simple enough to do mentally: it is easy to be "
    "confidently wrong on multiplication and division past a couple of digits, and there is no way for "
    "anyone reading your answer to tell a mentally-computed number from a genuinely checked one unless "
    "you actually ran it. Report the exact result the tool produced, not a number you worked out "
    "yourself. If the person frames the answer as high-stakes or asks you to double-check it (\"this "
    "goes to 400 people\", \"are you sure\"), treat that as a requirement to actually run the check, not "
    "a cue to reassure them in words alone. When you write computed amounts of money to a file or a "
    "table, round them to the currency's usual decimals (two for euros or dollars) in the code before "
    "writing, so a sum never shows as 1299.5300000000002. If you could not produce the file format the "
    "person asked for, say so in your answer and name the format you delivered instead. Python here has "
    "openpyxl for Excel (including openpyxl.chart for a chart inside the workbook), matplotlib for chart "
    "images, python-docx for Word and reportlab for PDF; a chart in a Word or PDF file is a matplotlib "
    "PNG embedded in it. Never ask the person to install software or run commands."
)


# The model must not sign its own answer as verified, checked or confirmed: it is not the thing that
# verifies, and the pipeline's own check may not cover the property claimed (an auto-derived "file exists
# with these columns" spec can't see whether a grouping is balanced). The judge gate (_JUDGE_SYSTEM) is
# the mechanism that catches a content claim the file contradicts and retries; this note is the other
# half. An instruction is the weaker form (module header, constraints vs. instructions), but a
# verification claim in free prose has no deterministic surface to constrain without brittle word
# matching. Unconditional, same shape as COMPUTATION_NOTE: a self-verification claim can land on any turn.
NO_VERIFICATION_CLAIM_NOTE = (
    "\n\n---\n\nDo not tell the user you have verified, checked, confirmed, validated, or made sure of "
    "your own answer, and do not call a result \"verified\" or \"correct\". You are the one that produced "
    "it, so you are not in a position to certify it. Report plainly what you did and what the output "
    "actually contains — \"I wrote teams.csv with six rows grouped into two teams\", not \"Verified: the "
    "teams are balanced\". If the task asked for a property you cannot show from what you ran (that a "
    "grouping is balanced, that a total is right, that a file meets a spec), state the property as what "
    "you aimed for, not as something you have confirmed."
)


# Without this, nothing in the prompt says what language to answer in, and a task sent in French,
# Portuguese, Arabic or Chinese tends to come back in English. Unconditional, same shape as
# WORKDIR_NOTE/CAPABILITY_NOTE: the answer language applies to every turn.
LANGUAGE_NOTE = (
    "\n\n---\n\nAnswer in the same language the person used to write to you, unless they explicitly ask "
    "for a different language. If most of what they wrote is in one language, answer in that language "
    "even if a name, a number, or a technical term in their message was in English."
)


# Restating or simplifying a source, the model paraphrases facts it should copy: a deadline of "28 days
# from the date of the notification" becomes "28 days from today", and a status "under review" becomes
# granted. In every language, so this is paraphrase rather than a translation defect. For a caseworker
# handing the text to someone, the drifted deadline is a wrong date.
#
# Status and category are separate axes: the model can keep "under review" and still change WHAT is under
# review, a "direito" (entitlement) becoming a "pedido" (application). A plain-language instruction
# pushes toward the commoner word, and in German the commoner word ("Antrag") names the wrong category
# where the formal one ("Anspruch") is right; English "claim" is already plain, so English holds. Hence
# the rule that plain language licenses simpler PHRASING, not a simpler CATEGORY. The abstract rule alone
# is not enough; the model needs the exact term pairs named, which is why the worked examples are here.
SOURCE_FIDELITY_NOTE = (
    "\n\n---\n\nWhen your task is to restate, translate, or simplify a piece of source text, treat exact "
    "facts in that source — dates, amounts, reference numbers, deadlines, and the status of a claim or "
    "application — as fixed, not as things to rephrase. Copy them exactly as the source states them. If "
    "a deadline is given relative to an event (e.g. \"28 days from the date of this notice\"), keep it "
    "relative to that same event — do not convert it to a fixed date, and do not restate it as relative "
    "to today or to whenever it's read, since you don't know when that will be. If the source says "
    "something is under review or not yet decided, do not upgrade it to a granted or confirmed status. "
    "Also keep the kind of thing being described unchanged — a right or entitlement that's under review "
    "is not the same as an application that's under review, and a benefit that's being paid is not the "
    "same as one that's being requested. This still holds when you're asked to simplify or use plain "
    "language: that license covers simpler PHRASING, not a simpler CATEGORY. If the most common everyday "
    "word for a concept in your output language happens to name a different category than the source's "
    "term, keep the source's category and phrase it plainly some other way — don't reach for the more "
    "familiar word just because it's easier to say. Use the source's own term for what's happening; "
    "don't substitute a similar-sounding one, even a more familiar one. For example, in German, a source "
    "saying \"Anspruch\" (an entitlement someone already has, being confirmed) must not become \"Antrag\" "
    "(an application someone is submitting for approval) or \"Anfrage\" (a mere inquiry) — both are more "
    "common everyday words than \"Anspruch\", and both name a different, wrong category. The same applies "
    "in Portuguese: a source saying \"direito\" (an entitlement someone already has, being confirmed) must "
    "not become \"solicitação\", \"pedido\", or \"requerimento\" (all name a request someone is submitting "
    "for approval) — keep \"direito\" and simplify the sentence around it instead. If a plain-language "
    "rewrite makes you want to reach for a more common word here, that's the exact case this rule exists "
    "for — keep the source's own term and simplify the sentence around it instead."
)


# LANGUAGE_NOTE has to come late (the answer language locks in on the first token), and
# SOURCE_FIDELITY_NOTE's category fix stops holding once it is no longer the last thing read before
# generation. This recap repeats the worked example, short, in the last slot of the prompt.
#
# Naming one synonym doesn't close the space; the model reaches for another ("solicitação" once "pedido"
# is named). So both notes list every near-synonym seen, not just the first.
CATEGORY_RECAP_NOTE = (
    "\n\n---\n\nOne more thing before you answer: keep the exact category of anything under review "
    "unchanged from the source, even if a more familiar word exists — e.g. in German, keep \"Anspruch\", "
    "never \"Antrag\" or \"Anfrage\"; in Portuguese, keep \"direito\", never \"pedido\", \"solicitação\", "
    "or \"requerimento\"."
)


# There is deliberately no note stating the current date. Hermes renders
# `Conversation started: {%A, %B %d, %Y}{ (zone) }` into its own system prompt unconditionally
# (agent/system_prompt.py at the pinned HERMES_SHA), and adds a "Today's date (as of the last context
# rebuild)" line once a session crosses midnight, on both transports (`hermes acp` and `hermes -z` share
# the prompt builder). That is enough for the model to resolve a relative deadline against today.
#
# A second date here would put two anchors in one prompt, in a file where note ORDER alone decides which
# instruction holds. The cost of relying on Hermes is an inherited dependency: the anchor rides a pinned
# upstream SHA, and upstream has a path that deliberately DROPS the date line
# (`_bot_chat_timeless_prompt`). scripts/date_anchor_probe.py measures it, and
# test_the_wall_clock_anchor_is_inherited_from_hermes_not_owned_here pins the SHA so a bump is a decision
# rather than a drift. If that probe ever comes back red, the fix is a note here, and its `relative` leg
# is what has to stay green while you add one.


def _policy_note(decision: dict) -> str:
    """Tell the MODEL, not just the caller, why a new caller under "staged" has no terminal or
    code_execution tool. _deny_writes_toolsets removes those tools from the toolset entirely, so Hermes
    never offers the model a denial to explain; without this note it can only guess. Empty for every
    tier except "new" — see _permission_decision for what produces a tier."""
    if decision["tier"] != "new":
        return ""
    return (
        f"\n\n---\n\nThis session has no terminal or code-execution tools available. You are a "
        f"new/unaccrued caller ({decision['tasks_done']}/{decision['tasks_required']} tasks of "
        f"history) — full capability unlocks automatically with more use. If asked to run something, "
        f"say so plainly rather than claiming you ran it."
    )


def _sandbox_note() -> str:
    """CUR-1405: tell a caller WITH terminal what that terminal cannot reach, before it finds out.

    _policy_note above covers the tier that has no terminal at all. This covers the opposite case, and
    it is the more expensive one to miss: asked for a PDF, an agent can run `pandoc`, then
    `apt update && apt install -y pandoc`, then `mkdir … && apt … && apt …`, then `which pandoc` — four
    terminal calls, four failures, roughly 19,000 tokens, and three separate approval prompts put in
    front of a person on a timer, for installs this container structurally cannot perform. Its closing
    line is then "I cannot install it due to permission issues and network problems," which is
    exactly what the deploy config already knew at boot.

    NOT an instruction standing in for a missing constraint — the constraints are real and enforced
    (nftables default-deny, /etc/hosts-only resolution, non-root uid). Every clause below is gated on
    the MEASURED state rather than the configured one, for the same reason _probe_egress exists at all:
    on a dev box with `AGENT_EGRESS=off` these sentences would be false, and a prompt that lies about
    the environment is worse than one that says nothing. Empty when nothing has been measured, so it is
    a no-op append wherever the probes did not run.
    """
    clauses: list[str] = []
    if _EGRESS_OBSERVED == "filtered" or _DNS_OBSERVED == "filtered":
        clauses.append(
            "This sandbox has no general network access — outbound connections and name lookups are "
            "blocked. Package managers (apt, pip, npm), downloads and remote APIs will fail"
        )
    if os.geteuid() != 0:
        clauses.append("you are not root, so nothing can be installed system-wide")
    if not clauses:
        return ""
    return (
        "\n\n---\n\n" + ", and ".join(clauses) + ". Work with what is already installed. Do not spend "
        "turns trying to install or download something to find out — if a tool you need is genuinely "
        "missing, say so and produce the best result you can with what is there."
    )


# _acp_run clears text_parts on every repair turn, so the final answer is always the LAST turn's: whatever
# the model writes in reply to _repair_turn_text ships to the user verbatim. Without saying who reads the
# reply, the model addresses it to the check, in text the user never asked about. Appended to every
# branch's return value, since the point is the same whichever correction fired.
_REPAIR_TURN_AUDIENCE_NOTE = (
    "\n\nWhen you reply, answer the user's original question directly. They have not seen this message "
    "or any check output — do not mention a check, a repair, or this correction to them."
)


def _repair_turn_text(detail: str, limit: int = REPAIR_DETAIL_CHARS) -> str:
    """The IN-SESSION repair turn. Sibling of _repair_prompt, and short where that one is not.

    _repair_prompt addresses a fresh agent that has never seen the workdir, so it restates the task and
    explains that files exist. Here the model wrote those files a moment ago and still has the task, its
    own plan, and its own reasoning in context. Restating all of it would be noise. What it does not have
    is the news that it was wrong, so that is the entire message.

    Same trust boundary as _repair_prompt: `detail` is check output, so it goes to the agent that
    produced it and nowhere else. Every return appends _REPAIR_TURN_AUDIENCE_NOTE — see its own comment
    for why."""
    tail = detail.strip()
    # The un-run turn is a different message, not a different detail. Nothing checked its files, so the
    # opening sentence below would be false, and this is the one prompt in the service whose entire job is
    # to stop the model reporting things it never observed — leading it with a fabricated check would be
    # the defect wearing the fix's clothes.
    if tail.startswith(UNRUN_DETAIL_PREFIX):
        name = tail[len(UNRUN_DETAIL_PREFIX):].strip() or "the file you wrote"
        # A failed tool call is NOT "never ran it" — the model ran something and it broke. The
        # sentence below would tell it the opposite of what happened, so this branches BEFORE falling
        # into that template rather than trying to make one sentence cover both shapes. (CUR-574)
        if name.startswith(TOOL_FAILED_PREFIX):
            kind = name[len(TOOL_FAILED_PREFIX):].strip() or "a"
            return (f"A {kind} call you made failed, but your answer reported a result anyway.\n\n"
                    "Look at what actually happened and try again. Read the error, fix what's wrong, "
                    "and retry the call.\n\n"
                    "Do not report a result from a call that failed. If you cannot complete this, say so "
                    "plainly and say why — an honest 'this failed and I could not complete it' is worth "
                    "more than a result you did not actually get." + _REPAIR_TURN_AUDIENCE_NOTE)
        # Distinct from both branches above — nothing was written (so "you wrote X" is false)
        # and no tool call failed (none ran at all). The model claimed a file already exists; telling it
        # to "run it now" would be the wrong instruction for a claim that's false about EXISTENCE. (CUR-777)
        if name.startswith(FALSE_EXISTENCE_PREFIX):
            fname = name[len(FALSE_EXISTENCE_PREFIX):].strip() or "the file you named"
            return (f"You said {fname} already exists, but it is not in the working directory.\n\n"
                    "Check what is actually there. If you still need to create or produce it, do that "
                    "now and confirm the result.\n\n"
                    "Do not tell the user something exists when it does not. If you cannot produce it, "
                    "say so plainly and say why." + _REPAIR_TURN_AUDIENCE_NOTE)
        return ("You reported this task as complete, but you wrote "
                f"{name} and never ran it.\n\n"
                "Run it now and report what it actually printed. If it fails, read the error, fix the "
                "code, and run it again.\n\n"
                "Do not describe output you have not seen. If you cannot run it, say so plainly and say "
                "why — an honest 'I could not run this' is worth more than a prediction presented as a "
                "result." + _REPAIR_TURN_AUDIENCE_NOTE)
    # A different shape from everything above — something DID run, successfully, and the
    # model's own numbers contradict each other (a nonzero before-count next to a zero after-count). (CUR-1404)
    if tail.startswith(ZERO_RESULT_PREFIX):
        counts = tail[len(ZERO_RESULT_PREFIX):].strip() or "your reported counts"
        return (f"Your answer reports {counts} — a step that removed every single row.\n\n"
                "That is almost never the correct result for a cleaning, filtering, or deduplication "
                "task. Look at the logic you ran against the actual data and find out why it dropped "
                "everything, rather than reporting the count as-is.\n\n"
                "If removing every row is genuinely correct here, say so explicitly and explain why. "
                "Otherwise, fix the logic, re-run it, and report the real numbers." + _REPAIR_TURN_AUDIENCE_NOTE)
    if len(tail) > limit:
        tail = "…" + tail[-limit:]
    # "not found" is the one complaint the model cannot act on from the text alone: it wrote the file and
    # was told the file is missing, so the honest reading available to it is that the CHECK is wrong — and
    # a model can reasonably say so out loud ("the file exists at /tmp/hello.txt, but the check might be
    # looking for it elsewhere"). Naming the directory turns an apparent contradiction
    # into an actionable one. The other complaints ("contains", "lines") already say what to change, and
    # a location reminder there would be noise.
    where = ("\n\nThe check only looks in your current working directory. If you wrote to an absolute "
             "path such as /tmp, write it again as a relative path from where you are now."
             if "not found" in tail else "")
    return ("You reported this task as complete. The acceptance check ran against your files and "
            f"disagrees:\n\n    {tail}\n{where}\n"
            "Fix what the check reported, then finish. "
            "Do not start over and do not rewrite what already passes." + _REPAIR_TURN_AUDIENCE_NOTE)


# The answer that REPLACES the model's text when repair is exhausted. _repair_turn_text asks the model to
# fix itself and REPAIR_TURNS bounds how many times. When acp_client._acp_run gives up (turns exhausted
# or wall clock out) with a failing verdict and no "edit" in tool_kinds, the model's prose would otherwise
# ship under a caveat banner, and a warning label above a confident, wrong number does not stop a reader
# believing the number. A model that had every repair chance and never ran a real edit has no draft worth
# caveating, so its text is replaced.
_REPAIR_EXHAUSTED_ANSWER = (
    "I was not able to complete this after several attempts. I don't have a verified result to give you."
)


def _best_of_gates(spec: VerifySpec | None, synthesize: bool,
                   nonce: str | None) -> tuple[int, bool, bool]:
    """Decide (best_of, may_derive, may_judge) for a run. PURE (no task mutation, no I/O) so it unit-tests.

    may_derive/may_judge require best_of>1 AND a gateway nonce (both POST through the gateway with the
    nonce — without one they 401; this is the relocated S4 gate). best_of COLLAPSES to 1 when there is
    no selection signal at all (no spec, nothing derivable, no judge) — else N attempts run with no way
    to pick a winner (N× spend, zero benefit). Caller MUST pass the already-allocated nonce: the gates
    are nonce-dependent, so computing them pre-nonce would silently force may_* False."""
    may_derive = (AUTODERIVE_VERIFY and BEST_OF > 1 and spec is None and synthesize and nonce is not None)
    may_judge = (JUDGE_VERIFY and BEST_OF > 1 and synthesize and nonce is not None)
    best_of = BEST_OF if (spec is not None or may_derive or may_judge) else 1
    return best_of, may_derive, may_judge


def _effective_toolsets() -> str:
    """What the agent ACTUALLY loads, which on the shipped transport is not AGENT_TOOLSETS.

    `hermes acp` accepts no `-t` — the toolset is fixed for the whole session — so with AGENT_ACP on,
    ALLOWED_TOOLSETS reaches nothing but the oneshot escape hatch. Reporting the configured value alone
    would describe a setting the running transport ignores (`coding` configured while every `hermes-acp`
    schema goes on the wire).

    HERMES_ACP_TOOLSETS is the one thing that DOES move it, written into each attempt's config.yaml as
    `platform_toolsets.acp` (acp_client._write_acp_toolsets). Reporting `hermes-acp` while that is set
    would name a toolset the wire does not carry, so it is read here rather than assumed absent. The pinned Hermes is what
    decides whether that key does anything (a pin older than v2026.9.24 ignores it), and this cannot
    tell the difference, so the value is reported as requested rather than as confirmed.

    Same posture as `secrets_boundary: OFF(legacy passthrough)` — say the true thing, including when
    the true thing is that a knob is inert.

    Under ACP_PERMISSION_POLICY=deny_writes (CUR-217), the toolset _model_env actually hands the
    subprocess is filtered by _deny_writes_toolsets — this must report THAT value, or /healthz would name
    a toolset the wire does not carry, the same bug this function exists to avoid one layer up. Oneshot is
    excluded: it reads -t/ALLOWED_TOOLSETS, never HERMES_ACP_TOOLSETS, so deny_writes has nothing to
    filter there (see _model_env)."""
    acp_override = (os.environ.get("HERMES_ACP_TOOLSETS") or "").strip()
    if ACP_PERMISSION_POLICY == "deny_writes" and AGENT_ACP:
        filtered = _deny_writes_toolsets(acp_override)
        note = f"deny_writes: covers {'+'.join(_PERMISSION_COVERS)}; excludes {'+'.join(_PERMISSION_UNCOVERED)}"
        if acp_override:
            return (f"{filtered} (HERMES_ACP_TOOLSETS, via platform_toolsets.acp in the attempt config.yaml; "
                     f"AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied; {note})")
        return f"{filtered} (hermes-acp default overridden by deny_writes; AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied; {note})"
    if ACP_PERMISSION_POLICY == "confirm" and AGENT_ACP:
        # Same filter, same reason as deny_writes above — confirm's callback only ever sees
        # write_file/patch too. (CUR-218)
        filtered = _deny_writes_toolsets(acp_override)
        note = f"confirm: covers {'+'.join(_PERMISSION_COVERS)}; excludes {'+'.join(_PERMISSION_UNCOVERED)}"
        if acp_override:
            return (f"{filtered} (HERMES_ACP_TOOLSETS, via platform_toolsets.acp in the attempt config.yaml; "
                     f"AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied; {note})")
        return f"{filtered} (hermes-acp default overridden by confirm; AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied; {note})"
    if ACP_PERMISSION_POLICY == "staged" and AGENT_ACP:
        # There is no single "effective" toolset under staged — it's resolved per caller
        # (_resolve_permission_policy), and this function has no caller to resolve against. Report the
        # FLOOR (what a brand-new caller gets, same filtered value as plain deny_writes) rather than
        # either the unfiltered toolset or nothing — the floor is the toolset most callers spend the
        # longest under, and it's the one worth an operator seeing at a glance. (CUR-470)
        filtered = _deny_writes_toolsets(acp_override)
        note = (f"staged: floor for a new caller, shown here — trusted callers "
                f"({TRUST_ACCRUAL_SECS // 86400}d/{TRUST_MIN_TASKS} tasks of history) get the unfiltered "
                f"toolset instead; covers {'+'.join(_PERMISSION_COVERS)}; excludes {'+'.join(_PERMISSION_UNCOVERED)}")
        if acp_override:
            return (f"{filtered} (HERMES_ACP_TOOLSETS, via platform_toolsets.acp in the attempt config.yaml; "
                     f"AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied; {note})")
        return f"{filtered} (hermes-acp default overridden by staged; AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied; {note})"
    if AGENT_ACP and acp_override:
        return f"{acp_override} (HERMES_ACP_TOOLSETS, via platform_toolsets.acp in the attempt config.yaml; AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied)"
    if not AGENT_ACP:
        return ALLOWED_TOOLSETS
    return f"hermes-acp(fixed by `hermes acp`; AGENT_TOOLSETS={ALLOWED_TOOLSETS!r} NOT applied)"


def _permission_state(policy: str = "", toolsets: str = "") -> tuple[str, str]:
    """(reported value, incoherence reason or "") for the ACP permission gate. PURE, so it unit-tests.

    The reason this returns two things instead of echoing the config: `deny_writes` sounds like write
    containment and is not one. It is consulted for write_file and patch only, so with `terminal` in the
    toolset a single shell redirect writes whatever it likes and the gate is never asked. An operator who
    sets deny_writes to contain an agent would otherwise get a machine that reports a control it does
    not have.

    Not fatal, and deliberately so: the combination is still an improvement over `allow` for the two tools
    it does cover, and refusing to boot over it would be a worse trade than saying so. bwrap is what
    actually bounds writes, and it does not care which tool asked.

    CUR-217: `toolsets` may now (post-fix) carry a parenthetical explaining what deny_writes excludes —
    e.g. "...excludes terminal+code_execution" — which legitimately CONTAINS the tool names it is
    reporting as absent. Checking `t in toolsets` against the raw string would misread that explanation as
    the tool still being present. Check membership against the toolset-LIST portion only, before the first
    " (" — the same delimiter convention _effective_toolsets already uses for every annotation.

    The "staged" branch below also names the always-confirm composition (CUR-760), for the same reason
    as the toolset parenthetical: "trusted: allow" on its own would be a half-truth. A trusted caller's
    toolset floor is unrestricted, but an edit/delete call still pauses for a human. This applies to the
    TRUSTED tier only: the new tier refuses those kinds outright under deny_writes, so it never reaches
    a confirm pause, and the annotation says "trusted tier" rather than a vaguer "both". Leaving it out
    would make the reported state claim less gating than actually runs.

    CUR-975: _ALWAYS_CONFIRM_KINDS is now a triple (edit, delete, execute), not a pair — both strings
    below read it via `'+'.join(...)`, so the reported state picks up "execute" automatically with no
    string-literal change here. Named explicitly so a future reader doesn't have to cross-reference the
    constant to know a trusted caller's terminal calls pause too, not just file edits."""
    policy = policy or ACP_PERMISSION_POLICY
    toolsets = toolsets if toolsets else _effective_toolsets()
    if policy == "staged":
        # Report both boundary states explicitly rather than the bare mode name — "staged"
        # alone tells an operator nothing about what a caller actually gets at either end. (CUR-470)
        return (f"staged(new: deny_writes, trusted: allow after "
                f"{TRUST_ACCRUAL_SECS // 86400}d/{TRUST_MIN_TASKS} tasks; "
                f"{'+'.join(_ALWAYS_CONFIRM_KINDS)} still pauses for confirm on the trusted tier — "
                f"CUR-760)", "")
    if policy == "allow":
        # Same composition as the staged/trusted branch above, for bare ACP_PERMISSION_POLICY=
        # allow — request_permission applies the always-confirm list to any resolved "allow", not only
        # one reached via staged's trust tiering. (CUR-760)
        return f"allow({'+'.join(_ALWAYS_CONFIRM_KINDS)} always pauses for confirm — CUR-760)", ""
    if policy not in ("deny_writes", "confirm"):
        return policy, ""
    toolset_list = toolsets.split(" (", 1)[0]
    leaky = [t for t in _PERMISSION_UNCOVERED if t in toolset_list]
    if not leaky:
        return f"{policy}(covers {'+'.join(_PERMISSION_COVERS)})", ""
    return (f"{policy}(covers {'+'.join(_PERMISSION_COVERS)}; NOT {'+'.join(leaky)})",
            f"ACP_PERMISSION_POLICY={policy} with {'+'.join(leaky)} in the toolset — the gate is never "
            f"consulted for those, so a shell redirect writes freely. This is edit approval, not write "
            f"containment; bwrap is what bounds writes.")


def _permission_selftest() -> None:
    """Say the incoherence out loud at boot, once, where the log sink will keep it."""
    reported, reason = _permission_state()
    if reason:
        _log_event("permission.MISLEADING", policy=ACP_PERMISSION_POLICY, reported=reported, reason=reason)
    else:
        _log_event("permission.checked", policy=ACP_PERMISSION_POLICY, reported=reported)


def _use_acp(transport: str | None) -> bool:
    """Transport pick: ACP client vs the oneshot Popen path. PURE (no task mutation, no I/O) so it
    unit-tests; the caller ANDs the result with AGENT_ACP (the whole-deploy kill switch — ACP is
    unavailable at all if that's off, regardless of this decision).

    Single-path default: ACP runs for every task once AGENT_ACP is on. `transport="oneshot"` is the
    one explicit escape hatch, for a caller that genuinely wants the old blocking one-call behavior (a
    health-check-style ping with truly no tool use, a deterministic CI-style probe) — not a per-request
    heuristic to maintain."""
    return transport != "oneshot"


def _remaining_timeout(start_mono: float, now_mono: float, cap_secs: int,
                       best_of: int = 1) -> tuple[float, bool]:
    """Wall-clock budget for the next attempt. Returns (timeout_secs, stop); stop=True when the task
    ceiling is reached and there is no time for another attempt. PURE.

    `cap_secs` bounds ONE attempt and `cap_secs * best_of` bounds the task, which is the same
    denomination the spend cap already uses (`_gateway_grant` is called per attempt with
    `task._max_tokens`). A per-TASK clock beside per-ATTEMPT tokens would let attempt 1 eat the entire
    deadline and leave nothing for the retries best-of exists to enable, paying for three attempts and
    running one.

    Sequential and per-attempt, rather than concurrent under one task budget, is a deliberate choice: on
    the standard fixture set most tasks verify on attempt 1, so early exit means the mean task costs a
    little over one attempt. Concurrent attempts would pay for all N on every task to shorten the tail
    for the minority that fail. `scripts/conccheck.py` measures whether the upstream would even serve
    them concurrently — a precondition, not the reason.

    The cost is worst-case latency: a task that exhausts every attempt now takes up to `cap_secs *
    best_of` where it used to take `cap_secs`. That is what running the attempts actually costs, and it
    only lands on tasks that fail all of them."""
    remaining = (start_mono + cap_secs * max(1, best_of)) - now_mono
    if remaining <= 0:
        return 0.0, True
    return min(remaining, float(cap_secs)), False


def _upstream_backoff_secs(reason: str | None, attempt: int, base: float) -> float:
    """Backoff before retrying an attempt that failed on the upstream 'api call failed after' marker (see
    UPSTREAM_RETRY_BASE_SECS). Exponential in the attempt number; PURE (attempt/base injected, no
    randomness) so it unit-tests like the other pure helpers. No jitter: these are one task's own
    sequential attempts, not a herd of independent clients racing each other, so there's nothing to
    de-synchronize. Any other reason (agent bug, empty output, our own cap) returns 0 — no reason to
    believe waiting helps, so retry immediately as before."""
    if not reason or "api call failed after" not in reason:
        return 0.0
    return base * (2 ** (attempt - 1))


def _spec_fields(spec: VerifySpec | None) -> dict:
    """The assertion a spec actually makes, as the set fields only — `{}` when there is no spec.

    Shipped so a consumer can say what was checked instead of only that something was. Defaults are
    dropped rather than sent, so `expect_sep` appears only when it mattered; a caller reading this should
    treat an absent key as "not part of the contract", not as "checked and passed"."""
    if spec is None:
        return {}
    out = {k: v for k, v in spec.model_dump().items() if v is not None}
    # (primary, dependent): the dependent field only means anything alongside its primary. A loop over
    # pairs rather than one hand-copied `if out.get(primary) is None: out.pop(dependent, None)` block per
    # pair — VerifySpec has grown one dependent-field pair before (expect_count/expect_sep) and this is
    # the second (expect_sorted_by/expect_sorted_desc); a third copy-pasted by hand is how the first one
    # silently desyncs from the second.
    for primary, dependent in (("expect_count", "expect_sep"), ("expect_sorted_by", "expect_sorted_desc")):
        if out.get(primary) is None:
            out.pop(dependent, None)
    return out


def _done_payload(task: Task) -> dict:
    """The terminal frame's body, built in ONE place because there are two emitters — the live buffer and
    the replay path for a client that reconnects after the buffer is gone — and they had already drifted:
    the replay frame omitted `verify_method` entirely, so the same task described itself differently
    depending on when you asked."""
    return {"state": task.state.value, "result": task.result, "summary": task.summary,
            # StatusResponse carries `error`, and so does this dict, so the live SSE `done` frame (the ONLY shape
            # production chat reads, endpointAgent.ts) can tell a moderation block or screen failure on the
            # agent's OWN artifacts (task.result stays None on that path, so `result` alone reads as an
            # unexplained failure) from any other FAILED reason (CUR-856).
            "error": task.error,
            # "restart" when a restart ended the task (the drain's deadline, or recover_orphans on
            # boot), so chat can say the service restarted and offer a retry rather than quote the error. (CUR-4598)
            "interrupted": "restart" if (task.error or "").startswith(RESTART_ERROR) else None,
            # The executor this task ran on (its own, not the deployment's default), and the ids the
            # upstream named serving it. A served id that is not the asked model is the record that something
            # else answered under its name. (CUR-4603)
            "model": task.model or AGENT_MODEL or None,
            "served_models": list(task.served_models),
            "verified": task.verified, "verify_method": task.verify_method,
            # An execution check off an auto-derived spec is weaker than one off a spec the caller wrote:
            # the CHECKING is deterministic, but the choosing of what to check was a model reading the
            # prompt. Without this bit a consumer cannot tell those apart and will overclaim.
            "verify_autoderived": task._verify_autoderived,
            "verify_check": task.verify_check, "judge_reason": task.judge_reason,
            "attempt_rejections": list(task.attempt_rejections),
            "artifacts": list(task.artifacts), "artifacts_dropped": task.artifacts_dropped,
            "expired": task.session_expired, "unrun_detail": task.unrun_detail,
            # Whether THIS turn reused a prior turn's session workdir (see _run's (task.user,
            # session_id) lookup). The chat client's honesty caveat needs this to scope its "claimed
            # action, zero tools observed" check to continued sessions only — a fresh session's plain
            # question legitimately needs no tool and must not trip it. (CUR-705)
            "session_continued": task._session_continued,
            # How many files this session's workdir already held when the turn STARTED (see
            # Task._session_files_at_start; CUR-1394). `session_continued` alone says a workdir was reused,
            # never whether anything was in it — and the chat path sends session_id=conversationId, so
            # every turn after the first in an ordinary conversation is a continued session with an empty
            # room. Absent on an older build, which endpointAgent.ts reads as
            # "we do not know" and therefore stays quiet, matching this repo's unknown-kind rule.
            "session_files_at_start": task._session_files_at_start,
            # "declined" / "answered" when the accepted answer made no tool call and the no-tool review
            # judged it claimed nothing; absent meaning (empty) keeps the site's caveat logic as it was. (CUR-4599)
            "no_tool_answer": task._no_tool_answer,
            # Same fields StatusResponse now carries (see _status_of) — kept in sync here so a
            # client watching the live SSE `done` frame and one that reconnects/polls afterward learn the
            # same thing about why this turn's toolset was what it was, not two different stories. (CUR-761)
            "tier": task.tier, "tasks_done": task.tasks_done, "tasks_required": task.tasks_required,
            # `transport_used` (CUR-773): `_run` sets it right after deciding `use_acp`; it is on StatusResponse
            # (`_status_of`) and must be in THIS payload too — the one the live SSE `done` frame sends. A
            # consumer gating caveat logic on it (endpointAgent.ts) would otherwise have to guess from
            # `state:working`'s timing, which fires before transport is even chosen.
            "transport_used": task.transport_used,
            # Same field/meaning as StatusResponse.machine_id — a reconnecting client needs it
            # to pin its own follow-up request, same rationale as tier/transport_used above. (CUR-895)
            "machine_id": FLY_MACHINE_ID}


def _is_artifact_backed(spec: VerifySpec) -> bool:
    """expect_file or check_cmd set — a real sandbox artifact the model produced, as opposed to
    expect_count (checks the answer's text SHAPE, not its content) or nothing at all. CUR-744: the one
    predicate `_select_attempt` uses twice to decide whether a spec is real grounding, not just present.
    Pre-existing call sites (the spend-cap salvage path, `_validate_verify`) keep their own inline check —
    same condition, different history, not touched here to keep this diff scoped to what it changed."""
    return bool(spec.expect_file or spec.check_cmd)


def _select_attempt(prompt: str, work: str | RemoteWork, result_text: str, spec: VerifySpec | None,
                    may_judge: bool, judge_call,
                    spec_autoderived: bool = False) -> tuple[bool, str | None, str]:
    """Best-of-N selection signal for ONE attempt. Returns (accepted, verify_method, judge_reason); does NOT
    mutate task (the caller assigns task.verified/verify_method). PURE given injected judge_call (unit-tests
    like the other helpers). Authority rules:
      - spec is None            → accept UNVERIFIED (verify_method=None): the legacy no-spec path, so a
                                   best_of==1 run is byte-equivalent to today (zero-delta).
      - file/shell spec         → _verify the sandbox artifact (existence + expect_contains/lines).
      - inline-count spec       → _verify_answer_count over the result text (code counts).
      - may_judge (chat turn)   → the artifact (if any) is NECESSARY but NOT SUFFICIENT; the judge is the
                                   correctness authority over the answer the user reads. Rejected → retry.
      - may_judge requires the EFFECTIVE spec, after the overrule below resolves, to be ARTIFACT-BACKED
        (expect_file or check_cmd set), not just present. Two situations hand the judge zero real
        grounding, and both are "accept unverified", not "let the judge vote either way":
          (1) no spec ever existed (nothing derivable for an open-ended riddle), or
          (2) a spec existed but failed and got overruled (see WHO GETS TO VETO below), which passes
              `spec=None` to the judge, so "no grounding" again.
        A judge with no content grounding false-accepts wrong answers to puzzles and letter counts. An
        expect_count-only spec that PASSES is not enough grounding for a JUDGE VOTE either —
        `_verify_answer_count` checks the answer's SHAPE ("is this terse"), not its content.

        That does NOT mean a genuinely passing expect_count check earns no credit at all: routing
        it all the way to unverified would make `_failure_reason` (hard_spec = caller-
        written, not autoderived) read `verified=False` as a real failure and mark the whole task FAILED,
        even though the caller's own contract was satisfied. "Not grounded" only withholds the JUDGE's
        vote; a real, passed, non-overruled check still earns "execution" on its own — the exact same
        credit the non-judge path below already gives it. Raising AGENT_BEST_OF must not silently re-arm
        an ungrounded JUDGE vote, but it also must not turn a passing caller contract into a false FAILED.
      - spec is None, no judge → accept UNVERIFIED (verify_method=None): the legacy no-spec path, so a
        best_of==1 run is byte-equivalent to today (zero-delta, C8).
      - grounded but result_text is empty (CUR-774) → accept "execution", judge skipped, not called at
        all. Reaching this branch already means exec_ok is True on an artifact-backed spec; an empty
        `result_text` (the ACP transport clears its accumulated text on every new tool_call — CUR-542 —
        and a turn that ends on a tool_result with no trailing wrap-up never refills it) is "nothing to
        grade," not "graded and failed." `_judge_result`'s own empty-string fail-closed stays correct
        for a caller with no deterministic backing; here the deterministic check already IS the
        evidence, so the missing prose gets the same "not grounded" credit two branches up, not a
        rejection.

    WHO GETS TO VETO (CUR-193). A caller-written spec is a CONTRACT: the caller said what correct means,
    and a failure is a rejection the judge does not get to overturn. An auto-derived spec is a model's
    GUESS about what to check, and letting a guess veto the correctness authority inverts the hierarchy.

    A derived spec can fail on the wrong grounds. `_derive_verify_spec` can derive `expect_count`, which
    counts separator-delimited items in the answer and therefore measures VERBOSITY, not correctness:
    "What is 17 * 23? Answer with just the number." derives `{expect_count: 1, sep: ","}` — really
    "contains no commas". A terse run passes and the judge confirms it; a chatty run, same correct
    arithmetic in prose, fails every attempt and never reaches the judge. Each such turn burns all three
    attempts, because retrying does not make a model terser.

    So a failed DERIVED spec does not reject; it steps aside — and (CUR-744) the judge gets no unchecked
    vote on it either, since a failed-and-overruled spec is exactly as ungrounded as no spec at all. Both
    resolve to accept-UNVERIFIED: the wordy-but-correct answer CUR-193 protects is not punished, and the
    judge is not asked to grade prose it has zero way to check."""
    exec_ok, exec_detail = True, ""
    if spec is not None:
        if _is_artifact_backed(spec):                      # file/shell contract → sandbox check
            exec_ok, exec_detail = _verify(work, spec)
        if exec_ok and spec.expect_count is not None:      # inline-count contract → answer-text check
            exec_ok, exec_detail = _verify_answer_count(result_text, spec)
    if may_judge:                                          # chat turn: judge decides (artifact must also be present)
        overruled = not exec_ok and spec_autoderived
        if not exec_ok and not overruled:                  # a CALLER's contract failed → the judge does not get a vote
            return False, None, (exec_detail or "expected artifact missing or incorrect")
        if overruled:
            _metric_inc("agent_derived_spec_overruled_total")
        # The spec goes to the judge only when it PASSED — everything it asserts is then settled, and a
        # judge that does not know that grades it a second time from prose. A spec that FAILED is passed
        # as None: it settled nothing, and scoping the judge to it would narrow the rubric around a
        # claim we just stopped believing.
        effective_spec = None if overruled else spec
        # An effective_spec that is None (never any spec, OR the only one failed and was overruled) or
        # expect_count-only (checks the answer's SHAPE, which measures verbosity) is NOT real grounding,
        # and a judge vote there in either direction is how wrong answers get accepted. Accept unverified
        # instead: a wordy-but-correct answer isn't punished, and an ungrounded one isn't vouched for.
        grounded = effective_spec is not None and _is_artifact_backed(effective_spec)
        if not grounded:
            # "Not grounded" only means the JUDGE doesn't get an unchecked vote — it does NOT mean a
            # deterministic check that genuinely ran and passed gets no credit. Without
            # this, a caller-written expect_count-only spec that PASSES (exec_ok=True,
            # not overruled) falls all the way to "accept unverified" — and _failure_reason (hard_spec=
            # caller-written and not autoderived) then reads verified=False as a genuine failure and
            # marks the whole task FAILED with a misleading "best-of-N exhausted", even though the
            # caller's own contract was satisfied and no judge was ever needed. `spec is not None` (not
            # `effective_spec`) rules out the "nothing was ever checked" default exec_ok=True; `exec_ok`
            # here can only be True if we're past the overrule gate above with a real check that passed.
            if spec is not None and exec_ok:
                return True, "execution", ""
            return True, None, ""
        # effective_spec is never None here: overruled forces grounded=False above, which already
        # returned. `spec` would do just as well as the argument below — kept as effective_spec so a
        # future change to the grounding gate doesn't have to rediscover this by hand.
        if not (result_text or "").strip():
            # `result_text` is the turn's accumulated prose (`client.text` under the ACP
            # transport). acp_client.py clears it on every new tool_call (CUR-542, so a chatty
            # multi-step turn doesn't wall-of-text every pre-call aside) and only refills it if the
            # model narrates AFTER its last tool call — so a turn that ends on a tool_result with no
            # trailing wrap-up leaves this genuinely "" even when the work behind it is real. We only
            # reach this line already knowing exec_ok is True on an artifact-backed spec: every path
            # that could land here with exec_ok False returned above. _judge_result fails closed on an
            # empty string unconditionally, which is right for a caller with nothing else behind it and
            # wrong here — no prose to grade is not a verdict AGAINST the artifact, and the "not
            # grounded" branch two lines up already credits a real, passed, non-overruled check the
            # same way without a judge vote. (CUR-774)
            _metric_inc("agent_judge_skipped_empty_result_total")
            return True, "execution", "judge skipped: result_text empty, artifact check already passed"
        jpass, reason = _judge_result(prompt, result_text, judge_call, effective_spec, work=work)
        if jpass:
            return True, "execution+judge", reason
        return False, None, reason
    if spec is not None:                                   # explicit/derived spec: execution is authority
        if exec_ok:
            return True, "execution", ""
        return False, None, exec_detail
    return True, None, ""                                  # spec None + no judge → accept unverified (legacy)


_SCRATCH_PREFIX = "agent-run-"


def _sweep_stale_scratch(now: float | None = None) -> tuple[int, int]:
    """Delete `agent-run-*` directories nothing can still be using. Returns (dirs, bytes) reclaimed.

    The per-task `finally` already rmtree's the scratch, and it is not the problem: a SIGKILL does not run
    `finally`, by definition, and OOM is a SIGKILL. So the abandoned directories are exactly the residue of
    the runs that died hardest, and on a box where scratch sits in tmpfs each one holds RAM that the kernel
    can only push to swap.
    Which makes it a loop rather than a leak: the kill leaves scratch, the scratch costs memory, the memory
    shortage causes the next kill. Boot is the right place to cut it, because boot is the one moment we know
    no task of ours is running.

    Age-gated well past any legal run (SCRATCH_STALE_SECS 7200 vs a 300s wall clock) so this cannot race a
    live task even if two services share a scratch root; `ignore_errors` because another user's identically
    named directory is not ours to fail over — and mtime, not ctime, so a long-running task that is still
    writing is never eligible.
    """
    root = Path(SCRATCH_ROOT) if SCRATCH_ROOT else Path(tempfile.gettempdir())
    now = time.time() if now is None else now
    dirs = freed = 0
    # Session workdirs share this prefix/root but are NOT abandoned — their idle clock is hours
    # (SESSION_IDLE_SECS), not SCRATCH_STALE_SECS's 2h, and the idle reaper (_session_reaper_loop) is their
    # sole owner. Without this exemption, a routine redeploy could silently reap a session before its own
    # timer would — the exact "expiry must fail loud" requirement this ticket exists to satisfy, undone by
    # a mechanism that predates it. (CUR-196)
    session_paths = store.session_workdir_paths()
    try:
        candidates = sorted(root.glob(_SCRATCH_PREFIX + "*"))
    except OSError:
        return 0, 0
    for p in candidates:
        if str(p) in session_paths:
            continue
        try:
            if not p.is_dir() or now - p.stat().st_mtime < SCRATCH_STALE_SECS:
                continue
            size = _dir_disk_bytes(str(p), SCRATCH_MAX_BYTES * 64)
        except OSError:
            continue
        shutil.rmtree(p, ignore_errors=True)
        if not p.exists():
            dirs += 1
            freed += size
    return dirs, freed


# Hermes gates two system-prompt blocks behind hardcoded model-name allowlists that both default to
# "auto": TOOL_USE_ENFORCEMENT_MODELS (gpt/codex/gemini/gemma/grok/glm/qwen/deepseek, "call tools,
# don't narrate") and EXECUTION_GUIDANCE_MODELS (gpt/codex/grok/deepseek/kimi/qwen/glm/minimax/mimo/
# mistral, "finish the job, verify before claiming done"). A model outside both lists, such as
# Apertus, gets neither nudge unless config.yaml turns them on, and this image ships no
# ~/.hermes/config.yaml (deploy/Dockerfile writes none). So the keys below force both on (CUR-1155).
_HERMES_FORCE_TOOL_ENFORCEMENT_YAML = "agent:\n  tool_use_enforcement: true\n  execution_guidance: true\n"


def _write_hermes_home_config(home_dir: str, global_cfg: Path) -> None:
    """Give the `hermes acp` subprocess a config.yaml that forces both enforcement gates on.

    Only writes our own default when there is no real global config to respect — an operator
    who later adds ~/.hermes/config.yaml has presumably already made their own choice about
    every key in it, these two included."""
    # The session workdir outlives a turn, so `hermes-home` and its config.yaml are names the agent could
    # have replaced with symlinks on an earlier turn. This runs outside bwrap as the uid that owns /data
    # and /srv, so it must never resolve one (CUR-3535, the same class `_write_no_follow` closed for raw.log).
    _ensure_real_dir(home_dir)
    cfg = os.path.join(home_dir, "config.yaml")
    _remove_if_not_regular(cfg)
    text = global_cfg.read_text() if global_cfg.exists() else _HERMES_FORCE_TOOL_ENFORCEMENT_YAML
    _write_no_follow(cfg, text)
    soul = os.path.join(home_dir, "SOUL.md")
    _remove_if_not_regular(soul)
    _write_no_follow(soul, AGENT_IDENTITY)


# Hermes' own system prompt is DEFAULT_AGENT_IDENTITY (agent/prompt_builder.py at the pinned commit), which
# asks finished work for "a short report of what changed, what's verified, and what's left". That gives
# every answer the "Files written / Verified / Left" shape, in Portuguese and Spanish too, and a
# system-prompt instruction outranks NO_VERIFICATION_CLAIM_NOTE in the task prompt (CUR-4055). A SOUL.md in
# HERMES_HOME takes that identity slot (agent/system_prompt.py: SOUL.md if present, else the default),
# so this replaces the instruction where it is given. It also drops "You are Hermes Agent, built by Nous
# Research": who the model is comes from the task prompt's identity line (CUR-573).
#
# The figures sentence: the ACP toolset (`HERMES_ACP_TOOLSETS`) has no web tool and the
# sandbox blocks egress, so real-world figures (rents, travel times) the model puts in a file are
# invented unless the person supplied them, and without this the answer presents them as facts. It lives
# here rather than in the task-prompt tail for the same system-prompt-precedence reason as above, and so
# the tail's note order is left alone.
AGENT_IDENTITY = (
    "You do tasks for a person inside AI Potluck, a chat app. Be direct: match the length of your reply to "
    "the weight of the ask. A one-line question gets a one-line answer. Finished work gets a short report "
    "of what you made or changed, what you ran and what its output showed, and what is still left, never a "
    "replay of the process. Do not describe your own work as verified, checked, confirmed or correct, and "
    "do not give the report a heading that says so: you produced it, so you report what it contains and "
    "let the person judge it. No filler, no restating the request back, no narrating tool calls the person "
    "can see. Plain claims over adjectives; when unsure, say so plainly. Any real-world figure you put in "
    "a file or an answer (a price, a rent, a travel time, a spec, a statistic) must come from what the "
    "person gave you or from something you actually read during this task. When you have no such source "
    "for a figure, you may still fill it in as an estimate, but say so in the file itself, where anyone "
    "who opens the file sees it (a note row, a column, a caption), and say in your answer that those "
    "figures are illustrative estimates to check, not facts. Write in the language the person wrote in.\n"
)


def _remove_if_not_regular(path: str) -> None:
    """Unlink `path` when it is a symlink, FIFO or anything else but a regular file or a directory."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
        os.unlink(path)


def _ensure_real_dir(path: str) -> None:
    """Make `path` a real directory: a symlink or any other non-directory planted there is removed first."""
    _remove_if_not_regular(path)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        os.mkdir(path, 0o700)
        return
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(path)
        os.mkdir(path, 0o700)


# pyright: ignore is on the def line below for reportGeneralTypeIssues "Code is too complex to analyze".
# That is a real signal, not a false positive — this function is long enough that pyright gives up on
# its control flow entirely, which means NOTHING below is type-checked. Suppressed rather than fixed
# because splitting _run is its own change with its own risk; tracked as the reason to do it.
def _log_tier1_corpus(task: Task, work: str | RemoteWork, stdout: str, nonce: str | None) -> None:
    """CUR-596 item 2 (Tier 1 corpus): did the deterministic SHAPE check catch something on this attempt.

    Deliberately independent of whether the judge went on to overrule an auto-derived spec's failure
    (_select_attempt's own CUR-193 authority rules — unchanged, not re-litigated here). Re-running
    _verify is redundant with the one _select_attempt already did, but threading an extra return value
    out of that carefully-scoped function was the riskier change for a diagnostic-only need.

    Never raises: this is a corpus sink, and a turn must not fail because a training row didn't land.
    """
    spec = task._verify_spec
    if spec is None or (spec.expect_sorted_by is None and spec.expect_columns is None):
        return
    ok, detail = _verify(work, spec)
    if ok:
        return
    # Only log when the failure is actually attributable to ONE of these two checks — _verify can fail
    # for an earlier, more basic reason first (the file was never created at all; a combined spec's
    # expect_contains/expect_lines missed). Defaulting an unrecognized reason to "expect_sorted_by" would
    # label the most common real failure as a sort violation in the corpus.
    if detail.startswith("expect_columns:"):
        kind = "expect_columns"
    elif detail.startswith("expect_sorted_by:"):
        kind = "expect_sorted_by"
    else:
        return
    try:
        # Every field is scrubbed BEFORE it's truncated/capped, since a nonce straddling the cut would
        # leave an unredacted fragment. This is sandbox-derived text landing in a DURABLE, exportable
        # table; the ephemeral sinks nearby (raw.log, attempt_rejections) already treat it as scrub-worthy.
        store.log_corpus(
            task.id, "tier1", kind, task.prompt,
            _corpus_snapshot_text(work, nonce),
            _truncate_utf8(_scrub((stdout or "").strip(), nonce), CORPUS_SNAPSHOT_MAX_BYTES),
            _scrub(detail[:2000], nonce))
    except Exception as e:  # noqa: BLE001 — must not break a turn, but must not vanish either
        # Swallowing EVERY exception silently would let a future signature change to store.log_corpus,
        # or an unexpected input shape from _corpus_snapshot_text/_scrub, leave verify_corpus (CUR-654)
        # permanently empty with zero trace anywhere, unlike every other failure path nearby (_pruner_loop's own prune/prune_corpus calls
        # both log on failure).
        _log_event("corpus.log_failed", id=task.id, tier="tier1", error=type(e).__name__)


def _finalize_run(
    task: Task, *, work: str | RemoteWork, stdout: str, stderr: str, fail: str | None,
    attempts: int, best_of: int, turn_start_wall: float, last_judge_reason: str,
) -> None:
    """The best-of-N loop is over. Decide what this turn actually serves, and write the terminal state.

    `fail` is decided by the CALLER and passed in, which is not an arbitrary split: moderation below can
    raise, and _run's handlers report the structural reason alongside the moderation block. A `fail`
    computed in here would be lost on exactly the path that needs it — the turn would report
    "moderation not configured" and drop "hermes exit 1".

    Everything it decides it writes onto `task` directly — result, artifacts, summary, state — because
    those are what the durable record and the live SSE `done` frame both read.

    Ordering here is load-bearing in three places: artifacts are collected BEFORE moderation so the post-check covers them; `task.result` is populated
    ahead of the `fail` branch so a structural failure still ships content it genuinely produced; and
    `task.state` is set LAST, after the summary, so a concurrent status() reader never sees COMPLETED
    over a not-yet-populated result.
    """
    raw = (stdout or "") + (stderr or "") + (f"\n[best-of-{best_of}: {attempts} attempt(s)]" if best_of > 1 else "")
    _write_no_follow(os.path.join(work.local if isinstance(work, RemoteWork) else work, "raw.log"), raw)   # raw forensic log, short-TTL (dies with scratch)
    full_output = (stdout or "").strip()
    # CUR-855/846 (F5): a SECOND cancel check, not a duplicate of the one above. Artifact collection
    # and two moderate() calls now sit between here and the terminal write below — real I/O and
    # network round-trips, potentially tens of seconds under retry/backoff — where the pre-existing
    # check above and the terminal write would otherwise be back-to-back statements on the failure path. A
    # DELETE landing in that window must still win: report CANCELED, not a FAILED turn with content
    # attached that the caller told us to stop shipping.
    if task._canceled:
        task.summary = task.summary or "canceled"
        return
    # The agent's files, captured while the scratch still exists (the `finally` below deletes it). Read
    # BEFORE moderation so the post-check covers them: everything about to reach a caller goes through
    # one gate, or "put it in a file instead of the answer" becomes the way around it.
    # CUR-596 item 2: `work` itself was already physically restored to the winning attempt's files
    # above (if a consistency-check restoration was needed) — reading it live here, same as always,
    # keeps this in sync with the artifact-download route and moderation below, which also read `work`
    # live. An in-memory override would desync from both the moment `work` on disk no longer matched it.
    artifacts, artifacts_dropped = _collect_artifacts(work, since=turn_start_wall)
    result, truncated = _truncate(_hide_workdir(full_output, work), RESULT_MAX_CHARS)
    # Independent verification: the agent's exit-0 + narrative is NOT proof (false-success finding).
    # The best-of loop above already decided success via _select_attempt (the deterministic LLM-free
    # _verify of the artifact, and/or the judge for chat turns, sets task.verified). The agent's
    # self-report never decides — nothing re-verifies here.
    # Moderate the FULL agent output (not the truncated tail) so nothing slips past the post-check.
    # CUR-855/846: runs regardless of `fail` — a structural failure can still carry a real answer in
    # full_output, and it must be moderated before it's ever eligible to reach task.result below.
    moderate(full_output, "output", task.user, task_id=task.id)         # raises -> handled below

    # Own call, own stage: every artifact's FULL text (CUR-546 — `_artifact_text_for_moderation`,
    # not `artifacts[].text`, which is capped for the inline preview).
    try:
        moderate(_artifact_text_for_moderation(work), STAGE_ARTIFACTS, task.user, task_id=task.id)
    except HTTPException as e:
        # Only on an actual BLOCK (403 — moderate()'s own third raise, "blocked by
        # moderation"), never on the other two HTTPExceptions that function can raise (503
        # unconfigured, 502 screen unavailable after retries): those mean moderation couldn't render a verdict
        # at all, not that this content failed one, and quarantining on "we couldn't check" would
        # wrongly remove a file nobody ever judged bad — the unavailable-vs-uncertain
        # distinction `moderate`'s own docstring draws, applied one level up (CUR-836).
        if e.status_code == 403:
            quarantined = _quarantine_blocked_artifacts(work)
            if quarantined:
                _log_event("artifact.quarantined", id=task.id, count=len(quarantined), files=quarantined)
        raise
    # task.verified stays False when no spec was supplied — i.e. an unverified self-report.
    # CUR-855/846: populated ahead of the `fail` check below, not only on the success path — a
    # structural failure must not `return` here before either the client's badge (task.result) or its
    # honesty caveat (task.unrun_detail, set in the `if fail:` branch below) gets the real answer
    # full_output already holds, or a turn that clearly produced something ships nothing. `state`
    # stays the authoritative correctness signal — this only stops FAILED from meaning empty.
    task.result, task.result_truncated = result, truncated
    task.artifacts, task.artifacts_dropped = artifacts, artifacts_dropped
    if artifacts:
        _log_event("run.artifacts", id=task.id, count=len(artifacts), dropped=artifacts_dropped,
                   bytes=sum(a["bytes"] for a in artifacts), artifacts=[a["name"] for a in artifacts])
    if fail:
        # CUR-855/846: only fills task.unrun_detail when nothing more specific already did —
        # repair_check's own content heuristics (acp_client.py) or the best-of consistency vote
        # (VALUE_DISAGREEMENT_PREFIX above) may have already set a sharper verdict, and `or` never
        # overwrites that. (task.unrun_detail clears only once an attempt is actually about to run, so
        # this `or` is not a no-op on the two break-before-execute paths — wall-clock stop,
        # gateway-grant failure.)
        #
        # Tagged with STRUCTURAL_FAILURE_PREFIX, NOT the bare reason: this is the fifth, different
        # shape that constant's own comment describes — an infrastructure failure, not the model
        # overclaiming — and endpointAgent.ts's fixed "predicted rather than measured" sentence would
        # be actively wrong copy for it (same reasoning TOOL_FAILED_PREFIX's comment already applies
        # to a narrower case). Reuses the existing wire contract (any non-empty value still gates
        # serviceFlagged) rather than a new field, but needs its own client-side branch on this exact
        # prefix for honest copy — see CUR-855/846.
        task.unrun_detail = task.unrun_detail or f"{STRUCTURAL_FAILURE_PREFIX}{fail}"
        task.error, task.summary, task.state = fail, f"failed: {fail[:60]}", State.FAILED
        return
    # Reconcile before either the badge (task.verified) or the summary line reads it — see
    # _reconcile_verification's own docstring for why this is the one late call, not one per site. (CUR-902)
    _reconcile_verification(task)
    # State is set LAST (after summary) so a concurrent status() reader never sees COMPLETED with a
    # not-yet-populated result (lock-free correctness — see _detect_run_failure note; task.result
    # itself is already set above, ahead of both this and the `fail` branch).
    if task.verified:
        _vlabel = f"verified via {task.verify_method}" if task.verify_method else "verified"
        if task.verify_method == "execution" and task._verify_autoderived:
            _vlabel += " (auto-derived spec)"
    else:
        _vlabel = "unverified"
    task.summary = f"completed ({_vlabel}): {len(raw)} log bytes"
    if not task.verified and last_judge_reason:        # why the judge wasn't convinced (honest unverified)
        task.summary += f" | judge: {last_judge_reason}"
    if best_of > 1:
        task.summary += f" | attempt {attempts}/{best_of}"
    task.state = State.COMPLETED


def _grant_attempt_budget(task: Task, nonce: str | None, attempts: int) -> tuple[str | None, str | None]:
    """Fund one attempt. Returns `(nonce, failure_reason)`; a reason means the gateway is unreachable.

    The gateway grant is the ONLY step cap (S1), so an attempt that cannot get one must not run. The
    nonce comes back None in that case because it can no longer authorize anything — the caller stops
    on the reason rather than proceeding uncapped.

    CUR-596: a LATER attempt's own infra failure must not discard an EARLIER one that already verified.
    With consistency_active this is no longer necessarily the task's only chance — that is the whole
    point of sampling past the first accept — so the caller breaks into the shared post-loop tail and
    lets the vote finalize with whatever it has, rather than hard-failing here.
    """
    if not nonce:
        return nonce, None
    try:
        _gateway_grant(nonce, task._max_steps, task._max_tokens, label=task.id, attempt=attempts,
                       model=task.model or AGENT_MODEL)
    except Exception as e:  # noqa: BLE001 — any grant failure means the same thing: this attempt cannot run
        return None, f"attempt {attempts}: model gateway unavailable ({type(e).__name__})"
    return nonce, None


def _record_accepted_attempt(
    task: Task, *, work: str | RemoteWork, stdout: str, stderr: str, vmethod: str | None,
    consistency_active: bool, consistency_samples: list[dict],
) -> None:
    """Write down an attempt the selection just accepted.

    While sampling (CUR-596 item 2) that means a vote entry and nothing else: verified/verify_method/
    judge_reason/unrun_detail are deliberately NOT set, because the post-loop vote is the one place
    that knows which sample actually won. Captured NOW, before the next attempt's _reset_scratch can
    wipe it — a value that would otherwise be gone the moment that attempt starts.

    EVERY accepted vmethod is captured, not just execution-confirmed ones. An overruled accept
    (CUR-744: vmethod is None, its file already failed the deterministic check) must still enter the
    list, or an overruled FIRST attempt finalizes the whole task on its own, bypassing sampling
    entirely and defeating the mechanism on exactly the turns where cross-attempt confirmation matters
    most. It gets sig=None either way — kept out of the vote, still eligible as a last-resort fallback
    if nothing better ever shows up.

    Not sampling: this attempt IS the answer, so the verdict is written here.
    """
    if not consistency_active:
        if vmethod is not None:            # None = accept-unverified (legacy no-spec path)
            task.verified, task.verify_method = True, vmethod
        return
    sig = _attempt_signature(work, task._verify_spec) if vmethod in ("execution", "execution+judge") else None
    consistency_samples.append({"sig": sig, "stdout": stdout, "stderr": stderr,
                                "vmethod": vmethod,
                                "judge_reason": task.judge_reason,
                                "unrun_detail": task.unrun_detail,
                                "snapshot": _snapshot_scratch(work)})


def _salvage_structural_failure(
    task: Task, *, work: str | RemoteWork, stdout: str, stderr: str, nonce: str | None,
    last_structural: str, attempts: int, consistency_active: bool,
    consistency_samples: list[dict],
) -> tuple[bool, str]:
    """Can the artifact check rescue an attempt that failed structurally? `(salvaged, why_not)`.

    Discarding a structurally failed attempt outright is right when the agent never ran, and wrong when
    it ran for a dozen turns and got throttled on the last one: the files it left are either correct or
    they aren't, and the check that settles it costs one subprocess and no model call. Long-horizon
    tasks hit this, most after a dozen or more model calls.
    _reset_scratch wipes the workdir on the next iteration, so the caller's `if last_structural:` is the last
    moment those artifacts exist.

    Deterministic artifact specs only: the judge needs a fresh gateway grant, and a spend cap is a poor
    reason to spend more. An attempt salvaged here is `execution`-verified by exactly the check every
    other attempt faces, so it is not a weaker kind of pass.

    `why_not` is the check's own words when it RAN and refused, and "" when it never ran at all (no
    spec, or a spec with nothing deterministic to check). The caller must keep those apart — an empty
    string there would otherwise wipe an earlier attempt's still-valid verdict.
    """
    spec = task._verify_spec
    if spec is None or not (spec.expect_file or spec.check_cmd):
        return False, ""
    ok, detail = _verify(work, spec)
    if not ok:
        # Not salvageable, but the check just said WHY, and a throttled attempt is the one most likely
        # to have left work worth repairing — it was cut off mid-task, not confused.
        return False, _scrub(detail, nonce)
    _log_event("run.salvaged", id=task.id, attempt=attempts, structural=last_structural,
               structural_kind=_structural_kind(last_structural), detail=detail)
    _metric_inc("agent_salvaged_total")
    task.verify_check = _spec_fields(spec)
    if consistency_active:
        # A salvaged attempt passed the SAME deterministic check a normal accept does — its computed
        # value is exactly as trustworthy, so it gets a real signature and enters the vote like any
        # other execution-verified attempt, instead of finalizing the whole task on one throttled
        # attempt alone. verified/verify_method stay unset here: the post-loop vote owns those.
        consistency_samples.append({"sig": _attempt_signature(work, spec), "stdout": stdout,
                                    "stderr": stderr, "vmethod": "execution",
                                    "judge_reason": task.judge_reason,
                                    "unrun_detail": task.unrun_detail,
                                    "snapshot": _snapshot_scratch(work)})
    else:
        task.verified, task.verify_method = True, "execution"
    return True, ""


def _backoff_before_retry(task: Task, last_structural: str, attempts: int, best_of: int) -> None:
    """Wait out an upstream failure before the next attempt, but never past the task's own deadline."""
    if attempts >= best_of or task._canceled:
        return
    delay = _upstream_backoff_secs(last_structural, attempts, UPSTREAM_RETRY_BASE_SECS)
    if delay <= 0:
        return
    remaining, stop = _remaining_timeout(_RUN_START[task.id], time.monotonic(),
                                         task._wall_clock, best_of)
    if not stop:                 # no time left → let the next loop iteration's own check break cleanly
        time.sleep(min(delay, remaining))   # rather than oversleeping past the deadline here


def _resolve_workdir(task: Task) -> tuple[str, int, bool]:
    """Where this turn writes, and how much of its ration is already spent.

    Returns `(work, baseline, session_over_budget)`. CUR-196: a session_id present means reuse (or
    create) a workdir keyed on (task.user, session_id) that survives past this turn, instead of the
    always-fresh, always-discarded per-task scratch. Absent, the behavior is byte-identical to
    pre-CUR-196 — baseline=0 makes the caller's watchdog math a no-op.

    `baseline` is what the session directory already held before this turn started, so the scratch
    watchdog measures THIS turn's growth rather than re-billing a continued session for files a
    previous turn legitimately left behind.
    """
    session_id = task._session_id
    if not session_id:
        return tempfile.mkdtemp(prefix=_SCRATCH_PREFIX, dir=SCRATCH_ROOT), 0, False
    existing = store.get_session_workdir(task.user, session_id)
    if existing and os.path.isdir(existing):
        work = existing
        baseline = _dir_disk_bytes(work, SESSION_SCRATCH_MAX_BYTES)
        session_over_budget = baseline >= SESSION_SCRATCH_MAX_BYTES
        task._session_continued = True
    else:
        work = tempfile.mkdtemp(prefix=_SCRATCH_PREFIX, dir=SCRATCH_ROOT)
        # Had a row with its dir gone, or the caller knows an earlier turn ran and this machine has no row
        # (CUR-4393: the follow-up reached a machine that never held the session). Tell the agent and the
        # caller rather than silently starting over.
        task.session_expired = existing is not None or task._continues_session
        baseline, session_over_budget = 0, False
    store.touch_session_workdir(task.user, session_id, work)
    return work, baseline, session_over_budget


def _mcp_offered(permission_policy: str) -> bool:
    """Whether a task resolved to `permission_policy` gets the configured MCP servers (CUR-3025).

    Only under "allow". deny_writes and confirm exist to keep writes away from the model or behind a
    human, and an MCP tool reaches neither guard: Hermes asks request_permission for write_file/patch and
    the execute kinds (see _PERMISSION_COVERS), never for an `mcp__*` call. A config-writing MCP tool is a
    write, so under those policies the servers are left off the session entirely, the same floor
    _deny_writes_toolsets applies to `terminal`. "staged" has already resolved to one of the others here."""
    return permission_policy == "allow" and bool(MCP_CONFIG.servers)


def _execute_attempt(
    task: Task, *, work: str, attempt_home: str, attempt_prompt: str, attempts: int,
    nonce: str | None, timeout_secs: float, buf: _EventBuffer | None, sandbox: list[str],
    use_acp: bool, decision: dict,
    verify_check: Callable[[], bool] | None,
    repair_check: Callable[[str], tuple[bool, str]] | None,
    tool_kinds: set[str], tool_failures: set[str],
) -> tuple[str, str, int | None, str | None, bool]:
    """Run ONE best-of-N attempt on whichever transport this task picked.

    Returns `(stdout, stderr, returncode, acp_stop, timed_out)` — the four things the caller's
    honest-success decision needs plus the ACP-native stop reason, which is None on the oneshot path
    because there is no prose channel to carry one. Lifted out of _run (CUR-1229): it was the single
    densest region of control flow in a 935-line function, and past a threshold pyright stops
    analyzing a function AT ALL rather than degrading — so nothing in _run was type-checked.

    `tool_kinds` / `tool_failures` are passed by reference and filled in by the ACP client as frames
    arrive; the caller clears them per attempt and reads them after. Mutating `task` is likewise part
    of the contract, not a leak: _proc, _acp_cancel and _acp_confirm are the live handles the cancel
    endpoint reaches for, so they have to be visible on the shared object while this runs.
    """
    acp_stop: str | None = None
    timed_out = False
    # CUR-470/471: `decision` was resolved ONCE per task, above the attempt loop — see the comment at
    # agent_prompt's construction for why. Every consumer downstream (_model_env, the ACP client) acts
    # on this task's own answer, not the bare mode name.
    permission_policy = decision["policy"]
    if use_acp:
        # ACP client session: live plan/tool_call/tool_result frames + per-op request_permission gate
        # (streaming-spec §3/§7.1). Lazy import so the default flag-off path never needs `acp`.
        import acp_client
        mcp_servers = (acp_client.build_mcp_servers(MCP_CONFIG, os.environ, task.id)
                       if _mcp_offered(permission_policy) else [])
        try:
            remote_rel = Path(attempt_home).name
            remote = task._sbx is not None
            review_work = ((RemoteWork(SANDBOX_BACKEND, task._sbx, _remote_work()) if task._sbx is not None else work)
                           if task._approval_mode == "auto" else None)
            stdout, acp_stop, ret = asyncio.run(acp_client._acp_run(
                work, attempt_home, attempt_prompt, nonce, timeout_secs, buf, task,
                sandbox_prefix=[] if remote else sandbox, hermes_bin="hermes" if remote else HERMES_BIN,
                model_env=(_remote_model_env(f"{_remote_work()}/{remote_rel}", permission_policy, nonce or "") if remote
                           else _model_env(nonce, attempt_home, permission_policy)),
                open_stdio=(_remote_hermes_opener(task._sbx, attempt_home, remote_rel)  # pyright: ignore[reportArgumentType]
                            if remote and task._sbx is not None else None),
                session_cwd=_remote_work() if remote else None,
                model=task.model or AGENT_MODEL, provider=AGENT_MODEL_PROVIDER, attempt=attempts,
                verify_check=verify_check, repair_check=repair_check,
                # `nonce` is a parameter of this function, not a loop variable, so the lambda's
                # late binding is safe.
                repair_turn_prompt=(lambda d: _repair_turn_text(_scrub(d, nonce))),
                repair_turns=REPAIR_TURNS,
                repair_exhausted_answer=_REPAIR_EXHAUSTED_ANSWER,
                emit_token=STREAM_TOKENS, token_max_frames=STREAM_MAX_FRAMES,
                tool_kinds=tool_kinds, tool_failures=tool_failures, permission_policy=permission_policy,
                policy_detail=decision,
                confirm_timeout_secs=CONFIRM_TIMEOUT_SECS,
                approval_mode=task._approval_mode,
                auto_reviewer=(_make_auto_reviewer(task.prompt, review_work, _gateway_post(nonce),
                                                   files_at_start=_start_listing(review_work))
                               if review_work is not None else None),
                on_confirmation_open=task._on_confirmation_open,
                on_confirmation_close=task._on_confirmation_close,
                mcp_servers=mcp_servers))
            stderr = ""
        except TimeoutError:
            stdout, stderr, ret, timed_out = "", "", None, True
        except asyncio.CancelledError:                  # external cancel — DELETE already set _canceled
            stdout, stderr, ret = "", "", None
        except Exception as e:  # noqa: BLE001 — JSON-RPC/transport error → nonzero-exit failure signal
            stdout, stderr, ret = "", f"{type(e).__name__}: {e}", 1
        finally:
            task._acp_cancel = None
            task._acp_confirm = None
            # Reimburse the TASK-level wall clock (_RUN_START, checked by _remaining_timeout
            # in the caller) for time this attempt spent paused on a human confirmation —
            # acp_client._acp_run's own `finally` already set task._confirm_wait_secs to the attempt's
            # actual paused duration before returning. Without this, a long confirm wait would silently
            # shrink the runway left for later best-of-N attempts even though the attempt that paused
            # spent no compute. (CUR-218)
            if task._confirm_wait_secs:
                _RUN_START[task.id] += task._confirm_wait_secs
                task._confirm_wait_secs = 0.0
    else:
        # Popen (not run) so the wall-clock cap and explicit cancel can kill the whole process tree.
        # semgrep's dangerous-subprocess-use-tainted-env-args flags this line. Read
        # directly rather than waved through, and it does not hold here — _model_env is the
        # secrets-at-boundary chokepoint: it starts from an env with every secret-named var stripped
        # and re-adds only HERMES_HOME (a server-derived per-task path) plus a per-task nonce
        # standing in for the real model token, so no request value reaches the child environment.
        # The argv is list-form with no shell, so attempt_prompt is one argument rather than
        # anything a shell parses. The suppression lives in ci.yml as --exclude-rule, not here: an
        # inline `# nosemgrep` does not take for this rule (neither the bare nor the fully-qualified
        # form takes on the match line; is_ignored stays null). (CUR-1275)
        proc = subprocess.Popen(
            [*sandbox, HERMES_BIN, "-z", attempt_prompt, "-t", ALLOWED_TOOLSETS, "--yolo", *_model_flags(task.model)],
            cwd=work, env=_model_env(nonce, attempt_home, permission_policy),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
        )
        task._proc = proc
        try:
            stdout, stderr = proc.communicate(timeout=timeout_secs)
        except subprocess.TimeoutExpired:
            _kill_process_group(proc)
            try:
                stdout, stderr = proc.communicate(timeout=10)
            except Exception:  # noqa: BLE001
                stdout, stderr = "", ""
            timed_out = True
        finally:
            ret = proc.returncode
            task._proc = None
    return stdout, stderr, ret, acp_stop, timed_out


def _run(task: Task) -> None:
    # The /run endpoint already sets this before the task is visible in TASKS, to close the
    # orphan-reaper startup race — setdefault so a caller that drives _run() directly (tests; any future
    # in-process caller) still gets one, since _run's own wall-clock math below reads _RUN_START[task.id]
    # unconditionally. (CUR-1330)
    _RUN_START.setdefault(task.id, time.monotonic())
    # session_id present -> reuse (or create) a workdir keyed on (task.user, session_id) that
    # survives past this turn, instead of the always-fresh, always-discarded scratch below. Absent ->
    # byte-identical to pre-CUR-196 behavior (baseline=0 makes the watchdog math below a no-op change). (CUR-196)
    work, baseline, session_over_budget = _resolve_workdir(task)
    task._workdir = work
    # This turn's own start, wall-clock — before any tool call this turn can run. In a continued
    # session `work` is the PRIOR turn's directory too (CUR-196), so an unfiltered artifact walk resurfaces
    # its real files under a "this turn produced" label even when this turn made zero tool calls. Passed
    # to `_collect_artifacts` at the one call site that builds that display list, nowhere else — moderation
    # and the download route stay unscoped on purpose. For a fresh session `work` is a brand-new empty
    # tempdir, so filtering by this is a no-op there; no need to gate on `task._session_continued`. (CUR-1117)
    turn_start_wall = time.time()
    # One watchdog for the whole task, not one per attempt: the scratch is shared across attempts and it
    # is the SUM that has to stay bounded. _reset_scratch between attempts keeps the reading honest.
    _scratch_stop = threading.Event()
    _scratch_thread = threading.Thread(target=_scratch_watchdog, args=(task, work, baseline, _scratch_stop), daemon=True)
    _scratch_thread.start()
    nonce: str | None = None
    revoked = False
    reqs = toks = 0
    usage_seen = False
    cap_hit = False
    last_judge_reason = ""                 # last LLM-judge rejection (surfaced in the summary when unverified)
    buf: _EventBuffer | None = None
    # Bound here rather than probed for with locals().get() in the handlers below: a name
    # assigned only deep inside the post-loop tail leaves the handlers unable to know whether it
    # exists. _finalize_run returns it, and a name a reader can follow beats a string lookup
    # no checker can (CUR-1229).
    fail: str | None = None
    try:
        if task._canceled:                                 # canceled while still SUBMITTED, before we started
            task.summary = task.summary or "canceled"      # leave state CANCELED; finally persists + cleans up
            return
        task.state = State.WORKING                         # flip to WORKING only after the cancel check (no race)
        _persist(task)
        # wall_clock_s is logged because a deadline nobody can observe is a deadline nobody can check. It
        # is the caller's number after clamping, so a chat client that believes it asked for 150 and a
        # task that actually ran to 300 disagree in the record rather than only in the timings — which is
        # the difference between finding a mismatch and inferring one from a latency histogram.
        _log_event("run.started", id=task.id, user=task.user, wall_clock_s=task._wall_clock)
        buf = _event_buffer(task.id, create=True)          # live SSE stream for this run (None when disabled)
        if buf is not None:
            buf.emit("state", {"task_id": task.id, "state": "working"})
        if session_over_budget:  # CUR-196: fail loud, no turn attempted against an over-budget session
            task.error = (f"session workspace exceeded its ration: {baseline} bytes against a "
                          f"{SESSION_SCRATCH_MAX_BYTES} byte cap (AGENT_SESSION_SCRATCH_MAX_BYTES)")
            task.summary, task.state = "failed: session scratch ration", State.FAILED
            return
        # Per-task HERMES_HOME: carries the model config + isolates session/checkpoint writes between tasks.
        home = str(Path(work, "hermes-home"))
        global_cfg = Path.home() / ".hermes" / "config.yaml"
        _write_hermes_home_config(home, global_cfg)
        # Secrets boundary + caps: ALLOCATE a per-task nonce. Fail CLOSED — if the gateway is meant to be
        # on but is unreachable, never silently fall back to passing the real token through. The nonce
        # ALLOCATION is split from the per-attempt grant POST below: the best-of-N gates are nonce-dependent
        # and must be computed AFTER this allocation, or they'd see nonce=None and silently force
        # may_derive/may_judge False.
        if MODEL_PROXY_URL and not PROXY_ADMIN_KEY:
            task.error, task.summary, task.state = "gateway configured but PROXY_ADMIN_KEY missing", "failed: gateway config", State.FAILED
            return
        if MODEL_PROXY_URL:
            nonce = uuid.uuid4().hex                        # allocate only; granted per-attempt below.
        # Best-of-N gates — computed post-nonce so may_derive/may_judge see the real nonce.
        best_of, may_derive, may_judge = _best_of_gates(task._verify_spec, task._synthesize, nonce)
        best_of = best_of if nonce is not None else 1       # C6: no gateway ⇒ no step cap ⇒ no best-of-N
        # Transport pick, once for the whole task (every best-of attempt uses the same one) — see
        # _use_acp: single-path default is ACP, transport="oneshot" is the explicit opt-out.
        use_acp = AGENT_ACP and _use_acp(task._transport)
        task.transport_used = "acp" if use_acp else "oneshot"   # observability: which path this task actually took
        ws: str | RemoteWork = work                         # where the agent's files are; the guest's, when remote
        if SANDBOX_BACKEND.name != "bwrap":
            # Hermes runs in the conversation's own sandbox, which only the ACP path can drive and
            # only the gateway can fund. Its own conversation key, apart from the run-code tools' sandbox,
            # since a sandbox's egress is fixed at its tier when it is made. (CUR-4482)
            if not (use_acp and nonce):
                task.error, task.summary, task.state = ("a remote sandbox needs the ACP transport and the model "
                                                        "gateway"), "failed: sandbox", State.FAILED
                return
            if (held := _connect_agent_sandbox(task, buf)) is None:
                return
            ws = RemoteWork(SANDBOX_BACKEND, held, _remote_work(), local=work)  # CUR-4483
        # Execution sandbox: optionally wrap the agent so it can't read host secrets / write outside scratch.
        sandbox = _sandbox_prefix(work) if task._sbx is None else []
        if SANDBOX_REQUIRED and not sandbox and task._sbx is None:
            task.error, task.summary, task.state = "sandbox required but not configured", "failed: sandbox", State.FAILED
            return
        # Shared gateway-call closures for the verify machinery (derive-before-loop + judge-in-loop). They
        # route through the same gateway/nonce; the judge runs as VERIFIER_MODEL when configured (a
        # stronger/diverse model checking the open executor) — else self-judge.
        def _derive_call(messages):
            import httpx
            r = httpx.post(MODEL_PROXY_URL + "/v1/chat/completions",
                           headers={"authorization": f"Bearer {nonce}"},
                           json={"model": AGENT_MODEL, "messages": messages,
                                 "temperature": 0.0, "max_tokens": DERIVE_MAX_TOKENS}, timeout=60.0)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]

        def _judge_call(messages):
            import httpx
            r = httpx.post(MODEL_PROXY_URL + "/v1/chat/completions",
                           headers={"authorization": f"Bearer {nonce}"},
                           json={"model": VERIFIER_MODEL or AGENT_MODEL, "messages": messages,
                                 "temperature": 0.0, "max_tokens": JUDGE_MAX_TOKENS},
                           timeout=JUDGE_TIMEOUT_SECS)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]

        # best-of-N: up to N attempts, accept the first the shared _select_attempt confirms. `-z`/oneshot
        # is final-text-only BY DESIGN (Hermes redirects the whole call tree's
        # stdout/stderr to devnull and writes only the final response to real stdout) — so `stdout` here is
        # already clean judge-able text, not a mixed transcript; the artifact `_verify` (when a spec exists)
        # still gates the judge as necessary-but-not-sufficient in _select_attempt.
        # Chat turn without a spec: derive an expect_file spec so best-of-N can engage. Under per-attempt
        # grants NO run-grant is live yet, so fund the derive with its own minimal grant/revoke (C2).
        if may_derive and nonce and task._verify_spec is None and best_of > 1:
            try:
                _gateway_grant(nonce, 1, DERIVE_MAX_TOKENS, label=f"{task.id}:derive")
                try:
                    derived = _derive_verify_spec(task.prompt, _derive_call)
                finally:
                    d_reqs, d_toks, _du, _dc = _gateway_revoke(nonce)
                    reqs += d_reqs; toks += d_toks
                if derived is not None:
                    task._verify_spec, task._verify_autoderived = derived, True
                    _log_event("verify.autoderived", id=task.id, expect_file=derived.expect_file)
            except Exception:  # noqa: BLE001 — derive is advisory; a failure just leaves no spec
                pass
        # Early-exit check (ACP only — see acp_client._acp_run's docstring for why oneshot can't do this).
        # Built once for the whole task: work/spec are stable across attempts even though attempt_home isn't.
        # Annotated, and the conditional `def` given its own name rather than rebinding this one: a bare
        # `verify_check = None` followed by `def verify_check()` declares the name as a function and then
        # contradicts itself, which is what pyright reports the moment it can see this function at all
        # (CUR-1229). The Optional is the real type — every consumer already treats None as "no check".
        verify_check: Callable[[], bool] | None = None
        if EARLY_EXIT and use_acp and task._verify_spec is not None:
            _early_exit_spec = task._verify_spec
            def _early_exit_check() -> bool:
                try:
                    ok, _detail = _verify(ws, _early_exit_spec)
                    return ok
                except Exception:  # noqa: BLE001 — a broken check must never crash the ACP loop
                    return False
            verify_check = _early_exit_check
        # In-session repair: the same check, but its VERDICT AND ITS WORDS, asked when the model says it
        # is finished. Early-exit and this are the same instrument pointed opposite ways — one ends a turn
        # the check has already approved, the other refuses to let one end that it hasn't.
        repair_check: Callable[[str], tuple[bool, str]] | None = None   # same shape as verify_check above
        # Tool kinds this attempt, filled in by the ACP client as frames arrive. Created HERE, before the
        # session exists, because the closure below is built before it too and shares this set by
        # reference. Reset per attempt with the rest of the attempt state.
        tool_kinds: set[str] = set()
        # Kinds with at least one call that ended status=="failed" this attempt, same
        # shared-by-reference shape as tool_kinds — see _AgentClient.tool_failures for what this catches. (CUR-574)
        tool_failures: set[str] = set()
        _repair_spec = task._verify_spec
        # In-session repair runs in two cases, distinguished by what the check can assert.
        #
        # 1. A content-asserting spec, which can refute the model on the task itself. An existence-only
        #    spec can't tell "done" from "wrote an empty file with the right name", so bouncing the model
        #    against it would burn turns on a check that will never disagree (_repair_carries_scratch).
        #
        # 2. No spec at all, which is the chat path (endpointAgent posts synthesize:true and sends none).
        #    Two things are still assertable without a spec: code that will not compile, and code written
        #    and never run. _repair_carries_scratch alone would exclude this case, but it answers a
        #    question about CROSS-ATTEMPT scratch retention, and in-session repair never resets the scratch.
        if REPAIR_TURNS > 0 and use_acp and (
                _repair_carries_scratch(_repair_spec, task._verify_autoderived) or _repair_spec is None):
            def _in_session_repair_check(answer: str) -> tuple[bool, str]:
                try:
                    # Syntax first. It is free, and it names the actual defect: the real check reports a
                    # file that does not parse as ModuleNotFoundError, which sends the repair turn to
                    # argue about a missing module instead of an unterminated string on line 32.
                    broken = _syntax_errors(ws)
                    if broken:
                        return False, "this code does not compile: " + "; ".join(broken[:5])
                    # Ordered AFTER the syntax check on purpose: a file that does not parse cannot be run,
                    # so asking for a run first would send the model to argue with the interpreter about a
                    # defect it can see for itself from the source.
                    unrun = _wrote_code_without_running_it(tool_kinds, tool_failures, ws, answer, use_acp)
                    if unrun:
                        return False, f"{UNRUN_DETAIL_PREFIX}{unrun}"
                    # Independent of the above — a real, successful run can still report a
                    # self-contradictory result (see _zero_result_from_nonzero_input's own comment). (CUR-1404)
                    zeroed = _zero_result_from_nonzero_input(answer)
                    if zeroed:
                        return False, f"{ZERO_RESULT_PREFIX}{zeroed}"
                    # A chart whose ranges plot the wrong cells, read from the .xlsx files this turn made. (CUR-4600)
                    charts = workdir_chart_problems(_artifact_paths(ws, 50, since=turn_start_wall),
                                                    workdir_reader(ws, ARTIFACT_DOWNLOAD_MAX_BYTES))
                    if charts:
                        return False, charts
                    if _repair_spec is None:
                        return True, ""        # nothing further is assertable without a spec
                    return _verify(ws, _repair_spec)
                except Exception as e:  # noqa: BLE001 — a broken check must not strand the turn; let it end
                    return True, f"check raised {type(e).__name__}"
            repair_check = _in_session_repair_check
        stdout = stderr = ""
        ret = None
        # What the AGENT is asked. `task.prompt` stays the untouched original and is what the judge reads
        # in _select_attempt — a judge shown the acceptance test would grade against the test instead of
        # against what the caller asked for, which is a different question and a weaker one.
        # WORKDIR_NOTE first and unconditionally: it is where output goes, true of every task, and the
        # appendix below only sometimes exists. Ordering puts the room before the grading.
        check_note = _check_appendix(task._verify_spec, task._verify_autoderived)
        # Computed ONCE per task, not per best-of-N attempt — a caller's trust state is a
        # property of their history in the tasks table, which this task's own (not-yet-COMPLETED) row
        # cannot change mid-loop, so recomputing per attempt bought nothing and risked attempts of the
        # SAME task disagreeing with each other. Gated on use_acp specifically for the prompt note:
        # oneshot always runs --yolo unconditionally and CUR-217's toolset filtering never applies
        # there, so telling an oneshot caller it lacks tools it actually has would be actively wrong. (CUR-471)
        decision = _permission_decision(task.user)
        # The caller's trust tier goes onto the client-visible task as well as the model-facing prompt
        # note and toolset decision: the SSE `policy` event carries it live, but a poller/webhook
        # consumer (StatusResponse, _done_payload) reads it from here (CUR-761). Unlike _policy_note
        # below, this is NOT gated on use_acp: tier/tasks_done/tasks_required are facts about the CALLER
        # (their trust history), true whichever transport this turn runs on. Whether the tier had any
        # toolset effect is transport-dependent (oneshot ignores the toolset filtering), and a client
        # already has `transport_used` on the same response to make that call; composing the two into a
        # human sentence is the UI's job, not this field's.
        task.tier, task.tasks_done, task.tasks_required = (
            decision["tier"], decision["tasks_done"], decision["tasks_required"])
        # Built once per task, passed into acp_client._acp_run below — acp_client.py cannot
        # import State/_TERMINAL (app.py imports acp_client, not the reverse), so these closures live
        # here and are forwarded as plain callables. Both guard against clobbering a state something
        # else already set: DELETE /run/{id} sets State.CANCELED synchronously, on the HTTP thread,
        # BEFORE it calls task._acp_cancel() (which only schedules the actual cancellation via
        # call_soon_threadsafe) — so there's a real window where CANCELED has already landed but the
        # attempt hasn't noticed yet. Without these guards, a confirmation opening or closing in that
        # window would silently revert CANCELED back to AWAITING_CONFIRMATION or WORKING. (CUR-218)
        def _confirmation_opened(desc: dict) -> None:
            task.pending_confirmations.append(desc)
            if task.state not in _TERMINAL:
                task.state = State.AWAITING_CONFIRMATION
            _persist(task)

        def _confirmation_closed(confirm_id: str) -> None:
            task.pending_confirmations = [c for c in task.pending_confirmations if c["confirm_id"] != confirm_id]
            if not task.pending_confirmations and task.state == State.AWAITING_CONFIRMATION:
                task.state = State.WORKING
            _persist(task)

        # Parked on the task rather than passed down as two more parameters: _execute_attempt forwards
        # them verbatim to acp_client and never calls them, so they are this task's state, not that
        # function's business (CUR-1229).
        task._on_confirmation_open = _confirmation_opened
        task._on_confirmation_close = _confirmation_closed
        # The count comes back from the same walk that builds the note, rather than a second one
        # here — see _workdir_note. Parked on the task so _done_payload can send it without re-reading a
        # `work` directory that the `finally` below deletes. (CUR-1394)
        workdir_note, task._session_files_at_start = _workdir_note(ws, task._session_continued, task.session_expired)  # CUR-196, CUR-4595
        # Order matters. The task sits at the front of this concatenation and every note after it is
        # read AFTER the task, so the notes nearest the end are what the model reads most recently before
        # answering. LANGUAGE_NOTE sits after SOURCE_FIDELITY_NOTE, which says nothing about what language
        # to answer in, so the language instruction gets a late position (CUR-706). The tail's order is
        # load-bearing: moving one of its notes fixes one leak and can reopen another (CUR-752).
        # _sandbox_note sits immediately after _policy_note because the two answer the same question,
        # what this session can actually do, and stays out of the
        # CAPABILITY/COMPUTATION/SOURCE_FIDELITY/LANGUAGE/CATEGORY_RECAP tail so that tail keeps its order
        # (CUR-1405).
        agent_prompt = task.prompt + workdir_note + check_note + (_policy_note(decision) if use_acp else "") + _sandbox_note() + CAPABILITY_NOTE + COMPUTATION_NOTE + SOURCE_FIDELITY_NOTE + LANGUAGE_NOTE + NO_VERIFICATION_CLAIM_NOTE + CATEGORY_RECAP_NOTE  # CUR-542, CUR-672, CUR-676, CUR-705, CUR-706, CUR-752, CUR-764, CUR-1405, CUR-4055
        if check_note:
            _log_event("run.check_shown", id=task.id, chars=len(check_note))
        last_structural: str | None = "agent did not run"
        last_verify_detail = ""                        # what the check said about the previous attempt
        attempts = 0
        # CUR-596 item 2: when active, a verified attempt no longer ends the loop immediately — sampling
        # continues (up to best_of) so independently-verified attempts' computed values can be compared.
        # Only file-shaped specs have a value to compare (_consistency_eligible); everything else behaves
        # exactly as before, including when the flag is off entirely (the default).
        consistency_active = VALUE_CONSISTENCY_CHECK and best_of > 1 and _consistency_eligible(task._verify_spec)
        # [{"sig","stdout","stderr","vmethod","judge_reason","unrun_detail","snapshot"}] — one entry per
        # attempt that reached ANY accepted/salvaged outcome while consistency_active, regardless of
        # WHICH code path accepted it (the normal _select_attempt accept, the structural-failure salvage
        # branch, or a judge-overruled accept). Every one of those paths appends here instead of
        # setting task.verified and `break`ing directly: independent setters would let whichever fired LAST
        # silently clobber an earlier, already-captured sample, and a judge-overruled FIRST attempt would
        # bypass sampling entirely, finalizing the whole task on one deterministically-failed-but-judge-
        # waved-through attempt with no cross-attempt confirmation. task.verified/verify_method/judge_reason/unrun_detail/stdout/stderr/`work` are ALL
        # deferred to the ONE post-loop vote below — never set inline in the loop — so no code path can
        # finalize the task on its own.
        #
        # `sig` is None for two different reasons the vote treats identically (excluded from winning, but
        # still eligible as a last-resort fallback if nothing better exists): a judge-overruled attempt's
        # file already failed the deterministic check, so its computed value was never trustworthy in the
        # first place; a genuine attempt-signature read failure (transient OSError, an oversized CSV
        # field) means the value COULD have been trustworthy but couldn't be confirmed. Either way, a
        # None-sig sample must never be preferred over a real one when picking what to serve — see the
        # post-loop fallback logic.
        consistency_samples: list[dict] = []
        for attempts in range(1, best_of + 1):
            if task._canceled:
                break
            attempt_prompt = agent_prompt
            if attempts > 1:
                # Repair, or restart. A retry that wipes the scratch and re-sends the original prompt is
                # best-of-N: N independent draws, no information carried between them. When the last
                # attempt left files AND the check said something about them AND the spec asserts content
                # (see _repair_carries_scratch for why that last clause is load-bearing), the strictly
                # better move is to hand both back and ask for a fix.
                if (REPAIR_LOOP and last_verify_detail
                        and _repair_carries_scratch(task._verify_spec, task._verify_autoderived)
                        and _scratch_artifacts(ws)):
                    attempt_prompt = _repair_prompt(agent_prompt, last_verify_detail)
                    _log_event("run.repair", id=task.id, attempt=attempts,
                               artifacts=_scratch_artifacts(ws)[:20], detail=last_verify_detail[:200])
                    _metric_inc("agent_repair_attempt_total")
                    # NB: the per-attempt HERMES_HOMEs stay either way; _reset_scratch is what would have
                    # removed the previous one, and skipping it leaves a few KB of dead session state in
                    # the scratch that dies with the task.
                else:
                    _reset_scratch(ws)                 # C7: reset FIRST, then create a fresh per-attempt home
            # task.id-qualified, not just attempts-qualified (CUR-196). `attempts` restarts at 1 every
            # _run call, and for a reused session workdir that would collide with a prior TURN's attempt 1
            # — Hermes writes more than config.yaml into its home ("isolates session/checkpoint writes
            # between tasks", per the comment above), so an unqualified name would silently inherit
            # whatever a previous turn's Hermes process left there. task.id is unique per turn.
            attempt_home = str(Path(work, f"hermes-home-{task.id}-{attempts}"))
            # Per-attempt, and CLEARED rather than rebound: repair_check closed over this object before the
            # loop, so assigning a fresh set here would leave the check reading a set nothing writes to.
            # Without the reset, an attempt that ran nothing inherits the previous attempt's `execute` and
            # the un-run turn silently stops firing from attempt 2 on.
            tool_kinds.clear()
            tool_failures.clear()             # same reset, same reason — CUR-574
            Path(attempt_home).mkdir(parents=True, exist_ok=True)
            _write_hermes_home_config(attempt_home, global_cfg)
            # Per-attempt wall-clock carved from the shared task deadline (S2): never run N×WALL_CLOCK.
            timeout_secs, stop = _remaining_timeout(_RUN_START[task.id], time.monotonic(),
                                                     task._wall_clock, best_of)
            if stop:
                # The EFFECTIVE cap, not the server ceiling. A caller that lowered its wall clock and
                # then read "300s task ceiling exceeded" would be told about a limit that did not stop it.
                last_structural = (f"wall-clock cap ({task._wall_clock * max(1, best_of)}s task ceiling) "
                                   f"exceeded")
                break
            nonce, grant_failure = _grant_attempt_budget(task, nonce, attempts)
            if grant_failure:
                last_structural = grant_failure
                # `break` into the shared post-loop tail rather than `return`ing here (CUR-855/846).
                # `stdout` is never reset between attempts (only initialized once, before the loop) — a
                # PRIOR attempt that ran, produced real content, and was then rejected leaves that
                # content sitting in `stdout` right up until a later attempt overwrites it. This grant
                # failure fires BEFORE the current attempt ever executes, so the shared tail moderates
                # that still-live content and populates task.result/task.unrun_detail before deciding
                # FAILED, same as every other structural failure.
                #
                # Whether that content actually SHIPS still depends on moderation succeeding —
                # moderation runs against the guard screen endpoint (SAFETY_SCREEN_URL), a different
                # dependency from the model gateway this failure is about, so a gateway failure does not
                # imply an unavailable screen. Fail-closed when the screen is unavailable is correct —
                # see moderate()'s own docstring.
                break
            # CUR-855/846 (F3): the reset sits here, right before this attempt runs, not at the top of
            # the attempt block. Both `break`s above fire BEFORE this attempt executes, so `stdout` (and
            # whatever real content it holds) still belongs to the PREVIOUS attempt when they fire, and so
            # does unrun_detail: the repair_check verdict acp_client._acp_run set mid-attempt. Resetting
            # before them would replace that attempt-specific verdict with a blank slate, and `if fail:`
            # below would then report this new attempt's unrelated failure reason instead. Here, the reset
            # still keeps a REJECTED earlier attempt's stale verdict from leaking into whichever attempt
            # gets selected (CUR-574) for every attempt that reaches this line, without wiping a verdict
            # that belongs to content this task is about to ship.
            task.unrun_detail = ""
            # Execute this attempt. Both transports yield the same four things for the shared
            # honest-success decision below; only the transport differs. See _execute_attempt.
            stdout, stderr, ret, acp_stop, timed_out = _execute_attempt(
                task, work=work, attempt_home=attempt_home, attempt_prompt=attempt_prompt,
                attempts=attempts, nonce=nonce, timeout_secs=timeout_secs, buf=buf,
                sandbox=sandbox, use_acp=use_acp, decision=decision,
                verify_check=verify_check, repair_check=repair_check,
                tool_kinds=tool_kinds, tool_failures=tool_failures)
            # Per-attempt tally + revoke (S3): accumulate for the ledger; use the per-attempt count for
            # THIS attempt's honest-success decision. The nonce is idle after this until the next grant.
            # `usage_seen` is a "did the gateway EVER see usage" fact and has to be sticky: reassigning
            # it here would let a run whose last attempt reported nothing erase what the earlier ones
            # saw, and the summary would then claim "spend-cap inert: no usage from upstream" about a task
            # that had metered fine. `cap_hit` stays per-attempt on purpose: _detect_run_failure below
            # asks whether THIS attempt was throttled, not whether any of them were.
            if nonce:
                a_reqs, a_toks, a_usage, cap_hit = _gateway_revoke(nonce, task.served_models)
                reqs += a_reqs; toks += a_toks
                usage_seen = usage_seen or a_usage
            else:
                a_reqs, a_toks, cap_hit = 0, 0, False
            if task._canceled:
                break
            if timed_out:
                # THIS ATTEMPT is out of clock. The task is not — it holds task._wall_clock * best_of, and
                # the loop head's own `stop` check is what ends it when that ceiling is reached. Breaking here
                # would let one long attempt kill the whole task with its siblings' budget untouched, each
                # discarding the wall clock it had been granted.
                # Falling through to the retry path costs nothing when the clock really is gone: the next
                # iteration's `stop` breaks immediately, and the message it sets names the task ceiling.
                last_structural = f"attempt {attempts} hit the {task._wall_clock}s per-attempt wall clock"
                # Log BEFORE the continue: below the branch it would record every attempt except
                # the one that ran out of clock — the single most informative
                # attempt in any long-horizon trial, and the one whose call count says whether the deadline
                # was spent working or spinning.
                _log_event("run.attempt", id=task.id, attempt=attempts, stop_reason="wall_clock",
                           requests=a_reqs, tokens=a_toks, out_chars=len(stdout or ""),
                           text_sha=_text_sha(stdout),
                           structural=last_structural, structural_kind=_structural_kind(last_structural),
                           returncode=ret)
                continue
            if acp_stop == "early_exit":
                # We deliberately cancelled BECAUSE _verify() already confirmed success — a killed/nonzero
                # `ret` and partial `stdout` here are EXPECTED, not failure signals. Skip _detect_run_failure
                # entirely (it would misread both) and go straight to selection below.
                last_structural = None
                _metric_inc("agent_early_exit_total")
                # Tokens spent on THIS attempt at the moment of the kill — not a live "tokens saved" figure
                # (we have no same-task historical baseline to diff against in-process), but logged so one
                # can be computed offline by comparing against typical full-run token counts for similar tasks.
                _log_event("run.early_exit", id=task.id, attempt=attempts, tokens=a_toks, requests=a_reqs)
            else:
                # Honest success for THIS attempt: Hermes' exit 0 is NOT trusted (gateway cap + marker scan).
                last_structural = _detect_run_failure(_teardown_exit(ret, acp_stop), stdout or "", stderr or "",
                                                      nonce is not None, a_reqs, cap_hit)
            # ACP-native stop reasons the stdout marker-scan can't see (there's no prose channel): a model
            # refusal or a Hermes-side cap. The gateway cap_hit stays authoritative for spend/step throttling.
            if not last_structural and acp_stop in ("refusal", "max_tokens", "max_turn_requests"):
                last_structural = f"agent stopped: {acp_stop}"
            # A spec-less chat turn (task._verify_spec is None — no expect_file/check_cmd to derive one
            # from) that fired zero tool calls gets an unconditional accept downstream (CUR-766):
            # _select_attempt's `grounded` check is False whenever spec is None, so exec_ok defaults
            # True and the judge is never called at all. Without this check, best_of's retry capacity
            # is unreachable for this class of turn — attempt 1 is final even if the model just
            # described what it would do instead of doing it. Mechanical (tool-count, not content):
            # doesn't touch the judge or its grounding rule, and doesn't fire when a spec exists
            # (that path already gets the judge/verify treatment it needs). Also excludes early_exit:
            # that stop reason only fires when a spec DID exist and _verify() already confirmed success
            # (see the early_exit branch above) — a killed attempt there with empty tool_kinds was never
            # ungrounded, it just never got a chance to touch a tool before the confirmed-good result
            # cancelled it.
            #
            # This check alone can't tell "described but didn't do" apart from "correctly needed no
            # tool": a plain greeting under forced agentMode:on hits every precondition above and would
            # exhaust best-of-N into FAILED (CUR-940). `auto` doesn't have this problem: the client
            # already asks _classify_agentic's /route question before a turn ever
            # reaches here, and only sends agentic:true turns into _run at all. Forced `on` skips that
            # gate entirely (its whole point is guaranteeing every turn reaches the agent backend, not
            # guaranteeing every turn calls a tool — see agentMode.ts's own "on" comment). Ask the same
            # question here, lazily, only once every other precondition already holds — the memo cache
            # (_classify_agentic keys on a prompt hash) makes this free for a turn `auto` already
            # classified, and one real call for a forced-`on` turn that was never asked. Fails open to
            # agentic:False on any router/gateway trouble, same as everywhere else `_classify_agentic` is
            # used, so a degraded classifier never blocks the turn; the turn is then accepted as before.
            #
            # The same holds for an honest refusal ("I cannot send emails"), which retrying cannot change
            # (CUR-4599). `_no_tool_check` asks what the reply is and retries only a skipped or narrated
            # one; see no_tool_review.py.
            task._no_tool_answer = ""
            if not last_structural:
                last_structural, task._no_tool_answer = _no_tool_check(
                    task.prompt, stdout or "", use_acp=use_acp, acp_stop=acp_stop,
                    spec_less=task._verify_spec is None, tool_kinds=tool_kinds,
                    classify=lambda p: _classify_agentic(p)["agentic"],
                    review=lambda body, n=nonce: _no_tool_review_call(n, task.id, body))
            # Every attempt's outcome, whatever it was, so an attempt that ended
            # `end_turn` after ONE model call having written nothing is distinguishable in the log from any
            # other failed verification. `requests` is the datum that separates "tried and got it wrong" from
            # "stopped before starting"; without it the retry loop looks like patience rather than a spin.
            _log_event("run.attempt", id=task.id, attempt=attempts, stop_reason=acp_stop or "",
                       requests=a_reqs, tokens=a_toks, out_chars=len(stdout or ""),
                       text_sha=_text_sha(stdout),
                       structural=last_structural or "", structural_kind=_structural_kind(last_structural),
                       returncode=ret)
            if last_structural:
                # Discarding a structurally failed attempt on the spot is right when the agent never ran,
                # and wrong when it ran for a dozen turns and got throttled on the last one: the files it
                # left are either correct or they aren't, and the check that settles it costs one
                # subprocess and no model call. Long-horizon tasks hit this, most after a dozen or
                # more model calls. _reset_scratch wipes the workdir on the
                # next iteration, so this is the last moment the artifacts exist.
                # Deterministic artifact specs only: the judge needs a fresh gateway grant, and a spend
                # cap is a poor reason to spend more. An attempt salvaged here is `execution`-verified by
                # exactly the check every other attempt faces, so it is not a weaker kind of pass.
                salvaged, salvage_detail = _salvage_structural_failure(
                    task, work=ws, stdout=stdout, stderr=stderr, nonce=nonce,
                    last_structural=last_structural, attempts=attempts,
                    consistency_active=consistency_active, consistency_samples=consistency_samples)
                if salvaged:
                    last_structural = None             # the run produced the artifact; report no failure
                    if consistency_active and attempts < best_of:
                        continue                       # keep sampling — the vote wants more than one
                    break
                if salvage_detail:                     # the check ran and refused; hand its words forward
                    last_verify_detail = salvage_detail
                _backoff_before_retry(task, last_structural, attempts, best_of)
                continue                               # structural failure → try another attempt
            # Selection: independent _verify of the artifact decides, then (chat turns) the judge. The
            # per-attempt grant above was already revoked by this point (S3) — the judge call needs its
            # OWN live grant on the same nonce, or it 401s and _judge_result fails closed on every call
            # (silently burning all best_of attempts for zero benefit). Mirrors the pre-loop derive grant.
            if may_judge and nonce:
                try:
                    _gateway_grant(nonce, 1, JUDGE_MAX_TOKENS, label=f"{task.id}:judge")
                except Exception:  # noqa: BLE001 — judge call fails closed anyway if the grant didn't take
                    pass
            accepted, vmethod, reason = _select_attempt(
                task.prompt, ws, (stdout or "").strip(), task._verify_spec, may_judge, _judge_call,
                spec_autoderived=task._verify_autoderived)
            reason = _scrub(reason, nonce)             # may be check output from inside the sandbox
            last_judge_reason = reason
            # Keep the reason on a PASS as well: a verdict with its
            # grounds attached is checkable, a bare "verified" is not.
            task.judge_reason = reason
            task.verify_check = _spec_fields(task._verify_spec)
            if may_judge and nonce:
                j_reqs, j_toks, _ju, _jc = _gateway_revoke(nonce)
                reqs += j_reqs; toks += j_toks
            # For the verify corpus (CUR-654), independent of whether the judge went on to overrule an
            # auto-derived spec's failure (_select_attempt's authority rules): did the deterministic shape
            # check itself catch something on THIS attempt. Re-running _verify is redundant with the one
            # _select_attempt already did, but it keeps that function's authority logic untouched for a
            # diagnostic-only need.
            _log_tier1_corpus(task, ws, stdout, nonce)
            if accepted:
                last_verify_detail = ""    # this attempt had no complaint — an EARLIER attempt's stale
                                            # rejection reason must not misroute a LATER one into repair
                                            # against output that is actually fine (only the rejected
                                            # branch below should ever set this)
                _record_accepted_attempt(
                    task, work=ws, stdout=stdout, stderr=stderr, vmethod=vmethod,
                    consistency_active=consistency_active, consistency_samples=consistency_samples)
                if consistency_active and attempts < best_of:
                    continue               # keep sampling — the vote wants more than one draw
                break
            # rejected (spec present, artifact missing/wrong) — leave last_structural None (the run was
            # clean) and retry; the tail decides FAILED-vs-honest-unverified from explicit-vs-autoderived.
            # Record WHY this attempt lost. A turn where the judge rejected twice before the third passed
            # is otherwise indistinguishable from one that passed immediately, and the difference says
            # more about whether the system is working than any badge does.
            reason = _scrub(reason, nonce)             # `reason` may be check output; see _scrub
            task.attempt_rejections.append(reason or "rejected (no reason given)")
            # Fired the MOMENT an attempt is rejected, not inferred later from a rising `attempt`
            # number on the next token frame. This rejection path has no artificial backoff (that's the
            # structural-failure branch above, a different case) — but the next attempt still needs a
            # real model call before its first token arrives, and a client with no earlier signal shows
            # the rejected attempt's stale prose for that whole gap. No new requirement on the client:
            # every `token`/`token_truncated` frame already carries `attempt` (acp_client._AgentClient,
            # constructed fresh per attempt), so a client that keys its rendered-answer buffer by
            # `attempt` and clears it on this event, or on any token frame whose `attempt` exceeds what
            # it has rendered, never shows a retracted attempt's text as final. (CUR-767)
            if buf is not None:
                buf.emit("attempt_rejected", {"attempt": attempts, "reason": reason or "rejected"})
            # Only an EXECUTION verdict is repair material. A judge rejection is prose about an answer,
            # and `vmethod` is None on every rejection so it can't be used to tell them apart — the spec
            # is what says whether `reason` came from _verify or from the model.
            last_verify_detail = reason if (task._verify_spec is not None and not may_judge) else ""
        # Pick which verified sample actually WON (CUR-596), then restore work/stdout/stderr/
        # verified/verify_method/judge_reason/unrun_detail to match it TOGETHER, from that one winner —
        # never left as whatever the loop's own literal final iteration happened to set (that iteration
        # can be a LATER attempt that failed, or one whose value lost the vote). A strict majority wins
        # when one exists (_majority_signature). Getting the WINNER right, not just detecting
        # disagreement, is the point: always serving consistency_samples[-1] regardless of which value the
        # majority held would give the false-success shape this feature exists to prevent: verified=True,
        # no caveat, wrong file served.
        #
        # Fallback when there's no majority: prefer the LAST sample with an actually-computed, readable
        # signature over the literal last-in-list sample — without that check, a sample whose OWN sig was None
        # (a judge-overruled accept, or a transient read failure) could be crowned the winner over a
        # genuinely-confirmed-but-losing sample, giving the same false-success shape. Only when EVERY sample has
        # sig=None (nothing readable was ever confirmed) does the literal last one serve as the answer —
        # there is nothing better to prefer at that point.
        #
        # Gated on `not task._canceled`: mutating task.verified/work/stdout here and THEN discovering the
        # task was canceled would leave a CANCELED task's fields looking like it had completed — a race
        # window that grows every time sampling continues into another full attempt. Cleanup of the
        # snapshot temp dirs still runs UNCONDITIONALLY below, canceled or not (on a tmpfs host an
        # abandoned dir is RAM, not disk, recoverable only by process restart).
        _disagreement: str | None = None
        if consistency_active and consistency_samples and not task._canceled:
            _real_sigs = [s["sig"] for s in consistency_samples if s["sig"] is not None]
            _majority_sig, _disagreement = _majority_signature(_real_sigs)
            if _majority_sig is not None:
                _winner = next((s for s in reversed(consistency_samples) if s["sig"] == _majority_sig), None) \
                    or consistency_samples[-1]
            else:
                _winner = next((s for s in reversed(consistency_samples) if s["sig"] is not None), None) \
                    or consistency_samples[-1]
            stdout, stderr = _winner["stdout"], _winner["stderr"]
            # An overruled _select_attempt returns vmethod=None (accept-unverified; CUR-744), so a
            # winner picked here can genuinely carry vmethod=None. verify_method is a plain `str` field (Task AND StatusResponse both
            # default ""), never Optional — an unguarded None here sets it anyway (Task is a dataclass, no
            # assignment-time check) and only surfaces as a pydantic ValidationError later, on the next
            # GET /run/{id}. Mirror the single-sample path's own guard (line ~4567) instead: only claim
            # verified when the winner actually carries a method.
            task.verified, task.verify_method = (_winner["vmethod"] is not None), (_winner["vmethod"] or "")
            task.judge_reason = _winner["judge_reason"]
            task.unrun_detail = _winner["unrun_detail"]
            _restore_scratch(ws, _winner["snapshot"])
            # Tier 2: every candidate genuinely ran and independently verified — they just didn't agree
            # on the computed value, so none of them can be trusted over the others. Shares
            # task.unrun_detail's wire contract on purpose (the frontend gate is "any non-empty value",
            # not this specific prefix) rather than inventing a second caveat field the client has to
            # also check. Logs EVERY sample, not just the winner — a single row would show only one side
            # of what the attempts disagreed about, and the point of a disagreement-labeled training row
            # is the disagreement itself (CUR-654 needs to see what different attempts computed, not just
            # which one this task happened to serve). Read from each sample's OWN snapshot dir, not the
            # now-restored `work` (which only ever reflects the winner) — done before the cleanup loop
            # below deletes those directories.
            if _disagreement:
                task.unrun_detail = f"{VALUE_DISAGREEMENT_PREFIX}{_disagreement}"
                _metric_inc("agent_value_disagreement_total")
                for _s in consistency_samples:
                    try:
                        store.log_corpus(
                            task.id, "tier2", "value_disagreement", task.prompt,
                            _corpus_snapshot_text(_s["snapshot"], nonce),
                            _truncate_utf8(_scrub((_s["stdout"] or "").strip(), nonce), CORPUS_SNAPSHOT_MAX_BYTES),
                            _scrub(_disagreement[:2000], nonce))
                    except Exception as e:  # noqa: BLE001 — must not break a turn, but must not vanish either
                        _log_event("corpus.log_failed", id=task.id, tier="tier2", error=type(e).__name__)
        for _s in consistency_samples:                    # snapshots are scratch for this decision only —
            _drop_snapshot(_s["snapshot"])  # cleaned up unconditionally, canceled or not
        if task._canceled:                             # cancel landed mid-loop (checked top + post-run)
            task.summary = task.summary or "canceled"
            return
        # The nonce is idle from here — the per-attempt revokes already ran. Set BEFORE the call, not
        # inside it: moderation below can raise, and the `finally`'s belt-and-braces revoke must not
        # double-count a grant that is already settled.
        revoked = True
        # Computed HERE, not inside _finalize_run: the handlers below report it alongside a moderation
        # block, and moderation runs inside that call — so a `fail` decided in there is gone on the one
        # path that needs it. See _finalize_run's docstring.
        fail = _failure_reason(
            hard_spec=(task._verify_spec is not None and not task._verify_autoderived),
            verified=task.verified, last_structural=last_structural,
            attempts=attempts, best_of=best_of, rejections=task.attempt_rejections)
        _finalize_run(
            task, work=ws, stdout=stdout, stderr=stderr, fail=fail,
            attempts=attempts, best_of=best_of, turn_start_wall=turn_start_wall,
            last_judge_reason=last_judge_reason)
    except HTTPException as e:                              # moderation block on output
        # CUR-855/846: `fail` carries this turn's structural failure whenever there was one — it is
        # decided before moderation ever runs. Keep that diagnostic primary: the content is withheld
        # either way (task.result is never reached on this path), so replacing an informative
        # structural reason with a bare moderation message would be a pure loss of information on a
        # turn that was already going to report FAILED.
        _structural = fail
        task.error = f"{_structural} (output also blocked by moderation: {e.detail})" if _structural else str(e.detail)
        task.summary, task.state = "failed: moderation", State.FAILED
    except Exception as e:                                 # noqa: BLE001 — never crash the worker
        _structural = fail
        task.error = (f"{_structural} (also hit {type(e).__name__}: {e})" if _structural
                      else f"{type(e).__name__}: {e}")
        task.summary, task.state = "failed: internal", State.FAILED
    finally:
        # CUR-596 item 2 safety net: the loop's own inline cleanup (right after the best-of-N loop) covers
        # the normal exit path, but an early `return` mid-loop (a per-attempt gateway-grant failure, a
        # moderation HTTPException, any of this function's other early exits) would skip straight past it,
        # leaking the snapshot temp dir it made. `locals().get` rather than a bare reference: this variable
        # may not exist yet if an even earlier guard returned before it was assigned.
        for _s in locals().get("consistency_samples", None) or []:
            _drop_snapshot(_s.get("snapshot", ""))
        # FIRST in the finally: the scratch is about to be rmtree'd, and a watchdog still walking it would
        # race the delete and could kill a task that had already finished.
        _scratch_stop.set()
        # The kill lands as a generic subprocess death, so without this the task reports something
        # unhelpful about exit codes and the operator never learns a ration fired. It has to OVERRIDE a
        # failure already recorded, not defer to one: guarding on `state not in _TERMINAL`
        # never fires, because _detect_run_failure has already classified the kill as
        # `hermes exit None` by the time the finally runs. The generic classifier is describing the
        # symptom; the watchdog knows the cause. A user cancel still wins — that one really is the cause.
        if task._scratch_exceeded and not task._canceled and task.state != State.COMPLETED:
            task.error = (f"scratch exceeded its ration: {task._scratch_exceeded} bytes on disk against a "
                          f"{SCRATCH_MAX_BYTES} byte cap (AGENT_SCRATCH_MAX_BYTES)")
            task.summary, task.state = "failed: scratch ration", State.FAILED
        if nonce and not revoked:                          # ensure the nonce is always revoked
            # ACCUMULATE, never assign: assigning would silently zero the ledger on every path that
            # leaves the loop early — the cancel `return` and any exception both skip `revoked = True`,
            # and by then the per-attempt revokes have already consumed the grants, so this call returns
            # (0, 0) and an assignment would throw away everything the attempts had spent, recording zero
            # tokens for a canceled task against a real bill.
            f_reqs, f_toks, f_usage, f_cap = _gateway_revoke(nonce)
            reqs += f_reqs; toks += f_toks
            usage_seen = usage_seen or f_usage
            cap_hit = cap_hit or f_cap
        task.model_calls, task.tokens = reqs, toks         # persisted: feeds the durable record + per-user spend ledger
        if nonce and task.summary:                         # fold the metered tally into the op-log
            note = "" if (usage_seen or not task._max_tokens) else " (spend-cap inert: no usage from upstream)"
            task.summary += f" | {reqs} model calls, {toks} tok{note}"
        _persist(task)                                     # durable final record (state + result + spend) — survives restart
        _metrics_record(task)                              # observability counters (brief §6B.5)
        if buf is not None:                                # final live-stream frames, then close (kept briefly for replay)
            buf.emit("usage", {"tokens": task.tokens, "steps": task.model_calls})
            buf.emit("done", _done_payload(task))
            buf.close()
        if KEEP_WORKDIR:                                   # diagnostic retention (harness only — see KEEP_WORKDIR)
            _log_event("run.workdir_kept", id=task.id, path=work, state=str(task.state))
        elif task._session_id:                             # CUR-196: persists across turns; only the idle reaper deletes this
            pass
        else:
            shutil.rmtree(work, ignore_errors=True)        # discard scratch + raw log (retention by construction)
        task._workdir = None
        if task._sbx is not None:                          # CUR-4482: the conversation's sandbox takes its next task
            _release_sandbox(task)
        _release_user(task.user, task._max_tokens)         # free the per-user in-flight reservation
        _release_slot()                                    # free the concurrency slot acquired in /run
        if task._webhook_url:                              # push delivery OFF-THREAD so a slow URL can't hold the slot
            threading.Thread(target=_deliver_webhook, args=(task,), daemon=True).start()


def _connect_agent_sandbox(task: Task, buf) -> Handle | None:
    """Hold the conversation's sandbox for this task, or fail the task and say why. The mark is taken before the
    sandbox resumes: a stopped task still pausing it would otherwise pause the sandbox this task just resumed.

    On a full host connect waits for a slot (CUR-4584): the event stream says "waiting_sandbox" with the text chat
    shows as the turn's live line, then "working" again once a slot is found. A cancel ends the wait."""
    conversation = f"agent:{task._session_id or task.id}"
    busy_key = key_for(task.user, conversation)
    if not _claim_remote(busy_key, REMOTE_BUSY_WAIT_SECS):
        task.error, task.summary, task.state = ("another task is running in this conversation",
                                                "failed: sandbox busy", State.FAILED)
        return None
    waited: list[str] = []

    def _waiting(text: str) -> None:
        waited.append(text)
        if buf is not None:
            buf.emit("state", {"task_id": task.id, "state": "waiting_sandbox", "text": text})
    try:
        task._sbx = SANDBOX_BACKEND.connect(task.user, conversation, Tier.AGENT,
                                            on_wait=_waiting, cancelled=lambda: task._canceled)
    except SandboxBusy as e:  # CUR-4484: the host is full; say so rather than a generic failure
        _unclaim_remote(busy_key)
        if not task._canceled:  # a cancel during the wait already set its state
            task.error, task.summary, task.state = str(e), "failed: sandbox busy", State.FAILED
        return None
    except Exception as e:  # noqa: BLE001 — any connect failure means the same thing: no place to run
        _unclaim_remote(busy_key)
        task.error, task.summary, task.state = (f"sandbox unavailable ({type(e).__name__})",
                                                "failed: sandbox", State.FAILED)
        return None
    if waited and buf is not None:
        buf.emit("state", {"task_id": task.id, "state": "working"})
    return task._sbx


def _release_sandbox(task: Task) -> None:
    """Pause the task's sandbox, then let the conversation's next task have it (CUR-4503). A running E2B sandbox
    holds its whole guest memory from the host's hugepage pool until its idle timeout, so ten finished tasks in
    ten minutes would fill the host; a paused one frees it, and the next task's connect resumes it with its
    files. A failed pause is logged and the mark still clears, since the idle timeout pauses it anyway."""
    sbx = task._sbx
    if sbx is None:
        return
    try:
        SANDBOX_BACKEND.pause(sbx)
    except Exception as e:  # noqa: BLE001 — any failure here leaves the sandbox to its idle timeout
        _log_event("sandbox.pause_failed", id=task.id, error=type(e).__name__, detail=str(e)[:300])
    finally:
        _unclaim_remote(sbx.key)


# ---- API ---------------------------------------------------------------------------------
_PRUNER_STOP = threading.Event()


def _pruner_loop() -> None:
    """Background retention sweep: bound the durable store (the live table is capped; the DB wasn't)."""
    while not _PRUNER_STOP.wait(RETENTION_SWEEP_SECS):
        # This thread also starts when CORPUS_RETENTION_SECS>0 even if TASK_RETENTION_SECS is "0" (keep
        # forever); without this guard, every tick would call store.prune(0), whose cutoff is
        # time.time()-0 == now, deleting all terminal task history every RETENTION_SWEEP_SECS, against an
        # operator's explicit "keep forever" choice (CUR-596).
        if TASK_RETENTION_SECS > 0:
            try:
                d = store.prune(TASK_RETENTION_SECS)
                if d:
                    _log_event("store.pruned", deleted=d, older_than_s=TASK_RETENTION_SECS)
            except Exception as e:  # noqa: BLE001
                _log_event("store.prune_failed", error=type(e).__name__)
        if CORPUS_RETENTION_SECS > 0:
            try:
                dc = store.prune_corpus(CORPUS_RETENTION_SECS)
                if dc:
                    _log_event("store.corpus_pruned", deleted=dc, older_than_s=CORPUS_RETENTION_SECS)
            except Exception as e:  # noqa: BLE001
                _log_event("store.corpus_prune_failed", error=type(e).__name__)


_STUCK_TASK_SWEEP_SECS = int(os.environ.get("AGENT_STUCK_TASK_SWEEP_SECS", "60"))  # cadence of the orphan sweep


def _reap_stuck_tasks() -> int:
    """CUR-1310: a task whose `_RUN_START` entry is already gone has had its worker thread exit — the
    same `finally` in `_run` that pops `_RUN_START` also releases the concurrency slot and records the
    outcome via `_metrics_record` — so `_inflight` and every other resource this task held are already
    correctly freed. If `task.state` is STILL not in `_TERMINAL` at that point, nothing is ever coming
    back to finish it: every reachable path through `_run` sets a terminal state before that `finally`
    runs (`_finalize_run` always does, on every branch; every early `return` in `_run` itself follows an
    explicit terminal assignment). This function only finds work when that invariant breaks, or when a
    restart drops `_RUN_START` (in-memory only) for a task the boot-time `store.recover_orphans()` sweep
    didn't reach. Either way `state` is the only thing stale — mark it FAILED so `tasks_live` (`/healthz`)
    stops counting it as live and a caller polling this task's status gets an honest terminal answer
    instead of AWAITING_CONFIRMATION or WORKING forever."""
    with _TASKS_LOCK:
        stuck = [t for t in TASKS.values() if t.state not in _TERMINAL and t.id not in _RUN_START]
    reaped: list[Task] = []
    for t in stuck:
        # Re-check immediately before writing: the snapshot above is taken once, up front, but a
        # concurrent DELETE /run/{id} can set state=CANCELED synchronously (on the HTTP thread, per
        # its own comment) at any point after that snapshot and before this loop reaches this task —
        # without this guard that CANCELED write would be silently overwritten by the FAILED below,
        # which would lose a caller's real cancel, not the orphan case this exists for.
        if t.state in _TERMINAL:
            continue
        t.error = t.error or "orphaned: worker thread exited without a terminal state"
        t.summary, t.state = "failed: orphaned", State.FAILED
        _persist(t)
        reaped.append(t)
    stuck = reaped
    if stuck:
        _log_event("run.reaped_orphan", count=len(stuck), ids=[t.id for t in stuck])
        # The log line and /healthz's tasks_stuck both go quiet again within one 60s sweep —
        # this is the only durable trace that a leak happened at all. (CUR-1320)
        _metric_inc("agent_run_reaped_orphan_total", len(stuck))
    return len(stuck)


_STUCK_TASK_REAPER_STOP = threading.Event()


def _stuck_task_reaper_loop() -> None:
    """Same shape as _session_reaper_loop — its own short cadence, not folded into _pruner_loop's hourly
    one: an orphan inflating tasks_live for up to an hour before the next sweep is exactly the failure
    this is meant to bound, and unlike the pruner this needs no retention config to be worth running."""
    while not _STUCK_TASK_REAPER_STOP.wait(_STUCK_TASK_SWEEP_SECS):
        try:
            _reap_stuck_tasks()
        except Exception as e:  # noqa: BLE001
            _log_event("run.reap_failed", error=type(e).__name__)


# A server that has stopped answering never exits, and an exit is the only thing Fly's on-failure
# policy restarts on. This thread asks the server for its own /healthz over localhost, the path a request
# from Fly's proxy takes, and exits the process after WATCHDOG_MISSES misses in a row. Running tasks die
# with it; on restart `recover_orphans` marks them failed, which is what they already were. A freeze of
# the whole process stops this thread too, so that case is left to the service check in agent-app.toml,
# which takes the machine out of routing but does not restart it. On by default on Fly only: off Fly
# nothing restarts the process, so an exit would just stop it. (CUR-4406)
WATCHDOG_SECS = int(os.environ.get("AGENT_WATCHDOG_SECS", "20" if FLY_MACHINE_ID else "0") or 0)
WATCHDOG_MISSES = 3
WATCHDOG_TIMEOUT_SECS = 10.0
WATCHDOG_URL = "http://127.0.0.1:8731/healthz"   # deploy/Dockerfile's CMD port
_WATCHDOG_STOP = threading.Event()


def _watchdog_probe() -> bool:
    import httpx
    try:
        return httpx.get(WATCHDOG_URL, timeout=WATCHDOG_TIMEOUT_SECS).status_code == 200
    except Exception:  # noqa: BLE001 — a refused or timed-out probe is the miss being counted
        return False


def _watchdog_loop(probe: Callable[[], bool] = _watchdog_probe, exit_: Callable[[int], object] = os._exit,
                   stop: threading.Event = _WATCHDOG_STOP) -> None:
    misses = 0
    while not stop.wait(WATCHDOG_SECS):
        if probe():
            misses = 0
            continue
        misses += 1
        _log_event("watchdog.miss", misses=misses, of=WATCHDOG_MISSES)
        if misses >= WATCHDOG_MISSES:
            _log_event("watchdog.exit", misses=misses, interval_s=WATCHDOG_SECS)
            exit_(1)
            return


_SESSION_REAPER_STOP = threading.Event()


def _forget_sandboxes(principal: str, session_id: str) -> int:
    """Kill a conversation's sandboxes, its run-code one and its agent one (CUR-4484). Never raises: a
    deleted conversation is gone from chat whether or not the sandbox host answered, and the idle sweep
    catches whatever this missed."""
    killed = 0
    for conversation in (session_id, f"agent:{session_id}"):
        try:
            killed += SANDBOX_BACKEND.destroy(principal, conversation)
        except Exception as e:  # noqa: BLE001
            _log_event("sandbox.destroy_failed", error=type(e).__name__)
    return killed


def _session_reaper_loop() -> None:
    """CUR-196: idle-expire session workdirs. Same shape as _pruner_loop, sole owner of session-workdir
    lifecycle (see the exemption in _sweep_stale_scratch) — an hours-scale clock, not days."""
    while not _SESSION_REAPER_STOP.wait(SESSION_SWEEP_SECS):
        try:
            expired = store.prune_idle_sessions(SESSION_IDLE_SECS)
            for _user, _sid, wd in expired:
                shutil.rmtree(wd, ignore_errors=True)
            if expired:
                _log_event("session.reaped", count=len(expired), older_than_s=SESSION_IDLE_SECS)
        except Exception as e:  # noqa: BLE001
            _log_event("session.reap_failed", error=type(e).__name__)
        _sweep_sandboxes()


def _sweep_sandboxes() -> list[str]:
    """One idle pass over the sandbox host (CUR-4484): a sandbox unused for SESSION_IDLE_SECS is killed, files
    and all, the same limit a local session workdir has. A run-code sandbox has no session row, so this
    reads the host's own timestamps rather than the store."""
    try:
        killed = SANDBOX_BACKEND.sweep(SESSION_IDLE_SECS)
    except Exception as e:  # noqa: BLE001
        _log_event("sandbox.sweep_failed", error=type(e).__name__)
        return []
    if killed:
        _log_event("sandbox.reaped", count=len(killed), older_than_s=SESSION_IDLE_SECS)
    return killed


def _sandbox_pool_tick() -> dict[int, int]:
    """One reading of the sandbox hosts' load (CUR-4553): a `sandbox.pool` line per host that answered, with its
    running sandboxes and E2B_SLOT_CAPACITY, which the pool alert reads. A bwrap backend has no hosts."""
    try:
        load = SANDBOX_BACKEND.pool_load()
    except Exception as e:  # noqa: BLE001
        _log_event("sandbox.pool_failed", error=type(e).__name__)
        return {}
    for slot, running in load.items():
        _log_event("sandbox.pool", fly_app=os.environ.get("FLY_APP_NAME", ""), slot=slot, running=running,
                   capacity=E2B_SLOT_CAPACITY)
    return load


_SANDBOX_POOL_STOP = threading.Event()


def _sandbox_pool_loop() -> None:
    while not _SANDBOX_POOL_STOP.wait(SANDBOX_POOL_SECS):
        _sandbox_pool_tick()


def _lease_tick(now: float | None = None) -> None:
    """One pass of the shared-store upkeep (CUR-4443): renew this machine's leases, stop the tasks another
    machine asked to cancel, and end other machines' tasks whose lease lapsed."""
    now = time.time() if now is None else now
    with _TASKS_LOCK:
        mine = [tid for tid, t in TASKS.items() if t.state not in _TERMINAL]
    for tid in store.renew_leases(OWNER_ID, mine, now + LEASE_SECS):
        with _TASKS_LOCK:
            t = TASKS.get(tid)
        if t is not None and t.state not in _TERMINAL:
            # Another machine failed it while our lease had lapsed; take its verdict and stop spending.
            rec = store.get(tid) or {}
            _stop_local(t)
            t.state, t.error, t.summary = State.FAILED, rec.get("error"), rec.get("summary")
            _log_event("run.ended_elsewhere", task_id=tid)
    for tid in store.cancels_for(mine):
        with _TASKS_LOCK:
            t = TASKS.get(tid)
        if t is not None and t.state not in _TERMINAL:
            _cancel_local(t)
            _log_event("run.cancel_applied", task_id=tid)
    for row in store.fail_lapsed(now):
        _log_event("run.lease_lapsed", task_id=row["id"], owner=row["owner"])


def _lease_loop() -> None:
    while not _PRUNER_STOP.wait(LEASE_RENEW_SECS):
        try:
            _lease_tick()
        except Exception as e:  # noqa: BLE001 — a failed tick retries next pass; leases outlive two misses
            _log_event("run.lease_tick_failed", error=type(e).__name__)


# ---- Drain on the stop signal (CUR-4598) ------------------------------------------------------------
# A deploy replaces this app's one Fly machine in place, and a task's run lives in this process, so a stop
# that does not wait kills every running task and the person reads "The agent stream dropped". The platform sends
# kill_signal, waits kill_timeout (at most 300 s), then stops the machine regardless.
# serve.py hands the first stop signal here instead of straight to uvicorn, which would close the listening
# socket at once. While draining, /run answers 503 with Retry-After and every other route keeps serving,
# so a running task's event stream, its file downloads, a confirm and a cancel all still reach it. Once no
# task is running, or DRAIN_SECS pass, uvicorn is told to exit as usual. A task still running then is ended
# as "interrupted by server restart" and gets its `done` frame, which chat shows as a restart with a retry,
# rather than dying with its stream. After the last task ends the machine keeps serving DRAIN_LINGER_SECS
# more, for the file downloads chat makes after a `done`. DRAIN_SECS + DRAIN_TIDY_SECS + DRAIN_LINGER_SECS +
# serve.py's graceful timeout (250 + 10 + 15 + 10) must stay under kill_timeout (300), or Fly kills the
# process before the interrupted tasks are told.
DRAIN_SECS = float(os.environ.get("AGENT_DRAIN_SECS", "250"))
DRAIN_TIDY_SECS = float(os.environ.get("AGENT_DRAIN_TIDY_SECS", "10"))
DRAIN_LINGER_SECS = float(os.environ.get("AGENT_DRAIN_LINGER_SECS", "15"))
DRAIN_RETRY_AFTER_SECS = int(os.environ.get("AGENT_DRAIN_RETRY_AFTER_SECS", "15"))
# The wording store.recover_orphans writes for a task a restart killed, shared so a task ended by the drain
# and one found orphaned on boot read the same to chat (`interrupted` in _done_payload).
RESTART_ERROR = "interrupted by server restart"
_DRAINING = threading.Event()
_DRAIN_NOW = threading.Event()


def _running_tasks() -> list[Task]:
    with _TASKS_LOCK:
        return [t for t in TASKS.values() if t.state not in _TERMINAL]


def _interrupt_for_restart(t: Task) -> None:
    """End a task the drain could not wait for, the way recover_orphans would after the restart, but while
    its stream is still open: `_run`'s finally then emits the `done` frame naming the restart. A task that
    finished since the drain last looked keeps its own outcome."""
    with _TASKS_LOCK:
        if t.state in _TERMINAL:
            return
        t._canceled = True                             # first, so `_run` keeps this state instead of its own
        t.error, t.summary, t.state = RESTART_ERROR, "failed: server restart", State.FAILED
    _persist(t)
    _stop_local(t)


def begin_drain(then: Callable[[], None]) -> bool:
    """Start draining and call `then` (uvicorn's own exit) once the running tasks are done. Returns False when
    a drain is already under way. Called from a signal handler, so it only sets a flag and starts a thread."""
    if _DRAINING.is_set():
        return False
    _DRAINING.set()
    threading.Thread(target=_drain, args=(then,), daemon=True, name="drain").start()
    return True


def end_drain_now() -> None:
    """A second stop signal: Fly's kill_timeout has run out, so stop waiting and interrupt what is left."""
    _DRAIN_NOW.set()


def _drain(then: Callable[[], None]) -> None:
    started = time.monotonic()
    live = _running_tasks()
    had_tasks = bool(live)
    _log_event("shutdown.drain_started", running=len(live), ids=[t.id for t in live], deadline_secs=DRAIN_SECS)
    while live and not _DRAIN_NOW.is_set() and time.monotonic() - started < DRAIN_SECS:
        _DRAIN_NOW.wait(0.2)
        live = _running_tasks()
    interrupted = [t.id for t in live]
    for t in live:
        _interrupt_for_restart(t)
    # `_run`'s finally emits the interrupted tasks' `done` frames; give it a moment so the streams carry them.
    tidy_until = time.monotonic() + DRAIN_TIDY_SECS
    while interrupted and time.monotonic() < tidy_until:
        if not any(tid in _RUN_START for tid in interrupted):   # _metrics_record pops it just before `done`
            break
        time.sleep(0.1)
    # A finished task's caller still has requests to make: chat copies the task's files out right after its
    # `done` frame (keepAgentFiles), and a reload reattaches. Stay up for them before the listener closes.
    if had_tasks:
        _DRAIN_NOW.wait(DRAIN_LINGER_SECS)
    _log_event("shutdown.drained", waited_secs=round(time.monotonic() - started, 1),
               interrupted=len(interrupted), ids=interrupted)
    then()


def _widen_thread_pool() -> None:
    """Raise the event loop's thread limit to THREADPOOL_TOKENS. Must run on the loop, so the lifespan calls it."""
    import anyio.to_thread
    anyio.to_thread.current_default_thread_limiter().total_tokens = max(1, THREADPOOL_TOKENS)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Startup: recover orphans (tasks left non-terminal by a crash → FAILED), sweep abandoned scratch,
    prune old rows, start the retention pruner. Shutdown: stop the pruner, reap still-running agent process
    groups (each runs in its own session, so killing uvicorn alone leaves them — and their spend — alive),
    close the store."""
    _widen_thread_pool()
    n = store.recover_orphans(OWNER_ID)
    if n:
        _log_event("startup.recovered_orphans", count=n)
    if store.shared:
        threading.Thread(target=_lease_loop, daemon=True).start()  # CUR-4443
    freed, bytes_freed = _sweep_stale_scratch()
    if freed:
        _log_event("startup.swept_stale_scratch", dirs=freed, bytes=bytes_freed)
    # Off the request path: a 3s connect must not delay readiness, and the answer is the same a second
    # later. Logged as well as reported, so a change in the egress verdict is findable after the fact rather than
    # only visible to whoever happens to curl /healthz.
    threading.Thread(target=_egress_selftest, daemon=True).start()
    threading.Thread(target=_dns_selftest, daemon=True).start()
    _permission_selftest()                             # pure + local; no reason to defer it to a thread
    _compute_provider_refresh()                         # immediate reading on boot, same shape as store.prune below
    compute_provider_refresher = threading.Thread(target=_compute_provider_refresh_loop, daemon=True)
    compute_provider_refresher.start()
    pruner = None
    # The pruner thread also sweeps verify_corpus (_pruner_loop) — gating its startup on
    # TASK_RETENTION_SECS alone would silently leave the corpus unpruned forever on a deploy that has
    # disabled task retention ("keep forever") but left corpus retention on, or vice versa. (CUR-596)
    if TASK_RETENTION_SECS > 0 or CORPUS_RETENTION_SECS > 0:
        if TASK_RETENTION_SECS > 0:
            store.prune(TASK_RETENTION_SECS)           # immediate sweep on boot
        if CORPUS_RETENTION_SECS > 0:
            store.prune_corpus(CORPUS_RETENTION_SECS)  # immediate sweep on boot
        pruner = threading.Thread(target=_pruner_loop, daemon=True)
        pruner.start()
    session_reaper = threading.Thread(target=_session_reaper_loop, daemon=True)  # CUR-196
    session_reaper.start()
    stuck_task_reaper = threading.Thread(target=_stuck_task_reaper_loop, daemon=True)  # CUR-1310
    stuck_task_reaper.start()
    if SANDBOX_POOL_SECS > 0 and SANDBOX_BACKEND.name == "e2b":
        threading.Thread(target=_sandbox_pool_loop, daemon=True).start()  # CUR-4553
    if WATCHDOG_SECS > 0:
        threading.Thread(target=_watchdog_loop, daemon=True).start()  # CUR-4406
    # A mounted Starlette app's own lifespan never runs, so the sandbox MCP transport's task group is
    # entered here (CUR-4232).
    async with _SANDBOX_MCP.session_manager.run():
        yield
    _PRUNER_STOP.set()
    _SESSION_REAPER_STOP.set()
    _SANDBOX_POOL_STOP.set()
    _STUCK_TASK_REAPER_STOP.set()
    _WATCHDOG_STOP.set()
    _COMPUTE_PROVIDER_REFRESH_STOP.set()
    with _TASKS_LOCK:
        live = [t._proc for t in TASKS.values() if t._proc is not None]
    for p in live:
        _kill_process_group(p)
    store.close()


app = FastAPI(title="Public AI Agent Service", version="0.5.0", lifespan=_lifespan)


class VerifySpec(BaseModel):
    """Optional, deterministic success contract checked AFTER the agent (and without it). Supply either
    expect_file (+ optional expect_contains) — the safe declarative path — or check_cmd as an escape hatch."""
    expect_file: str | None = None       # path (relative to the task sandbox) that must exist
    expect_contains: str | None = None   # substring expect_file must contain (requires expect_file)
    expect_lines: int | None = None      # exact count of NON-EMPTY lines expect_file must have (requires expect_file).
    #                                      # Deterministic quantity check — catches off-by-one (19 vs 20) that an
    #                                      # LLM judge eyeballs past. The cheapest, strongest verifier for "N per line".
    expect_count: int | None = None      # exact count of delimiter-separated items the ANSWER TEXT must contain.
    expect_sep: str = ","                #   The INLINE analog of expect_lines — for "list N X, comma-separated"
    #                                      # turns where the items are in the reply, not a file. Counts non-empty
    #                                      # items after split(expect_sep). LLM judges (any) eyeball long-sequence
    #                                      # counts past; code counts exactly.
    expect_sorted_by: str | None = None  # column name in expect_file (comma-delimited) that must be monotonic.
    expect_sorted_desc: bool = False     #   Only meaningful when expect_sorted_by is set (requires expect_file).
    expect_columns: list[str] | None = None  # every name must appear in expect_file's header row (requires
    #                                      # expect_file). Declarative, LLM-free column-presence check (CUR-596) —
    #                                      # exists because check_cmd can't reach production (AGENT_CHECK_CMD_DISABLED).
    check_cmd: str | None = None         # shell check run in the sandbox (scrubbed env); exit 0 = verified


class RunRequest(BaseModel):
    prompt: str
    verify: VerifySpec | None = None     # if set, the agent's self-report never decides success — this does
    max_steps: int | None = Field(default=None, ge=1)   # per-task step-cap override; defaults to AGENT_MAX_STEPS
    max_tokens: int | None = Field(default=None, ge=0)  # per-task spend-cap override (0=off); defaults to AGENT_MAX_TOKENS
    # Per-task wall-clock override, lower-only, defaults to AGENT_WALL_CLOCK_SECS. For callers that will
    # STOP WAITING before the server stops working: a chat client whose watchdog fires at 155s does not
    # want us running to 300, because everything past its deadline is work done for a reader who has
    # already been shown a timeout. The caller knows its own deadline and the server cannot guess it, so
    # the caller states it. See _effective_caps for why this can only tighten.
    wall_clock_secs: int | None = Field(default=None, ge=1)
    webhook_url: str | None = None       # optional: POST the terminal StatusResponse here when the task ends (push delivery, vs poll)
    synthesize: bool = False             # chat surface (Story B): a free-form turn with no verify spec — engages auto-derive + LLM-judge best-of-N gating
    transport: str | None = None         # "oneshot" opts out of the ACP default (see _use_acp); "acp"/None = default
    # opt-in workdir persistence across turns, keyed on (this request's authenticated user,
    # session_id). Absent -> today's behavior exactly (fresh workdir, discarded at turn end). Chat forwards
    # its own conversation id here; bounded like SUBJECT_MAX_CHARS bounds the asserted subject, since this
    # also becomes a store key. (CUR-196)
    session_id: str | None = Field(default=None, max_length=200)
    # True when an earlier turn of this session_id ran an agent task. A machine with no workdir for
    # the session then reports it expired rather than answering from an empty room as if it were new. (CUR-4393)
    continues_session: bool = False
    # "auto" lets acp_client decide in-sandbox edits and reviewed shell/code calls instead of
    # opening a card for each. Chat sends it when the `agent-auto-approve` flag is on for the person. (CUR-3142)
    approval_mode: Literal["ask", "auto"] = "ask"
    # The executor model for this task, as the chat names it (its gateway id, e.g.
    # "mistral-large-2610"). Absent: AGENT_MODEL, as before. Named: run on it, or refuse the task with 422 when
    # the gateway does not route it (`_resolve_task_model`). Never swapped for another model. (CUR-4603)
    model: str | None = Field(default=None, max_length=200)


class RunResponse(BaseModel):
    id: str
    state: State
    # The Fly machine that created this task, or None off Fly. A caller that will make ANY
    # further request naming this task_id (poll, stream, confirm, cancel) should echo it back as the
    # `Fly-Force-Instance-Id` header on that request — see FLY_MACHINE_ID's own comment for why. (CUR-895)
    machine_id: str | None = None


class StatusResponse(BaseModel):
    id: str
    state: State
    result: str | None = None
    result_truncated: bool = False       # True if `result` is only the tail of a larger output
    error: str | None = None
    summary: str | None = None
    verified: bool = False               # True only if an independent check confirmed the result
    verify_method: str = ""              # "execution" | "execution+judge" | "" (unverified). Bare "judge"
                                          # is no longer produced (CUR-744) — see the Task field above.
    # The grounds for that verdict, same fields the SSE done frame carries (_done_payload) — a poller and
    # a streamer must not learn different things about the same task. See _done_payload for why the
    # autoderived bit is load-bearing rather than a footnote.
    verify_autoderived: bool = False     # the spec was derived from the prompt by a model, not supplied
    verify_check: dict = Field(default_factory=dict)   # the assertion actually checked ({} = none)
    judge_reason: str = ""               # the judge's stated reason, on a pass as well as a rejection
    attempt_rejections: list[str] = Field(default_factory=list)  # why each losing attempt lost, in order
    unrun_detail: str = ""               # CUR-574: "" once cleared, else the repair loop's own final
                                          # verdict on this turn — see Task.unrun_detail
    # The agent's files. Its scratch directory is deleted when the turn ends, so this is the only route by
    # which work it describes ("I created revenue_data.csv") reaches the person who asked for it (CUR-195).
    artifacts: list[dict] = Field(default_factory=list)  # [{name, bytes, text|None, truncated}]
    artifacts_dropped: bool = False      # more files existed than the per-turn cap returns
    # True iff a session_id was sent but its prior workdir was gone (reaped or lost) — this turn started
    # fresh instead of continuing (additive/optional, no api bump; CUR-196).
    expired: bool = False
    # True iff this turn reused a PRIOR turn's session workdir (see Task._session_continued). CUR-705:
    # the chat client's honesty caveat needs this to scope its "claimed action, zero tools observed"
    # check to continued sessions only.
    session_continued: bool = False
    # Confirmations currently open (kind/title/summary, redacted — see acp_client's
    # _describe_tool_call). Empty unless ACP_PERMISSION_POLICY=confirm and the task is mid-pause. (CUR-218)
    pending_confirmations: list = Field(default_factory=list)
    model_calls: int = 0                 # gateway-metered model calls this task made
    tokens: int = 0                      # gateway-metered tokens this task spent
    model: str | None = None             # the task's executor model id (provenance — for the "what's running" badge)
    served_models: list[str] = Field(default_factory=list)  # CUR-4603: ids upstream named serving it
    compute_provider: str | None = None  # the compute host the model actually ran on (provenance honesty)
    transport_used: str = ""             # "acp" | "oneshot" | "" (not yet decided, or task predates this field)
    # The caller's trust posture, so a client can say WHY a turn ran on a restricted toolset
    # instead of a silent floor reading as a broken/nerfed agent. "uniform" (with tasks_done/tasks_required
    # null) under any non-"staged" ACP_PERMISSION_POLICY — one caller-trust tier applies to everyone, so
    # there is nothing to disclose; "" only if _run never got far enough to resolve one at all. Read
    # alongside transport_used above: a "new"/"deny_writes"-floor tier only had a real toolset effect
    # under transport_used="acp" — oneshot ignores CUR-217's filtering entirely (see _run's own comment). (CUR-761)
    tier: str = ""
    tasks_done: int | None = None
    tasks_required: int | None = None
    # The machine that answered THIS response — same field/meaning as RunResponse.machine_id.
    # Server-global (this deploy's own machine), not per-task, so a caller pinned to a different machine
    # can tell from a successful response alone that its pin is still holding. (CUR-895)
    machine_id: str | None = None


def _validate_verify(v: VerifySpec | None) -> None:
    """Reject ambiguous/under-specified verify specs up front (exactly one mode; contains needs a file)."""
    if v is None:
        return
    has_file, has_cmd = bool(v.expect_file), bool(v.check_cmd)
    has_count = v.expect_count is not None
    if has_file and has_cmd:
        raise HTTPException(400, "verify: set exactly one of expect_file or check_cmd, not both")
    if has_cmd and has_count:
        raise HTTPException(400, "verify: expect_count is answer-text only — not combinable with check_cmd")
    if not (has_file or has_cmd or has_count):
        raise HTTPException(400, "verify: set expect_file, expect_count, or check_cmd")
    if has_cmd and CHECK_CMD_DISABLED:
        raise HTTPException(400, "verify.check_cmd is disabled on this deployment")
    if v.expect_contains is not None and not has_file:
        raise HTTPException(400, "verify: expect_contains requires expect_file")
    if v.expect_lines is not None and not has_file:
        raise HTTPException(400, "verify: expect_lines requires expect_file")
    if v.expect_sorted_by is not None and not has_file:
        raise HTTPException(400, "verify: expect_sorted_by requires expect_file")
    if v.expect_columns is not None and not has_file:
        raise HTTPException(400, "verify: expect_columns requires expect_file")
    if v.expect_count is not None and not (1 <= v.expect_count <= 100_000):   # `has_count`, narrowed inline
        raise HTTPException(400, "verify: expect_count out of range (1..100000)")


def _validate_transport(t: str | None) -> None:
    if t is not None and t not in ("oneshot", "acp"):
        raise HTTPException(400, 'transport: must be "oneshot", "acp", or omitted')


def _status_of(t: Task) -> StatusResponse:
    """Single source of the status/poll response shape — the chat↔agent CONTRACT response. Keep it here so
    the poll endpoint, the cancel endpoint, AND the webhook all serialize identically (a hand-built dict in the webhook would miss
    the provenance fields). Provenance is server-global today."""
    return StatusResponse(id=t.id, state=t.state, result=t.result, result_truncated=t.result_truncated,
                          error=t.error, summary=t.summary, verified=t.verified, verify_method=t.verify_method,
                          verify_autoderived=t._verify_autoderived, verify_check=t.verify_check,
                          judge_reason=t.judge_reason, attempt_rejections=list(t.attempt_rejections),
                          unrun_detail=t.unrun_detail,
                          artifacts=list(t.artifacts), artifacts_dropped=t.artifacts_dropped,
                          expired=t.session_expired, session_continued=t._session_continued,
                          pending_confirmations=list(t.pending_confirmations),
                          model_calls=t.model_calls, tokens=t.tokens, transport_used=t.transport_used,
                          model=t.model or AGENT_MODEL or None, served_models=list(t.served_models),
                          compute_provider=_effective_compute_provider(),
                          tier=t.tier, tasks_done=t.tasks_done, tasks_required=t.tasks_required,
                          machine_id=FLY_MACHINE_ID)


@app.post("/run", response_model=RunResponse)
def run(req: RunRequest, user: str = Depends(require_user), _account: None = Depends(require_account),
        fly_replay_src: str | None = Header(default=None),
        fly_force_instance_id: str | None = Header(default=None),
        x_agent_subject_daily_tasks: str | None = Header(default=None)) -> RunResponse | Response:
    if _DRAINING.is_set():                                 # CUR-4598: this machine is stopping for a deploy
        _log_event("run.rejected", user=user, reason="draining")
        raise HTTPException(503, "agent service restarting for an update — retry shortly",
                            headers={"Retry-After": str(DRAIN_RETRY_AFTER_SECS)})
    # A conversation's first agent turn starts on its home machine, the one its sandbox calls reach, so
    # the two share a workdir; a follow-up pinned with Fly-Force-Instance-Id is served where it lands.
    replay = _replay_home(req.session_id, _routing_headers(fly_replay_src, fly_force_instance_id), "run")
    if replay is not None:
        return replay
    if not req.prompt.strip():
        raise HTTPException(400, "empty prompt")
    if len(req.prompt) > MAX_PROMPT_CHARS:
        raise HTTPException(413, f"prompt too large (> {MAX_PROMPT_CHARS} chars)")
    if req.webhook_url is not None:
        _validate_webhook_url(req.webhook_url)             # SSRF guard (host must resolve to a public address)
    _validate_verify(req.verify)
    _validate_transport(req.transport)
    task_model = _resolve_task_model(req.model, user)      # CUR-4603: 422 for a model this gateway can't run
    steps, tokens, wall = _effective_caps(req.max_steps, req.max_tokens, req.wall_clock_secs)  # clamp overrides; `tokens` is the worst-case reservation
    _check_user_budget(user, tokens, _subject_daily_tasks(x_agent_subject_daily_tasks))  # per-user budget incl. in-flight reservations (429 if over)
    moderate(req.prompt, "input", user)                    # pre-check the prompt (raises 403 if blocked)
    if req.verify and req.verify.check_cmd:
        moderate(req.verify.check_cmd, STAGE_CHECK_CMD, user)  # own stage — no task yet to attribute the report to
    if not _try_acquire_slot():                            # concurrency cap: bound live procs + aggregate spend
        _metric_inc("agent_runs_rejected_concurrency_total")
        _log_event("run.rejected", user=user, reason="concurrency", limit=MAX_CONCURRENCY)
        # Retry-After says how soon a slot is worth asking for again, so a caller waits that long and
        # resubmits instead of failing the turn (CUR-3893). The daily limits send none: a retry cannot
        # clear them, and their body says so.
        raise HTTPException(429, f"server at capacity ({MAX_CONCURRENCY} concurrent runs) — retry shortly",
                            headers={"Retry-After": str(CAPACITY_RETRY_AFTER_SECS)})
    if not _reserve_user(user, tokens, _subject_live_cap(user)):  # reserve in-flight count + worst-case tokens (released in _run finally)
        _release_slot()
        _metric_inc("agent_runs_rejected_concurrency_total")
        _log_event("run.rejected", user=user, reason="subject_concurrency", limit=SUBJECT_MAX_CONCURRENCY)
        # Worded without "limit reached": chat reads that phrase as a daily limit, which says "tomorrow".
        raise HTTPException(429, f"this visitor already has {SUBJECT_MAX_CONCURRENCY} agent task(s) running"
                                 " — wait for one to finish", headers={"Retry-After": str(CAPACITY_RETRY_AFTER_SECS)})
    task: Task | None = None                               # CUR-1331: unbound until Task() succeeds — guards the except below
    try:
        task = Task(id=uuid.uuid4().hex[:12], prompt=req.prompt, user=user)
        task._verify_spec = req.verify
        task._max_steps, task._max_tokens, task._wall_clock = steps, tokens, wall
        task._caller_wall_clock = req.wall_clock_secs   # what was ASKED, unclamped; None when unstated
        task._webhook_url = req.webhook_url
        task._synthesize = req.synthesize
        task._transport = req.transport
        task._session_id = req.session_id                  # CUR-196
        task._continues_session = bool(req.session_id) and req.continues_session   # CUR-4393
        task._approval_mode = req.approval_mode                                       # CUR-3142
        task.model = task_model                                                       # CUR-4603
        _RUN_START[task.id] = time.monotonic()  # CUR-1330: before _store_task, so the task is never
        # visible in TASKS without a matching _RUN_START entry — closes the orphan-reaper startup race.
        _store_task(task)
        _metric_inc("agent_runs_submitted_total")
        _log_event("run.submitted", id=task.id, user=user, max_steps=steps, max_tokens=tokens, model=task_model)
        threading.Thread(target=_run, args=(task,), daemon=True).start()  # _run releases slot + reservation in its finally
    except Exception:
        _release_slot()                                    # never leak a slot/reservation if launch failed before _run took over
        _release_user(user, tokens)
        # If _store_task already ran (task.id is in TASKS, non-terminal) but the thread never
        # started, popping this restores the orphan signature _reap_stuck_tasks/_healthz already check —
        # without it the task sits in TASKS with a live _RUN_START entry forever, invisible to both. (CUR-1331)
        if task is not None:
            _RUN_START.pop(task.id, None)
        raise
    return RunResponse(id=task.id, state=task.state, machine_id=FLY_MACHINE_ID)


# ---- Agentic router (chat "auto" mode brain) ----------------------------------------------
# The chat's 3-state agent toggle (off / auto / on) asks THIS endpoint, in "auto", whether a turn
# benefits from the multi-step agent or should be answered directly by the normal model. It is NOT the
# agent loop — just the decision: one forced-choice model call through the gateway, temp 0, memoized.
#
# Routing uses a BARE prompt (no agent persona) + an explicit single-tool forced choice — a full agent
# persona measurably hurts a clean binary decision on a weak/small model (0% vs 83% on a forced tool
# call). Fail-open: any hiccup → DIRECT (the cheap, fast path; the chat then just uses the normally-
# selected model), so the router can never wedge a turn.
# No AGENT_ROUTE_ENABLED kill switch. Who may be routed is the web side's per-user agent
# flag (resolveAgentRoute.ts), and a 404 here only showed those users a "route failed" notice. (CUR-3199)
ROUTE_MAX_TOKENS = int(os.environ.get("AGENT_ROUTE_MAX_TOKENS", "64"))  # a forced tool call emits a tiny JSON
ROUTE_TIMEOUT_SECS = float(os.environ.get("AGENT_ROUTE_TIMEOUT_SECS", "20"))
_ROUTE_MEMO: dict[str, dict] = {}                                  # prompt-hash -> {"agentic","reason"} (temp-0 deterministic)
_ROUTE_MEMO_MAX = 512

_ROUTE_SYSTEM = (
    "You are a routing classifier. Decide whether the user's latest message needs an autonomous, "
    "multi-step AGENT — one that runs shell commands, reads and writes files, and works across "
    "several steps in a sandbox — or whether a single DIRECT answer from your own knowledge, the "
    "conversation, or a live web lookup is enough.\n"
    "Choose the agent ONLY when the task genuinely requires doing work over multiple steps: writing and "
    "running code, building or transforming files, multi-source research, or step-by-step computation.\n"
    "Choose direct for explanations, questions, chit-chat, definitions, opinions, advice, or anything you "
    "can answer well in one reply.\n"
    'Reply with ONLY a JSON object and nothing else: {"agentic": true|false, "reason": "<a short phrase>"}'
)
# NB: NO tool-calling in the request — the router asks for a JSON decision in the message CONTENT and
# parses it, mirroring _derive_verify_spec (the other content-JSON call proven on this endpoint). This
# also keeps the call portable across upstreams whose tool-calling serving may be broken or absent.
# Forced-choice is achieved by the prompt, not a tool_choice. _extract_route_args still handles tool_calls
# for endpoints that DO emit them.


def _loose_route_parse(text: str) -> dict | None:
    """Tolerant fallback when a weak model emits near-JSON or narrates instead of a clean tool call.
    Pulls an explicit agentic boolean out of the text; returns None if no boolean is present."""
    m = re.search(r'"?agentic"?\s*[:=]\s*(true|false)', text, re.IGNORECASE)
    if not m:
        return None
    rm = re.search(r'"?reason"?\s*[:=]\s*"?([^"\n}]{0,200})', text, re.IGNORECASE)
    return {"agentic": m.group(1).lower() == "true", "reason": (rm.group(1).strip() if rm else "")}


def _extract_route_args(msg: dict) -> dict | None:
    """Parse the route decision from the model message. This deploy answers in CONTENT (text protocol), so
    the content path is primary: whole-content JSON, then an embedded {...} block, then a loose boolean pull.
    The tool_calls path is kept first for endpoints that DO support function calls."""
    for tc in ((msg or {}).get("tool_calls") or []):
        fn = (tc or {}).get("function") or {}
        if fn.get("name") in ("route", None):
            raw = fn.get("arguments")
            if isinstance(raw, dict):
                return raw
            if isinstance(raw, str):
                try:
                    return json.loads(raw)
                except Exception:  # noqa: BLE001
                    parsed = _loose_route_parse(raw)
                    if parsed is not None:
                        return parsed
    content = str((msg or {}).get("content") or "").strip()
    if not content:
        return None
    try:                                                       # whole content is the JSON object
        obj = json.loads(content)
        if isinstance(obj, dict) and "agentic" in obj:
            return obj
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"\{.*\}", content, re.DOTALL)               # JSON embedded in surrounding prose
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict) and "agentic" in obj:
                return obj
        except Exception:  # noqa: BLE001
            pass
    return _loose_route_parse(content)                         # last resort: regex a boolean out of prose


def _classify_agentic(prompt: str, use_memo: bool = True) -> dict:
    """Forced-choice agentic router (bare prompt — see /route note). Returns
    {"agentic": bool, "reason": str, "source": "memo|model|fallback", "backend": str|None,
    "served_model": str|None}. Never raises; on any failure defaults to DIRECT (agentic=False) — the cheap
    path the chat falls back to the normal model on.

    `backend`/`served_model` name who actually answered (the gateway's x-agent-backend header and the
    response's own `model`). A memo hit carries the ones recorded when the verdict was made, so a cached
    answer still says where it came from. `use_memo=False` skips the memo READ only (CUR-2154: an eval that reads verdicts from the memo
    grades its own cache); a fresh verdict is still stored."""
    key = hashlib.sha256(prompt.encode("utf-8", "replace")).hexdigest()
    if use_memo and key in _ROUTE_MEMO:
        return {"backend": None, "served_model": None, **_ROUTE_MEMO[key], "source": "memo"}
    fallback = {"agentic": False, "reason": "router unavailable", "source": "fallback",
                "backend": None, "served_model": None}
    # The boundary is absolute: app.py never holds the model token. No gateway → no safe classify → DIRECT.
    if not MODEL_PROXY_URL or not PROXY_ADMIN_KEY:
        return fallback
    import httpx
    nonce = uuid.uuid4().hex
    try:
        _gateway_grant(nonce, max_steps=1, max_tokens=ROUTE_MAX_TOKENS, label="route")
    except Exception:  # noqa: BLE001 — gateway down → fail open to DIRECT
        return fallback
    decision = fallback
    try:
        r = httpx.post(MODEL_PROXY_URL + "/v1/chat/completions",
                       headers={"authorization": f"Bearer {nonce}"},
                       # No tools/tool_choice — text protocol (see _ROUTE_SYSTEM note). Same shape as the
                       # proven _derive_verify_spec call: a content-JSON answer at temp 0.
                       json={"model": AGENT_MODEL,
                             "messages": [{"role": "system", "content": _ROUTE_SYSTEM},
                                          {"role": "user", "content": prompt}],
                             "temperature": 0.0, "max_tokens": ROUTE_MAX_TOKENS},
                       timeout=ROUTE_TIMEOUT_SECS)
        r.raise_for_status()
        payload = r.json()
        args = _extract_route_args(payload["choices"][0]["message"])
        if args is not None:
            decision = {"agentic": bool(args.get("agentic")),
                        "reason": str(args.get("reason") or "")[:200], "source": "model",
                        "backend": r.headers.get("x-agent-backend") or r.headers.get("x-agent-provider"),
                        "served_model": payload.get("model") if isinstance(payload.get("model"), str) else None}
    except httpx.HTTPStatusError as e:  # surface the upstream detail so a 4xx is diagnosable (still DIRECT)
        body = (e.response.text or "")[:160].replace("\n", " ")
        decision = {"agentic": False, "reason": f"router http {e.response.status_code}: {body}", "source": "fallback"}
    except Exception as e:  # noqa: BLE001 — any classify failure → DIRECT (never wedge the turn)
        decision = {"agentic": False, "reason": f"router error: {type(e).__name__}", "source": "fallback"}
    finally:
        _gateway_revoke(nonce)
    if decision["source"] == "model":
        _ROUTE_MEMO[key] = {"agentic": decision["agentic"], "reason": decision["reason"],
                            "backend": decision["backend"], "served_model": decision["served_model"]}
        if len(_ROUTE_MEMO) > _ROUTE_MEMO_MAX:
            _ROUTE_MEMO.pop(next(iter(_ROUTE_MEMO)))             # evict oldest (insertion-ordered)
    return decision


class RouteRequest(BaseModel):
    prompt: str                          # the turn to classify (latest user message, optionally with brief context)
    fresh: bool = False                  # skip the memo read; honoured for OPERATOR_SUBS only (CUR-2154 eval)


class RouteResponse(BaseModel):
    agentic: bool                        # True => the chat should route this turn to the agent
    reason: str = ""                     # one short phrase (for an explainable-routing UI affordance later)
    source: str = "model"               # model | memo | fallback (fallback = router degraded → DIRECT)
    model: str | None = None             # provenance: which model made the decision
    backend: str | None = None           # provenance: the upstream host that answered (None on fallback)
    api: int = API_VERSION               # contract version (chat detects drift via /healthz)


@app.post("/route", response_model=RouteResponse)
def route_turn(req: RouteRequest, user: str = Depends(require_user)) -> RouteResponse:
    """Agentic-vs-direct classifier for the chat's 'auto' mode. One forced-choice model call through the
    gateway (bare prompt, temp 0, memoized) — the decision only, never the agent loop. Same auth +
    moderation boundary as /run. Fail-open to DIRECT so a router hiccup degrades to the normal model."""
    p = req.prompt.strip()
    if not p:
        raise HTTPException(400, "empty prompt")
    if len(p) > MAX_PROMPT_CHARS:
        raise HTTPException(413, f"prompt too large (> {MAX_PROMPT_CHARS} chars)")
    moderate(p, "input", user)                                   # same moderation boundary as /run input
    # A fresh verdict is for our own measurement runs. An invitee asking for one would only spend
    # a gateway call the memo exists to save, so the flag is ignored for them rather than refused. (CUR-2154)
    fresh = req.fresh and _caller_of(user) in OPERATOR_SUBS
    d = _classify_agentic(p, use_memo=not fresh)
    _metric_inc("agent_route_total")
    _metric_inc("agent_route_agentic_total" if d["agentic"] else "agent_route_direct_total")
    _log_event("route.decided", user=user, agentic=d["agentic"], source=d["source"], fresh=fresh,
               backend=d.get("backend"), served_model=d.get("served_model"))
    return RouteResponse(agentic=d["agentic"], reason=d["reason"], source=d["source"],
                         model=AGENT_MODEL or None, backend=d.get("backend"))


@app.get("/run/{task_id}", response_model=StatusResponse)
def status(task_id: str, user: str = Depends(require_user)) -> StatusResponse:
    t = _get_task(task_id)
    if not t:
        raise HTTPException(404, "no such task")
    if not _may_access(t, user):                            # tenant isolation: only the owner reads a task
        raise HTTPException(403, "not your task")
    return _status_of(t)


@app.get("/run/{task_id}/events")
async def events(task_id: str, request: Request, user: str = Depends(require_user),
                 last_event_id: str | None = Header(default=None)) -> StreamingResponse:
    """Live event stream (SSE, streaming-spec.md §4). Same auth + tenant isolation as GET /run/{id}.
    Reconnect-safe: a `Last-Event-ID` header resumes after that seq (the browser sends it automatically).

    Under ACP (`AGENT_ACP=1`, what ships) this carries live per-step `plan` / `tool_call` /
    `tool_result` / `usage` as the agent works, AND — since AGENT_STREAM_TOKENS, on by default — the
    answer text as `token` frames while it is generated, capped per attempt with one `token_truncated`
    marker past the cap. `done.result` still carries the whole answer, so a consumer may ignore every
    token frame and behave exactly as before.

    Over the oneshot transport there are no per-step frames or token frames: coarse state, then done. A terminal task whose buffer
    is gone (post-restart/eviction) gets a single synthesized `done` frame so a late subscriber still
    terminates cleanly."""
    t = _get_task(task_id)
    if not t:
        raise HTTPException(404, "no such task")
    if not _may_access(t, user):                            # tenant isolation: only the owner reads a task
        raise HTTPException(403, "not your task")
    buf = _event_buffer(task_id)
    after = -1
    if last_event_id:
        try:
            after = int(last_event_id)
        except ValueError:
            after = -1

    async def gen():
        nonlocal after
        if buf is None and store.shared:                   # CUR-4443: the task runs (or ran) on another machine
            async for frame in _events_from_store(task_id, after, request):
                yield frame
            return
        if buf is None:                                    # no live stream → if terminal, emit one done frame
            tt = _get_task(task_id)
            if tt and tt.state in _TERMINAL:
                yield _sse_frame("done", _done_payload(tt), 0)
            return
        waited = 0.0
        while True:
            if await request.is_disconnected():
                return
            evs, closed = buf.since(after)
            for seq, etype, data in evs:
                after = seq
                yield _sse_frame(etype, data, seq)
            if closed and not evs:                         # drained AND producer done → end the stream
                return
            if evs:
                waited = 0.0
                continue
            await asyncio.sleep(SSE_POLL_SECS)
            waited += SSE_POLL_SECS
            if waited >= SSE_IDLE_TIMEOUT_SECS:            # abandon a stream that produced nothing for too long
                return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _events_from_store(task_id: str, after: int, request: Request):
    """A task's events read back from the shared store, for a machine that does not run it (CUR-4443): the
    stored events in order, then new ones as the owner writes them, until the task is terminal and nothing
    is left. A terminal task whose `done` frame never reaches the store gets the synthesized one a
    one-machine reader gets."""
    waited = 0.0
    while True:
        if await request.is_disconnected():
            return
        evs = await asyncio.to_thread(store.events_since, task_id, after)
        for seq, etype, data in evs:
            after = seq
            yield _sse_frame(etype, data, seq)
            if etype == "done":
                return
        if evs:
            waited = 0.0
            continue
        tt = await asyncio.to_thread(_get_task, task_id)
        if tt is None or tt.state in _TERMINAL:
            # The owner persists the terminal state before its last events reach the store, so keep reading
            # until the `done` frame arrives. If it never does (a flush dropped, or a task ended by a lapsed
            # lease, whose owner wrote nothing more), send the one a one-machine reader would get.
            deadline = time.monotonic() + TAIL_WAIT_SECS
            while time.monotonic() < deadline:
                tail = await asyncio.to_thread(store.events_since, task_id, after)
                for seq, etype, data in tail:
                    after = seq
                    yield _sse_frame(etype, data, seq)
                    if etype == "done":
                        return
                await asyncio.sleep(_EventSink.FLUSH_SECS)
            if tt is not None:
                tt = await asyncio.to_thread(_get_task, task_id) or tt
                yield _sse_frame("done", _done_payload(tt), after + 1)
            return
        await asyncio.sleep(SSE_POLL_SECS)
        waited += SSE_POLL_SECS
        if waited >= SSE_IDLE_TIMEOUT_SECS:
            return


@app.delete("/run/{task_id}", response_model=StatusResponse)
def cancel(task_id: str, user: str = Depends(require_user)) -> StatusResponse:
    """A2A-style cancel: kill the agent process tree if still running. Idempotent on terminal tasks."""
    t = _get_task(task_id)
    if not t:
        raise HTTPException(404, "no such task")
    if not _may_access(t, user):
        raise HTTPException(403, "not your task")
    with _TASKS_LOCK:
        local = task_id in TASKS
    if not local and store.shared and t.state not in _TERMINAL:
        store.request_cancel(task_id)                      # CUR-4443: its owner stops it within a lease tick
        _log_event("run.cancel_forwarded", task_id=task_id, owner_lease=True)
        return _status_of(t)
    if t.state not in _TERMINAL:
        _cancel_local(t)
    return _status_of(t)


def _cancel_local(t: Task) -> None:
    """Stop a task this machine runs: from its own cancel route, or a cancel asked elsewhere (CUR-4443)."""
    t._canceled = True                                 # first, so a run finishing now keeps CANCELED
    t.summary, t.state = "canceled by user", State.CANCELED
    _persist(t)                                        # durable immediately (the _run finally also persists)
    _stop_local(t)


def _stop_local(t: Task) -> None:
    """Kill a task's agent process. `_canceled` makes `_run` drain and tidy up without rewriting its state."""
    t._canceled = True
    if t._proc is not None:
        _kill_process_group(t._proc)                   # _run drains, sees _canceled, and tidies up
    if t._acp_cancel is not None:                      # ACP path: hop onto the run loop to cancel the session
        try:
            t._acp_cancel()
        except Exception:  # noqa: BLE001 — best-effort; _run also sees _canceled and tidies up
            pass


class ConfirmRequest(BaseModel):
    confirm_id: str
    decision: Literal["allow", "deny"]


@app.post("/run/{task_id}/confirm", response_model=StatusResponse)
def confirm(task_id: str, req: ConfirmRequest, user: str = Depends(require_user)) -> StatusResponse:
    """CUR-218: deliver a human's answer to a paused request_permission call. Mirrors cancel() above —
    same auth, same idempotency posture, same best-effort signal-and-return pattern. 409 (not a silent
    no-op) on an unknown/already-resolved confirm_id — the case where a human clicks a button in a UI for
    a confirmation that already timed out or was answered by another request."""
    t = _get_task(task_id)
    if not t:
        raise HTTPException(404, "no such task")
    if not _may_access(t, user):
        raise HTTPException(403, "not your task")
    if not any(c.get("confirm_id") == req.confirm_id for c in t.pending_confirmations):
        raise HTTPException(409, "no such pending confirmation")
    if t._acp_confirm is not None:
        try:
            t._acp_confirm(req.confirm_id, req.decision)
        except Exception:  # noqa: BLE001 — best-effort, mirrors cancel()'s _acp_cancel call above
            pass
    return _status_of(t)


class MigrateCallerRequest(BaseModel):
    old_subject: str
    new_subject: str


class MigrateCallerResponse(BaseModel):
    migrated: int


@app.post("/callers/migrate", response_model=MigrateCallerResponse)
def migrate_caller(req: MigrateCallerRequest, user: str = Depends(require_user)) -> MigrateCallerResponse:
    """Re-key an anonymous session's accrued trust onto the account signing in (CUR-761), called from the
    same chat-side sign-in hook that re-keys conversations (migrateAnonymousConversations). Scoped to THIS request's own authenticated caller
    (`_caller_of(user)`) — never a value the body supplies — so one tenant cannot re-key another's
    history. Sanitised the same way `_principal` sanitises an asserted X-Agent-Subject: a malformed
    value just matches zero rows rather than migrating the wrong ones, and this call never derives a
    subject itself, so it need not enforce SUBJECT_MAX_CHARS' own reasoning about a `dict` — a caller
    passing something too long simply matches nothing."""
    caller = _caller_of(user)
    old_s = _SUBJECT_STRIP.sub("", req.old_subject.strip())[:SUBJECT_MAX_CHARS]
    new_s = _SUBJECT_STRIP.sub("", req.new_subject.strip())[:SUBJECT_MAX_CHARS]
    return MigrateCallerResponse(**store.migrate_caller(caller, old_s, new_s))


class DeleteCallerRequest(BaseModel):
    subject: str = ""


class DeleteCallerResponse(BaseModel):
    tasks_deleted: int
    workdirs_deleted: int


@app.post("/callers/delete", response_model=DeleteCallerResponse)
def delete_caller(req: DeleteCallerRequest, user: str = Depends(require_user)) -> DeleteCallerResponse:
    """CUR-1722: delete every task row and session workdir for ONE principal under the calling
    caller — the account-deletion counterpart to migrate_caller above. Scoped to THIS request's own
    authenticated caller (`_caller_of(user)`), never a value the body supplies, so one tenant cannot
    delete another's history. `subject` sanitised the same way migrate_caller sanitises one."""
    caller = _caller_of(user)
    s = _SUBJECT_STRIP.sub("", req.subject.strip())[:SUBJECT_MAX_CHARS]
    result = store.delete_for_user(caller, s)
    principal = f"{caller}/{s}" if s else caller
    for sid, wd in result["workdirs"]:
        shutil.rmtree(wd, ignore_errors=True)
        _forget_sandboxes(principal, sid)
    return DeleteCallerResponse(
        tasks_deleted=result["tasks_deleted"], workdirs_deleted=len(result["workdirs"])
    )


class DeleteSessionsRequest(BaseModel):
    subject: str = ""
    session_ids: list[str] = Field(default_factory=list, max_length=500)


class DeleteSessionsResponse(BaseModel):
    workdirs_deleted: int
    sandboxes_deleted: int


@app.post("/sessions/delete", response_model=DeleteSessionsResponse)
def delete_sessions(req: DeleteSessionsRequest, user: str = Depends(require_user)) -> DeleteSessionsResponse:
    """CUR-4484: chat deleted these conversations, so their files go too: the session workdir here and each
    conversation's sandboxes on the sandbox host. Scoped to this request's own caller as `delete_caller` is,
    so a guessed conversation id under another token names nothing."""
    caller = _caller_of(user)
    s = _SUBJECT_STRIP.sub("", req.subject.strip())[:SUBJECT_MAX_CHARS]
    principal = f"{caller}/{s}" if s else caller
    ids = [i for i in (x.strip() for x in req.session_ids) if i and len(i) <= 200]
    workdirs = store.delete_sessions(principal, ids)
    for wd in workdirs:
        shutil.rmtree(wd, ignore_errors=True)
    killed = sum(_forget_sandboxes(principal, sid) for sid in ids)
    return DeleteSessionsResponse(workdirs_deleted=len(workdirs), sandboxes_deleted=killed)


@app.get("/sessions/{session_id}/artifacts/{filename:path}")
def get_artifact(session_id: str, filename: str, user: str = Depends(require_user),
                 fly_replay_src: str | None = Header(default=None),
                 fly_force_instance_id: str | None = Header(default=None)) -> Response:
    """CUR-546: fetch one file back out of a still-alive session workdir, so a completed turn's output can
    leave the browser as a real download instead of surviving only as CUR-195's inline copy-block.

    Session-scoped ONLY, by construction: a task without `session_id` has its scratch removed at the end
    of `_run` (`shutil.rmtree(work, ...)` — "retention by construction", the `else` branch a few hundred
    lines up), so there is nothing left here a moment later for a non-session turn. The inline copy-block
    remains the only way to get that turn's output.

    Auth mirrors GET /run/{id}: same require_user dependency. Tenant isolation is
    get_session_workdir_info's own WHERE clause (keyed on (user, session_id), never session_id alone),
    not a separate _may_access check — a session_id guessed under a different account simply has no
    matching row, so unlike GET /run/{id}'s 403-vs-404 split this can't be used to probe whether a given
    session_id exists at all.

    Retention: `X-Artifact-Session-Expires-At` states the real number this session's idle reaper is
    actually working from (SESSION_IDLE_SECS past last_used_at) (CUR-546). Public copy about
    retention has to match it."""
    replay = _replay_home(session_id, _routing_headers(fly_replay_src, fly_force_instance_id), "artifact")
    if replay is not None:
        return replay
    if ARTIFACT_MAX_FILES <= 0:          # its own comment calls this "feature off" — an operator relying on
        raise HTTPException(404, "no such artifact")   # that (e.g. for compliance) must get the whole surface off, not just the inline preview
    info = store.get_session_workdir_info(user, session_id)
    if not info:
        raise HTTPException(404, "no such session")
    work, last_used_at = info
    expires_at = int(last_used_at + SESSION_IDLE_SECS)
    if SANDBOX_BACKEND.name != "bwrap":
        return _guest_artifact(user, session_id, filename, expires_at)
    if not os.path.isdir(work):                # store row outlived the directory (mirrors _run's own check)
        raise HTTPException(404, "no such session")
    resolved = _resolve_artifact_path(work, filename)
    if resolved is None:
        raise HTTPException(404, "no such artifact")
    path, dev, ino = resolved
    fh, size, oversize = _open_artifact_for_streaming(path, ARTIFACT_DOWNLOAD_MAX_BYTES, dev, ino)
    if fh is None:
        if oversize:
            raise HTTPException(413, f"artifact exceeds the {ARTIFACT_DOWNLOAD_MAX_BYTES}-byte download cap "
                                      f"(AGENT_ARTIFACT_DOWNLOAD_MAX_BYTES)")
        raise HTTPException(404, "no such artifact")   # e.g. reaped by the idle sweep between resolve and read
    return StreamingResponse(_stream_artifact_chunks(fh), media_type="application/octet-stream", headers={
        "Content-Disposition": _content_disposition(os.path.basename(path)),
        "X-Artifact-Session-Expires-At": str(expires_at),
        "Content-Length": str(size),
    })


def _mcp_health() -> dict[str, object]:
    """The /healthz `mcp` field (CUR-3025), or nothing at all when AGENT_MCP_SERVERS is unset.

    Names only — /healthz is unauthenticated, so no URL and no header value. `missing_header_env` names
    env VARS whose value is unset (that server is skipped). `offered_under` is the policy a task must
    resolve to for the servers to reach it; `active` is false whenever AGENT_ACP is off, because only the
    ACP transport passes servers."""
    if not MCP_CONFIG.configured:
        return {}
    return {"mcp": {**mcp_config.health(MCP_CONFIG), "offered_under": "allow",
                    "active": AGENT_ACP and bool(MCP_CONFIG.servers)}}


def _guest_artifact(user: str, session_id: str, filename: str, expires_at: int) -> Response:
    """CUR-4483: the download route when the session's agent ran in its own sandbox. The file is read from
    the guest, found by the same key `_run` connected with, and never created: a session with no sandbox
    left has nothing to download."""
    rel = posixpath.normpath(filename) if filename and "\x00" not in filename else ""
    if not rel or posixpath.isabs(rel) or rel == ".." or rel.startswith("../") or not _downloadable(tuple(rel.split("/"))):
        raise HTTPException(404, "no such artifact")
    try:
        h = SANDBOX_BACKEND.find(user, f"agent:{session_id}", Tier.AGENT)
    except Exception as e:  # an unreachable sandbox host is unavailability, not a missing file
        raise HTTPException(503, f"sandbox unavailable ({type(e).__name__})") from e
    if h is None:
        raise HTTPException(404, "no such session")
    try:
        raw = RemoteWork(SANDBOX_BACKEND, h, _remote_work()).read(rel, ARTIFACT_DOWNLOAD_MAX_BYTES + 1)
    except SandboxError as e:
        raise HTTPException(503, "sandbox unavailable (read failed)") from e
    if raw is None:
        raise HTTPException(404, "no such artifact")
    if len(raw) > ARTIFACT_DOWNLOAD_MAX_BYTES:
        raise HTTPException(413, f"artifact exceeds the {ARTIFACT_DOWNLOAD_MAX_BYTES}-byte download cap "
                                  f"(AGENT_ARTIFACT_DOWNLOAD_MAX_BYTES)")
    return Response(raw, media_type="application/octet-stream", headers={
        "Content-Disposition": _content_disposition(posixpath.basename(rel)),
        "X-Artifact-Session-Expires-At": str(expires_at),
    })


def _sandbox_workdir(principal: str, session_id: str) -> str:
    """The conversation's workdir for a sandbox MCP call: the agent's own for this (principal, session), so
    files carry between the two, created and recorded the same way `_resolve_workdir` does (CUR-4232)."""
    existing = store.get_session_workdir(principal, session_id)
    if existing and os.path.isdir(existing):
        work = existing
    else:
        work = tempfile.mkdtemp(prefix=_SCRATCH_PREFIX, dir=SCRATCH_ROOT)
    store.touch_session_workdir(principal, session_id, work)
    return work


def _existing_sandbox_workdir(principal: str, session_id: str) -> str | None:
    """The conversation's workdir if it already has one on this machine; never creates (CUR-4502)."""
    existing = store.get_session_workdir(principal, session_id)
    return existing if existing and os.path.isdir(existing) else None


def _routing_headers(fly_replay_src: object, fly_force_instance_id: object) -> dict[str, str]:
    """The two Fly routing headers `home_machine.replay_target` reads. A non-string is the `Header` sentinel
    from a direct call (tests call the route functions), and counts as absent, as in `require_account`."""
    pairs = (("fly-replay-src", fly_replay_src), ("fly-force-instance-id", fly_force_instance_id))
    return {k: v for k, v in pairs if isinstance(v, str)}


def _replay_home(conversation: str | None, headers: dict[str, str], route: str) -> Response | None:
    """A `fly-replay` answer sending this conversation's request to its home machine, or None to serve it
    here (CUR-4435, `home_machine.py`). Fly's proxy acts on the header and the body is never seen."""
    target = home_machine.replay_target(conversation, headers, self_id=FLY_MACHINE_ID)
    if target is None:
        return None
    _log_event("sandbox.replay", route=route, to=target)
    return Response(status_code=204, headers={"fly-replay": home_machine.replay_header(target)})


def _remote_work() -> str:
    from sandbox_e2b import WORK  # lazy: only a remote backend has a guest workspace
    return WORK


def _build_sandbox_backend():
    """`AGENT_SANDBOX_BACKEND` picks it (CUR-4482). A remote backend missing its config fails at import, so a
    machine never comes up believing it isolates work it would actually run beside its own secrets."""
    if AGENT_SANDBOX_BACKEND == "bwrap":
        return BwrapBackend(sandbox_prefix=lambda work: _sandbox_prefix(work), workdir_for=_sandbox_workdir,
                            existing_workdir=_existing_sandbox_workdir)
    if AGENT_SANDBOX_BACKEND != "e2b":
        raise RuntimeError(f"AGENT_SANDBOX_BACKEND={AGENT_SANDBOX_BACKEND!r}: bwrap or e2b")
    missing = [k for k, v in (("E2B_API_URL", E2B_API_URL), ("E2B_API_KEY", os.environ.get("E2B_API_KEY", "")),
                              ("AGENT_GATEWAY_PUBLIC_URL", AGENT_GATEWAY_PUBLIC_URL),
                              ("PROXY_ADMIN_KEY", PROXY_ADMIN_KEY)) if not v]
    if missing:
        raise RuntimeError(f"AGENT_SANDBOX_BACKEND=e2b needs {', '.join(missing)}")
    from sandbox_e2b import E2BBackend, E2BConfig
    return E2BBackend(E2BConfig(api_url=E2B_API_URL, api_key=os.environ["E2B_API_KEY"], sandbox_url=E2B_SANDBOX_URL,
                                template=E2B_TEMPLATE or E2BConfig.template, gateway_host=urlparse(AGENT_GATEWAY_PUBLIC_URL).hostname or "",
                                slots=E2B_SLOTS, off=E2B_SLOTS_OFF, account_max_live=E2B_ACCOUNT_MAX_LIVE,
                                slot_capacity=E2B_SLOT_CAPACITY, auto_off_secs=E2B_SLOT_AUTO_OFF_SECS,
                                run_code_idle_secs=E2B_RUN_CODE_IDLE_SECS, busy_wait_secs=E2B_BUSY_WAIT_SECS,
                                busy_retry_secs=CAPACITY_RETRY_AFTER_SECS),
                      log_event=lambda event, **fields: _log_event(event, fly_app=os.environ.get("FLY_APP_NAME", ""),
                                                                   **fields))


SANDBOX_BACKEND = _build_sandbox_backend()


def _work_isolated() -> bool:
    """Whether the run-code tools run anywhere but beside this process's secrets. A remote backend is its own
    microVM whatever AGENT_SANDBOX says; the host-local runner is isolated only under the bwrap profile."""
    return SANDBOX_BACKEND.name != "bwrap" or SANDBOX == "bwrap"


def _isolation_report() -> dict[str, str]:
    """The /healthz fields that say what isolates the work. Under a remote backend they name it, and the bwrap
    profile's own fields read n/a: the deployed config still carries AGENT_SANDBOX=bwrap (the image bakes it),
    and reporting that as the sandbox read as bwrap isolation on a machine where nothing runs under bwrap."""
    if SANDBOX_BACKEND.name != "bwrap":
        na = f"n/a({SANDBOX_BACKEND.name})"
        return {"sandbox": SANDBOX_BACKEND.name, "sandbox_seccomp": na, "rlimits": na}
    return {
        "sandbox": SANDBOX if SANDBOX != "off" else "OFF(no fs isolation)",
        # Whether bwrap loads the syscall filter, read from the file the prefix opens. (CUR-4478)
        "sandbox_seccomp": ("on" if _seccomp_ready() else "OFF(no syscall filter)") if SANDBOX == "bwrap" else "n/a",
        # Namespacing and RATIONING are two different things and only the first was ever reported. A
        # sandbox with no budget is one prompt away from a fork bomb taking the machine with it.
        "rlimits": (f"nproc={RLIMIT_NPROC} fsize={RLIMIT_FSIZE} tmpfs={TMPFS_BYTES}"
                    if RLIMIT_ENABLED else "OFF(unrationed)"),
    }


_SANDBOX_MCP = build_sandbox_server(
    backend=SANDBOX_BACKEND,
    sandbox_on=_work_isolated,
    principal_for=require_user,
    log_event=_log_event,
)


def _bearer_gate(asgi):
    """Refuse an unauthenticated request before the MCP transport reads it, with the same checks and
    status codes as every other route (`require_user`)."""
    async def gated(scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            try:
                require_user(headers.get("authorization"), headers.get("x-agent-subject"))
                require_account(headers.get("x-agent-account"))
            except HTTPException as e:
                await PlainTextResponse(str(e.detail), status_code=e.status_code)(scope, receive, send)
                return
            replay = _replay_home((headers.get("x-agent-session") or "").strip() or None, headers, "mcp")
            if replay is not None:
                await replay(scope, receive, send)
                return
        await asgi(scope, receive, send)
    return gated


app.mount("/mcp", _bearer_gate(sandbox_http_app(_SANDBOX_MCP)))


@app.get("/healthz")
def healthz() -> dict[str, object]:
    # Unauthenticated (k8s liveness needs it) → posture only, no sensitive specifics like the binary's
    # absolute path (needless recon surface).
    #
    # `TASKS`'s own doc comment says what it holds — "non-terminal + recently-terminal" — so
    # len(TASKS) was never "live" in the sense the field's name promises; it is the retained-table size,
    # which only shrinks at the MAX_TASKS eviction and so climbs with total volume regardless of whether
    # anything is stuck. `n_live` is the count the name actually means. `n_stuck` narrows further: a
    # non-terminal task whose `_RUN_START` entry is already gone means its own worker thread already hit
    # the `finally` in `_run` (which unconditionally pops `_RUN_START` and releases the concurrency slot)
    # WITHOUT the task ever reaching a terminal state — the thread is done, but nothing is coming to
    # finish this task. That is the orphan `_reap_stuck_tasks` (below) targets, and it is the one
    # condition here `inflight` can be silently wrong about too: a task that took its slot back without
    # ever terminalizing. (CUR-1310)
    with _TASKS_LOCK:
        n_tasks = len(TASKS)
        n_live = sum(1 for t in TASKS.values() if t.state not in _TERMINAL)
        n_stuck = sum(1 for t in TASKS.values() if t.state not in _TERMINAL and t.id not in _RUN_START)
    with _INFLIGHT_LOCK:
        inflight = _inflight
    # Read from the STORE, not from _METRICS. See `Store.caller_deadline_count`: this app scales to
    # zero, so a since-boot counter here would answer "has anyone ever" with "no" forever.
    caller_deadlines = store.caller_deadline_count()
    return {
        # A stuck task is the one condition genuinely worth failing THIS check for: it means a
        # concurrency slot came back without the task that held it ever finishing, which is exactly
        # what a deploy-gate agent turn can run headlong into. Anything else here degrading (moderation,
        # the gateway, a missing binary) already has its own more specific field below; this endpoint
        # doesn't editorialize on those into one flat status, only on the one thing IT tracks directly.
        # Present only when AGENT_MCP_SERVERS is set (valid or not), so an unconfigured service
        # reports exactly the fields it did before. See _mcp_health. (CUR-3025)
        **_mcp_health(),
        "status": "degraded (stuck tasks)" if n_stuck else "ok",
        # True while a stop signal waits for running tasks; /run answers 503 meanwhile. Not a
        # failure of this check, since a draining machine must keep serving its tasks' streams. (CUR-4598)
        "draining": _DRAINING.is_set(),
        "api": API_VERSION, "build": BUILD_SHA or "unknown",
        "model": AGENT_MODEL or "unset", "compute_provider": _effective_compute_provider() or "unset",
        "hermes": "configured" if (shutil.which(HERMES_BIN) or Path(HERMES_BIN).exists()) else "MISSING",
        "toolsets": ALLOWED_TOOLSETS, "toolsets_effective": _effective_toolsets(),
        # The four knobs that most change what a USER experiences, reported so a caller can see which transport
        # is running without shell access, and so a drift check, which can only compare what
        # /healthz reports, catches the config file and the running machine disagreeing about the
        # transport, the judge, or how many attempts a turn gets. Rendered "on"/"off" to match the convention the caps
        # above already use, so prodcheck's normaliser needs no new vocabulary.
        "acp": "on" if AGENT_ACP else "off",
        # Whether the answer text streams, and how much of it is published. Reported because it changes what
        # a consumer sees on the wire. ACP-only — the oneshot transport has no delta channel.
        #
        # Bare "on"/"off" and the cap as its own numeric field, NOT "on(max 400/attempt)". The `acp` comment
        # above says rendering in this convention is what keeps prodcheck's normaliser free of new
        # vocabulary; a composite such as "on(max 400/attempt)" would compare unequal to config "1" and raise
        # a false STALE DEPLOY. A false alarm
        # on a real check is how the check gets ignored.
        "stream_tokens": "on" if (STREAM_TOKENS and AGENT_ACP) else "off",
        "stream_max_frames": STREAM_MAX_FRAMES or "off",
        # What the per-tool gate is CONSULTED for, not what its name suggests. `deny_writes` beside a
        # toolset carrying `terminal` reads as write containment and is not one — the value says so.
        "acp_permission": _permission_state()[0],
        "early_exit": "on" if EARLY_EXIT else "off",
        "best_of": BEST_OF,
        # What a retry MEANS, which `best_of` alone does not say: at 0 the model's own claim of done ends
        # the turn, above 0 an attempt is handed the check's failure and told to try again inside the same
        # session. Two runs at the same best_of are not comparable across this number.
        #
        # It is in prodcheck's COMPARED table, which checks the two CONFIG FILES against each other; this
        # field lets prodcheck check the RUNNING app too, so `AGENT_REPAIR_TURNS` cannot be inherited
        # rather than stated with every check passing. Bare int, matching `best_of`: prodcheck's normaliser compares "2" to 2 and needs no new
        # vocabulary. ACP-only in effect — read it against `acp` above, which is why that field is here.
        "repair_turns": REPAIR_TURNS,
        # How often the self-probe that exits a hung server runs, or "off". (CUR-4406)
        "watchdog_s": WATCHDOG_SECS or "off",
        # How many STORED TASKS arrived stating their own deadline — an observation, not a setting, so it
        # is deliberately absent from prodcheck's key map and compared against no config value. It sits
        # beside the knobs rather than with the task counts because it answers what they cannot:
        # `wall_clock_s` says what the ceiling is, this says whether anyone has ever asked for less.
        #
        # Durable, and counted over the same population as `tasks_total`, so the two ARE comparable. An
        # in-process counter would not be: the app runs with `min_machines_running = 0`, so it resets on
        # every scale-to-zero and reports 0 however often the chat tier sends `wall_clock_secs`. A metric answering a question about all
        # time has to be as durable as the number it is read against.
        "caller_deadlines": caller_deadlines,
        # The seat, not the model. It is fail-CLOSED: a judge that cannot be reached marks every turn
        # unverified, so which model sits here decides how much correct work gets rejected. "unset" is a
        # real configuration rather than a missing one — it means the executor judges itself, which has a
        # measured discrimination ceiling, not that judging is off.
        "verifier": VERIFIER_MODEL or "unset",
        # Per ATTEMPT, both of them, and the task ceiling each implies at the configured best-of. Reported
        # as two numbers so a reader can tell the per-attempt clock from the per-task ceiling; one number
        # for both would mix differently-denominated things.
        "wall_clock_s": WALL_CLOCK_SECS, "wall_clock_task_s": WALL_CLOCK_SECS * max(1, BEST_OF),
        "auth": "disabled(dev)" if AUTH_DISABLED else ("configured" if WEBUI_SECRET_KEY else "unconfigured(fails-closed)"),
        "require_account": REQUIRE_ACCOUNT,
        # Which pipeline is actually reachable, not which one was intended. `off` on a surface with open
        # signup is worth seeing on every read. The host, never the token — SAFETY_SCREEN_TOKEN must
        # never appear here, this is unauthenticated.
        "moderation": {"off": "disabled(dev)",
                       "unconfigured": "unconfigured(fails-closed)",
                       "guard": f"guard({urlparse(SAFETY_SCREEN_URL).netloc or 'screen'})"}[_moderation_mode()],
        # Was in prodcheck's COMPARED since the day the feature landed (config-vs-config only);
        # this is the RUNNING app's own value, same reasoning as repair_turns above — how many attempts a
        # moderation call gets moves both false-positive-502 rate and worst-case latency. (CUR-759)
        "moderation_attempts": MODERATION_ATTEMPTS,
        "output_screen": OUTPUT_SCREEN_MODE,
        "secrets_boundary": "on(gateway)" if MODEL_PROXY_URL else "OFF(legacy passthrough)",
        # sandbox, sandbox_seccomp, rlimits: what isolates the work, by backend (_isolation_report).
        **_isolation_report(),
        "sandbox_backend": SANDBOX_BACKEND.name,   # CUR-4482: where Hermes and run-code actually run
        "sandbox_account_max_live": E2B_ACCOUNT_MAX_LIVE or "off",   # CUR-4553: run-code sandboxes one account may have running
        # E2B hosts this machine has taken out for failing every ask past E2B_SLOT_AUTO_OFF_SECS; per machine.
        "sandbox_slots_auto_off": getattr(SANDBOX_BACKEND, "auto_off_slots", list)(),
        "sandbox_run_code_idle_s": E2B_RUN_CODE_IDLE_SECS,   # seconds before a run-code sandbox pauses
        "threadpool_tokens": THREADPOOL_TOKENS,
        # Separate from `rlimits` because it is enforced by a different mechanism for a different reason:
        # RLIMIT_FSIZE bounds one file, this bounds their sum, and no rlimit exists for the sum.
        "scratch_cap": f"{SCRATCH_MAX_BYTES}B/task" if SCRATCH_MAX_BYTES > 0 else "OFF(unbounded)",
        # session-scoped workdirs — idle expiry and their own, separate, session-total disk cap. (CUR-196)
        "session_idle_s": SESSION_IDLE_SECS,
        "session_scratch_cap": f"{SESSION_SCRATCH_MAX_BYTES}B/session" if SESSION_SCRATCH_MAX_BYTES > 0 else "OFF(unbounded)",
        # Two fields, deliberately. `egress` is what entrypoint.sh was ASKED to do; `egress_observed` is
        # what a connection attempt to an address outside the allowlist actually did. They can disagree,
        # and that disagreement is the whole point: a comment asserting a NetworkPolicy handles egress
        # is a claim, not a check.
        "egress": EGRESS,
        "egress_observed": _EGRESS_OBSERVED,
        # The same pair for the name half. Worth its own line rather than folding into `egress` because the
        # two fail independently: with the connect filter on and correct, any name at all can still be
        # resolved, which is a data channel the address allowlist never touches.
        "dns": DNS,
        "dns_observed": _DNS_OBSERVED,
        "keep_workdir": "on" if KEEP_WORKDIR else "off",
        # Whether the agent's files come back at all, and how much of them. `off` means a turn can describe
        # a file it wrote while the response carries nothing (CUR-195); this field makes that visible from
        # outside.
        "artifacts": "off" if ARTIFACT_MAX_FILES <= 0 else f"{ARTIFACT_MAX_FILES} files",
        "artifact_max_bytes": ARTIFACT_MAX_BYTES, "artifact_total_bytes": ARTIFACT_TOTAL_BYTES,
        "artifact_download_max_bytes": ARTIFACT_DOWNLOAD_MAX_BYTES,   # CUR-546: GET .../artifacts/{filename}'s own cap
        "step_cap": MAX_STEPS, "spend_cap": MAX_TOKENS_BUDGET or "off",
        # Reported because a judge timeout is a REJECTION (fail-closed), so this bounds latency and moves
        # verification outcomes. A run comparing itself to prod has to be able to see it.
        "judge_timeout_s": JUDGE_TIMEOUT_SECS,
        # Whether the judge sees the file it's grading against (CUR-596). A harness with a different
        # excerpt cap than prod is showing the judge more or less of the source data, changing the
        # acceptance bar on any spec'd file turn — same reasoning as judge_timeout_s above.
        "judge_excerpt_bytes": "off" if JUDGE_EXCERPT_BYTES <= 0 else JUDGE_EXCERPT_BYTES,
        # CUR-596 item 2: on this changes verification outcomes AND task cost — a run comparing itself to
        # prod has to be able to see both which value it's set to and whether it actually fires (best_of>1
        # too). Same reasoning as judge_timeout_s/judge_excerpt_bytes above.
        "value_consistency_check": "on" if VALUE_CONSISTENCY_CHECK else "off",
        "spend_cap_task": (MAX_TOKENS_BUDGET * max(1, BEST_OF)) if MAX_TOKENS_BUDGET else "off",
        "check_cmd": "disabled" if CHECK_CMD_DISABLED else "enabled",
        # Named `caller_*`, not `user_*`, because the bucket key is the authenticated token subject and chat
        # holds one token for every visitor — see the constants. `subject_daily_tasks` is the per-visitor
        # allowance and only bites once a caller sends X-Agent-Subject, so `off` here while the caller limit
        # is set is the normal state until the header lands, not a missing control.
        "caller_daily_tokens": CALLER_DAILY_TOKENS or "off", "caller_daily_tasks": CALLER_DAILY_TASKS or "off",
        "subject_daily_tasks": SUBJECT_DAILY_TASKS or "off",
        "subject_max_concurrency": SUBJECT_MAX_CONCURRENCY or "off",
        # Which spelling the running process actually read. A rename whose old name still works is invisible
        # otherwise: config left on `AGENT_USER_DAILY_TASKS` behaves identically and drifts forever. Empty
        # means neither was set, i.e. the quota is off because nothing asked for it.
        "quota_vars": " ".join(v for v in (CALLER_TASKS_VAR, CALLER_TOKENS_VAR) if v) or "unset",
        # COUNT, not names. /healthz needs no auth, and these are precisely the callers exempt from the
        # task and token quotas — publishing which `sub` to aim for is a free hint on the one value worth
        # forging. The count still answers "is anyone exempt", which is what operating on it requires.
        "operator_subs": len(OPERATOR_SUBS),
        "persistence": "postgres" if TASKS_DATABASE_URL else "sqlite", "tasks_live": n_live, "tasks_stuck": n_stuck, "tasks_retained": n_tasks,
        "tasks_total": store.count(), "max_tasks": MAX_TASKS,
        "task_retention_s": TASK_RETENTION_SECS or "forever", "webhook_egress": "private-ok(dev)" if WEBHOOK_ALLOW_PRIVATE else "public-only",
        "metrics_auth": "token" if METRICS_TOKEN else "open",
        "inflight": inflight, "max_concurrency": MAX_CONCURRENCY,
        # A sink whose own failures are invisible reproduces the bug it was built to fix, so its
        # dropped/failed counters are reported rather than merely kept.
        "logsink": logsink.stats(),
    }


@app.get("/metrics")
def metrics(authorization: str | None = Header(default=None)) -> PlainTextResponse:
    """Prometheus text-format metrics (aggregate counters only — no per-user/secret data). Scrape target for
    the inherited telemetry stack (§6A). If AGENT_METRICS_TOKEN is set, require it as a bearer token."""
    if METRICS_TOKEN and authorization != f"Bearer {METRICS_TOKEN}":
        raise HTTPException(401, "metrics require a bearer token")
    with _METRICS_LOCK:
        snap = dict(_METRICS)
    with _INFLIGHT_LOCK:
        snap["agent_inflight"] = _inflight
    lines = []
    for k, v in snap.items():
        kind = "gauge" if k == "agent_inflight" else ("counter" if k.endswith("_total") else "gauge")
        lines.append(f"# TYPE {k} {kind}")
        lines.append(f"{k} {v}")
    return PlainTextResponse("\n".join(lines) + "\n")
