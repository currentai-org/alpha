"""
Public AI Agent Service — model-boundary gateway (brief §6B.1 secrets-at-boundary + §6B caps).

ONE owned chokepoint in front of Plane A that solves four interlocks the Hermes one-shot CLI cannot
enforce itself (the `hermes -z` path ignores config `max_turns`, and passing the real
upstream token through to the agent subprocess env is the known exfil gap):

  1. SECRETS BOUNDARY — the agent subprocess is given a per-task NONCE as its HF_TOKEN (Hermes' own
     hardcoded credential env var — see below), never the real one. This proxy holds the real
     MODEL_UPSTREAM_TOKEN and swaps it onto the outbound request. An agent with a shell can read its own
     env and find only the nonce, which is useless off-host and already budget-bound to its own task.
  2. STEP-CAP — counts model calls per nonce; rejects past max_requests. This is the iteration cap the
     CLI won't let us set.
  3. SPEND-CAP — sums SSE `usage` tokens per nonce; rejects further calls past max_tokens. Caveats it
     is honest about: it is a per-CALL-granularity ceiling (a single in-flight call can overshoot by up
     to one request's tokens — bounded by the model's max_tokens + context_length), and it depends on
     upstream emitting `usage` in the stream. If usage never appears, the cap can't bind — revoke()
     surfaces `usage_seen:false` so the caller knows the spend-cap was inert and the REQUEST cap was the
     only backstop.
  4. COMPUTE-ROUTER (the PRD "compute-router" module) — an ORDERED, sovereign-first provider list
     (MODEL_PROVIDERS) with failover.
     One provider's outage/overload doesn't take the agent down, and "where the model ran" becomes a
     routing fact this boundary owns + reports (x-agent-provider header, /healthz chain) — the basis for
     honest provenance. Failover fires only on availability signals (transport error / 5xx / 429 / 408);
     4xx is forwarded unmasked so config/request errors surface. Per-provider `model` rewrite handles the
     same open weights carrying different catalog ids across providers. Unset → legacy single upstream.

Wire (per task, set by api/app.py): provider stays `huggingface`; the agent subprocess gets
HF_BASE_URL=http://127.0.0.1:<port>/v1 and HF_TOKEN=<nonce> — Hermes' `huggingface` provider plugin
hardcodes these two exact names (hermes_cli/auth.py), so they're fixed regardless of the real upstream;
Hermes then streams chat completions here with `Authorization: Bearer <nonce>`; this proxy validates +
meters + swaps + stream-forwards to the real upstream (router.huggingface.co, or MODEL_UPSTREAM_BASE).

Run:  MODEL_UPSTREAM_TOKEN=<real> PROXY_ADMIN_KEY=<shared-with-app> uvicorn proxy:app --port 8732
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import random
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import logsink
from aiolimiter import AsyncLimiter
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

UPSTREAM_BASE = os.environ.get("MODEL_UPSTREAM_BASE", "https://router.huggingface.co/v1")
REAL_TOKEN = os.environ.get("MODEL_UPSTREAM_TOKEN", "")   # the real credential — lives ONLY in this process
PROXY_ADMIN_KEY = os.environ.get("PROXY_ADMIN_KEY", "")   # shared secret so only app.py can grant/revoke
UPSTREAM_TIMEOUT = float(os.environ.get("MODEL_UPSTREAM_TIMEOUT", "120"))
# A call that STALLS is a different failure from a call that is slow, and it needs its own instrument.
# A stalled call opens the stream and then goes silent, and on a single-provider chain with nowhere to
# fail over it holds the whole UPSTREAM_TIMEOUT, a large share of the app's wall clock, on one call.
# **Do not handle that by lowering UPSTREAM_TIMEOUT**: httpx
# applies it as a READ timeout per chunk of a streamed response, so a long inter-frame silence is legal
# and any threshold under it kills healthy calls mid-answer. Time-to-first-token is separable and, unlike
# inter-frame gap, is short and tightly bounded for a healthy call, so a 30s first-token limit sits far
# above any healthy first token and far below the stall.
FIRST_TOKEN_TIMEOUT = float(os.environ.get("MODEL_FIRST_TOKEN_TIMEOUT", "30"))
# Opens per client request before giving up with a 504. 2 bounds a persistently silent upstream at ~60s
# instead of looping. The retry re-sends the prompt, and the abandoned attempt meters ZERO,
# because a response that never streamed never reported a usage block. That under-reports real upstream
# spend by exactly the stalls, which is why `router.stall` is logged rather than silently retried.
FIRST_TOKEN_ATTEMPTS = max(1, int(os.environ.get("MODEL_FIRST_TOKEN_ATTEMPTS", "2")))
GRANT_TTL_SECS = int(os.environ.get("GRANT_TTL_SECS", "3600"))   # a nonce self-expires (covers app crash before revoke)
MAX_GRANTS = int(os.environ.get("MAX_GRANTS", "10000"))          # backstop against unbounded grant growth
GRANT_MAX_REQUESTS = int(os.environ.get("GRANT_MAX_REQUESTS", "1000"))  # hard ceiling per grant — gateway-side clamp so an absurd cap can't slip through (defense-in-depth vs app clamp)
GRANT_MAX_TOKENS = int(os.environ.get("GRANT_MAX_TOKENS", "0"))         # hard token ceiling per grant (0 = no gateway-side token ceiling)
# Some upstream inference backends (e.g. HF-router-served Apertus models)
# front a WAF that 403-blocks Python-HTTP-client User-Agents (python-httpx, Python-urllib,
# OpenAI/Python) as bots — while allowing curl/browser UAs. Hermes uses the OpenAI Python SDK, so
# without this its requests get "HTTP 403: Your request was blocked" and the agent produces no
# output. Normalizing the UA at this boundary fixes it for every model with no Hermes fork.
# (Allowlisting the agent UA on the backend would make this unnecessary; this is the safe default.)
UPSTREAM_USER_AGENT = os.environ.get("UPSTREAM_USER_AGENT", "curl/8.5.0")
# Diagnostic: log secret-free metadata about each upstream request (model, tool_choice, temperature,
# tool/message counts, roles — NEVER content). Off by default; set PROXY_LOG_REQUESTS=1 to see exactly
# what the harness sends — e.g. to debug why a model tool-calls on a raw curl but not through Hermes.
LOG_REQUESTS = os.environ.get("PROXY_LOG_REQUESTS", "") not in ("", "0", "false")
# Interim Apertus fix: some upstreams (the HF-routed `publicai` Apertus provider)
# run the tool-call parser ONLY on their non-streaming codepath — a streamed request returns the tool
# call as plain-text content, so an agent that always streams (Hermes) never sees a tool call. When this
# is set, the proxy DE-STREAMS: it calls upstream with stream=false (parser engaged → real tool_calls),
# then re-emits the result to the client as a synthetic SSE stream. The client (Hermes) sees a normal
# streamed tool call and needs no changes. Cost: the final answer arrives in one delta rather than
# token-by-token (fine for agent/tool turns; -z has no display anyway). Drop this once the provider
# parses tool calls while streaming.
#
# Off by default: that provider is no longer on the path, and the flag distorts every inter-frame
# measurement taken while it is on. Two things to know
# before turning it on: there is no stream, so FIRST_TOKEN_TIMEOUT does not apply and a stalled call
# burns the full UPSTREAM_TIMEOUT with no retry; and gap distributions measured under it
# quantize to whole-call latency, because no frame can arrive mid-call.
DESTREAM = os.environ.get("PROXY_DESTREAM", "") not in ("", "0", "false")
# Force the model to answer with a tool call instead of prose. The dominant long-horizon failure is the
# model writing the whole deliverable into a chat message and calling nothing, so no file is written.
# `scripts/modelcheck.py --tool-choice` measures the fix: the `folded` control makes no tool calls under
# "auto" and calls a tool every time under "required", so the endpoint enforces the
# constraint rather than passing it through. Wording cannot make prose impossible; this can.
FORCE_TOOL_CHOICE = os.environ.get("PROXY_FORCE_TOOL_CHOICE", "") not in ("", "0", "false")
# Compute-router (the PRD "compute-router" module). The boundary routes across an ORDERED, sovereign-first
# list of providers with failover, so a single provider's outage/overload doesn't take the agent down — and
# so "where the model ran" is a routing fact this chokepoint owns (provenance honesty). Statuses that mean
# "this provider is unavailable/overloaded" (not "the request is bad") trigger failover; everything
# else (2xx, 4xx) is forwarded as-is so config/request errors surface loudly instead of being masked.
FAILOVER_STATUSES = {int(s) for s in os.environ.get("ROUTER_FAILOVER_STATUSES", "408,429,500,502,503,504").split(",") if s.strip().isdigit()}
# The LAST provider in the chain (with MODEL_PROVIDERS unset, the only one) has nobody to fail over to,
# so `_open_stream_failover`'s `i < len(provs) - 1` guard is never true for it, and a single 502/503/504
# there would go straight to the caller as a blank turn. A transient 5xx on the same upstream can clear
# on an immediate retry, so such a call gets one bounded retry in place before the status is returned. Short backoff: this is a live user waiting on a stream, not a batch job.
SAME_PROVIDER_RETRY_ATTEMPTS = max(1, int(os.environ.get("MODEL_SAME_PROVIDER_RETRY_ATTEMPTS", "2")))


def _flag(name: str) -> bool:
    """Env truthiness, matching the module's existing convention (unset/0/false = off)."""
    return os.environ.get(name, "") not in ("", "0", "false")


