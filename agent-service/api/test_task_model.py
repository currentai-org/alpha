"""CUR-4603: a task runs on the model the chat names, or not at all.

A task may name its executor; AGENT_MODEL is the deployment-wide default. These are the contracts that make that safe: a named model the gateway
cannot route is refused, and AGENT_MODEL never stands in for it; the gateway pins every call on a task's grant to
that task's model; a provider with a model map never rewrites a model it lacks into one it has; and the
task reports what ran.
"""
import asyncio
import json

import app
import proxy
import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient


# --------------------------------------------------------------------------- app: choosing the executor
@pytest.fixture
def routable(monkeypatch):
    """The gateway routes Medium (the default) and Large 4; nothing else."""
    monkeypatch.setattr(app, "AGENT_MODEL", "mistral-medium-2604")
    monkeypatch.setattr(app, "VERIFIER_MODEL", "google/gemma-4-31B-it")
    monkeypatch.setattr(app, "_routable_models", lambda: frozenset({"mistral-medium-2604", "mistral-large-2610"}))


def test_a_task_naming_no_model_runs_on_agent_model(routable):
    assert app._resolve_task_model(None) == "mistral-medium-2604"
    assert app._resolve_task_model("") == "mistral-medium-2604"


def test_a_task_naming_a_routable_model_runs_on_that_model(routable):
    assert app._resolve_task_model("mistral-large-2610") == "mistral-large-2610"


def test_a_task_naming_a_model_outside_the_allowlist_is_refused_never_run_on_agent_model(routable):
    with pytest.raises(HTTPException) as e:
        app._resolve_task_model("speakleash/Bielik-11B-v3.0-Instruct")
    assert e.value.status_code == 422


def test_a_task_naming_the_verifier_is_refused_so_the_judge_never_grades_its_own_model(routable, monkeypatch):
    # Even when the gateway would route it: a same-model judge is the correlated check the verifier avoids.
    monkeypatch.setattr(app, "_routable_models", lambda: frozenset({"google/gemma-4-31b-it"}))
    with pytest.raises(HTTPException) as e:
        app._resolve_task_model("google/gemma-4-31B-it")
    assert e.value.status_code == 422


def test_with_no_gateway_answer_only_agent_model_runs_fail_closed(monkeypatch):
    # The gateway unreachable before its first answer: a model it never confirmed is refused, not assumed.
    monkeypatch.setattr(app, "AGENT_MODEL", "mistral-medium-2604")
    monkeypatch.setattr(app, "MODEL_PROXY_URL", "http://gateway.invalid:1")
    monkeypatch.setattr(app, "_ROUTABLE_MODELS", (0.0, frozenset()))
    assert app._resolve_task_model("mistral-medium-2604") == "mistral-medium-2604"
    with pytest.raises(HTTPException) as e:
        app._resolve_task_model("mistral-large-2610")
    assert e.value.status_code == 422


def test_run_refuses_an_unroutable_model_with_422_and_starts_no_task(routable, monkeypatch):
    monkeypatch.setattr(app, "AUTH_DISABLED", True)
    monkeypatch.setattr(app, "MODERATION_DISABLED", True)
    started = []
    monkeypatch.setattr(app, "_run", lambda task: started.append(task))
    tc = TestClient(app.app)
    r = tc.post("/run", json={"prompt": "x", "model": "speakleash/Bielik-11B-v3.0-Instruct"})
    assert r.status_code == 422, r.text
    assert started == [], "a refused model starts nothing, on any model"


def test_run_records_the_named_model_on_the_task_its_status_and_the_store(routable, monkeypatch):
    monkeypatch.setattr(app, "AUTH_DISABLED", True)
    monkeypatch.setattr(app, "MODERATION_DISABLED", True)
    started = []
    monkeypatch.setattr(app, "_run", lambda task: started.append(task))
    tc = TestClient(app.app)
    r = tc.post("/run", json={"prompt": "x", "model": "mistral-large-2610"})
    assert r.status_code == 200, r.text
    task = started[0]
    assert task.model == "mistral-large-2610"
    assert app._done_payload(task)["model"] == "mistral-large-2610", "the done frame names the task's model"
    assert app._status_of(task).model == "mistral-large-2610"
    app._persist(task)
    with app._TASKS_LOCK:
        app.TASKS.pop(task.id, None)
    assert app._get_task(task.id).model == "mistral-large-2610", "a poll on another machine reads it back"


def test_hermes_oneshot_flags_carry_the_tasks_model_not_agent_model(monkeypatch):
    monkeypatch.setattr(app, "AGENT_MODEL", "mistral-medium-2604")
    monkeypatch.setattr(app, "AGENT_MODEL_PROVIDER", "")
    assert app._model_flags("mistral-large-2610") == ["-m", "mistral-large-2610"]
    assert app._model_flags() == ["-m", "mistral-medium-2604"]


