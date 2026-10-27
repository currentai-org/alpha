"""The parts of the E2B backend that need no live install (CUR-4451). The rest is the contract suite, run with
SANDBOX_CONTRACT_BACKEND=e2b against the bake-off install."""

import pytest
from sandbox_backend import SandboxError, Tier

sandbox_e2b = pytest.importorskip("sandbox_e2b")
pytest.importorskip("e2b")


@pytest.mark.parametrize("rel", ["", "/etc/passwd", "../x", "a/../../x", "a\x00b"])
def test_a_path_outside_the_workspace_never_reaches_the_guest(rel):
    with pytest.raises(SandboxError):
        sandbox_e2b.workspace_path(rel)


def test_a_path_inside_the_workspace_is_kept_inside_it():
    assert sandbox_e2b.workspace_path("a/../b.txt") == f"{sandbox_e2b.WORK}/b.txt"


def _backend(**cfg):
    return sandbox_e2b.E2BBackend(sandbox_e2b.E2BConfig(api_url="http://e2b.invalid", api_key="k", **cfg))


def test_run_code_sandboxes_reach_nothing_even_with_a_gateway_configured():
    net = _backend(gateway_host="gw.example")._network(Tier.RUN_CODE)
    assert net == {"deny_out": ["0.0.0.0/0"], "allow_public_traffic": False}


def test_agent_sandboxes_reach_only_the_gateway_and_carry_no_header_rules():
    """CUR-4500: Embed does not apply a stored header-rewrite rule, so a rule here only looks like a boundary."""
    net = _backend(gateway_host="gw.example")._network(Tier.AGENT)
    assert net == {"deny_out": ["0.0.0.0/0"], "allow_out": ["gw.example"], "allow_public_traffic": False}


def test_an_agent_sandbox_with_no_gateway_configured_reaches_nothing():
    assert _backend()._network(Tier.AGENT) == {"deny_out": ["0.0.0.0/0"], "allow_public_traffic": False}


class _FakeE2B:
    """Just enough of the SDK for the lifecycle calls: a listing and a kill by id, and a connect that fails."""

    def __init__(self, infos):
        fake = self

        class Pages:
            def __init__(self, items):
                self._items, self.has_next = items, True

            def next_items(self):
                self.has_next = False
                return self._items

        class Sandbox:
            @staticmethod
            def list(query=None, **_api):
                key = (query.metadata or {}).get("key") if query is not None else None
                return Pages([i for i in fake.infos if key is None or i.metadata.get("key") == key])

            @staticmethod
            def kill(sandbox_id, **_api):
                fake.killed.append(sandbox_id)
                return True

            @staticmethod
            def connect(*_a, **_k):
                raise AssertionError("a lifecycle call must not resume a sandbox")

        self.infos, self.killed, self.Sandbox = infos, [], Sandbox


def _info(sid, key, end_offset_s):
    import datetime
    import types
    end = datetime.datetime.now(datetime.UTC) + datetime.timedelta(seconds=end_offset_s)
    return types.SimpleNamespace(sandbox_id=sid, metadata={"key": key} if key else {}, end_at=end)


def test_one_sweep_kills_a_sandbox_unused_past_the_limit_and_keeps_a_recent_one():
    """CUR-4484. With a 600 s idle timeout and a four-hour limit: paused five hours ago goes, and so does one that
    paused 3 h 55 m ago, since it was last used ten minutes before pausing. Paused ten minutes ago stays, running
    stays, and a sandbox we did not make (no key) is never touched."""
    b = _backend(idle_secs=600)
    b._e2b = _FakeE2B([_info("old", "k-old", -5 * 3600), _info("edge", "k-edge", -(4 * 3600 - 300)),
                       _info("recent", "k-recent", -600),
                       _info("running", "k-run", 300), _info("theirs", None, -9 * 3600)])
    assert b.sweep(4 * 3600) == ["k-old", "k-edge"]
    assert b._e2b.killed == ["old", "edge"]


def test_destroying_a_conversation_kills_its_sandbox_without_resuming_it():
    from sandbox_backend import key_for
    b = _backend()
    b._e2b = _FakeE2B([_info("mine", key_for("alice", "conv-1"), -60), _info("other", key_for("alice", "conv-2"), -60)])
    assert b.destroy("alice", "conv-1") == 1
    assert b._e2b.killed == ["mine"]


def test_a_full_host_refuses_new_sandboxes_at_once_for_a_cool_off_and_one_success_closes_it(monkeypatch):
    """CUR-4484. The host's capacity refusal opens the breaker: the next create is refused as busy without asking the
    host. After the cool-off one create is tried, and its success lets the following ones through. A create that
    fails for any other reason leaves the breaker closed."""
    import circuitbreaker
    import e2b
    from sandbox_backend import SandboxBusy

    now = [1000.0]
    monkeypatch.setattr(circuitbreaker, "monotonic", lambda: now[0])
    b = _backend(busy_cooloff_secs=30)
    fake = _FakeE2B([])
    outcomes: list = []

    class _Commands:
        def run(self, *_a, **_k):
            return None

    class _Created:
        commands = _Commands()
        sandbox_id = "new"

    def create(**_kw):
        fake.created += 1
        result = outcomes.pop(0)
        if isinstance(result, Exception):
            raise result
        return _Created()

    fake.created = 0
    fake.Sandbox.create = staticmethod(create)
    fake.ServiceBusyException, fake.RateLimitException = e2b.ServiceBusyException, e2b.RateLimitException
    fake.SandboxException = e2b.SandboxException
    b._e2b = fake

    outcomes.append(RuntimeError("one bad create"))
    with pytest.raises(RuntimeError):
        b.connect("alice", "c0", Tier.RUN_CODE)
    outcomes.append(e2b.ServiceBusyException("no capacity"))
    with pytest.raises(SandboxBusy):
        b.connect("alice", "c1", Tier.RUN_CODE)
    assert fake.created == 2  # the unrelated failure did not open it; the capacity one did
    now[0] += 29
    with pytest.raises(SandboxBusy):
        b.connect("bob", "c2", Tier.RUN_CODE)
    assert fake.created == 2  # refused here, the host never asked
    now[0] += 2
    outcomes.extend([_Created(), _Created()])
    b.connect("carol", "c3", Tier.RUN_CODE)
    b.connect("dave", "c4", Tier.RUN_CODE)
    assert fake.created == 4