@dataclass
class Provider:
    """One upstream in the failover list. The same open weights are served under DIFFERENT catalog ids per
    provider (Infomaniak product-id path vs HF `swiss-ai/Apertus-…` vs a self-hosted name), so `model` is an
    optional per-provider rewrite of the request's `model` field. `token` is a secret — NEVER logged.

    `no_cache` marks an upstream that answers from a RESPONSE cache — a property of the upstream, like
    `model` is, not of the request. See `_no_cache` for why we opt out of it.

    `bill_to` is HF's `X-HF-Bill-To` org-billing header — Current AI's HF org tier has no org-owned
    service token, so an HF-routed provider authenticates as a personal token; this attributes the
    spend to the org. Same pattern as endpointOai.ts."""
    name: str
    base_url: str
    token: str = ""
    model: str = ""
    no_cache: bool = False
    bill_to: str = ""
    # the app's model id -> this provider's wire id, for a provider that serves more than one
    # model. Set, it replaces `model`: a request naming a model the map lacks is not this provider's to
    # serve, and is never rewritten to some other model (`routable`). Keys are lower case.
    model_map: dict[str, str] = field(default_factory=dict)
    # App model ids whose calls carry LiteLLM's `disable_fallbacks`, because the router's backup for them
    # is a different model under the same name (Large 4 -> Bedrock's Large 3, web gatewayFallbackGate.ts).
    no_fallback: frozenset[str] = frozenset()
    # Request fields a model needs that the caller doesn't send, keyed by app model id; the caller's own
    # value always wins. `model_extra` goes on every call, `model_unstreamed_extra` only on stream=false
    # calls. On the gateway, Large 4 answers 400 to temperature 0 unless
    # top_p is 1, and 500 after ~36 s to an unstreamed call unless reasoning is off; Large 3 answers 400 to
    # any reasoning_effort, so neither can be set provider-wide.
    model_extra: dict[str, dict] = field(default_factory=dict)
    model_unstreamed_extra: dict[str, dict] = field(default_factory=dict)
    # app model ids whose stream=false calls go upstream streamed and come back joined into one
    # completion (`_restream`). The gateway 400s Large 4 on reasoning_effort none and 500s every other
    # unstreamed call after a long wait, while a streamed call answers promptly.
    stream_upstream: frozenset[str] = frozenset()

    def routable(self, model: str) -> bool:
        """Whether this provider may serve a request naming `model`. A provider with no map takes anything; one with a map takes only what it names."""
        return not self.model_map or (model or "").strip().lower() in self.model_map

    def wire_model(self, model: str) -> str:
        """The id this provider is sent for `model`: its map entry, else the single `model` rewrite, else
        `model` itself."""
        if self.model_map:
            return self.model_map.get((model or "").strip().lower(), model)
        return self.model or model

    @property
    def pinned(self) -> str:
        """The inference provider this route pins through HF's `model:provider` suffix
        (`zai-org/GLM-5.2:scaleway` → "scaleway"), or "" when the route leaves the choice to the router.
        a pin is a request-side claim, so `_record_backend` checks it against the response."""
        return self.model.rsplit(":", 1)[1].strip().lower() if ":" in self.model else ""


def _id_list(raw: str) -> list[str]:
    """`a, b` -> ["a", "b"], lower case, blanks dropped."""
    return [x.strip().lower() for x in raw.split(",") if x.strip()]


def _parse_model_map(raw: str) -> dict[str, str]:
    """`PROVIDER_<NAME>_MODEL_MAP`: `app-id=wire-id,app-id=wire-id` -> {app id (lower case): wire id}.
    An entry with no `=` or an empty side is dropped rather than guessed at, so a typo makes a model
    unroutable (a refusal the app reports) instead of routing it somewhere unnamed."""
    out: dict[str, str] = {}
    for item in raw.split(","):
        app_id, sep, wire = item.partition("=")
        if sep and app_id.strip() and wire.strip():
            out[app_id.strip().lower()] = wire.strip()
    return out


