"""The gateway's public listener answers over IPv4, the way Fly's proxy reaches it."""

import asyncio
import socket
import threading
import time
import urllib.request

import gateway_serve


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_the_public_gateway_port_answers_a_request_over_ipv4():
    """A `::` bind is IPv6-only under asyncio, so a `::` bind would let the edge take TLS and then hang the request. This connects
    the way the proxy does, over IPv4, and needs an answer."""
    port = _free_port()
    _, public = gateway_serve.servers(private_port=_free_port(), public_port=port)
    public.config.log_level = "warning"
    thread = threading.Thread(target=lambda: asyncio.run(public.serve()), daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not public.started and time.monotonic() < deadline:
            time.sleep(0.05)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=5) as r:
            assert r.status == 200
    finally:
        public.should_exit = True
        thread.join(timeout=10)


def test_the_private_gateway_port_answers_over_ipv4_when_its_host_is_set_to_ipv4():
    """On an IPv4-only network the agent dials the private port by an IPv4 address. With the default `::` bind that
    connection is refused, so the AWS hosts set GATEWAY_PRIVATE_HOST=0.0.0.0, and the port must then answer."""
    port = _free_port()
    private, _ = gateway_serve.servers(private_port=port, public_port=_free_port(), private_host="0.0.0.0")
    private.config.log_level = "warning"
    thread = threading.Thread(target=lambda: asyncio.run(private.serve()), daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not private.started and time.monotonic() < deadline:
            time.sleep(0.05)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=5) as r:
            assert r.status == 200
    finally:
        private.should_exit = True
        thread.join(timeout=10)


def test_the_private_gateway_port_keeps_its_ipv6_bind_by_default(monkeypatch):
    """Fly's 6PN is IPv6-only, so an unset GATEWAY_PRIVATE_HOST must leave the private app on `::`."""
    import importlib
    monkeypatch.delenv("GATEWAY_PRIVATE_HOST", raising=False)
    try:
        private, _ = importlib.reload(gateway_serve).servers(private_port=_free_port(), public_port=_free_port())
        assert private.config.host == "::"
    finally:
        monkeypatch.undo()
        importlib.reload(gateway_serve)