def _creating_fake(e2b, delay=0.0):
    """A fake whose create registers the new sandbox in the listing, as the host does, after `delay`."""
    import datetime
    import itertools
    import time as _time
    import types

    fake = _FakeE2B([])
    ids = itertools.count()

    class _Commands:
        def run(self, *_a, **_k):
            return None

    def create(metadata, **_kw):
        _time.sleep(delay)
        sid = f"s{next(ids)}"
        fake.infos.append(types.SimpleNamespace(sandbox_id=sid, metadata=metadata,
                                                started_at=datetime.datetime.now(datetime.UTC)))
        return types.SimpleNamespace(sandbox_id=sid, commands=_Commands())

    fake.Sandbox.create = staticmethod(create)
    fake.Sandbox.connect = staticmethod(lambda sid, **_k: types.SimpleNamespace(sandbox_id=sid))
    fake.ServiceBusyException, fake.RateLimitException = e2b.ServiceBusyException, e2b.RateLimitException
    fake.SandboxException = e2b.SandboxException
    return fake


def test_parallel_first_calls_on_one_conversation_share_one_sandbox():
    """CUR-4517: chat runs a turn's tool calls on worker threads. Three first calls at once made three sandboxes and
    the files written to two of them were never seen again."""
    import threading

    import e2b
    b = _backend()
    b._e2b = _creating_fake(e2b, delay=0.05)
    got: list = []
    threads = [threading.Thread(target=lambda: got.append(b.connect("alice", "c", Tier.RUN_CODE).ref.sandbox_id))
               for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(b._e2b.infos) == 1
    assert got == ["s0", "s0", "s0"]


def test_a_sandbox_another_machine_started_first_for_the_conversation_wins_and_ours_is_killed():
    """CUR-4517: two agent machines can race past each other's locks. Each keeps the earliest-started sandbox."""
    import datetime
    import types

    import e2b
    from sandbox_backend import key_for
    b = _backend()
    b._e2b = fake = _creating_fake(e2b)
    earlier = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=1)
    real_create = fake.Sandbox.create

    def create_while_another_machine_does(metadata, **kw):
        fake.infos.append(types.SimpleNamespace(sandbox_id="theirs", metadata=metadata, started_at=earlier))
        return real_create(metadata=metadata, **kw)

    fake.Sandbox.create = staticmethod(create_while_another_machine_does)
    h = b.connect("alice", "c", Tier.RUN_CODE)
    assert h.ref.sandbox_id == "theirs"
    assert fake.killed == ["s0"]
    assert h.key == key_for("alice", "c")


def test_a_failed_check_for_another_machines_sandbox_keeps_ours():
    """The review on #4133: a listing that fails after a good create must not strand the new sandbox."""
    import e2b
    b = _backend()
    b._e2b = fake = _creating_fake(e2b)

    def listing_down(**_k):
        raise e2b.SandboxException("502: bad gateway")

    fake.Sandbox.list = staticmethod(listing_down)
    b.find = lambda *_a: None
    assert b.connect("alice", "c", Tier.RUN_CODE).ref.sandbox_id == "s0"
    assert fake.killed == []


def test_a_host_out_of_guest_memory_is_busy_and_opens_the_breaker(monkeypatch):
    """CUR-4518: Embed refuses a create its hugepage pool can't hold with a 500, which the SDK raises as a plain
    SandboxException. It must read as busy, and the next create must not reach the host."""
    import circuitbreaker
    import e2b
    from sandbox_backend import SandboxBusy

    monkeypatch.setattr(circuitbreaker, "monotonic", lambda: 1000.0)
    b = _backend(busy_cooloff_secs=30)
    b._e2b = fake = _creating_fake(e2b)
    calls = []

    def full(**_kw):
        calls.append(1)
        raise e2b.SandboxException("500: Failed to place sandbox: this node cannot map 1024 MiB of guest memory: "
                                   "its memory pool is too small or in use by running sandboxes")

    fake.Sandbox.create = staticmethod(full)
    with pytest.raises(SandboxBusy, match="host is full"):
        b.connect("alice", "c1", Tier.RUN_CODE)
    with pytest.raises(SandboxBusy):
        b.connect("bob", "c2", Tier.RUN_CODE)
    assert len(calls) == 1


def _waiting_backend(monkeypatch, busy_creates, **cfg):
    """CUR-4584: a backend that waits up to 60 s on a full host, on a fake clock its sleeps move. The host refuses
    the first `busy_creates` creates for capacity (all of them when None), then has room."""
    import circuitbreaker
    import e2b

    now = [1000.0]
    monkeypatch.setattr(circuitbreaker, "monotonic", lambda: now[0])
    b = _backend(busy_cooloff_secs=30, busy_wait_secs=60, **cfg)
    b._e2b = fake = _creating_fake(e2b)
    b._clock = lambda: now[0]
    b._sleep = lambda secs: now.__setitem__(0, now[0] + secs)
    room = fake.Sandbox.create
    fake.asked_at = []

    def create(**kw):
        fake.asked_at.append(now[0])
        if busy_creates is None or len(fake.asked_at) <= busy_creates:
            raise e2b.ServiceBusyException("no capacity to place a sandbox")
        return room(**kw)

    fake.Sandbox.create = staticmethod(create)
    events: list = []
    b._log_event = lambda event, **f: events.append((event, f))
    return b, fake, now, events


def test_a_full_host_that_frees_a_slot_inside_the_wait_gets_the_sandbox_after_one_waiting_status(monkeypatch):
    """CUR-4584: busy twice, then a free slot. The connect returns a handle, the person was told once, and the
    second and third asks went through the breaker the first refusal opened: a waiting connect re-probes rather
    than being refused by its own breaker until the 30 s cool-off ends."""
    from sandbox_backend import SANDBOX_WAIT_TEXT

    b, fake, now, events = _waiting_backend(monkeypatch, busy_creates=2)
    statuses: list[str] = []
    h = b.connect("alice", "c1", Tier.RUN_CODE, on_wait=statuses.append)
    assert h.ref.sandbox_id == "s0"
    assert statuses == [SANDBOX_WAIT_TEXT] == ["Waiting for a free sandbox…"]
    assert fake.asked_at == [1000.0, 1005.0, 1012.5]  # 5 s, then half again: inside the breaker's 30 s
    assert [(e, f["outcome"]) for e, f in events] == [("sandbox.host_busy", "waited")]
    assert events[0][1]["waited_ms"] == 12_500


