"""Each conversation in a Firecracker microVM of its own, on a self-hosted E2B install (CUR-4451, part of CUR-4434).

E2B Embed (`e2b-dev/infra`, `embed/`, Apache-2.0) runs the whole E2B runtime on one VM in our own AWS account, and
the `e2b` SDK (MIT) is the same one E2B Cloud uses. This backend is that SDK behind `SandboxBackend`:

- A conversation's sandbox carries `key_for(principal, conversation)` as metadata, so `connect` finds it with a
  metadata query from any agent machine. A paused sandbox resumes on connect, memory and files intact.
- The run-code tier is created with all egress denied. The agent tier may reach only the model gateway, with the
  task's own capped, revoked-at-the-end nonce. No header-rewrite rule is set, because Embed's network rules do not
  rewrite request headers (CUR-4500).
- An idle sandbox pauses itself after its tier's idle window (`idle_for`, E2B's own lifecycle). `sweep` kills one
  unused past the session limit,
  read from E2B's own timestamps, so it keeps no state either.
- File operations run inside the guest through E2B's file API. A path is still confined to the workspace, since a
  read that followed a planted link would hand back the guest's own files, which nobody asked for.

Nothing imports this module unless `AGENT_SANDBOX_BACKEND=e2b`, and the `e2b` package is imported only here.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import posixpath
import shlex
import socket
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import urlsplit, urlunsplit

from sandbox_backend import (
    SANDBOX_WAIT_TEXT,
    ExecResult,
    Handle,
    OnWait,
    Proc,
    SandboxAccountLimit,
    SandboxBusy,
    SandboxError,
    StdioStreams,
    Tier,
    key_for,
    owner_for,
)

if TYPE_CHECKING:
    from e2b import Sandbox
    from e2b.connection_config import ApiParams
    from e2b.sandbox.sandbox_api import SandboxLifecycle, SandboxNetworkOpts

WORK = "/home/user/work"
_BOUNDARY = "\x1e"  # separates a listing's records; a file name can't hold it in practice and we only ever split


@dataclass
class E2BConfig:
    api_url: str  # through the WireGuard link (deploy/e2b-link), never Embed's public address: it speaks plain HTTP
    api_key: str
    sandbox_url: str = ""  # client-proxy, port 3002 on the same path; empty lets the SDK derive it
    # The image agent mode runs in (deploy/e2b-template). Embed's own "base" lacks Hermes and the guest libraries, and
    # on a fresh host its parent layers may be absent, so a client that forgot to name a template must still get this.
    template: str = "hermes"
    idle_secs: int = 600  # the agent tier's pause window: a task's attempts and confirm cards sit inside it
    # The run-code tier's pause window. A running sandbox holds its whole guest memory on the host and a paused one
    # holds none, so this window, not the number of people, is what fills the host: at 600 s a host's 56 slots
    # serve 56 people per ten minutes, and an account on the first tier is refused a second conversation for ten minutes.
    # A call resumes a paused sandbox with its memory and files, so a shorter window costs a resume, not the work.
    run_code_idle_secs: int = 120
    gateway_host: str = ""  # the agent tier's one allowed destination
    # After the host refuses a create for capacity, refuse new sandboxes here for this long rather than queue every
    # conversation behind the SDK's own retries; the first create after it decides whether the host has room again.
    busy_cooloff_secs: int = 30
    # How long a connect waits for a slot on a full host before it gives up with "the host is full" (CUR-4584); 0
    # refuses at once. The first wait is `busy_retry_secs`, the 5 s the run endpoint's Retry-After already names, and
    # each one after is half again as long, up to `_WAIT_MAX_STEP_SECS`.
    busy_wait_secs: float = 0.0
    busy_retry_secs: float = 5.0
    # How many hosts the link fronts (CUR-4529). Slot i is reached on both URLs' ports moved by SLOT_PORT_STEP * (i-1),
    # so slot 1 is the URLs as given and one slot is exactly the single-host backend.
    slots: int = 1
    # Slots taken out by hand (E2B_SLOTS_OFF): never asked, never placed on. A host that stays dead goes auto-off on
    # its own after `auto_off_secs`; this is for taking one out at once, or keeping it out.
    off: frozenset[int] = frozenset()
    # How many run-code sandboxes one account may have running at once, across every slot (CUR-4553); 0 is no cap. A
    # paused sandbox is not live, so an account's idle conversations cost it nothing.
    account_max_live: int = 2
    # Running sandboxes one host holds before it refuses a create, for the pool gauge's "nearly full" reading; 0 when
    # not known, which leaves the gauge reporting counts with nothing to compare them to.
    slot_capacity: int = 0
    # A slot that has failed every ask for this long is treated as off for refusals and placement
    # (E2B_SLOT_AUTO_OFF_SECS, CUR-4592); 0 never does. `E2BBackend._auto_off` says what it changes and what it costs.
    auto_off_secs: int = 300

    def __post_init__(self) -> None:
        if self.slots < 1:
            raise ValueError("E2B_SLOTS is at least 1")
        if self.auto_off_secs < 0:
            raise ValueError("E2B_SLOT_AUTO_OFF_SECS is 0 (never) or more")
        if not self.off <= set(range(1, self.slots + 1)) or len(self.off) >= self.slots:
            raise ValueError("E2B_SLOTS_OFF names slots from 1 to E2B_SLOTS and leaves at least one on")
        if self.slots > 1 and any(u and urlsplit(u).port is None for u in (self.api_url, self.sandbox_url)):
            raise ValueError("with E2B_SLOTS above 1, E2B_API_URL and E2B_SANDBOX_URL name their ports")

    def idle_for(self, tier: Tier | str | None) -> int:
        """Seconds without a call before a sandbox of `tier` pauses. A tier read from metadata is its string value,
        which a StrEnum compares equal to."""
        return self.run_code_idle_secs if tier == Tier.RUN_CODE else self.idle_secs

    def api(self, slot: int = 1) -> ApiParams:
        by = SLOT_PORT_STEP * (slot - 1)
        params: ApiParams = {"api_url": _port_moved(self.api_url, by), "api_key": self.api_key}
        if self.sandbox_url:
            params["sandbox_url"] = by_address(_port_moved(self.sandbox_url, by))
        return params


SLOT_PORT_STEP = 100  # deploy/e2b-link listens for slot i on 3000 and 3002 plus this * (i-1)
_PAUSE_RETRY_WAITS = (1.0, 2.0, 4.0, 8.0)  # seconds between asks of a busy host; the task's end waits at most 15 s


def _port_moved(url: str, by: int) -> str:
    if not by:
        return url
    parts = urlsplit(url)
    host = parts.hostname or ""
    netloc = f"[{host}]" if ":" in host else host
    return urlunsplit(parts._replace(netloc=f"{netloc}:{cast('int', parts.port) + by}"))


def by_address(url: str) -> str:
    """`url` with its host swapped for the address it resolves to now (CUR-4497).

    E2B's client proxy reads the sandbox and port from `E2b-Sandbox-*` headers only when the request's host is
    localhost or an IP address; any other host is parsed as `<port>-<sandbox>.<domain>`, so the link's
    `potluck-e2b-link.internal` reads as port "potluck" and every call is refused. The name stays in config,
    since the egress allowlist resolves it too, and the lookup is a read of /etc/hosts, which the entrypoint keeps
    current. A name that does not resolve is passed through, so the failure names it."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if not host or host == "localhost" or _is_ip(host):
        return url
    try:
        addr = str(socket.getaddrinfo(host, parts.port, type=socket.SOCK_STREAM)[0][4][0])
    except OSError:
        return url
    netloc = f"[{addr}]" if ":" in addr else addr
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit(parts._replace(netloc=netloc))


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _sbx(h: Handle) -> Sandbox:
    return cast("Sandbox", h.ref)