def _per_model_json(name: str) -> dict[str, dict]:
    """`PROVIDER_<NAME>_MODEL_EXTRA`-style env: a JSON object of {app model id: {field: value}}, or {} when
    unset. Anything else raises at import, so a typo fails the deploy's health check instead of quietly
    sending no fields."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return {}
    val = json.loads(raw)
    if not isinstance(val, dict) or not all(isinstance(v, dict) for v in val.values()):
        raise ValueError(f"{name} must be a JSON object of {{model id: {{field: value}}}}")
    return {str(k).strip().lower(): v for k, v in val.items()}


def _load_providers() -> list[Provider]:
    """Build the ordered provider list from env. `MODEL_PROVIDERS=infomaniak,lumi,cscs` names the chain
    (sovereign anchor first); each <NAME> reads PROVIDER_<NAME>_BASE / _TOKEN / _MODEL (token in its own
    secret env var, never inline). Back-compat: with MODEL_PROVIDERS unset, synthesize a single provider
    from the legacy MODEL_UPSTREAM_BASE + MODEL_UPSTREAM_TOKEN — i.e. today's single-upstream behavior,
    unchanged."""
    out: list[Provider] = []
    for n in [x.strip() for x in os.environ.get("MODEL_PROVIDERS", "").split(",") if x.strip()]:
        key = n.upper().replace("-", "_")
        base = os.environ.get(f"PROVIDER_{key}_BASE", "").rstrip("/")
        token = os.environ.get(f"PROVIDER_{key}_TOKEN", "")
        if base and token:                                    # a provider with no base/token is skipped (not half-configured)
            out.append(Provider(name=n, base_url=base, token=token, model=os.environ.get(f"PROVIDER_{key}_MODEL", ""),
                                no_cache=_flag(f"PROVIDER_{key}_NO_CACHE"),
                                bill_to=os.environ.get(f"PROVIDER_{key}_BILL_TO", "").strip(),
                                model_map=_parse_model_map(os.environ.get(f"PROVIDER_{key}_MODEL_MAP", "")),
                                no_fallback=frozenset(_id_list(os.environ.get(f"PROVIDER_{key}_NO_FALLBACK_MODELS", ""))),
                                model_extra=_per_model_json(f"PROVIDER_{key}_MODEL_EXTRA"),
                                model_unstreamed_extra=_per_model_json(f"PROVIDER_{key}_MODEL_UNSTREAMED_EXTRA"),
                                stream_upstream=frozenset(_id_list(os.environ.get(f"PROVIDER_{key}_STREAM_UPSTREAM_MODELS", "")))))
    if not out and REAL_TOKEN:
        out.append(Provider(name=os.environ.get("AGENT_COMPUTE_PROVIDER", "") or "primary",
                            base_url=UPSTREAM_BASE.rstrip("/"), token=REAL_TOKEN,
                            model=os.environ.get("MODEL_UPSTREAM_MODEL", "")))
    return out


PROVIDERS: list[Provider] = _load_providers()


def routable_models(providers: list[Provider] | None = None) -> list[str]:
    """The app model ids this gateway can route, for the app's per-task model check.

    Only a chain whose every provider carries a MODEL_MAP can say: a provider with none rewrites every
    request to its one model, so it can honestly route only the app's default, and the answer is [].
    The app reads [] as "the default model only" and refuses any other, which is the safe reading."""
    provs = PROVIDERS if providers is None else providers
    if not provs or any(not p.model_map for p in provs):
        return []
    return sorted({k for p in provs for k in p.model_map})


# requests a minute this gateway sends a model, per model, for models whose account limit is
# shared with chat (`MODEL_RPM_LIMITS=mistral-large-2512=60`). Once tasks run on the person's pick, a
# handful of agent tasks on Large 3 could take its whole shared allowance, so the gateway takes a share.
# Per process: the gateway runs one machine. A call over the limit waits up to MODEL_RPM_MAX_WAIT_SECS for
# room (aiolimiter's leaky bucket), then is refused with 429, which Hermes retries.
MODEL_RPM_MAX_WAIT_SECS = float(os.environ.get("MODEL_RPM_MAX_WAIT_SECS", "20"))


def _load_rpm_limits(raw: str) -> dict[str, AsyncLimiter]:
    out: dict[str, AsyncLimiter] = {}
    for app_id, per_minute in _parse_model_map(raw).items():
        if per_minute.isdigit() and int(per_minute) > 0:
            out[app_id] = AsyncLimiter(int(per_minute), 60)
    return out


RPM_LIMITERS: dict[str, AsyncLimiter] = _load_rpm_limits(os.environ.get("MODEL_RPM_LIMITS", ""))


def _load_verifier() -> Provider | None:
    """The fusion VERIFIER route — a SEPARATE upstream for the verifier model (a decorrelated model that
    judges the executor, e.g. gpt-oss-120b on HF). Selected by model-id match, NOT part of the primary
    failover chain (different weights, different host). Boundary preserved: the proxy holds the verifier
    token; the app still passes only a nonce. Configured by MODEL_VERIFIER_{MODEL,BASE,TOKEN}; unset → the
    verifier model (if any) just falls through the normal chain. model="" → no rewrite (the app already sends
    the right catalog id).

    MODEL_VERIFIER_BILL_TO is optional (see Provider.bill_to) — no-op against a non-HF host."""
    m = os.environ.get("MODEL_VERIFIER_MODEL", "").strip()
    base = os.environ.get("MODEL_VERIFIER_BASE", "").strip()
    token = os.environ.get("MODEL_VERIFIER_TOKEN", "").strip()
    if m and base and token:
        return Provider(name="verifier", base_url=base.rstrip("/"), token=token, model="",
                        no_cache=_flag("MODEL_VERIFIER_NO_CACHE"),
                        bill_to=os.environ.get("MODEL_VERIFIER_BILL_TO", "").strip())
    return None


VERIFIER_MODEL = os.environ.get("MODEL_VERIFIER_MODEL", "").strip()
VERIFIER: Provider | None = _load_verifier()


def _providers_for(body: bytes) -> list[Provider]:
    """Pick the upstream list for this request: the dedicated verifier upstream when the request's model is
    the configured verifier model (single provider, no failover, no rewrite), else the normal failover chain."""
    if VERIFIER is not None and VERIFIER_MODEL:
        try:
            if json.loads(body).get("model") == VERIFIER_MODEL:
                return [VERIFIER]
        except Exception:  # noqa: BLE001 — malformed body: normal chain (it'll 4xx there, unmasked)
            pass
    return PROVIDERS


@dataclass
class Grant:
    max_requests: int
    max_tokens: int                # 0 = no token cap (request cap still applies)
    expires_at: float              # monotonic deadline; self-expires so a crashed app can't leave it live
    used_requests: int = 0
    used_tokens: int = 0
    usage_seen: bool = False       # did upstream ever emit a usage block? (if not, the spend-cap was inert)
    rejected: int = 0              # # of calls refused by the step/spend cap — the AUTHORITATIVE "was the agent throttled" signal app.py trusts (vs string-matching stdout)
    # Forensic identity for the operational log. The nonce is the per-task BEARER TOKEN to this gateway and
    # never goes to disk; app.py supplies a task id and attempt number instead, so a router.failover line can
    # name which trial and which best-of attempt it belongs to. attempt=0 means the grant is not an agent
    # attempt (the derive, judge and route calls each take their own single-request grant).
    label: str = ""
    attempt: int = 0
    # the app model id this grant may spend on, or "" for any (the derive/judge/route side calls).
    # Every call on a pinned grant goes out as this model whatever its body names, so an agent with the
    # nonce in its shell cannot spend its task's budget on a different, scarcer model.
    model: str = ""
    # The model ids upstream reported serving on this grant's calls, read off each response. Returned on
    # revoke so the task records what actually ran, not only what was asked for.
    served_models: set[str] = field(default_factory=set)


_GRANTS: dict[str, Grant] = {}
_LOCK = threading.Lock()

app = FastAPI(title="Agent Service — model boundary gateway", version="0.4.0")


def _require_admin(authorization: str | None) -> None:
    if not PROXY_ADMIN_KEY:
        raise HTTPException(503, "PROXY_ADMIN_KEY not configured — gateway refuses to grant (fail closed)")
    if not hmac.compare_digest((authorization or "").encode(), f"Bearer {PROXY_ADMIN_KEY}".encode()):
        raise HTTPException(401, "bad admin key")


def _purge_expired_locked(now: float) -> None:
    """Drop grants past their TTL. Caller holds _LOCK."""
    for n in [n for n, g in _GRANTS.items() if g.expires_at <= now]:
        _GRANTS.pop(n, None)


def _live_grant_locked(nonce: str, now: float) -> Grant | None:
    """Return the grant if present AND not expired (popping it if expired). Caller holds _LOCK."""
    g = _GRANTS.get(nonce)
    if g is None:
        return None
    if g.expires_at <= now:
        _GRANTS.pop(nonce, None)
        return None
    return g


class GrantReq(BaseModel):
    nonce: str = Field(min_length=8)            # unguessable per-task token
    max_requests: int = Field(default=90, ge=1)  # >=1 (a 0 cap would just guarantee failure)
    max_tokens: int = Field(default=0, ge=0)     # 0 = no token cap
    ttl_secs: int | None = Field(default=None, ge=1)  # optional override of GRANT_TTL_SECS
    label: str = Field(default="", max_length=64)     # task id, for the operational log (never the nonce)
    attempt: int = Field(default=0, ge=0)             # best-of attempt number; 0 = derive/judge/route grant
    model: str = Field(default="", max_length=200)    # pin every call on this grant to this model


@app.post("/admin/grant")
def grant(req: GrantReq, authorization: str | None = Header(default=None)) -> dict:
    """app.py registers a per-task nonce with its caps before launching the agent."""
    _require_admin(authorization)
    now = time.monotonic()
    ttl = req.ttl_secs or GRANT_TTL_SECS
    # Gateway-side clamp: a grant can never exceed the gateway's own ceiling, even if the caller (app.py,
    # which also clamps) or a holder of the admin key asks for more (an absurd max_requests must be
    # clamped). 0 = off for tokens; the ceiling only binds when set.
    max_requests = min(req.max_requests, GRANT_MAX_REQUESTS)
    max_tokens = req.max_tokens
    if GRANT_MAX_TOKENS > 0:
        max_tokens = GRANT_MAX_TOKENS if req.max_tokens == 0 else min(req.max_tokens, GRANT_MAX_TOKENS)
    with _LOCK:
        _purge_expired_locked(now)
        if req.nonce not in _GRANTS and len(_GRANTS) >= MAX_GRANTS:
            raise HTTPException(503, f"gateway at capacity ({MAX_GRANTS} active grants)")
        _GRANTS[req.nonce] = Grant(max_requests=max_requests, max_tokens=max_tokens, expires_at=now + ttl,
                                   label=req.label, attempt=req.attempt, model=req.model.strip())
    return {"ok": True, "ttl_secs": ttl, "max_requests": max_requests, "max_tokens": max_tokens,
            "model": req.model.strip() or None}


@app.delete("/admin/grant/{nonce}")
def revoke(nonce: str, authorization: str | None = Header(default=None)) -> dict:
    """app.py revokes the nonce when the task ends; returns the final tally for the two-tier log.
    `usage_seen` tells the caller whether the spend-cap was actually able to meter (vs inert)."""
    _require_admin(authorization)
    with _LOCK:
        g = _GRANTS.pop(nonce, None)
    if not g:
        return {"ok": True, "requests": 0, "tokens": 0, "usage_seen": False, "cap_hit": False, "served_models": []}
    return {"ok": True, "requests": g.used_requests, "tokens": g.used_tokens,
            "usage_seen": g.usage_seen, "cap_hit": g.rejected > 0, "served_models": sorted(g.served_models)}


def _nonce_from(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer nonce")
    return authorization.split(" ", 1)[1]


def _plog(event: str, **fields) -> None:
    """Emit one operational log line, epoch-stamped. Every proxy event goes through here.

    The stamp is the point: without it the proxy log is an ordered list, not a timeline, so per-call
    latency cannot be recovered from it, and a stalled upstream call cannot be told apart from several slow
    serves. Matches the app log's
    `ts` field (api/app.py `_log_event`) so the two can be merged on one axis — which is only a real
    merge once both planes reach the same sink, hence the logsink.emit below (a no-op without a
    token). `upstream.error`'s `body` is a provider's error text and is redacted on the way out."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    logsink.stdout_line(rec)
    logsink.emit(rec)