def test_a_host_still_full_past_the_wait_gives_up_with_todays_sentence(monkeypatch):
    """CUR-4584: busy for the whole minute. Raises SandboxBusy with the sentence the tools already word, after
    about 60 s, having told the person once, and the waiter asked the host at most once per 5 s pause."""
    from sandbox_backend import SANDBOX_WAIT_TEXT, SandboxBusy

    b, fake, now, events = _waiting_backend(monkeypatch, busy_creates=None)
    statuses: list[str] = []
    with pytest.raises(SandboxBusy, match=r"^the sandbox host is full right now; try again in a minute$"):
        b.connect("alice", "c1", Tier.RUN_CODE, on_wait=statuses.append)
    assert now[0] == 1060.0
    assert statuses == [SANDBOX_WAIT_TEXT]
    gaps = [b2 - a for a, b2 in zip(fake.asked_at, fake.asked_at[1:], strict=False)]
    assert gaps and min(gaps) >= 5.0 and max(gaps) <= 10.0
    assert [(e, f["outcome"], f["waited_ms"]) for e, f in events] == [("sandbox.host_busy", "gave_up", 60_000)]


def test_a_wait_of_zero_refuses_at_once_as_before(monkeypatch):
    from sandbox_backend import SandboxBusy

    b, fake, now, events = _waiting_backend(monkeypatch, busy_creates=None)
    b._cfg.busy_wait_secs = 0
    statuses: list[str] = []
    with pytest.raises(SandboxBusy):
        b.connect("alice", "c1", Tier.RUN_CODE, on_wait=statuses.append)
    assert (now[0], statuses, fake.asked_at) == (1000.0, [], [1000.0])
    assert [(e, f["outcome"]) for e, f in events] == [("sandbox.host_busy", "refused")]


def test_a_cancelled_wait_stops_asking_and_raises_busy(monkeypatch):
    from sandbox_backend import SandboxBusy

    b, fake, now, _events = _waiting_backend(monkeypatch, busy_creates=None)
    stopped = []
    with pytest.raises(SandboxBusy):
        b.connect("alice", "c1", Tier.AGENT, on_wait=lambda _t: stopped.append(True), cancelled=lambda: bool(stopped))
    assert fake.asked_at == [1000.0, 1005.0]


def test_waiters_ask_an_open_breakers_slot_once_per_pause_between_them_and_others_are_still_refused(monkeypatch):
    """Several people waiting on one full host send it one create per 5 s between them, not one each; a caller
    that is not waiting is refused by the open breaker without asking the host at all."""
    from sandbox_backend import SandboxBusy

    b, fake, now, _events = _waiting_backend(monkeypatch, busy_creates=None)
    b._cfg.busy_wait_secs = 0
    with pytest.raises(SandboxBusy):
        b.connect("alice", "c1", Tier.RUN_CODE)  # opens the breaker
    for who in ("bob", "carol"):
        with pytest.raises(SandboxBusy):
            b._create(who, f"k-{who}", Tier.RUN_CODE, probe=True)
    with pytest.raises(SandboxBusy):
        b.connect("dave", "c4", Tier.RUN_CODE)
    assert fake.asked_at == [1000.0, 1000.0]  # alice's refusal, then one probe between bob and carol
    now[0] += 5
    with pytest.raises(SandboxBusy):
        b._create("carol", "k-carol", Tier.RUN_CODE, probe=True)
    assert len(fake.asked_at) == 3


def test_any_other_failed_create_is_a_sandbox_error_the_tool_can_word():
    """CUR-4518: an SDK error that is not capacity still reaches the person as a sentence, and opens nothing."""
    import e2b
    b = _backend()
    b._e2b = fake = _creating_fake(e2b)

    def broken(**_kw):
        raise e2b.SandboxException("500: Failed to place sandbox: sandbox creation failed on 1 node(s)")

    fake.Sandbox.create = staticmethod(broken)
    with pytest.raises(SandboxError, match="could not be started"):
        b.connect("alice", "c1", Tier.RUN_CODE)
    assert not b._create_breakers[1].opened


def _resolves_to(monkeypatch, addr):
    def fake(host, port, *a, **k):
        if addr is None:
            raise OSError("no such host")
        return [(None, None, None, "", (addr, port))]
    monkeypatch.setattr(sandbox_e2b.socket, "getaddrinfo", fake)


def test_the_sandbox_url_reaches_the_proxy_by_address_so_it_routes_by_header(monkeypatch):
    _resolves_to(monkeypatch, "fdaa::2")
    cfg = sandbox_e2b.E2BConfig(api_url="http://e2b.invalid", api_key="k", sandbox_url="http://potluck-e2b-link.internal:3002")
    assert cfg.api()["sandbox_url"] == "http://[fdaa::2]:3002"
    _resolves_to(monkeypatch, "10.0.0.7")
    assert sandbox_e2b.by_address("http://link.internal:3002/x") == "http://10.0.0.7:3002/x"


@pytest.mark.parametrize("url", ["http://localhost:3002", "http://[fdaa::9]:3002", "http://10.1.2.3:3002"])
def test_a_sandbox_url_already_routed_by_header_is_left_alone(monkeypatch, url):
    _resolves_to(monkeypatch, "fdaa::2")
    assert sandbox_e2b.by_address(url) == url


def test_a_sandbox_host_that_does_not_resolve_is_passed_through_so_the_failure_names_it(monkeypatch):
    _resolves_to(monkeypatch, None)
    assert sandbox_e2b.by_address("http://gone.internal:3002") == "http://gone.internal:3002"


def test_the_guest_stdin_is_a_real_stream_writer_that_sends_in_order_before_drain_returns():
    import asyncio

    async def go():
        sent: list[bytes] = []
        gate = asyncio.Event()

        async def send(data: bytes):
            await gate.wait()
            sent.append(data)

        writer = sandbox_e2b.stdin_writer(send, asyncio.get_running_loop())
        # acp 0.9.0's ClientSideConnection refuses anything else (CUR-4498).
        assert isinstance(writer, asyncio.StreamWriter)
        writer.write(b'{"a":1}\n')
        writer.write(b'{"b":2}\n')
        drained = asyncio.ensure_future(writer.drain())
        await asyncio.sleep(0.01)
        assert not drained.done() and sent == []
        gate.set()
        await asyncio.wait_for(drained, 1)
        assert sent == [b'{"a":1}\n', b'{"b":2}\n']
        writer.write(b"c")
        await asyncio.wait_for(writer.drain(), 1)
        assert sent[-1] == b"c"

    asyncio.run(go())


def test_a_guest_gone_mid_write_closes_the_writer_instead_of_hanging_drain():
    import asyncio

    async def go():
        async def send(data: bytes):
            raise RuntimeError("sandbox gone")

        writer = sandbox_e2b.stdin_writer(send, asyncio.get_running_loop())
        writer.write(b"x")
        try:
            await asyncio.wait_for(writer.drain(), 1)
        except (ConnectionError, RuntimeError):
            pass
        assert writer.is_closing()

    asyncio.run(go())