def workspace_path(rel: str) -> str:
    """`rel` as an absolute path inside WORK, or SandboxError. Lexical only; `_resolved` checks links in the guest."""
    if not rel or "\x00" in rel or rel.startswith("/"):
        raise SandboxError(f"{rel!r} is outside the workspace")
    target = posixpath.normpath(posixpath.join(WORK, rel))
    if target != WORK and not target.startswith(WORK + "/"):
        raise SandboxError(f"{rel!r} is outside the workspace")
    return target


class E2BBackend:
    name = "e2b"

    def __init__(self, cfg: E2BConfig, log_event: Callable[..., None] | None = None):
        import e2b  # lazy: only this backend needs the package
        from circuitbreaker import CircuitBreaker

        self._e2b = e2b
        self._cfg = cfg
        self._log_event = log_event
        # One per slot, and one capacity refusal opens it (CUR-4484). E2B calls a 503 "no capacity to place a
        # sandbox" and a 429 its concurrency cap, both after the SDK's own retries; any other error is a fault of
        # that one create.
        self._create_breakers = {
            s: CircuitBreaker(failure_threshold=1, recovery_timeout=cfg.busy_cooloff_secs,
                              expected_exception=lambda _t, e: self._is_capacity(e), name=f"e2b-create-{s}")
            for s in range(1, cfg.slots + 1)}
        self._key_locks = [threading.Lock() for _ in range(64)]  # striped: bounded, and keys rarely share one
        self._owner_locks = [threading.Lock() for _ in range(64)]  # one account's count-then-start, one at a time here
        # Slots that get no new sandboxes, set by the pool's scaler before it turns one off, and slots it has turned
        # off, which are never asked at all (CUR-4530).
        self.draining: set[int] = set()
        self.off: set[int] = set(cfg.off)
        self._down_until: dict[int, float] = {}  # slot -> monotonic time it is next asked again
        # A waiting connect may ask a slot whose breaker is open, at most once per `_PROBE_SECS` across
        # every waiter, so a slot that frees inside the cool-off is used then, not at its end. (CUR-4584)
        self._probed_at: dict[int, float] = {}
        self._probe_lock = threading.Lock()
        self._sleep: Callable[[float], None] = time.sleep  # tests swap both for a fake clock
        self._clock: Callable[[], float] = time.monotonic
        # slot -> monotonic time of its first failed ask since its last answer. Observed here, per machine, and gone on
        # a restart: soft state, no host map, so each machine reaches its verdict from the silence it saw itself.
        self._failing_since: dict[int, float] = {}
        self._auto_off_now: set[int] = set()  # what the last pass judged auto-off, so each change is logged once
        self._slot_lock = threading.Lock()

    # -- slots -------------------------------------------------------------------------------------------------

    _DOWN_SECS = 30.0
    _LIST_TIMEOUT_SECS = 5.0

    def _on(self) -> list[int]:
        return [s for s in range(1, self._cfg.slots + 1) if s not in self.off]

    def _up(self) -> list[int]:
        now = time.monotonic()
        return [s for s in self._on() if self._down_until.get(s, 0.0) <= now]

    def _each(self, call: Callable[[int], object]) -> tuple[list[tuple[int, object]], list[int]]:
        """`call(slot)` on every slot that is on, as ([(slot, result)], [slots that did not answer]). With one slot it
        is the plain call, errors and all, so a single host behaves as it always has. With several they run at once;
        a slot that fails is not asked again for `_DOWN_SECS`, and both it and a slot still in that window are named
        as unanswered, so a caller that must see every slot refuses rather than taking silence for "none here".

        A slot that is auto-off (`_auto_off`) is still asked, and its first answer brings it back, but its silence is
        left out of the unanswered list, so it no longer makes `find` and `destroy` refuse."""
        if self._cfg.slots == 1:
            return [(1, call(1))], []
        up = self._up()
        unread = [s for s in self._on() if s not in up]
        out: list[tuple[int, object]] = []
        with ThreadPoolExecutor(max_workers=max(1, len(up))) as pool:
            futures = {pool.submit(call, s): s for s in up}
            for f, s in futures.items():
                try:
                    out.append((s, f.result()))
                except Exception:  # noqa: BLE001 — one host's failure is that host being down
                    self._down_until[s] = time.monotonic() + self._DOWN_SECS
                    unread.append(s)
        auto_off = self._observe([s for s, _r in out], unread)
        return sorted(out, key=lambda r: r[0]), sorted(s for s in unread if s not in auto_off)

    def _observe(self, answered: list[int], unread: list[int]) -> set[int]:
        """Record one pass's answers and silences, and return the slots now auto-off, logging each change once."""
        now = time.monotonic()
        with self._slot_lock:
            for s in answered:
                self._failing_since.pop(s, None)
            for s in unread:
                self._failing_since.setdefault(s, now)
            auto_off = self._auto_off(now)
            went, back = auto_off - self._auto_off_now, self._auto_off_now - auto_off
            self._auto_off_now = auto_off
            since = dict(self._failing_since)
        for s in sorted(went):
            self._log("sandbox.slot_auto_off", slot=s, failing_for_s=round(now - since.get(s, now)),
                      after_s=self._cfg.auto_off_secs)
        for s in sorted(back):
            self._log("sandbox.slot_rejoined", slot=s,
                      reason="answered" if s in answered else "no other slot answering")
        return auto_off

    def _auto_off(self, now: float) -> set[int]:
        """Slots that have failed every ask for `auto_off_secs` or longer: off for refusals and placement, and still
        asked, so the first answer brings one back. Without it the only way past a dead host refusing every new
        conversation's `find` is E2B_SLOTS_OFF and a restart. Never the pool's last answering slot: while every slot
        that is on has failed since it last answered, none is auto-off and the pool refuses as before.

        The trade: from here a dead host and a long partition look the same. During a partition, a returning
        conversation whose sandbox sits on the auto-off slot gets a fresh, empty sandbox on another slot, and when
        the slot rejoins the conversation has two. `find` then keeps the one used last (`_pick`), so the person
        stays with the files they have been working on; the other is left for the idle sweep or `destroy`."""
        if self._cfg.auto_off_secs <= 0:
            return set()
        on = self._on()
        failing = {s for s in on if s in self._failing_since}
        if failing >= set(on):
            return set()
        return {s for s in failing if now - self._failing_since[s] >= self._cfg.auto_off_secs}

    def auto_off_slots(self) -> list[int]:
        """The slots this machine judges auto-off right now, for /healthz."""
        with self._slot_lock:
            return sorted(self._auto_off_now)

    def _params(self, slot: int) -> ApiParams:
        """Slot's API params for a list or kill, bounded by `_LIST_TIMEOUT_SECS` however many slots there are. A host
        behind a link that stops passing packets answers nothing: the link accepts the connection and its own connect
        to the host hangs, so an unbounded call waits out the SDK's 60 s default, past chat's 45 s turn (CUR-4628)."""
        params = self._cfg.api(slot)
        params["request_timeout"] = self._LIST_TIMEOUT_SECS
        return params

    def _kill(self, slot: int, sandbox_id: str) -> bool | None:
        """Kill one sandbox: True if it went, False if it was already gone, None if the kill failed. Kept apart from
        the slot's list so one sandbox mid-pause doesn't count as its whole host down."""
        try:
            return bool(self._e2b.Sandbox.kill(sandbox_id, **self._params(slot)))
        except Exception:  # noqa: BLE001
            return None

    def _listed(self, slot: int, query) -> list:
        return self._e2b.Sandbox.list(query=query, **self._params(slot)).next_items()

    @staticmethod
    def _unreachable(unread: list[int]) -> SandboxError:
        return SandboxError(f"sandbox host {', '.join(map(str, unread))} can't be reached right now; try again in a minute")

    # -- lifecycle ---------------------------------------------------------------------------------------------

    def _network(self, tier: Tier) -> SandboxNetworkOpts:
        if tier is Tier.RUN_CODE or not self._cfg.gateway_host:
            return {"deny_out": ["0.0.0.0/0"], "allow_public_traffic": False}
        return {"deny_out": ["0.0.0.0/0"], "allow_out": [self._cfg.gateway_host], "allow_public_traffic": False}

    def find(self, principal: str, conversation: str, tier: Tier) -> Handle | None:
        """The conversation's sandbox if one exists, resumed; None rather than a new one. With several slots, None only
        when every slot that is on answered: a slot that didn't may hold it, and a new sandbox elsewhere would split
        the conversation's files across two (CUR-4529)."""
        key = key_for(principal, conversation)
        from e2b.api.client.models.sandbox_state import SandboxState
        from e2b.sandbox.sandbox_api import SandboxQuery

        query = SandboxQuery(metadata={"key": key})
        try:
            answered, unread = self._each(lambda s: self._listed(s, query))
        except Exception as e:
            # One slot: `_each` passes the host's own failure through. Worded, so the run-code tool returns a
            # sentence the model can pass on instead of a bare "Error executing tool" (CUR-4628).
            raise self._unreachable(self._on()) from e
        found = [(slot, info) for slot, infos in answered for info in cast("list", infos)]
        if any(info.metadata.get("tier") != tier.value for _s, info in found):
            raise SandboxError("this conversation's sandbox was made for another tier")
        if found:
            slot, info = self._pick(found)
            if getattr(info, "state", None) == SandboxState.PAUSED:
                self._admit(principal, key, tier)  # connecting runs it again, so it counts as live from here
            sbx = self._e2b.Sandbox.connect(info.sandbox_id, timeout=self._cfg.idle_for(tier), **self._cfg.api(slot))
            return Handle(key=key, tier=tier, ref=sbx, slot=slot)
        if unread:
            raise self._unreachable(unread)
        return None

    def _pick(self, found: list[tuple[int, Any]]) -> tuple[int, Any]:
        """The conversation's sandbox when the listing holds several: the one used last by `end_at` (a running
        sandbox's last connect plus `idle_secs`, a paused one's moment of pausing), then the earliest started. Several
        means a slot came back from auto-off holding the conversation's older sandbox, or a create race still
        settling. Every machine reads the same listing, so they agree; nothing is killed here."""
        if len(found) > 1:
            self._log("sandbox.split_conversation", count=len(found), slots=sorted({s for s, _i in found}))
        never = datetime.min.replace(tzinfo=UTC)

        def rank(r: tuple[int, Any]) -> tuple:
            info = r[1]
            started = getattr(info, "started_at", None) or never
            return (getattr(info, "end_at", None) or never, -started.timestamp() if started != never else 0.0,
                    getattr(info, "sandbox_id", ""))
        return max(found, key=rank)

    def destroy(self, principal: str, conversation: str) -> int:
        """Kill the conversation's sandbox of every tier on every slot, without resuming it first. Returns how many
        went; raises after killing what it could if a slot didn't answer, so the caller logs the miss."""
        from e2b.sandbox.sandbox_api import SandboxQuery

        query = SandboxQuery(metadata={"key": key_for(principal, conversation)})

        def on(slot: int) -> list[bool | None]:
            return [self._kill(slot, info.sandbox_id) for info in self._listed(slot, query)]
        answered, unread = self._each(on)
        if unread:
            raise self._unreachable(unread)
        results = [r for _s, rs in answered for r in cast("list[bool | None]", rs)]
        if None in results:
            raise SandboxError("a sandbox of this conversation could not be killed; the idle sweep will retry")
        return sum(1 for r in results if r)

    def sweep(self, older_than_secs: float) -> list[str]:
        """Kill every sandbox of ours unused for longer than `older_than_secs`, returning their keys.

        Each connect sets the sandbox's timeout to its tier's idle window from now, so `end_at` is the last use
        plus that window while it runs, and the moment it paused once it has: either way the last use is
        `end_at` minus the window. A running sandbox is never past the limit by this measure."""
        from e2b.api.client.models.sandbox_state import SandboxState
        from e2b.sandbox.sandbox_api import SandboxQuery

        now = time.time()

        def on(slot: int) -> list[str]:
            killed: list[str] = []
            pages = self._e2b.Sandbox.list(query=SandboxQuery(state=[SandboxState.RUNNING, SandboxState.PAUSED]),
                                           **self._params(slot))
            while pages.has_next:
                for info in pages.next_items():
                    key = info.metadata.get("key") or ""
                    idle = self._cfg.idle_for(info.metadata.get("tier"))
                    stale = bool(key) and now - (info.end_at.timestamp() - idle) > older_than_secs
                    if stale and self._kill(slot, info.sandbox_id):
                        killed.append(key)
            return killed
        return [k for _s, keys in self._each(on)[0] for k in cast("list[str]", keys)]  # the next pass takes a miss

    def _log(self, event: str, **fields: object) -> None:
        if self._log_event is not None:
            self._log_event(event, **fields)

    def _admit(self, principal: str, key: str, tier: Tier) -> None:
        """Refuse a run-code sandbox that would be the account's one past `account_max_live` running at once.

        Counted from the host's own listing, by the owner metadata every new sandbox carries, so it holds across agent
        machines and restarts and keeps no state here. A sandbox made before the metadata existed is not counted; it
        pauses within its idle window. Agent mode is not counted either: its tasks already have their own per-account
        limit (AGENT_SUBJECT_MAX_CONCURRENCY). A slot that does not answer is not counted, so a host being down never
        locks an account out."""
        cap = self._cfg.account_max_live
        if cap <= 0 or tier is not Tier.RUN_CODE:
            return
        from e2b.api.client.models.sandbox_state import SandboxState
        from e2b.sandbox.sandbox_api import SandboxQuery

        owner = owner_for(principal)
        query = SandboxQuery(metadata={"owner": owner, "tier": tier.value}, state=[SandboxState.RUNNING])
        try:
            answered, _unread = self._each(lambda s: self._listed(s, query))
        except Exception:  # noqa: BLE001 — one host, and it did not answer: nothing to count, so nothing to refuse on
            return
        live = [info for _s, infos in answered for info in cast("list", infos)]
        if any(info.metadata.get("key") == key for info in live):
            return
        if len(live) >= cap:
            self._log("sandbox.account_cap", owner=owner, live=len(live), cap=cap)
            minutes = max(1, self._cfg.idle_for(tier) // 60)
            raise SandboxAccountLimit(
                f"This account already has {cap} code sandboxes running in other conversations, which is the most "
                f"it can have at once. A sandbox pauses after {minutes} minutes without a call, so try again then, "
                f"or carry on in one of those conversations.")

    def pool_load(self) -> dict[int, int]:
        """How many sandboxes are running on each slot that answered, ours or not: the host's load, for the alert."""
        from e2b.api.client.models.sandbox_state import SandboxState
        from e2b.sandbox.sandbox_api import SandboxQuery

        def on(slot: int) -> int:
            pages = self._e2b.Sandbox.list(query=SandboxQuery(state=[SandboxState.RUNNING]), **self._params(slot))
            n = 0
            while pages.has_next:
                n += len(pages.next_items())
            return n
        return {s: cast("int", n) for s, n in self._each(on)[0]}

    def _is_capacity(self, e: BaseException) -> bool:
        if isinstance(e, (self._e2b.ServiceBusyException, self._e2b.RateLimitException)):
            return True
        # Embed answers a create its guest-memory pool can't hold with a 500, not a 503: the orchestrator's
        # FailedPrecondition "this node cannot map N MiB of guest memory" (e2b-dev/infra bca4b33e44,
        # packages/orchestrator/pkg/server/sandboxes.go:3130), forwarded as text (CUR-4518).
        return isinstance(e, self._e2b.SandboxException) and "cannot map" in str(e)

    _WAIT_MAX_STEP_SECS = 10.0
    _PROBE_SECS = 5.0

    def connect(self, principal: str, conversation: str, tier: Tier, *, on_wait: OnWait | None = None,
                cancelled: Callable[[], bool] | None = None) -> Handle:
        """The conversation's sandbox, resumed or new. On a full host it waits up to `busy_wait_secs` for a slot,
        asking again with a growing pause and telling `on_wait` once when the wait starts (CUR-4584); `cancelled`
        ends the wait early. The wait holds no lock, and runs on the caller's thread, which is never a request's
        event loop: the agent task's own thread, or the worker a run-code tool hands its call to."""
        started = self._clock()
        step = self._cfg.busy_retry_secs
        waiting = False
        while True:
            try:
                h = self._connect_once(principal, conversation, tier, probe=waiting)
            except SandboxBusy:
                left = started + self._cfg.busy_wait_secs - self._clock()
                if left <= 0 or (cancelled is not None and cancelled()):
                    self._log_busy(tier, "gave_up" if waiting else "refused", started)
                    raise
                if not waiting:
                    waiting = True
                    if on_wait is not None:
                        on_wait(SANDBOX_WAIT_TEXT)
                self._sleep(min(step, left))
                step = min(step * 1.5, self._WAIT_MAX_STEP_SECS)
                continue
            if waiting:
                self._log_busy(tier, "waited", started)
            return h

    def _log_busy(self, tier: Tier, outcome: str, started: float) -> None:
        """One `sandbox.host_busy` per connect that met a full host: `refused` at once, `waited` for a slot and got
        one, or `gave_up` after the wait. The alert counts the ones a person was turned away by."""
        self._log("sandbox.host_busy", tier=tier.value, slots=len(self._on()), outcome=outcome,
                  waited_ms=int((self._clock() - started) * 1000))

    def _connect_once(self, principal: str, conversation: str, tier: Tier, *, probe: bool) -> Handle:
        key = key_for(principal, conversation)
        # Chat's tool calls run on worker threads, so a turn's parallel first calls would each find nothing and each
        # create; the lock makes the later ones find the first one's sandbox (CUR-4517).
        with self._key_locks[hash(key) % len(self._key_locks)], self._owner_lock(principal, tier):
            found = self.find(principal, conversation, tier)
            if found is not None:
                return found
            return self._create(principal, key, tier, probe=probe)

    def _may_probe(self, slot: int) -> bool:
        """Whether a waiting connect may ask `slot` although its breaker is open: once per `_PROBE_SECS` across every
        waiter, so a full host hears one refused create from them per slot per pause, not one per waiter."""
        with self._probe_lock:
            now = self._clock()
            if now - self._probed_at.get(slot, float("-inf")) < self._PROBE_SECS:
                return False
            self._probed_at[slot] = now
            return True

    def _owner_lock(self, principal: str, tier: Tier):
        """Holds one account's count-then-start to one at a time on this machine, so two conversations opening at once
        can't both pass the count; two machines can still overshoot by one. No lock where there is no count."""
        if self._cfg.account_max_live <= 0 or tier is not Tier.RUN_CODE:
            return contextlib.nullcontext()
        return self._owner_locks[hash(principal) % len(self._owner_locks)]

    def _create(self, principal: str, key: str, tier: Tier, *, probe: bool = False) -> Handle:
        """A new sandbox on the lowest-numbered slot that is up, not draining and has room. A capacity refusal moves
        on to the next slot, so the person hears the host is full only when every slot is. With several slots any
        other failure moves on too; it doesn't mark the slot down, since that would make every `find` refuse for
        `_DOWN_SECS` on the strength of one create.

        A slot whose breaker is open is skipped, unless `probe` (a connect already waiting) and `_may_probe` lets this
        caller ask it: the breaker's success resets it, so a slot that freed serves everyone again (CUR-4584)."""
        self._admit(principal, key, tier)
        busy = SandboxBusy("the sandbox host is full right now; try again in a minute")
        failed: Exception | None = None
        auto_off = self.auto_off_slots()
        for slot in self._up():
            if slot in self.draining or slot in auto_off:
                continue
            if self._create_breakers[slot].opened and not (probe and self._may_probe(slot)):
                continue
            try:
                sbx = self._create_on(slot, key, tier, owner_for(principal))
            except Exception as e:
                if self._is_capacity(e):
                    continue
                if self._cfg.slots > 1:
                    failed = e
                    continue
                if isinstance(e, self._e2b.SandboxException):
                    raise SandboxError("the sandbox could not be started; try again") from e
                raise
            return self._earliest(key, tier, slot, sbx)
        if failed is not None:
            raise SandboxError("the sandbox could not be started; try again") from failed
        raise busy

    def _create_on(self, slot: int, key: str, tier: Tier, owner: str) -> Sandbox:
        lifecycle: SandboxLifecycle = {"on_timeout": {"action": "pause", "keep_memory": True}, "auto_resume": True}
        with self._create_breakers[slot]:
            return self._e2b.Sandbox.create(
                template=self._cfg.template,
                timeout=self._cfg.idle_for(tier),
                metadata={"key": key, "tier": tier.value, "owner": owner},
                envs={},
                network=self._network(tier),
                lifecycle=lifecycle,
                **self._cfg.api(slot),
            )

    def _earliest(self, key: str, tier: Tier, slot: int, sbx: Sandbox) -> Handle:
        """Two agent machines can still race on one conversation, on one slot or two. Every racer keeps the
        earliest-started sandbox for the key on any slot, so they agree without talking, and the others are killed
        before anything is written to them. The check is best effort: if it fails, keep ours, as before it existed."""
        from e2b.sandbox.sandbox_api import SandboxQuery

        Sandbox = self._e2b.Sandbox
        mine = sbx.sandbox_id
        try:
            query = SandboxQuery(metadata={"key": key})
            found = [(s, info) for s, infos in self._each(lambda s: self._listed(s, query))[0]
                     for info in cast("list", infos)]
            first = min(found, key=lambda r: (r[1].started_at, r[1].sandbox_id), default=None)
            if first is not None and (first[0], first[1].sandbox_id) != (slot, mine):
                theirs = Sandbox.connect(first[1].sandbox_id, timeout=self._cfg.idle_for(tier),
                                         **self._cfg.api(first[0]))
                Sandbox.kill(mine, **self._params(slot))
                return Handle(key=key, tier=tier, ref=theirs, slot=first[0])
        except Exception:  # noqa: BLE001
            pass
        sbx.commands.run(f"mkdir -p {shlex.quote(WORK)}", timeout=30)
        return Handle(key=key, tier=tier, ref=sbx, slot=slot)

    def pause(self, h: Handle) -> None:
        """Pause, asking again while the host answers busy (CUR-4503). Embed refuses a pause with a 503 when the
        node can't take it yet, and the SDK says a refused pause changed nothing, so the same call is safe to repeat;
        given up after one try, the sandbox keeps its slot until the idle timeout and the host can fill up."""
        for wait in (*_PAUSE_RETRY_WAITS, None):
            try:
                _sbx(h).pause()
                return
            except (self._e2b.ServiceBusyException, self._e2b.RateLimitException) as e:
                self._log("sandbox.pause_busy", key=h.key, slot=h.slot, retry_in=wait, detail=str(e)[:300])
                if wait is None:
                    raise
                time.sleep(wait)

    def kill(self, h: Handle) -> None:
        _sbx(h).kill()

    # -- commands ----------------------------------------------------------------------------------------------

    def exec(self, h: Handle, argv: list[str], timeout: float, *, stdin: str | None = None) -> ExecResult:
        cmd = shlex.join(argv)
        if stdin is not None:
            _sbx(h).files.write(f"{WORK}/.stdin", stdin)
            cmd = f"{cmd} < .stdin; s=$?; rm -f .stdin; exit $s"
        t0 = time.monotonic()
        ms = lambda: int((time.monotonic() - t0) * 1000)
        try:
            r = _sbx(h).commands.run(f"bash -c {shlex.quote(cmd)}", cwd=WORK, envs={}, timeout=timeout)
        except self._e2b.CommandExitException as e:  # a non-zero exit is an answer, not a failure here
            return ExecResult(e.stdout, e.stderr, e.exit_code, ms())
        except self._e2b.TimeoutException:
            return ExecResult("", "", None, ms(), timed_out=True)
        return ExecResult(r.stdout, r.stderr, r.exit_code, ms())

    def _resolved(self, h: Handle, rel: str) -> str:
        """`rel` with links resolved inside the guest, still inside WORK, or SandboxError."""
        target = workspace_path(rel)
        res = self.exec(h, ["realpath", "-m", "--", target], 15)
        real = res.stdout.strip()
        if res.code != 0 or (real != WORK and not real.startswith(WORK + "/")):
            raise SandboxError(f"{rel!r} is outside the workspace")
        return real

    # -- files -------------------------------------------------------------------------------------------------

    def read(self, h: Handle, path: str, limit: int) -> bytes:
        real = self._resolved(h, path)
        if self.exec(h, ["test", "-f", real], 15).code != 0:
            raise SandboxError(f"{path!r} is not a file in the workspace")
        return bytes(_sbx(h).files.read(real, format="bytes"))[:limit]

    def write(self, h: Handle, path: str, data: bytes) -> None:
        real = self._resolved(h, path)
        if real == WORK or self.exec(h, ["test", "-d", real], 15).code == 0:
            raise SandboxError(f"{path!r} is a directory")
        _sbx(h).files.write(real, data)

    def list(self, h: Handle, limit: int) -> list[tuple[str, int]]:
        # Regular files only, never through a link: the same answer BwrapBackend's lstat walk gives.
        res = self.exec(h, ["find", WORK, "-type", "f", "-printf", f"%P\t%s{_BOUNDARY}"], 30)
        out: list[tuple[str, int]] = []
        for rec in res.stdout.split(_BOUNDARY):
            rel, _, size = rec.partition("\t")
            if rel and size.isdigit() and not rel.startswith(".stdin"):
                out.append((rel, int(size)))
        return sorted(out)[:limit]

    # -- long processes ----------------------------------------------------------------------------------------

    def _proc(self, handle) -> Proc:
        """A Proc over an E2B command handle. Its output arrives only while someone iterates the handle, so
        `lines` is that iteration, and `wait` drains whatever nobody read."""

        def lines() -> Iterator[str]:
            for out, _err, _pty in handle:
                if out:
                    yield out

        def wait(timeout: float | None) -> int | None:
            try:
                return handle.wait().exit_code
            except self._e2b.CommandExitException as e:
                return e.exit_code

        return Proc(id=str(handle.pid), lines=lines(), write=lambda s: handle.send_stdin(s), wait=wait,
                    kill=handle.kill)

    def spawn(self, h: Handle, argv: list[str], env: dict[str, str]) -> Proc:
        return self._proc(_sbx(h).commands.run(shlex.join(argv), background=True, stdin=True, cwd=WORK, envs=env,
                                             timeout=0))

    def attach(self, h: Handle, proc_id: str) -> Proc:
        """The process lives in the sandbox, so a restarted service reconnects to it by pid."""
        return self._proc(_sbx(h).commands.connect(int(proc_id), timeout=0))

    @asynccontextmanager
    async def open_stdio(self, h: Handle, argv: list[str], env: dict[str, str]) -> AsyncIterator[StdioStreams]:
        """`argv` started in the guest with its stdio bridged to asyncio streams for an ACP session. Leaving the
        block kills the process; the sandbox itself stays for the conversation's next task."""
        loop = asyncio.get_running_loop()
        # The timeout restarts the sandbox's pause clock: it otherwise counts from the conversation's last connect,
        # and E2B paused the guest under a running attempt at exactly its idle window (CUR-4535).
        sbx = await self._e2b.AsyncSandbox.connect(_sbx(h).sandbox_id, timeout=self._cfg.idle_for(h.tier),
                                                   **self._cfg.api(h.slot))
        reader, errs = asyncio.StreamReader(), asyncio.StreamReader()

        def out(s: str) -> None:
            reader.feed_data(s.encode())

        def err(s: str) -> None:
            errs.feed_data(s.encode())

        handle = await sbx.commands.run(shlex.join(argv), background=True, stdin=True, cwd=WORK, envs=env,
                                        on_stdout=out, on_stderr=err, timeout=0)
        proc = _AsyncProc(errs)

        async def reap() -> None:
            try:
                proc.returncode = (await handle.wait()).exit_code
            except self._e2b.CommandExitException as e:
                proc.returncode = e.exit_code
            finally:
                reader.feed_eof()
                errs.feed_eof()

        reaper = loop.create_task(reap())
        try:
            yield reader, stdin_writer(handle.send_stdin, loop), proc
        finally:
            if proc.returncode is None:
                # Bounded: a kill sent to a paused or unreachable guest otherwise never returns (CUR-4535).
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(handle.kill(), _TEARDOWN_SECS)
            await asyncio.wait({reaper}, timeout=_TEARDOWN_SECS)


_TEARDOWN_SECS = 10.0  # how long leaving `open_stdio` waits for the kill, then for the exit code


class _AsyncProc:
    def __init__(self, stderr: asyncio.StreamReader):
        self.stderr: asyncio.StreamReader | None = stderr
        self.returncode: int | None = None


def stdin_writer(send: Callable[[bytes], Awaitable[object]], loop: asyncio.AbstractEventLoop) -> asyncio.StreamWriter:
    """A real `asyncio.StreamWriter` whose bytes go to the guest's stdin through `send`, in order (CUR-4498).

    acp 0.9.0, the version the service runs, refuses anything that is not an `asyncio.StreamWriter`. Writes queue on
    the transport, and the protocol stays paused until the queue is sent, so `drain()` returns only once the guest
    has the bytes: asyncio's own flow control, nothing of ours in between."""
    protocol = asyncio.StreamReaderProtocol(asyncio.StreamReader(), loop=loop)
    transport = _StdinTransport(send, protocol, loop)
    protocol.connection_made(transport)
    return asyncio.StreamWriter(transport, protocol, None, loop)


class _StdinTransport(asyncio.WriteTransport):
    def __init__(self, send: Callable[[bytes], Awaitable[object]], protocol: asyncio.BaseProtocol,
                 loop: asyncio.AbstractEventLoop):
        super().__init__()
        self._send, self._protocol, self._loop = send, protocol, loop
        self._queue: list[bytes] = []
        self._sender: asyncio.Task | None = None
        self._closing = False

    def write(self, data) -> None:
        if self._closing or not data:
            return
        self._queue.append(bytes(data))
        if self._sender is None:
            self._protocol.pause_writing()  # type: ignore[attr-defined]
            self._sender = self._loop.create_task(self._flush())

    async def _flush(self) -> None:
        try:
            while self._queue:
                await self._send(self._queue.pop(0))
        except Exception as e:  # noqa: BLE001 — the guest is gone; the reader's EOF tells the session
            self._closing = True
            self._queue.clear()
            self._protocol.connection_lost(e)
            return
        finally:
            self._sender = None
        self._protocol.resume_writing()  # type: ignore[attr-defined]

    def is_closing(self) -> bool:
        return self._closing

    def close(self) -> None:
        self._closing = True

    def get_write_buffer_size(self) -> int:
        return sum(len(b) for b in self._queue)
