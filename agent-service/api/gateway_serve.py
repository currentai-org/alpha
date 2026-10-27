"""Run the gateway's private and public apps in one process (CUR-4480).

The private app (proxy.app) keeps the admin routes on Fly's 6PN port; the public app (proxy.public_app)
serves only nonce routes on the port Fly's [http_service] exposes. One process, so a grant registered
on the private port is live on the public one. When either server stops, the other is told to stop.
"""

import asyncio
import os

import proxy
import uvicorn

PRIVATE_PORT = int(os.environ.get("GATEWAY_PRIVATE_PORT", "8732"))
PUBLIC_PORT = int(os.environ.get("GATEWAY_PUBLIC_PORT", "8733"))


async def _run(server: uvicorn.Server, other: uvicorn.Server) -> None:
    try:
        await server.serve()
    finally:
        other.should_exit = True


def servers(private_port: int = PRIVATE_PORT, public_port: int = PUBLIC_PORT) -> tuple[uvicorn.Server, uvicorn.Server]:
    # The private app binds `::`, since 6PN is IPv6-only. The public one binds IPv4: Fly's proxy hands public
    # traffic to the machine over IPv4, and asyncio's `::` socket is IPv6-only, so a `::` public port took the
    # TLS handshake at Fly's edge and then never answered.
    private = uvicorn.Server(uvicorn.Config(proxy.app, host="::", port=private_port))
    public = uvicorn.Server(uvicorn.Config(proxy.public_app, host="0.0.0.0", port=public_port))
    return private, public


async def main() -> None:
    private, public = servers()
    await asyncio.gather(_run(private, public), _run(public, private))


if __name__ == "__main__":
    asyncio.run(main())