def test_leaving_a_hermes_session_returns_even_when_the_guest_never_takes_the_kill(monkeypatch):
    """CUR-4535. A guest E2B has paused never answers the kill or the wait, and an unbounded kill held the agent
    task's slot until the app was redeployed. The connect also restarts the sandbox's pause clock."""
    import asyncio
    import time
    import types

    from sandbox_backend import Handle

    never = asyncio.Event()
    connects = []

    class _Handle:
        async def wait(self):
            await never.wait()

        async def kill(self):
            await never.wait()

        async def send_stdin(self, data):
            return None

    class _Commands:
        async def run(self, *_a, **_k):
            return _Handle()

    class AsyncSandbox:
        @staticmethod
        async def connect(sandbox_id, **kw):
            connects.append(kw.get("timeout"))
            return types.SimpleNamespace(commands=_Commands())

    monkeypatch.setattr(sandbox_e2b, "_TEARDOWN_SECS", 0.2)
    b = _backend(idle_secs=600)
    b._e2b = types.SimpleNamespace(AsyncSandbox=AsyncSandbox, CommandExitException=type("CommandExitException", (Exception,), {}))
    h = Handle(key="k", tier=Tier.AGENT, ref=types.SimpleNamespace(sandbox_id="sbx-1"))

    async def session():
        async with b.open_stdio(h, ["hermes", "acp"], {}):
            pass

    started = time.monotonic()
    asyncio.run(asyncio.wait_for(session(), 5))
    assert time.monotonic() - started < 2
    assert connects == [600]


# -- a pool of slots (CUR-4529) -----------------------------------------------------------------------------------


_RUNNING = pytest.importorskip("e2b.api.client.models.sandbox_state").SandboxState.RUNNING
_PAUSED = pytest.importorskip("e2b.api.client.models.sandbox_state").SandboxState.PAUSED


class _PoolFake:
    """Several hosts behind one link: each call lands on the slot its port names, as the link routes it."""

    def __init__(self, e2b, slots=2):
        import datetime
        import itertools
        import types
        from urllib.parse import urlsplit

        fake = self
        self.infos = {s: [] for s in range(1, slots + 1)}
        self.killed, self.created, self.connected = [], [], []
        self.refuse, self.down, self.broken, self.unkillable = set(), set(), set(), set()
        self.timeouts = []  # request_timeout of every list and kill
        ids = itertools.count()

        def slot_of(api):
            return (urlsplit(api["api_url"]).port - 3000) // 100 + 1

        class Pages:
            def __init__(self, items):
                self._items, self.has_next = items, True

            def next_items(self):
                self.has_next = False
                return self._items

        class _Commands:
            def run(self, *_a, **_k):
                return None

        class Sandbox:
            @staticmethod
            def list(query=None, **api):
                s = slot_of(api)
                fake.timeouts.append(api.get("request_timeout"))
                if s in fake.down:
                    raise ConnectionError(f"slot {s} is down")
                want = (query.metadata or {}) if query is not None else {}
                states = (query.state or None) if query is not None else None
                return Pages([i for i in fake.infos[s]
                              if all(i.metadata.get(k) == v for k, v in want.items())
                              and (states is None or getattr(i, "state", _RUNNING) in states)])

            @staticmethod
            def create(metadata, **api):
                s = slot_of(api)
                fake.created.append(s)
                if s in fake.refuse:
                    raise e2b.ServiceBusyException("no capacity to place a sandbox")
                if s in fake.broken:
                    raise e2b.SandboxException("connection refused")
                sid = f"s{s}-{next(ids)}"
                now = datetime.datetime.now(datetime.UTC)
                fake.infos[s].append(types.SimpleNamespace(sandbox_id=sid, metadata=metadata, started_at=now,
                                                           end_at=now + datetime.timedelta(seconds=600)))
                return types.SimpleNamespace(sandbox_id=sid, commands=_Commands())

            @staticmethod
            def connect(sid, **api):
                s = slot_of(api)
                fake.connected.append((sid, s))
                return types.SimpleNamespace(sandbox_id=sid, kill=lambda: fake.killed.append((sid, s)))

            @staticmethod
            def kill(sid, **api):
                fake.timeouts.append(api.get("request_timeout"))
                if sid in fake.unkillable:
                    raise e2b.SandboxException("sandbox is pausing")
                fake.killed.append((sid, slot_of(api)))
                return True

        self.Sandbox = Sandbox
        self.ServiceBusyException, self.RateLimitException = e2b.ServiceBusyException, e2b.RateLimitException
        self.SandboxException = e2b.SandboxException
        self.slot_of = slot_of

    def add(self, slot, sid, key, age_s=0, tier="run_code", idle_for_s=0, owner=None, state=None):
        import datetime
        import types
        now = datetime.datetime.now(datetime.UTC)
        info = types.SimpleNamespace(
            sandbox_id=sid, metadata={"key": key, "tier": tier, **({"owner": owner} if owner else {})},
            started_at=now - datetime.timedelta(seconds=age_s),
            end_at=now - datetime.timedelta(seconds=idle_for_s) + datetime.timedelta(seconds=600))
        if state is not None:
            info.state = state
        self.infos[slot].append(info)


def _pool(slots=2, **cfg):
    import e2b
    b = sandbox_e2b.E2BBackend(sandbox_e2b.E2BConfig(api_url="http://e2b.invalid:3000", api_key="k",
                                                     sandbox_url="http://e2b.invalid:3002", slots=slots, **cfg))
    b._e2b = _PoolFake(e2b, slots)
    return b, b._e2b


def test_slot_i_is_the_link_on_ports_moved_by_a_hundred_and_slot_one_is_the_urls_as_given():
    cfg = sandbox_e2b.E2BConfig(api_url="http://e2b.invalid:3000", api_key="k", sandbox_url="http://e2b.invalid:3002",
                                slots=3)
    assert cfg.api(1) == {"api_url": "http://e2b.invalid:3000", "api_key": "k", "sandbox_url": "http://e2b.invalid:3002"}
    assert cfg.api(3)["api_url"] == "http://e2b.invalid:3200" and cfg.api(3)["sandbox_url"] == "http://e2b.invalid:3202"
    with pytest.raises(ValueError, match="name their ports"):
        sandbox_e2b.E2BConfig(api_url="http://e2b.invalid", api_key="k", slots=2)
    for off in ({3}, {1, 2}):
        with pytest.raises(ValueError, match="E2B_SLOTS_OFF"):
            sandbox_e2b.E2BConfig(api_url="http://e2b.invalid:3000", api_key="k", slots=2, off=frozenset(off))