logsink.init("gateway")   # no-op unless AXIOM_TOKEN is set; see app.py for why this is at import


def _prefix_sha(tools: list, msgs: list) -> str:
    """Short digest of the part of a request that should be byte-identical from call to call.

    Content-free by the same contract as _request_meta: a digest, never the text. Covers the tool schemas
    and the leading system message — everything up to the first turn-specific token."""
    lead = [m for m in msgs[:1] if isinstance(m, dict) and m.get("role") == "system"]
    blob = json.dumps([tools, [m.get("content") for m in lead]], sort_keys=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def _request_meta(body: bytes) -> dict:
    """Secret-free shape of an upstream chat request (for PROXY_LOG_REQUESTS). NEVER includes message
    content or tool arguments — only ids/params/counts, per the same no-secrets contract as the app log."""
    try:
        d = json.loads(body)
    except (ValueError, TypeError):
        return {"parse": "non-json", "bytes": len(body)}
    msgs = d.get("messages") if isinstance(d.get("messages"), list) else []
    tools = d.get("tools") if isinstance(d.get("tools"), list) else []
    return {
        "model": d.get("model"),
        "tool_choice": d.get("tool_choice"),
        "temperature": d.get("temperature"),
        "stream": d.get("stream"),
        "bytes": len(body),          # request size, to read against upstream's prompt_tokens
        "n_tools": len(tools),
        "n_messages": len(msgs),
        "roles": [m.get("role") for m in msgs if isinstance(m, dict)],
        # Fingerprint of the cacheable prefix — the tool schemas plus the system message, in the exact
        # order they go on the wire. It must be CONSTANT across a run's calls. Measured against CSCS with a
        # warm-up control and two prefix sizes: a repeated prefix reaches first token in
        # 0.38s where a novel one takes 0.82s, and the gap grew from 0.22s to 0.43s as the prefix grew
        # from 3.6k to 6.3k tokens — the server skips prefill on a prefix it has already seen. At the real
        # ~9.8k-token prefix that is most of a second per call, on every call. A prefix cache is
        # unforgiving: one varying byte near the front turns every hit into a miss while every other
        # number in the log looks exactly the same. This field is how that becomes visible instead.
        "prefix_sha": _prefix_sha(tools, msgs),
    }


def _provider_headers(prov: Provider, accept: str | None = None) -> dict:
    """Headers for a call to `prov`: the secret-swapped auth (this provider's real token) + a WAF-allowed
    user-agent. The agent's own UA is NEVER passed through — some backends 403-block python-httpx/OpenAI-SDK
    UAs as bots (see UPSTREAM_USER_AGENT). content-type is harmless on the GET /models probe."""
    h = {"authorization": f"Bearer {prov.token}", "content-type": "application/json",
         "user-agent": UPSTREAM_USER_AGENT}
    if accept:
        h["accept"] = accept
    if prov.bill_to:
        h["X-HF-Bill-To"] = prov.bill_to
    return h


def _rewrite_model(body: bytes, prov: Provider, unstreamed: bool | None = None) -> bytes:
    """Rewrite the request's `model` to this provider's catalog id when one is configured (same weights,
    different id per provider). No-op if the provider has no override or the body isn't a JSON object.

    a provider with a MODEL_MAP is sent the mapped id for the model the body names, plus
    `disable_fallbacks` for a model whose router backup is another model, plus that model's extra fields
    (`Provider.model_extra`, and `model_unstreamed_extra` when the body is not streamed). A caller only
    reaches here with a model the provider can route (`Provider.routable`). `unstreamed=True` marks a call
    the caller sent unstreamed and `_restream` streams upstream, so it keeps that call's extra."""
    if not prov.model and not prov.model_map:
        return body
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001
        return body
    if not isinstance(d, dict):
        return body
    asked = str(d.get("model") or "")
    key = asked.strip().lower()
    d["model"] = prov.wire_model(asked)
    if key in prov.no_fallback:
        d["disable_fallbacks"] = True
    extra = dict(prov.model_extra.get(key) or {})
    if unstreamed or not d.get("stream"):
        extra.update(prov.model_unstreamed_extra.get(key) or {})
    if extra:
        d = {**extra, **d}                                     # the caller's own value wins
    return json.dumps(d).encode()


def _no_cache(body: bytes, prov: Provider) -> bytes:
    """Opt this request out of the upstream's RESPONSE cache. PURE. No-op unless `prov.no_cache`.

    Our LiteLLM gateway caches whole completions keyed on the request: identical POSTs return the same
    `x-litellm-cache-key` at 84-156ms, and the same body with `cache: {"no-cache": true}` returns no cache
    key at ~380ms. So the cache is on, and this field turns it off.

    A cache is the wrong shape for this traffic in two separate ways, and only the second is obvious:

      1. best-of-N deliberately sends the SAME first request per attempt — same system prompt, same task,
         empty history. Its whole premise is that attempt 2 might differ from attempt 1. Against a cache
         it cannot: attempt 2 opens with attempt 1's exact response and diverges only if a tool result
         later differs. That is best-of-1 charged at best-of-3's wall clock. (CSCS-direct decorrelates
         weakly rather than not at all — 5 identical requests, 2 distinct outputs — so this is a real
         loss of the little variance we had, not a loss of variance we imagined.)
      2. Within ONE attempt, an agent that repeats a call with identical messages is looping. Uncached,
         it has some chance of sampling its way out. Cached, the loop is guaranteed.

    Per-provider rather than per-host: the flag describes the upstream, so it cannot drift when a base URL
    changes, and CSCS-direct never sees a field it might reject. Touches neither `messages` nor `tools`,
    so `_prefix_sha` and the upstream PREFIX cache (a different thing, and one we want) are unmoved."""
    if not prov.no_cache:
        return body
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001 — non-JSON body forwards untouched, same as _rewrite_model
        return body
    if not isinstance(d, dict) or "cache" in d:               # a caller that already decided is not guessing
        return body
    d["cache"] = {"no-cache": True}
    return json.dumps(d).encode()


# Where the model ACTUALLY ran, read off the response instead of inferred from the base URL we dialed.
#
# A gateway host implies nothing about the backend behind it: the gateway can route one model name to
# several backends in different countries. Pinning the executor to one direct host protects provenance by
# avoidance, which stops working once the executor moves onto the gateway. So: assert per response,
# falsifiably, rather than assume per config.
BACKEND_HEADER = "x-litellm-model-api-base"

# The hosts whose catalog org is in Switzerland, the same set the chat app's `backendIsSwiss()` reads.
# Generated from the catalog's host table (BACKEND_HOSTS, web/src/lib/chat/routing/catalog.ts) by
# `pnpm gen:served-backends` into served_backends.json beside this file, which the image's `COPY api/`
# carries. It includes `api.swissai.svc.cscs.ch`, CSCS's direct host that this service dials. A missing
# or unreadable file raises at import: a proxy that cannot place a backend must not start and call
# every one unknown.
SWISS_BACKENDS = frozenset(
    json.loads((Path(__file__).resolve().with_name("served_backends.json")).read_text("utf-8"))["swissHosts"]
)


def _backend_of(headers) -> str:
    """The upstream's own report of which host served the completion. "" when it doesn't say — which is
    the normal case for a direct provider, and is NOT the same as "somewhere unapproved"."""
    try:
        return urllib.parse.urlsplit(headers.get(BACKEND_HEADER, "")).hostname or ""
    except Exception:  # noqa: BLE001 — an unparseable header is not worth failing a served request over
        return ""


# Hugging Face's router names the inference provider that served the call in this response header
# (`x-inference-provider: scaleway`, present on both stream modes). The value is a provider
# name, so it is recorded in its own field beside the backend host.
HF_PROVIDER_HEADER = "x-inference-provider"


def _served_by(headers) -> str:
    """The provider HF's router reports for this call, lowercased; "" off the HF router."""
    return (headers.get(HF_PROVIDER_HEADER, "") or "").strip().lower()


def _backend_swiss(host: str) -> bool | None:
    """True/False for a host we can place; None when the upstream named none. None must never be read as
    True: unknown is the state an unplaced backend hides in."""
    return None if not host else host in SWISS_BACKENDS


DONE_TOOL_NAME = "task_complete"   # Hermes' synthetic terminator; see _force_tool_choice


def _force_tool_choice(body: bytes) -> bytes:
    """Rewrite `tool_choice` to "required" when the request carries an in-band way to STOP. PURE.

    "required" removes the loop's natural termination — a no-tool-call text response is how a turn ends,
    and under forced choice the model can never emit one. Hermes solves that with `HERMES_DONE_TOOL`, a
    synthetic `task_complete` tool whose call the conversation loop intercepts as the final answer. The
    two halves have to travel together or the agent runs until the wall clock every single time.

    So the presence of `task_complete` in the request's own tool list IS the precondition, checked here
    rather than stated in a comment telling an operator to set two env vars. Hermes' half exists and ours
    did not: `agent/done_tool.py` says the forcing comes from "the weak-model profile", and that profile
    is not in the checkout — the string appears in that docstring and nowhere else in the tree. Enabling
    HERMES_DONE_TOOL alone therefore opens an escape hatch for a constraint nothing applies.

    Leaves an explicit "none"/named-function choice alone — a caller that already decided is not guessing.
    Touches neither `messages` nor `tools`, so the upstream prefix cache (see `_prefix_sha`) is unmoved."""
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001 — non-JSON body forwards untouched, same as _rewrite_model
        return body
    if not isinstance(d, dict) or d.get("tool_choice") not in (None, "auto"):
        return body
    tools = d.get("tools")
    if not isinstance(tools, list):
        return body
    names = {t.get("function", {}).get("name") for t in tools if isinstance(t, dict)}
    if DONE_TOOL_NAME not in names:
        return body                    # no way to stop → forcing would trap the loop, so don't
    d["tool_choice"] = "required"
    return json.dumps(d).encode()


def _grant_identity(nonce: str | None) -> dict:
    """The grant's task id + attempt, for attributing an operational log line to the trial that caused it.
    Empty when there is no nonce or the grant is gone. **The nonce itself is a bearer token and is never
    returned** — only `Grant.label`, which the app sets to a task id.

    Without this an operational line is unattributable: with several trials in one run, nothing says which
    trial a stall belongs to. `attempt` matters for the
    same reason: a stall on attempt 1 that succeeds on attempt 2 averages the same per call as
    one genuinely slow serve, so without it the fast-retry and slow-serve cases stay merged."""
    if not nonce:
        return {}
    with _LOCK:
        g = _GRANTS.get(nonce)
    return {"task": g.label, "attempt": g.attempt} if g is not None else {}


def _log_failover(frm: Provider, reason: str, nonce: str | None = None) -> None:
    """Secret-free operational log when the router advances past a provider (rare + important)."""
    _plog("router.failover", **{"from": frm.name, "reason": reason, **_grant_identity(nonce)})


def _log_stall(prov: Provider, why: str, attempt: int, nonce: str | None = None) -> None:
    """Secret-free operational log when a provider OPENS a stream and then sends no first frame.

    Distinct from `router.failover`, which fires when a provider refuses or is unreachable — here the
    upstream accepted the request and went quiet, so the request may well have been prefilled and paid for
    on their side while metering here records nothing (see FIRST_TOKEN_ATTEMPTS). This line is the only
    record that the spend happened."""
    _plog("router.stall", provider=prov.name, why=why, attempt_open=attempt,
          waited_s=FIRST_TOKEN_TIMEOUT, **_grant_identity(nonce))


def _is_failover(status: int) -> bool:
    return status in FAILOVER_STATUSES


@app.get("/v1/models")
@app.get("/api/v1/models")
async def models(authorization: str | None = Header(default=None)) -> JSONResponse:
    """Hermes probes models on startup; validate the nonce, then answer from upstream with the real key."""
    nonce = _nonce_from(authorization)
    now = time.monotonic()
    with _LOCK:
        if _live_grant_locked(nonce, now) is None:
            raise HTTPException(401, "unknown or expired nonce")
    r = None
    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT) as c:
        for i, prov in enumerate(PROVIDERS):
            try:
                r = await c.get(f"{prov.base_url}/models", headers=_provider_headers(prov))
            except Exception as e:  # noqa: BLE001 — unreachable provider → next
                _log_failover(prov, f"models:exc:{type(e).__name__}", nonce)
                r = None
                continue
            if _is_failover(r.status_code) and i < len(PROVIDERS) - 1:
                _log_failover(prov, f"models:{r.status_code}", nonce)
                continue
            break
    if r is None:
        raise HTTPException(502, "no provider reachable for /models")
    ct = r.headers.get("content-type", "")
    return JSONResponse(status_code=r.status_code, content=r.json() if ct.startswith("application/json") else {"data": []})


