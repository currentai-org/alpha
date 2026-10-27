"""The gateway's public listener answers over IPv4, the way Fly's proxy reaches it (CUR-4480)."""

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
    """A `::` bind is IPv6-only under asyncio, so Fly's edge took TLS and the request then hung. This connects
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