def test_a_conversations_sandbox_living_on_slot_two_is_found_and_reached_there():
    from sandbox_backend import key_for
    b, fake = _pool()
    fake.add(2, "theirs", key_for("alice", "c"))
    h = b.find("alice", "c", Tier.RUN_CODE)
    assert h is not None and h.slot == 2 and h.ref.sandbox_id == "theirs"
    assert fake.connected == [("theirs", 2)]


def test_a_full_slot_one_places_the_sandbox_on_slot_two():
    b, fake = _pool()
    fake.refuse = {1}
    h = b.connect("alice", "c", Tier.RUN_CODE)
    assert (h.slot, fake.created) == (2, [1, 2])


def test_a_draining_slot_gets_no_new_sandbox_even_with_room():
    b, fake = _pool()
    b.draining = {1}
    h = b.connect("alice", "c", Tier.RUN_CODE)
    assert (h.slot, fake.created) == (2, [2])


def test_the_host_is_full_only_when_every_slot_refuses():
    from sandbox_backend import SandboxBusy
    b, fake = _pool(slots=3)
    fake.refuse = {1, 2, 3}
    with pytest.raises(SandboxBusy):
        b.connect("alice", "c", Tier.RUN_CODE)
    assert fake.created == [1, 2, 3]


def test_a_slot_that_cant_be_read_stops_find_rather_than_giving_the_conversation_a_second_empty_sandbox():
    from sandbox_backend import SandboxError, key_for
    b, fake = _pool()
    fake.add(1, "hers", key_for("alice", "c"))
    fake.down = {1}
    with pytest.raises(SandboxError, match="can't be reached"):
        b.connect("alice", "c", Tier.RUN_CODE)
    assert fake.created == []
    fake.down = set()
    b._down_until.clear()
    assert b.connect("alice", "c", Tier.RUN_CODE).ref.sandbox_id == "hers"


def test_a_down_slot_is_not_asked_for_thirty_seconds_then_asked_again(monkeypatch):
    from sandbox_backend import SandboxError
    now = [1000.0]
    monkeypatch.setattr(sandbox_e2b.time, "monotonic", lambda: now[0])
    b, fake = _pool()
    fake.down = {1}
    with pytest.raises(SandboxError):
        b.find("alice", "c", Tier.RUN_CODE)
    fake.down = set()
    asked = len(fake.timeouts)
    now[0] += 29
    with pytest.raises(SandboxError):  # back, but not asked yet: refused at once
        b.find("alice", "c", Tier.RUN_CODE)
    assert len(fake.timeouts) == asked + 1  # slot 2 only
    now[0] += 2
    assert b.connect("carol", "c3", Tier.RUN_CODE).slot == 1


def test_a_slot_turned_off_is_never_asked_and_gets_no_sandbox():
    b, fake = _pool(off=frozenset({1}))
    fake.down = {1}
    h = b.connect("alice", "c", Tier.RUN_CODE)
    assert (h.slot, fake.created) == (2, [2])


def test_a_create_that_fails_on_one_slot_for_another_reason_moves_to_the_next():
    from sandbox_backend import SandboxError
    b, fake = _pool()
    fake.broken = {1}
    assert b.connect("alice", "c", Tier.RUN_CODE).slot == 2
    assert b._down_until == {}  # one create's failure doesn't make every find refuse
    fake.broken = {1, 2}
    with pytest.raises(SandboxError, match="could not be started"):
        b.connect("bob", "c", Tier.RUN_CODE)


def test_a_racing_machines_earlier_sandbox_on_another_slot_wins_and_ours_is_killed():
    from sandbox_backend import key_for
    b, fake = _pool()
    key = key_for("alice", "c")
    fake.add(2, "theirs", key, age_s=5)
    h = b._create("alice", key, Tier.RUN_CODE)  # past the find, as when another machine created between our find and create
    assert (h.slot, h.ref.sandbox_id) == (2, "theirs")
    assert [k for k in fake.killed if k[1] == 1] == [(fake.infos[1][0].sandbox_id, 1)]


def test_kill_and_the_hermes_session_reach_the_handles_own_slot():
    import asyncio
    import types

    from sandbox_backend import key_for
    b, fake = _pool()
    fake.add(2, "theirs", key_for("alice", "c"))
    h = b.find("alice", "c", Tier.RUN_CODE)
    b.kill(h)
    assert fake.killed == [("theirs", 2)]

    seen = []

    class _Handle:
        async def wait(self):
            return types.SimpleNamespace(exit_code=0)

        async def kill(self):
            return None

        async def send_stdin(self, data):
            return None

    class AsyncSandbox:
        @staticmethod
        async def connect(sid, **api):
            seen.append((sid, fake.slot_of(api)))

            class _Commands:
                async def run(self, *_a, **_k):
                    return _Handle()
            return types.SimpleNamespace(commands=_Commands())

    fake.AsyncSandbox = AsyncSandbox
    fake.CommandExitException = type("CommandExitException", (Exception,), {})

    async def session():
        async with b.open_stdio(h, ["hermes", "acp"], {}):
            pass

    asyncio.run(session())
    assert seen == [("theirs", 2)]


def test_sweep_and_destroy_reach_every_slot():
    from sandbox_backend import key_for
    b, fake = _pool()
    fake.add(1, "old1", "k-old1", idle_for_s=5 * 3600)
    fake.add(2, "old2", "k-old2", idle_for_s=5 * 3600)
    fake.add(2, "new2", "k-new2")
    assert sorted(b.sweep(4 * 3600)) == ["k-old1", "k-old2"]
    key = key_for("alice", "c")
    fake.add(1, "c1", key)
    fake.add(2, "c2", key)
    fake.killed.clear()
    assert b.destroy("alice", "c") == 2
    assert sorted(fake.killed) == [("c1", 1), ("c2", 2)]
    assert set(fake.timeouts) == {sandbox_e2b.E2BBackend._LIST_TIMEOUT_SECS}  # no list or kill can hang a pass