def _usage_int(v: object) -> int:
    """A usage field as a non-negative int, or 0. Upstreams have shipped strings and nulls here, and a
    malformed count must never kill a stream or a metering call."""
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return max(0, v)
    if isinstance(v, str) and v.isdigit():
        return int(v)
    return 0


def _meter(nonce: str, usage: dict, path: str) -> int:
    """Charge one call's usage to its grant; return the total charged. The three upstream shapes
    (destreamed JSON, non-streaming passthrough, live SSE) all land here so they cannot drift apart.

    Under PROXY_LOG_REQUESTS this also emits the prompt/completion split, which the cap itself does not
    need — it binds on `total_tokens` — but which is the only way to tell a genuinely cheap call from
    one whose usage never arrived. Both look identical in the grant, and a run full of the second kind
    reads as a bargain while the spend-cap silently meters nothing. Logged even when the total is 0,
    because that is exactly the case worth seeing."""
    total = _usage_int(usage.get("total_tokens"))
    if LOG_REQUESTS:
        _plog("upstream.usage", path=path,
              prompt_tokens=_usage_int(usage.get("prompt_tokens")),
              completion_tokens=_usage_int(usage.get("completion_tokens")),
              total_tokens=total)
    if total:
        with _LOCK:
            g = _GRANTS.get(nonce)
            if g is not None:
                g.used_tokens += total
                g.usage_seen = True
    return total


def _pin_model(body: bytes, pinned: str, nonce: str) -> tuple[bytes, str]:
    """`(body, model)` for a call on a grant pinned to `pinned`: the body names `pinned` whatever
    it asked for, and a call that asked for something else is logged. Unpinned, the body is unchanged and
    `model` is what it names ("" for a body that isn't a JSON object)."""
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001 — non-JSON forwards untouched, as _rewrite_model does
        return body, pinned
    if not isinstance(d, dict):
        return body, pinned
    asked = str(d.get("model") or "")
    if not pinned or asked == pinned:
        return body, asked
    _plog("grant.model_pinned", asked=asked or None, model=pinned, **_grant_identity(nonce))
    d["model"] = pinned
    return json.dumps(d).encode(), pinned


def _note_served(nonce: str, model: object) -> None:
    """Record a model id an upstream response named on this grant. Blank or non-string: nothing."""
    if not isinstance(model, str) or not model.strip():
        return
    with _LOCK:
        g = _GRANTS.get(nonce)
        if g is not None and len(g.served_models) < 8:
            g.served_models.add(model.strip())


