"""The docker sandbox backend and the socket proxy it goes through, live.

Skipped unless DOCKER_HOST names a socket proxy and SANDBOX_CONTRACT_IMAGE a digest-pinned image with python3:
.github/selfhost-socket-proxy-smoke.sh runs it against the pinned sockguard from selfhost/compose.yaml, with
selfhost/sockguard.yaml as its policy. The refusals are asked of the proxy with the same client the backend uses,
so a 403 here is the proxy's answer to the backend's own kind of request."""

from __future__ import annotations

import os
import re
import uuid

import pytest
from sandbox_backend import Tier

HOST = os.environ.get("DOCKER_HOST", "")
IMAGE = os.environ.get("SANDBOX_CONTRACT_IMAGE", "")
GATEWAY = os.environ.get("SANDBOX_CONTRACT_GATEWAY", "")

pytestmark = pytest.mark.skipif(not (HOST.startswith("tcp://") and IMAGE),
                                reason="DOCKER_HOST (the proxy) and SANDBOX_CONTRACT_IMAGE name what to test")


@pytest.fixture
def backend():
    from sandbox_docker import DockerBackend, DockerConfig

    b = DockerBackend(DockerConfig(docker_host=HOST, image=IMAGE, gateway_host="gateway" if GATEWAY else "",
                                   gateway_container=GATEWAY))
    run = uuid.uuid4().hex[:8]
    made = []

    def connect(conversation: str, tier: Tier):
        h = b.connect(f"live-{run}", conversation, tier)
        made.append(h)
        return h
    yield b, connect
    for h in made:
        b.kill(h)


def _refused(call) -> None:
    import docker

    with pytest.raises(docker.errors.APIError) as e:
        call()
    assert e.value.status_code == 403, e.value
    assert "sockguard" in str(e.value), e.value
    print(f"PASS refused with 403: {e.value.explanation}")


def test_the_proxy_refuses_a_privileged_create_with_403(backend):
    b, _ = backend
    _refused(lambda: b._api.create_container(IMAGE, entrypoint=["true"], host_config={
        "Privileged": True, "SecurityOpt": ["no-new-privileges:true"]}))


def test_the_proxy_refuses_a_host_root_bind_with_403(backend):
    b, _ = backend
    _refused(lambda: b._api.create_container(IMAGE, entrypoint=["true"], host_config={
        "Binds": ["/:/host"], "SecurityOpt": ["no-new-privileges:true"]}))


def test_the_proxy_refuses_an_exec_as_root_with_403(backend):
    b, connect = backend
    h = connect("root-exec", Tier.RUN_CODE)
    _refused(lambda: b._api.exec_create(h.ref, ["id"], user="root"))


def test_a_sandbox_runs_unprivileged_on_a_read_only_root(backend):
    b, connect = backend
    h = connect("hardening", Tier.RUN_CODE)
    r = b.exec(h, ["sh", "-c", "id -u; grep -E '^(CapEff|NoNewPrivs)' /proc/self/status; "
                               "touch /etc/planted 2>/dev/null && echo ROOT-WRITABLE || echo ROOT-READ-ONLY"], 15)
    assert r.code == 0, r
    print(r.stdout)
    lines = r.stdout.split()
    assert lines[0] == "1000"
    assert re.search(r"CapEff:\s+0+\n", r.stdout), r.stdout  # no capability at all
    assert re.search(r"NoNewPrivs:\s+1\n", r.stdout), r.stdout
    assert "ROOT-READ-ONLY" in r.stdout


@pytest.mark.skipif(not GATEWAY, reason="SANDBOX_CONTRACT_GATEWAY names the gateway container")
def test_an_agent_sandbox_reaches_the_gateway_by_name_and_nothing_outside(backend):
    b, connect = backend
    h = connect("agent-net", Tier.AGENT)
    code = (
        "import socket, urllib.request as u\n"
        "print('GATEWAY', socket.gethostbyname('gateway'))\n"
        "try:\n"
        "    u.urlopen('http://1.1.1.1/', timeout=3); print('REACHED web')\n"
        "except Exception:\n"
        "    print('BLOCKED web')\n"
    )
    r = b.exec(h, ["python3", "-"], 20, stdin=code)
    print(r.stdout, r.stderr)
    assert "GATEWAY " in r.stdout and "BLOCKED web" in r.stdout and "REACHED" not in r.stdout, r