def test_with_one_host_every_list_and_kill_is_bounded_so_a_silent_host_cannot_outlast_a_chat_turn():
    # One slot on the SDK's 60 s default would let a host behind a link that stopped passing packets hold
    # each run-code call past chat's 45 s turn cap (CUR-4628).
    from sandbox_backend import key_for
    b, fake = _pool(slots=1)
    key = key_for("alice", "c")
    fake.add(1, "c1", key)
    fake.add(1, "old", "k-old", idle_for_s=5 * 3600)
    assert b.find("alice", "c", Tier.RUN_CODE) is not None
    b.pool_load()
    b.sweep(4 * 3600)
    b.destroy("alice", "c")
    assert fake.timeouts and set(fake.timeouts) == {sandbox_e2b.E2BBackend._LIST_TIMEOUT_SECS}
    assert sandbox_e2b.E2BBackend._LIST_TIMEOUT_SECS < 45


def test_with_one_host_that_does_not_answer_a_run_code_call_gets_the_worded_unreachable_error_and_no_new_sandbox():
    from sandbox_backend import SandboxError
    b, fake = _pool(slots=1)
    fake.down = {1}
    with pytest.raises(SandboxError, match="can't be reached right now"):
        b.connect("alice", "c", Tier.RUN_CODE)
    assert fake.created == []


def test_destroy_kills_what_it_can_reach_and_raises_for_a_slot_it_cant():
    from sandbox_backend import SandboxError, key_for
    b, fake = _pool()
    key = key_for("alice", "c")
    fake.add(1, "c1", key)
    fake.add(2, "c2", key)
    fake.down = {2}
    with pytest.raises(SandboxError, match="host 2"):
        b.destroy("alice", "c")
    assert fake.killed == [("c1", 1)]


def test_one_sandbox_that_wont_die_leaves_its_host_up_and_the_rest_of_the_sweep_standing():
    from sandbox_backend import SandboxError, key_for
    b, fake = _pool()
    fake.add(1, "stuck", "k-stuck", idle_for_s=5 * 3600)
    fake.add(1, "old", "k-old", idle_for_s=5 * 3600)
    fake.unkillable = {"stuck"}
    assert b.sweep(4 * 3600) == ["k-old"]
    assert b._down_until == {}  # the host answered; one kill failing doesn't make every find refuse
    fake.add(2, "c", key_for("alice", "c"))
    fake.unkillable = {"c"}
    with pytest.raises(SandboxError, match="could not be killed"):
        b.destroy("alice", "c")
    assert b._down_until == {}


# -- one account's live sandboxes (CUR-4553) ----------------------------------------------------------------------


def test_a_third_conversation_of_one_account_is_refused_while_another_accounts_first_still_runs():
    from sandbox_backend import SandboxAccountLimit
    b, fake = _pool(account_max_live=2)
    b.connect("alice", "c1", Tier.RUN_CODE)
    b.connect("alice", "c2", Tier.RUN_CODE)
    with pytest.raises(SandboxAccountLimit, match="already has 2 code sandboxes running"):
        b.connect("alice", "c3", Tier.RUN_CODE)
    assert len(fake.created) == 2  # the third never reached the host
    assert b.connect("bob", "c1", Tier.RUN_CODE).ref.sandbox_id  # a second account is not held back by the first


def test_a_conversation_already_running_is_never_refused_at_the_cap():
    b, fake = _pool(account_max_live=2)
    first = b.connect("alice", "c1", Tier.RUN_CODE)
    b.connect("alice", "c2", Tier.RUN_CODE)
    assert b.connect("alice", "c1", Tier.RUN_CODE).ref.sandbox_id == first.ref.sandbox_id
    assert len(fake.created) == 2


def test_the_count_spans_every_slot():
    from sandbox_backend import SandboxAccountLimit, owner_for
    b, fake = _pool(slots=2, account_max_live=2)
    fake.add(1, "a", "k1", owner=owner_for("alice"))
    fake.add(2, "b", "k2", owner=owner_for("alice"))
    with pytest.raises(SandboxAccountLimit):
        b.connect("alice", "c3", Tier.RUN_CODE)


def test_a_paused_sandbox_is_not_live_so_an_accounts_idle_conversations_never_fill_its_cap():
    from sandbox_backend import owner_for
    b, fake = _pool(account_max_live=2)
    for i in range(5):
        fake.add(1, f"p{i}", f"k{i}", owner=owner_for("alice"), state=_PAUSED)
    assert b.connect("alice", "fresh", Tier.RUN_CODE).ref.sandbox_id.startswith("s1-")


def test_resuming_a_paused_conversation_at_the_cap_is_refused_instead_of_slipping_past_it():
    """The read path (`find`, used by read_file and list_files) resumes a paused sandbox, which makes it live."""
    from sandbox_backend import SandboxAccountLimit, key_for, owner_for
    b, fake = _pool(account_max_live=2)
    fake.add(1, "live1", "k1", owner=owner_for("alice"))
    fake.add(1, "live2", "k2", owner=owner_for("alice"))
    fake.add(1, "asleep", key_for("alice", "c3"), owner=owner_for("alice"), state=_PAUSED)
    with pytest.raises(SandboxAccountLimit):
        b.find("alice", "c3", Tier.RUN_CODE)
    assert fake.connected == []  # refused before the host was asked to resume it


def test_agent_sandboxes_are_neither_counted_nor_refused_by_the_run_code_cap():
    from sandbox_backend import owner_for
    b, fake = _pool(account_max_live=1)
    fake.add(1, "agent1", "ka", tier="agent", owner=owner_for("alice"))
    b.connect("alice", "c1", Tier.RUN_CODE)  # the account's agent sandbox is not in its run-code count
    assert b.connect("alice", "agent:c1", Tier.AGENT).ref.sandbox_id  # and a task is never held by the run-code cap


def test_a_cap_of_zero_means_no_cap_and_no_listing_before_a_create():
    b, fake = _pool(account_max_live=0)
    for i in range(4):
        b.connect("alice", f"c{i}", Tier.RUN_CODE)
    assert len(fake.created) == 4


def test_a_new_sandbox_carries_its_owner_so_the_next_count_can_find_it():
    from sandbox_backend import owner_for
    b, fake = _pool()
    b.connect("alice", "c1", Tier.RUN_CODE)
    assert fake.infos[1][0].metadata["owner"] == owner_for("alice")
    assert "alice" not in str(fake.infos[1][0].metadata)  # the account id never reaches host metadata