def _sse_model(buf: bytes) -> str:
    """The `model` field of the first complete SSE data frame in `buf` that has one, or ""."""
    for raw in buf.split(b"\n"):
        line = raw.strip()
        if not line.startswith(b"data:"):
            continue
        payload = line[len(b"data:"):].strip()
        if payload in (b"", b"[DONE]"):
            continue
        try:
            m = json.loads(payload).get("model")
        except (ValueError, TypeError, AttributeError):
            continue
        if isinstance(m, str) and m.strip():
            return m.strip()
    return ""


def _scan_usage(buf: bytes) -> tuple[bytes, dict]:
    """Pull complete SSE lines off the front of buf, return (remainder, the usage block with the largest
    total_tokens seen in them). Line-buffered so a usage frame is caught no matter where in the stream it
    lands (no tail window). Returns the whole block, not just the total, so the caller can log the
    prompt/completion split."""
    best: dict = {}
    if b"\n" not in buf:
        return buf, best
    *lines, remainder = buf.split(b"\n")
    for raw in lines:
        line = raw.strip()
        if not line.startswith(b"data:"):
            continue
        payload = line[len(b"data:"):].strip()
        if payload in (b"", b"[DONE]"):
            continue
        try:
            u = json.loads(payload).get("usage")
        except (ValueError, TypeError):
            continue
        if isinstance(u, dict) and _usage_int(u.get("total_tokens")) > _usage_int(best.get("total_tokens")):
            best = u
    return remainder, best


_LAST_SERVED: dict = {}   # most recent _record_backend call — read by /healthz, and by the app's badge


def _record_backend(prov: Provider, upstream_headers, nonce: str | None = None) -> dict:
    """Record where this call actually ran, and return the response headers announcing it.

    Logged UNCONDITIONALLY, not behind PROXY_LOG_REQUESTS: a provenance fact that only appears when
    someone has turned up verbosity is a provenance fact nobody has. One record per model call is the
    volume, and per-call is deliberate rather than change-only, because the routing this
    is watching for is mixed rather than switched: a pool that looks uniform across consecutive samples can
    still send a fraction of calls elsewhere, which a change-detector would call stable.

    Also latches into _LAST_SERVED — a single most-recent reading, not a mixed-pool average (the same
    "mixed rather than switched" fact above means one sample can misrepresent the mix), but a live one
    beats the alternative: AGENT_COMPUTE_PROVIDER is a human-typed intent that has drifted from the
    real chain before and cannot self-correct. Global rather than per-nonce because the
    app-side reader (/healthz) has no per-task context to key on; a caller wanting real per-task
    provenance for THIS call already has it in the returned x-agent-provider header."""
    host = _backend_of(upstream_headers)
    served_by = _served_by(upstream_headers)
    # a pinned route states which provider it asked for; the response states which one answered.
    # pin_ok=false is the record that the two disagree, and it is logged on every call rather than sampled.
    pin = {"pinned": prov.pinned, "pin_ok": served_by == prov.pinned} if prov.pinned else {}
    _plog("upstream.backend", provider=prov.name, backend=host or None, served_by=served_by or None,
          swiss=_backend_swiss(host), **pin, **_grant_identity(nonce))
    global _LAST_SERVED
    # The badge reads "provider" from here. When the response names who served, that name wins over the
    # chain entry's configured name, so the badge carries a measurement rather than this proxy's config.
    # The verifier route runs on its own host outside the reported chain, so a verifier call never writes
    # the last-served latch: the badge reflects only the chain's own providers.
    if prov is not VERIFIER:
        _LAST_SERVED = {"provider": served_by or prov.name, "backend": host or None,
                        "swiss": _backend_swiss(host), "at": time.time(), **pin}
    h = {"x-agent-provider": prov.name}
    if host:
        h["x-agent-backend"] = host
    if served_by:
        h["x-agent-served-by"] = served_by
    return h


def _sse(obj: dict) -> bytes:
    return b"data: " + json.dumps(obj).encode() + b"\n\n"


async def _destream(req: dict, nonce: str, providers: list[Provider] | None = None) -> Response:
    """Call upstream non-streaming, then replay the single response as a synthetic SSE stream.

    The provider parses tool calls only on its non-streaming path (Apertus `publicai`), so we force
    stream=false upstream, take the parsed `message` (content OR tool_calls), and emit it as one delta
    chunk + a finish chunk + optional usage chunk + [DONE]. Hermes' streaming accumulator handles a
    whole tool_call delivered in a single delta. Usage is counted from the non-streamed `usage` block."""
    want_usage = bool((req.get("stream_options") or {}).get("include_usage"))
    r = None
    served: Provider | None = None
    ns: dict = {}    # this provider's rewritten body; read again below the loop for the served model
    provs = providers or PROVIDERS
    for i, prov in enumerate(provs):                           # ROUTER: providers in order, failover between them
        ns = dict(req)
        ns["stream"] = False
        ns.pop("stream_options", None)
        if prov.model or prov.model_map:
            ns = json.loads(_rewrite_model(json.dumps(ns).encode(), prov))   # this provider's id for the model
        if prov.no_cache and "cache" not in ns:
            ns["cache"] = {"no-cache": True}                   # see _no_cache; this path builds its own dict
        headers = _provider_headers(prov)
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT) as c:
            try:
                r = await c.post(f"{prov.base_url}/chat/completions", headers=headers,
                                 content=json.dumps(ns).encode())
            except Exception as e:  # noqa: BLE001
                _log_failover(prov, f"destream:exc:{type(e).__name__}", nonce)
                r = None
                continue
        if _is_failover(r.status_code) and i < len(provs) - 1:   # provider overloaded/down → failover
            _log_failover(prov, f"destream:{r.status_code}", nonce)
            continue
        served = prov                                          # committed to this provider
        break
    if r is None or served is None:
        raise HTTPException(502, "all providers unreachable (destream)")
    if r.status_code >= 400:
        # Same unconditional record as the streaming path above: an error path whose
        # silence depends on a flag staying off is not a property worth keeping.
        _plog("upstream.error", status=r.status_code, provider=served.name, path="destream",
              **({"body": r.content.decode(errors="replace")[:1000]} if LOG_REQUESTS else {}))
        return Response(content=r.content, status_code=r.status_code,
                        media_type=r.headers.get("content-type", "application/json"),
                        headers=_record_backend(served, r.headers, nonce))
    data = r.json()
    usage = data.get("usage") or {}
    _meter(nonce, usage, "destream")
    _note_served(nonce, data.get("model"))
    cid = data.get("id", "chatcmpl-destream")
    created = data.get("created", int(time.time()))
    model = data.get("model", ns.get("model", ""))
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    finish = choice.get("finish_reason") or "stop"

    def _frame(delta: dict, finish_reason=None) -> bytes:
        return _sse({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]})

    async def gen():
        # 1) open with the role, 2) deliver content and/or tool_calls in one delta, 3) finish, 4) usage, DONE.
        yield _frame({"role": "assistant"})
        delta: dict = {}
        if msg.get("content"):
            delta["content"] = msg["content"]
        if msg.get("tool_calls"):
            delta["tool_calls"] = [
                {"index": i, "id": tc.get("id"), "type": tc.get("type", "function"),
                 "function": tc.get("function", {})}
                for i, tc in enumerate(msg["tool_calls"])
            ]
        if delta:
            yield _frame(delta)
        yield _frame({}, finish_reason=finish)
        if want_usage:
            yield _sse({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                        "choices": [], "usage": usage})
        yield b"data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers=_record_backend(served, r.headers, nonce))


def _wants_restream(body: bytes, chain: list[Provider]) -> bool:
    """Whether this call is a stream=false call for a model the first provider in `chain` lists in
    `stream_upstream`. A body that isn't a JSON object never is."""
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001
        return False
    if not isinstance(d, dict) or d.get("stream") or not chain:
        return False
    return str(d.get("model") or "").strip().lower() in chain[0].stream_upstream