def test_the_acp_attempt_runs_hermes_on_the_tasks_model_and_pins_its_grant(monkeypatch, tmp_path):
    """Both halves of one attempt: Hermes is configured with the task's model, and the gateway grant that
    funds it is pinned to that model."""
    import acp_client
    seen = {}

    async def _fake_acp_run(*a, **kw):
        seen["model"] = kw["model"]
        return "done", None, 0

    monkeypatch.setattr(acp_client, "_acp_run", _fake_acp_run)
    monkeypatch.setattr(app, "AGENT_MODEL", "mistral-medium-2604")
    t = app.Task(id="cur4603-acp", prompt="p", user="u")
    t.model = "mistral-large-2610"
    app._execute_attempt(t, work=str(tmp_path), attempt_home=str(tmp_path / "h"), attempt_prompt="p", attempts=1,
                     nonce=None, timeout_secs=5, buf=None, sandbox=[], use_acp=True,
                     decision={"policy": "allow"}, verify_check=None, repair_check=None,
                     tool_kinds=set(), tool_failures=set())
    assert seen["model"] == "mistral-large-2610"

    grants = []
    monkeypatch.setattr(app, "_gateway_grant", lambda *a, **kw: grants.append(kw))
    app._grant_attempt_budget(t, "nonce-4603", 1)
    assert grants[0]["model"] == "mistral-large-2610"


def test_revoke_collects_the_models_upstream_said_served_the_grant(monkeypatch):
    class _R:
        def json(self):
            return {"requests": 3, "tokens": 30, "usage_seen": True, "cap_hit": False,
                    "served_models": ["mistralai/mistral-large-2610"]}

    import httpx
    monkeypatch.setattr(httpx, "request", lambda *a, **kw: _R())
    served: list = []
    assert app._gateway_revoke("n", served) == (3, 30, True, False)
    assert served == ["mistralai/mistral-large-2610"]


# --------------------------------------------------------------------------- gateway: routing and caps
def _mistral(**kw):
    return proxy.Provider(name="mistral", base_url="https://router.test/v1", token="t",
                          model_map={"mistral-medium-2604": "mistralai/mistral-medium-3-5",
                                     "mistral-large-2610": "mistralai/mistral-large-2610"},
                          no_fallback=frozenset({"mistral-large-2610"}), **kw)


def test_model_map_parses_and_drops_malformed_entries():
    assert proxy._parse_model_map(" A=wire/a , b=, =c, d , e=wire/e") == {"a": "wire/a", "e": "wire/e"}


def test_a_mapped_provider_sends_each_model_its_own_wire_id_and_disables_cross_model_fallback():
    p = _mistral()
    medium = json.loads(proxy._rewrite_model(b'{"model":"mistral-medium-2604"}', p))
    large4 = json.loads(proxy._rewrite_model(b'{"model":"mistral-large-2610"}', p))
    assert medium == {"model": "mistralai/mistral-medium-3-5"}, "no fallback flag on a model whose backup is itself"
    assert large4 == {"model": "mistralai/mistral-large-2610", "disable_fallbacks": True}


def test_a_mapped_provider_cannot_route_a_model_it_lacks():
    assert not _mistral().routable("mistral-large-2512")
    assert proxy.Provider(name="legacy", base_url="x", token="t", model="m").routable("anything"), \
        "a provider with no map takes any request, as before"


def test_healthz_models_list_only_a_fully_mapped_chain():
    assert proxy.routable_models([_mistral()]) == ["mistral-large-2610", "mistral-medium-2604"]
    assert proxy.routable_models([_mistral(), proxy.Provider(name="legacy", base_url="x", token="t")]) == [], \
        "a legacy provider rewrites everything to one model, so only the app's default is honestly routable"


class _Upstream:
    """httpx.AsyncClient stand-in that records the body it was sent and streams one frame naming a model."""

    def __init__(self, sent, served="mistralai/mistral-large-2610", **_kw):
        self.sent, self.served = sent, served

    class _Resp:
        def __init__(self, served):
            self.status_code = 200
            self.headers = {"content-type": "text/event-stream"}
            self._served = served

        async def aiter_raw(self):
            yield f'data: {{"model":"{self._served}","choices":[]}}\n\n'.encode()
            yield b'data: {"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n'

        async def aclose(self):
            pass

    def build_request(self, method, url, headers=None, content=None):
        self.sent.append(json.loads(content))
        return ("req", url)

    async def send(self, req, stream=True):
        return self._Resp(self.served)

    async def aclose(self):
        pass


def _call(monkeypatch, body, grant_model="", providers=None, rpm=None):
    sent: list = []
    monkeypatch.setattr(proxy, "PROVIDERS", providers or [_mistral()])
    monkeypatch.setattr(proxy, "DESTREAM", False)
    monkeypatch.setattr(proxy, "RPM_LIMITERS", rpm or {})
    monkeypatch.setattr(proxy.httpx, "AsyncClient", lambda **kw: _Upstream(sent, **kw))
    nonce = "nonce-cur4603"
    proxy._GRANTS[nonce] = proxy.Grant(max_requests=9, max_tokens=0, expires_at=proxy.time.monotonic() + 60,
                                       label="t", attempt=1, model=grant_model)
    try:
        with TestClient(proxy.app) as tc:
            r = tc.post("/v1/chat/completions", headers={"authorization": f"Bearer {nonce}"}, json=body)
            _ = r.content
        g = proxy._GRANTS.get(nonce)
        return r, sent, g
    finally:
        proxy._GRANTS.pop(nonce, None)