def test_a_refusal_at_the_cap_and_a_full_host_each_leave_a_log_event_the_alert_can_read():
    from sandbox_backend import SandboxAccountLimit, SandboxBusy
    events: list = []
    b, fake = _pool(account_max_live=1)
    b._log_event = lambda event, **f: events.append((event, f))
    b.connect("alice", "c1", Tier.RUN_CODE)
    with pytest.raises(SandboxAccountLimit):
        b.connect("alice", "c2", Tier.RUN_CODE)
    fake.refuse = {1, 2}
    with pytest.raises(SandboxBusy):
        b.connect("bob", "c1", Tier.RUN_CODE)
    assert [e for e, _ in events] == ["sandbox.account_cap", "sandbox.host_busy"]
    assert events[0][1]["live"] == 1 and events[0][1]["cap"] == 1
    assert "alice" not in str(events)


def test_pool_load_counts_running_sandboxes_per_slot_and_leaves_out_paused_ones_and_down_slots():
    b, fake = _pool(slots=3)
    for sid, slot, state in (("a", 1, None), ("b", 1, None), ("c", 1, _PAUSED), ("d", 2, None), ("e", 3, None)):
        fake.add(slot, sid, f"k{sid}", state=state)
    fake.down = {3}
    assert b.pool_load() == {1: 2, 2: 1}


# -- a dead host switches itself off --------------------------------------------------------------------------------


def _clocked_pool(monkeypatch, **cfg):
    now = [1000.0]
    monkeypatch.setattr(sandbox_e2b.time, "monotonic", lambda: now[0])
    b, fake = _pool(**cfg)
    events: list = []
    b._log_event = lambda event, **f: events.append((event, f))
    return b, fake, now, events


def test_a_slot_failing_every_ask_for_longer_than_the_auto_off_window_stops_find_refusing_and_gets_no_sandbox(
        monkeypatch):
    b, fake, now, events = _clocked_pool(monkeypatch, auto_off_secs=300, account_max_live=0)
    fake.down = {1}
    with pytest.raises(SandboxError, match="host 1"):
        b.find("alice", "c", Tier.RUN_CODE)
    now[0] += 301
    assert b.find("alice", "c", Tier.RUN_CODE) is None  # asked again, failed again, and past the window
    assert b.auto_off_slots() == [1]
    assert [(e, f["slot"]) for e, f in events] == [("sandbox.slot_auto_off", 1)]
    assert events[0][1]["failing_for_s"] == 301
    now[0] += 31  # out of its down window, so `_up` offers it to placement again: auto-off must still skip it
    assert b._create("alice", "k", Tier.RUN_CODE).slot == 2
    assert fake.created == [2]
    assert b.destroy("alice", "c") == 0  # destroy stops refusing on it too


def test_a_slot_failing_inside_the_auto_off_window_still_makes_find_refuse(monkeypatch):
    b, fake, now, _events = _clocked_pool(monkeypatch, auto_off_secs=300)
    fake.down = {1}
    for step in (0, 100, 100, 99):  # asked at 0, 100, 200 and 299 s of failing
        now[0] += step
        with pytest.raises(SandboxError, match="host 1"):
            b.find("alice", "c", Tier.RUN_CODE)
    assert b.auto_off_slots() == []


def test_one_answer_from_an_auto_off_slot_brings_it_back_and_restarts_its_window(monkeypatch):
    b, fake, now, events = _clocked_pool(monkeypatch, auto_off_secs=300)
    fake.down = {1}
    with pytest.raises(SandboxError):
        b.find("alice", "c", Tier.RUN_CODE)
    now[0] += 301
    assert b.find("alice", "c", Tier.RUN_CODE) is None
    fake.down = set()
    now[0] += 31
    assert b.find("alice", "c", Tier.RUN_CODE) is None
    assert b.auto_off_slots() == []
    assert events[-1] == ("sandbox.slot_rejoined", {"slot": 1, "reason": "answered"})
    fake.down = {1}
    now[0] += 1
    with pytest.raises(SandboxError, match="host 1"):  # a fresh failure starts a fresh window
        b.find("alice", "c", Tier.RUN_CODE)


def test_the_pool_never_auto_offs_its_last_answering_slot_so_a_pool_failing_everywhere_keeps_refusing(monkeypatch):
    b, fake, now, events = _clocked_pool(monkeypatch, auto_off_secs=300)
    fake.down = {1, 2}
    for _ in range(5):
        with pytest.raises(SandboxError, match="host 1, 2"):
            b.find("alice", "c", Tier.RUN_CODE)
        now[0] += 301
    assert b.auto_off_slots() == [] and events == []


def test_an_auto_off_slot_counts_again_the_moment_the_last_other_slot_fails(monkeypatch):
    b, fake, now, events = _clocked_pool(monkeypatch, auto_off_secs=300)
    fake.down = {1}
    with pytest.raises(SandboxError):
        b.find("alice", "c", Tier.RUN_CODE)
    now[0] += 301
    assert b.find("alice", "c", Tier.RUN_CODE) is None
    fake.down = {1, 2}
    now[0] += 31
    with pytest.raises(SandboxError, match="host 1, 2"):
        b.find("alice", "c", Tier.RUN_CODE)
    assert events[-1] == ("sandbox.slot_rejoined", {"slot": 1, "reason": "no other slot answering"})


def test_an_auto_off_window_of_zero_never_auto_offs_a_slot(monkeypatch):
    b, fake, now, events = _clocked_pool(monkeypatch, auto_off_secs=0)
    fake.down = {1}
    for _ in range(5):
        with pytest.raises(SandboxError, match="host 1"):
            b.find("alice", "c", Tier.RUN_CODE)
        now[0] += 3600
    assert b.auto_off_slots() == [] and events == []
    with pytest.raises(ValueError, match="E2B_SLOT_AUTO_OFF_SECS"):
        _backend(auto_off_secs=-1)


def test_after_an_auto_off_slot_rejoins_with_the_conversations_older_sandbox_find_keeps_the_one_used_last(
        monkeypatch):
    """The trade auto-off makes: a partition, not a dead host, leaves the conversation two sandboxes. The newer one
    holds what the person did since, so every machine keeps that one, and nothing is killed on the strength of it."""
    from sandbox_backend import key_for
    b, fake, now, events = _clocked_pool(monkeypatch, auto_off_secs=300)
    key = key_for("alice", "c")
    fake.add(1, "before", key, age_s=3600, idle_for_s=120)
    fake.down = {1}
    with pytest.raises(SandboxError):
        b.connect("alice", "c", Tier.RUN_CODE)
    now[0] += 301
    during = b.connect("alice", "c", Tier.RUN_CODE)  # slot 1 auto-off: a fresh sandbox on slot 2
    assert during.slot == 2 and fake.killed == []  # the race check could not see slot 1, so it kept ours
    fake.down = set()
    now[0] += 31
    for _ in range(2):
        after = b.find("alice", "c", Tier.RUN_CODE)
        assert (after.slot, after.ref.sandbox_id) == (2, during.ref.sandbox_id)
    assert fake.killed == []
    assert ("sandbox.split_conversation", {"count": 2, "slots": [1, 2]}) in events