def _content_text(content: object) -> str:
    """A delta's text. Large 4 streams `content` as a list of blocks, thinking first and then text, where
    other models send a string; the thinking blocks are dropped, as the unstreamed answer never had them."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text") or "" for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _join_stream(raw: bytes) -> dict:
    """Join an OpenAI-shaped SSE stream into the one chat.completion object an unstreamed call returns:
    the text, any tool calls (by index), the finish reason and the usage block. A frame carrying an
    `error` raises 502 with it, since the stream ended without an answer."""
    out: dict = {"id": "", "object": "chat.completion", "created": 0, "model": ""}
    text: list[str] = []
    calls: dict[int, dict] = {}
    finish = None
    usage: dict = {}
    for line in raw.splitlines():
        if not line.startswith(b"data:"):
            continue
        data = line[5:].strip()
        if not data or data == b"[DONE]":
            continue
        try:
            frame = json.loads(data)
        except Exception:  # noqa: BLE001 — a malformed frame carries nothing we can join
            continue
        if not isinstance(frame, dict):
            continue
        if frame.get("error"):
            raise HTTPException(502, f"upstream stream error: {json.dumps(frame['error'])[:500]}")
        for k in ("id", "created", "model"):
            if frame.get(k) and not out[k]:
                out[k] = frame[k]
        if isinstance(frame.get("usage"), dict) and frame["usage"]:
            usage = frame["usage"]
        for ch in frame.get("choices") or []:
            delta = ch.get("delta") or {}
            text.append(_content_text(delta.get("content")))
            for tc in delta.get("tool_calls") or []:
                slot = calls.setdefault(int(tc.get("index") or 0),
                                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                slot["function"]["name"] += fn.get("name") or ""
                slot["function"]["arguments"] += fn.get("arguments") or ""
            if ch.get("finish_reason"):
                finish = ch["finish_reason"]
    message: dict = {"role": "assistant", "content": "".join(text)}
    if calls:
        message["tool_calls"] = [calls[i] for i in sorted(calls)]
    out["choices"] = [{"index": 0, "message": message, "finish_reason": finish}]
    if usage:
        out["usage"] = usage
    return out


async def _restream(body: bytes, nonce: str, chain: list[Provider]) -> Response:
    """Serve a stream=false call by streaming it upstream and joining the frames. Same failover
    as every other call (`_open_stream_failover`); an upstream error status is forwarded unmasked."""
    req = json.loads(body)
    req["stream"] = True
    req["stream_options"] = {**(req.get("stream_options") or {}), "include_usage": True}
    client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT)
    r: httpx.Response | None = None
    try:
        served, r = await _open_stream_failover(client, json.dumps(req).encode(), "text/event-stream", chain, nonce,
                                                unstreamed=True)
        raw = await r.aread()
        headers = _record_backend(served, r.headers, nonce)
        ctype = r.headers.get("content-type", "")
        status = r.status_code
    finally:
        if r is not None:
            await r.aclose()
        await client.aclose()
    if status >= 400:
        _plog("upstream.error", status=status, provider=served.name, path="restream",
              **({"body": raw.decode(errors="replace")[:1000]} if LOG_REQUESTS else {}))
        return Response(content=raw, status_code=status, media_type=ctype or "application/json", headers=headers)
    if "text/event-stream" not in ctype:                      # an upstream that answered unstreamed anyway
        return Response(content=raw, status_code=status, media_type=ctype or "application/json", headers=headers)
    completion = _join_stream(raw)
    _note_served(nonce, completion.get("model"))
    _meter(nonce, completion.get("usage") or {}, "restream")
    return JSONResponse(completion, status_code=status, headers=headers)


async def _open_stream_failover(client: httpx.AsyncClient, body: bytes, accept: str | None,
                                providers: list[Provider] | None = None,
                                nonce: str | None = None, unstreamed: bool = False) -> tuple[Provider, httpx.Response]:
    """Open the chat-completions stream against providers in order. Advances on a transport error or a
    FAILOVER status (closing that response first); commits on 2xx OR any forwardable status — so a 4xx, or
    the LAST provider's error, reaches the caller unmasked (never dress an upstream
    failure as a 200). Returns (served_provider, open_response); raises 502 if no provider is reachable."""
    last = None
    provs = providers or PROVIDERS
    for i, prov in enumerate(provs):
        pbody = _rewrite_model(body, prov, unstreamed)         # this provider's catalog id for the same weights
        pbody = _no_cache(pbody, prov)                         # a cached completion is not a second attempt
        if FORCE_TOOL_CHOICE:
            forced = _force_tool_choice(pbody)                 # prose is not an option when a stop tool exists
            if forced != pbody:
                # `upstream.request` above reads the body as RECEIVED, so a forced call logs
                # tool_choice=null there and the flag looks inert while it is working. Rather than let
                # the one record of this describe a different body than the one on the wire, say so here.
                _plog("upstream.forced_tool_choice", provider=prov.name, **_grant_identity(nonce))
            pbody = forced
        for attempt in range(1, SAME_PROVIDER_RETRY_ATTEMPTS + 1):
            try:
                upstream_req = client.build_request("POST", f"{prov.base_url}/chat/completions",
                                                    headers=_provider_headers(prov, accept), content=pbody)
                r = await client.send(upstream_req, stream=True)
            except Exception as e:  # noqa: BLE001 — unreachable → failover to next provider, never retried
                last = f"exc:{type(e).__name__}"; _log_failover(prov, last, nonce)
                r = None
                break
            if not _is_failover(r.status_code):
                return prov, r
            last = str(r.status_code)
            has_next_provider = i < len(provs) - 1
            if has_next_provider:
                _log_failover(prov, last, nonce)
                await r.aclose()
                break                                            # advance to next provider — unchanged
            if attempt < SAME_PROVIDER_RETRY_ATTEMPTS:
                _log_failover(prov, f"{last}:retry{attempt}", nonce)
                await r.aclose()
                await asyncio.sleep(0.5 + random.random())  # noqa: S311 — retry jitter, not a secret  # noqa: S311 — retry jitter, not a secret
                continue                                          # retry the last provider in place
            return prov, r                                        # retries exhausted on the last provider
    raise HTTPException(502, f"all providers unreachable (last={last})")


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str | None = Header(default=None)):
    """The metered, secret-swapping, streaming forward. The step-cap is a HARD pre-admit gate; the
    spend-cap is a per-call-granularity gate (checked before, counted after — see module docstring)."""
    if not PROVIDERS:
        raise HTTPException(503, "gateway has no upstream provider configured")
    nonce = _nonce_from(authorization)
    now = time.monotonic()
    with _LOCK:
        g = _live_grant_locked(nonce, now)
        if g is None:
            raise HTTPException(401, "unknown or expired nonce")
        if g.used_requests >= g.max_requests:
            g.rejected += 1                                   # record the throttle so revoke() can report it authoritatively
            raise HTTPException(429, f"step-cap reached ({g.max_requests} model calls)")
        if g.max_tokens and g.used_tokens >= g.max_tokens:
            g.rejected += 1
            raise HTTPException(429, f"spend-cap reached ({g.max_tokens} tokens)")
        g.used_requests += 1                                  # count on admit, before the call
        pinned = g.model

    body = await request.body()

    if LOG_REQUESTS:
        _plog("upstream.request", **_request_meta(body))

    # a grant pinned to a model sends every call as that model, whatever the body names.
    body, model = _pin_model(body, pinned, nonce)
    chain = [p for p in _providers_for(body) if p.routable(model)]
    if not chain:
        # A model no provider here maps is refused, never rewritten to one it does map: the task would
        # otherwise run on a model nobody picked while every record named the one they did.
        _plog("upstream.unroutable_model", model=model or None, **_grant_identity(nonce))
        raise HTTPException(400, f"model {model!r} is not routed by this gateway")
    limiter = RPM_LIMITERS.get(model.strip().lower())
    if limiter is not None:
        try:
            await asyncio.wait_for(limiter.acquire(), MODEL_RPM_MAX_WAIT_SECS)
        except TimeoutError:
            with _LOCK:
                g2 = _GRANTS.get(nonce)
                if g2 is not None:
                    g2.used_requests = max(0, g2.used_requests - 1)   # refused before the call: no step spent
            _plog("upstream.rpm_limited", model=model, wait_s=MODEL_RPM_MAX_WAIT_SECS, **_grant_identity(nonce))
            raise HTTPException(429, f"{model} is at this gateway's requests-a-minute share — retry shortly",
                                headers={"Retry-After": "5"}) from None

    if _wants_restream(body, chain):
        return await _restream(body, nonce, chain)

    # Interim Apertus fix (see DESTREAM above): when the client asked to stream, call upstream
    # NON-streaming (so the provider's tool-call parser engages) and re-emit the result as a synthetic
    # SSE stream. Counts usage from the non-streamed `usage` block (more reliable than mid-stream scan).
    # _destream runs the SAME provider failover internally.
    if DESTREAM:
        try:
            _req = json.loads(body)
        except Exception:  # noqa: BLE001  — malformed body: fall through to normal path
            _req = None
        if isinstance(_req, dict) and _req.get("stream"):
            return await _destream(json.loads(body), nonce, chain)

    # Open the stream and inspect its status BEFORE committing to a response. A committed 200
    # StreamingResponse would deliver an upstream 401/402/429/5xx to the agent as a 200 with an
    # error body, masking real billing/quota/auth
    # failures as model hiccups, so non-2xx is forwarded with its true status. The ROUTER tries providers
    # in order (failover on transport error / overload) and reports which one served via x-agent-provider.
    # The same window also bounds TIME-TO-FIRST-TOKEN (see FIRST_TOKEN_TIMEOUT): pull the first frame here,
    # before the response commits, so a provider that opens and then goes silent can be retried invisibly.
    # After `return StreamingResponse(...)` the headers are on the wire and that option is gone.
    client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT)
    served: Provider | None = None
    r: httpx.Response | None = None
    frames = None                    # the raw-chunk iterator, once a first frame has actually arrived
    first = b""                      # that frame, held back until the response commits
    stalled: list[str] = []          # providers that opened and went quiet on THIS call
    try:
        for _open in range(1, FIRST_TOKEN_ATTEMPTS + 1):
            # `chain` is this call's routable providers, computed once above.
            # Prefer a provider that hasn't already stalled this call. A single-provider chain has nobody
            # else, so it retries itself, as in a single-provider deployment (MODEL_PROVIDERS=cscs, deliberately
            # no failover partner: routing an Apertus outage to Infomaniak would silently serve Mistral).
            served, r = await _open_stream_failover(
                client, body, request.headers.get("accept"),
                [p for p in chain if p.name not in stalled] or chain, nonce)
            if r.status_code >= 400:
                err_body = await r.aread()
                # The FACT of an upstream 4xx/5xx is never routine traffic, so it is logged
                # unconditionally; only the BODY stays behind the verbose flag. PROXY_LOG_REQUESTS unset is a
                # supported deployment, and a logging flag that can hide an
                # authentication failure is the wrong shape regardless of how it happens to be set.
                _plog("upstream.error", status=r.status_code, provider=served.name,
                      **({"body": err_body.decode(errors="replace")[:1000]} if LOG_REQUESTS else {}))
                await r.aclose()
                await client.aclose()
                return Response(content=err_body, status_code=r.status_code,
                                media_type=r.headers.get("content-type", "application/json"),
                                headers=_record_backend(served, r.headers, nonce))

            # Non-streaming upstream response (a caller posts stream=false → a single JSON object, not SSE):
            # the SSE usage-scanner below never fires on it, so these calls metered 0 tokens. Buffer it, meter
            # usage.total_tokens from the JSON, and return as-is. (Streaming clients fall through to stream().)
            ctype = r.headers.get("content-type", "")
            if "text/event-stream" not in ctype:
                raw = await r.aread()
                await r.aclose()
                await client.aclose()
                try:
                    parsed = json.loads(raw)
                    u = parsed.get("usage")
                    _note_served(nonce, parsed.get("model"))
                except Exception:  # noqa: BLE001 — malformed/usage-less body: meter 0, still return it verbatim
                    u = None
                _meter(nonce, u if isinstance(u, dict) else {}, "nonstream")
                return Response(content=raw, status_code=r.status_code, media_type=ctype or "application/json",
                                headers=_record_backend(served, r.headers, nonce))

            frames = r.aiter_raw()
            try:
                first = await asyncio.wait_for(frames.__anext__(), FIRST_TOKEN_TIMEOUT)
                break
            except (TimeoutError, StopAsyncIteration) as e:
                # Silent past the bound, or closed having sent nothing at all — same failure to the caller,
                # and the second is the one a bare `except TimeoutError` would let through as an empty 200.
                _log_stall(served, type(e).__name__, _open, nonce)
                stalled.append(served.name)
                await r.aclose()
                r = None
    except BaseException:
        if r is not None:
            await r.aclose()
        await client.aclose()
        raise
    # served/frames are set in the same breath as r (and only r is reset to None on a stall), so this
    # one guard covers all three. Naming them keeps the invariant checkable instead of implied.
    if r is None or served is None or frames is None:   # every open went quiet — fail loudly rather
        await client.aclose()
        raise HTTPException(504, f"no first token within {FIRST_TOKEN_TIMEOUT:g}s "   # than serve an empty stream
                                 f"across {FIRST_TOKEN_ATTEMPTS} upstream open(s)")

    async def replay():
        """The held-back first frame, then the rest — so the client sees one unbroken stream and the usage
        scanner still sees every byte."""
        yield first
        async for chunk in frames:
            yield chunk

    async def stream():
        # Stream upstream SSE straight through, scanning complete lines for the usage tally as they pass.
        buf = b""
        best: dict = {}
        seen_model = False
        try:
            async for chunk in replay():
                yield chunk
                buf += chunk
                if not seen_model:
                    served_model = _sse_model(buf)       # what upstream says it ran, first frame on
                    if served_model:
                        _note_served(nonce, served_model)
                        seen_model = True
                buf, found = _scan_usage(buf)
                if _usage_int(found.get("total_tokens")) > _usage_int(best.get("total_tokens")):
                    best = found
        finally:
            await r.aclose()
            await client.aclose()
            # Meter what actually streamed, even on a mid-stream client disconnect. Called
            # unconditionally so a stream that carried no usage block is visible in the log as a 0
            # rather than as silence.
            _meter(nonce, best, "stream")

    return StreamingResponse(stream(), status_code=r.status_code,
                             media_type=r.headers.get("content-type", "text/event-stream"),
                             headers=_record_backend(served, r.headers, nonce))


@app.get("/healthz")
def healthz() -> dict:
    now = time.monotonic()
    with _LOCK:
        _purge_expired_locked(now)
        active = len(_GRANTS)
    # Provider chain is provenance-relevant + operator-facing: report names + base URLs in failover order
    # (NEVER tokens). `credential` stays MISSING-honest: no configured provider = no way to serve.
    return {"status": "ok",
            # `no_cache` is reported because it is otherwise a per-request body field nobody can see from
            # outside: a cache silently back on looks exactly like a fast day.
            "providers": [{"name": p.name, "base_url": p.base_url, "model": p.model or None,
                           "model_map": p.model_map or None, "no_fallback": sorted(p.no_fallback) or None,
                           "model_extra": p.model_extra or None,
                           "model_unstreamed_extra": p.model_unstreamed_extra or None,
                           "stream_upstream": sorted(p.stream_upstream) or None,
                           "no_cache": p.no_cache} for p in PROVIDERS],
            # the app model ids a task may run on here; the app refuses any other. [] = the
            # chain has a provider with no MODEL_MAP, so only the app's default is routable.
            "models": routable_models(),
            "rpm_limits": {m: int(lim.max_rate) for m, lim in RPM_LIMITERS.items()},
            "primary": PROVIDERS[0].name if PROVIDERS else None,
            "failover_statuses": sorted(FAILOVER_STATUSES),
            "credential": "configured" if PROVIDERS else "MISSING",
            # which provider actually served the most recent call, not just which one is
            # configured as primary — the app polls this to keep its own "what's running" badge honest.
            "last_served": _LAST_SERVED or None,
            "admin": "configured" if PROXY_ADMIN_KEY else "unconfigured(fails-closed)",
            "active_grants": active, "grant_ttl_s": GRANT_TTL_SECS,
            # A sink whose own failures are invisible reproduces the bug it was built to fix, so its
            # dropped/failed counters are reported rather than merely kept.
            "logsink": logsink.stats()}


# the public face, for an agent run whose Hermes lives in a sandbox off Fly's private network.
# It carries only the routes a per-task nonce opens; /admin/* has no route here at all, so the admin key
# is never checked on a public port. gateway_serve.py runs it beside `app` in one process, so both read
# the same in-memory grants.
public_app = FastAPI(title="Agent Service — model gateway (public)", docs_url=None, redoc_url=None,
                     openapi_url=None)
public_app.add_api_route("/v1/models", models, methods=["GET"])
public_app.add_api_route("/v1/chat/completions", chat_completions, methods=["POST"])


@public_app.get("/healthz")
def public_healthz() -> dict:
    return {"status": "ok"}