def test_a_pinned_grant_sends_every_call_as_its_model_whatever_the_body_names(monkeypatch):
    r, sent, g = _call(monkeypatch, {"model": "mistral-medium-2604", "stream": True}, grant_model="mistral-large-2610")
    assert r.status_code == 200, r.text
    assert sent[0]["model"] == "mistralai/mistral-large-2610", "the agent cannot spend its grant on another model"
    assert g.served_models == {"mistralai/mistral-large-2610"}, "what upstream said it ran is recorded"


def test_an_unroutable_model_is_refused_with_400_never_rewritten_to_a_mapped_one(monkeypatch):
    r, sent, _g = _call(monkeypatch, {"model": "mistral-large-2512", "stream": True})
    assert r.status_code == 400, r.text
    assert sent == [], "nothing reached upstream"


def test_a_model_over_its_rpm_share_is_refused_with_429_and_refunds_the_step(monkeypatch):
    monkeypatch.setattr(proxy, "MODEL_RPM_MAX_WAIT_SECS", 0.05)
    lim = proxy.AsyncLimiter(1, 60)
    asyncio.run(lim.acquire())                      # the minute's one call is already spent
    r, sent, g = _call(monkeypatch, {"model": "mistral-large-2610", "stream": True},
                       grant_model="mistral-large-2610", rpm={"mistral-large-2610": lim})
    assert r.status_code == 429, r.text
    assert sent == [] and g.used_requests == 0, "a call refused before upstream spends no step"


def test_rpm_limits_parse_per_model():
    lims = proxy._load_rpm_limits("mistral-large-2512=60, bad=x, zero=0")
    assert list(lims) == ["mistral-large-2512"] and lims["mistral-large-2512"].max_rate == 60


# --------------------------------------------------------------------------- gateway: per-model request fields
def _large4_fields():
    return _mistral(model_extra={"mistral-large-2610": {"top_p": 1}},
                    model_unstreamed_extra={"mistral-large-2610": {"reasoning_effort": "none"}})


def test_large4_gets_top_p_1_on_every_call_and_reasoning_off_only_when_unstreamed():
    """Large 4 with its fallback off needs top_p 1 alongside temperature 0, and an unstreamed call needs
    reasoning off. The app's review/derive/route calls are unstreamed at temp 0."""
    p = _large4_fields()
    unstreamed = json.loads(proxy._rewrite_model(b'{"model":"mistral-large-2610","temperature":0.0}', p))
    streamed = json.loads(proxy._rewrite_model(b'{"model":"mistral-large-2610","stream":true}', p))
    assert unstreamed["top_p"] == 1 and unstreamed["reasoning_effort"] == "none"
    assert streamed["top_p"] == 1 and "reasoning_effort" not in streamed, "Hermes' streamed calls keep reasoning"


def test_per_model_fields_never_reach_another_model_so_large3_is_not_sent_reasoning_effort():
    # Large 3 rejects any reasoning_effort, so a provider-wide field would
    # break every Large 3 task's review call.
    p = _large4_fields()
    p.model_map["mistral-large-2512"] = "mistralai/mistral-large-2512"
    large3 = json.loads(proxy._rewrite_model(b'{"model":"mistral-large-2512"}', p))
    assert large3 == {"model": "mistralai/mistral-large-2512"}


def test_the_callers_own_value_beats_a_per_model_field():
    own = json.loads(proxy._rewrite_model(b'{"model":"mistral-large-2610","top_p":0.9,"reasoning_effort":"high"}',
                                          _large4_fields()))
    assert own["top_p"] == 0.9 and own["reasoning_effort"] == "high"


def test_a_malformed_per_model_field_env_fails_loud_at_load(monkeypatch):
    monkeypatch.setenv("X_EXTRA", '{"Mistral-Large-2610":{"top_p":1}}')
    assert proxy._per_model_json("X_EXTRA") == {"mistral-large-2610": {"top_p": 1}}
    for bad in ('{"reasoning_effort":"none"}', '["x"]', "top_p=1"):
        monkeypatch.setenv("X_EXTRA", bad)
        with pytest.raises(ValueError):
            proxy._per_model_json("X_EXTRA")


def test_a_pinned_large4_review_call_reaches_the_wire_with_its_fields(monkeypatch):
    """The auto reviewer posts stream=false at temp 0 on the attempt's nonce; the pin makes it Large 4."""
    r, sent, _g = _call(monkeypatch, {"model": "mistral-medium-2604", "temperature": 0.0},
                        grant_model="mistral-large-2610", providers=[_large4_fields()])
    assert sent and sent[0]["model"] == "mistralai/mistral-large-2610"
    assert sent[0]["top_p"] == 1 and sent[0]["reasoning_effort"] == "none" and sent[0]["disable_fallbacks"] is True