class _BusyPause:
    """A sandbox whose pause the host refuses `refusals` times with a 503, then takes."""

    def __init__(self, e2b, refusals):
        self._e2b, self.refusals, self.asks = e2b, refusals, 0

    def pause(self):
        self.asks += 1
        if self.asks <= self.refusals:
            raise self._e2b.ServiceBusyException("503: Service temporarily unavailable, please retry.")


@pytest.mark.parametrize("refusals", [1, 4])
def test_a_pause_the_host_refuses_as_busy_is_asked_again_until_it_takes(monkeypatch, refusals):
    """CUR-4503: a host that refuses a task-end pause with a 503 leaves each finished sandbox holding its slot until
    the idle timeout; a refused pause changes nothing, so asking again is safe."""
    import types

    import e2b
    from sandbox_backend import Handle
    waits: list = []
    monkeypatch.setattr(sandbox_e2b.time, "sleep", waits.append)
    b = _backend()
    b._e2b = types.SimpleNamespace(ServiceBusyException=e2b.ServiceBusyException,
                                   RateLimitException=e2b.RateLimitException)
    sbx = _BusyPause(e2b, refusals)
    b.pause(Handle(key="k", tier=Tier.AGENT, ref=sbx))
    assert sbx.asks == refusals + 1
    assert waits == list(sandbox_e2b._PAUSE_RETRY_WAITS[:refusals])


def test_a_pause_still_refused_after_every_retry_raises_and_names_the_hosts_answer(monkeypatch):
    import types

    import e2b
    from sandbox_backend import Handle
    events: list = []
    monkeypatch.setattr(sandbox_e2b.time, "sleep", lambda _s: None)
    b = _backend()
    b._log_event = lambda event, **f: events.append((event, f))
    b._e2b = types.SimpleNamespace(ServiceBusyException=e2b.ServiceBusyException,
                                   RateLimitException=e2b.RateLimitException)
    sbx = _BusyPause(e2b, refusals=99)
    with pytest.raises(e2b.ServiceBusyException):
        b.pause(Handle(key="k", tier=Tier.AGENT, ref=sbx))
    assert sbx.asks == len(sandbox_e2b._PAUSE_RETRY_WAITS) + 1
    assert all("503" in f["detail"] for _e, f in events) and events[-1][1]["retry_in"] is None


def test_a_pause_that_fails_for_another_reason_is_not_retried(monkeypatch):
    import types

    import e2b
    from sandbox_backend import Handle
    monkeypatch.setattr(sandbox_e2b.time, "sleep", lambda _s: pytest.fail("slept on a non-busy failure"))
    b = _backend()
    b._e2b = types.SimpleNamespace(ServiceBusyException=e2b.ServiceBusyException,
                                   RateLimitException=e2b.RateLimitException)

    class _Gone:
        asks = 0

        def pause(self):
            self.asks += 1
            raise RuntimeError("sandbox not found")

    sbx = _Gone()
    with pytest.raises(RuntimeError):
        b.pause(Handle(key="k", tier=Tier.AGENT, ref=sbx))
    assert sbx.asks == 1


# -- each tier's own pause window ---------------------------------------------------------------------------------

def _recording_timeouts(fake):
    """Wrap the fake's create and connect so each records the pause window it was asked for."""
    asked: list = []
    create, connect = fake.Sandbox.create, fake.Sandbox.connect

    def rec_create(metadata, **api):
        asked.append(("create", metadata["tier"], api.get("timeout")))
        return create(metadata, **api)

    def rec_connect(sid, **api):
        asked.append(("connect", sid, api.get("timeout")))
        return connect(sid, **api)

    fake.Sandbox.create, fake.Sandbox.connect = staticmethod(rec_create), staticmethod(rec_connect)
    return asked


def test_a_run_code_sandbox_pauses_after_the_short_window_so_its_memory_returns_to_the_host_sooner():
    """A running sandbox holds its guest memory on the host; a paused one holds none. Run-code turns are short, so
    their sandbox pauses after `run_code_idle_secs`, while an agent task's keeps the longer `idle_secs`."""
    b, fake = _pool(slots=1, idle_secs=600, run_code_idle_secs=120)
    asked = _recording_timeouts(fake)
    b.connect("alice", "c1", Tier.RUN_CODE)
    b.connect("alice", "agent:c1", Tier.AGENT)
    assert [a for a in asked if a[0] == "create"] == [("create", "run_code", 120), ("create", "agent", 600)]


def test_every_call_into_a_run_code_sandbox_restarts_the_short_window_not_the_agent_one():
    """The pause clock restarts on each connect; a run-code conversation's next call must not push it out to the
    agent tier's ten minutes, or the short window never takes effect after the first call."""
    from sandbox_backend import key_for
    b, fake = _pool(slots=1, idle_secs=600, run_code_idle_secs=120)
    fake.add(1, "mine", key_for("alice", "c1"))
    asked = _recording_timeouts(fake)
    b.find("alice", "c1", Tier.RUN_CODE)
    assert asked == [("connect", "mine", 120)]


def test_the_sweep_reads_each_sandboxs_last_use_from_its_own_tiers_window():
    """`end_at` is the last use plus the tier's window. With a four-hour limit, a run-code and an agent sandbox that
    both paused 3 h 50 m ago differ: the run-code one was last used two minutes before that and stays, the agent one
    ten minutes before that, past the limit, and goes."""
    import datetime
    import types
    b = _backend(idle_secs=600, run_code_idle_secs=120)
    end = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=4 * 3600 - 600)
    b._e2b = _FakeE2B([types.SimpleNamespace(sandbox_id="rc", metadata={"key": "k-rc", "tier": "run_code"}, end_at=end),
                       types.SimpleNamespace(sandbox_id="ag", metadata={"key": "k-ag", "tier": "agent"}, end_at=end)])
    assert b.sweep(4 * 3600) == ["k-ag"]


def test_the_account_cap_refusal_names_the_run_code_window_the_person_actually_waits():
    from sandbox_backend import SandboxAccountLimit, owner_for
    b, fake = _pool(account_max_live=1, idle_secs=600, run_code_idle_secs=120)
    fake.add(1, "live1", "k1", owner=owner_for("alice"))
    with pytest.raises(SandboxAccountLimit, match="after 2 minutes"):
        b.connect("alice", "c2", Tier.RUN_CODE)
