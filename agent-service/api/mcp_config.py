"""Operator-configured MCP servers for agent mode (CUR-3025).

`AGENT_MCP_SERVERS` is a JSON list; each entry names one remote MCP server the agent may call:

    [{"name": "folkways", "url": "https://folkways.example/mcp",
      "headers": {"Authorization": "FOLKWAYS_MCP_AUTH"}}]

- `name`: lowercase letters, digits, `-`, `_`; Hermes exposes the tools as `mcp__<name>__<tool>`.
- `url`: https only. `http://localhost` / `http://127.0.0.1` / `http://[::1]` are accepted ONLY when
  `AGENT_MCP_ALLOW_LOCALHOST=1`, for local development against a stub or a server on the same box.
- `transport`: optional, `"http"` (Streamable HTTP, the default) is the only accepted value. See
  `_TRANSPORTS` for why SSE is refused.
- `headers`: optional, maps a header NAME to the NAME of an env var holding its value. The value is read
  from the environment when each session starts, so no secret sits in the JSON or in a toml, and
  `_model_env` (app.py) strips those vars from the agent's own environment.

Unset or empty is exactly the behavior from before this module existed: no servers, nothing sent.
Malformed JSON, or any invalid entry, yields NO servers plus an `error` string that /healthz reports and
the log carries once at import. One bad entry drops the whole list rather than the bad entry alone: a
partial list is a config nobody wrote, and it would look healthy.

Stdlib only, because deploy/entrypoint.sh runs `python3 mcp_config.py hosts` as root before the app
starts, to put the configured hosts into the egress allowlist from the same parser the app uses.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import sys
from dataclasses import dataclass, field
from urllib.parse import urlsplit

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# RFC 9110 token characters — a header name outside this set is a typo, never a real header.
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
# SSE is refused at config time. Hermes 29112bef's ACP adapter (`_register_session_mcp_servers`,
# acp_adapter/server.py:1126) passes every non-stdio ACP server on as {"url", "headers"} without the
# transport, and tools/mcp_tool.py picks SSE only from a `transport: sse` key that path never sets — so an
# SSE server sent over ACP would be dialled as Streamable HTTP and fail to connect, with only a warning in
# Hermes' own log. Saying so at config time beats a server that silently never shows up.
_TRANSPORTS = ("http",)


@dataclass(frozen=True)
class McpServerSpec:
    name: str
    url: str
    transport: str = "http"
    headers: dict[str, str] = field(default_factory=dict)   # header name -> env var NAME (never a value)

    @property
    def host(self) -> str:
        return urlsplit(self.url).hostname or ""

    @property
    def is_loopback(self) -> bool:
        return self.host in _LOOPBACK_HOSTS


@dataclass(frozen=True)
class McpConfig:
    servers: tuple[McpServerSpec, ...] = ()
    error: str | None = None

    @property
    def configured(self) -> bool:
        return bool(self.servers) or self.error is not None


def _check_url(url: object, allow_localhost: bool) -> str | None:
    """None if the URL is acceptable, else the reason it is not."""
    if not isinstance(url, str) or not url:
        return "url must be a non-empty string"
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        parts.port   # noqa: B018 — raises ValueError on a malformed port
    except ValueError as e:
        return f"url is malformed ({e})"
    if not host:
        return "url has no host"
    if parts.username or parts.password:
        return "url must not carry credentials; put them in a header env var"
    if host in _LOOPBACK_HOSTS:
        if not allow_localhost:
            return "localhost is refused unless AGENT_MCP_ALLOW_LOCALHOST=1 (local development only)"
        return None if parts.scheme in ("http", "https") else "url scheme must be http or https"
    if parts.scheme != "https":
        return "url must be https (http is accepted only for localhost under AGENT_MCP_ALLOW_LOCALHOST=1)"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_reserved:
        return "url names a private or reserved address; use a public hostname"
    return None


def _parse_entry(i: int, raw: object, allow_localhost: bool) -> McpServerSpec:
    if not isinstance(raw, dict):
        raise ValueError(f"entry {i} is not an object")
    unknown = set(raw) - {"name", "url", "transport", "headers"}
    if unknown:
        raise ValueError(f"entry {i} has unknown keys {sorted(unknown)}")
    name = raw.get("name")
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ValueError(f"entry {i}: name must match {_NAME_RE.pattern}")
    reason = _check_url(raw.get("url"), allow_localhost)
    if reason:
        raise ValueError(f"server {name!r}: {reason}")
    transport = raw.get("transport", "http")
    if transport not in _TRANSPORTS:
        raise ValueError(f"server {name!r}: transport must be one of {list(_TRANSPORTS)} "
                         "(the pinned Hermes drops the SSE transport over ACP — see mcp_config._TRANSPORTS)")
    headers = raw.get("headers", {}) or {}
    if not isinstance(headers, dict):
        raise ValueError(f"server {name!r}: headers must be an object of header name -> env var name")
    for h, var in headers.items():
        if not isinstance(h, str) or not _HEADER_NAME_RE.match(h):
            raise ValueError(f"server {name!r}: bad header name {h!r}")
        if not isinstance(var, str) or not _ENV_NAME_RE.match(var):
            raise ValueError(f"server {name!r}: header {h!r} must name an env var (the value is read from "
                             "the environment, never written in this JSON)")
    return McpServerSpec(name=name, url=str(raw["url"]), transport=transport, headers=dict(headers))


def parse(text: str | None, *, allow_localhost: bool = False) -> McpConfig:
    """Parse AGENT_MCP_SERVERS. Never raises: a bad value comes back as McpConfig(error=...)."""
    if text is None or not text.strip():
        return McpConfig()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return McpConfig(error=f"AGENT_MCP_SERVERS is not valid JSON ({e.msg} at char {e.pos})")
    if not isinstance(data, list):
        return McpConfig(error="AGENT_MCP_SERVERS must be a JSON list")
    try:
        servers = tuple(_parse_entry(i, raw, allow_localhost) for i, raw in enumerate(data))
    except ValueError as e:
        return McpConfig(error=f"AGENT_MCP_SERVERS: {e}")
    names = [s.name for s in servers]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        return McpConfig(error=f"AGENT_MCP_SERVERS: duplicate server names {dupes}")
    return McpConfig(servers=servers)


def load(env: dict[str, str] | os._Environ[str] | None = None) -> McpConfig:
    env = os.environ if env is None else env
    return parse(env.get("AGENT_MCP_SERVERS"), allow_localhost=env.get("AGENT_MCP_ALLOW_LOCALHOST") == "1")


def header_env_names(cfg: McpConfig) -> set[str]:
    """Every env var a header value is read from — _model_env removes these from the agent's environment."""
    return {var for s in cfg.servers for var in s.headers.values()}


def resolve_headers(spec: McpServerSpec, env: dict[str, str] | os._Environ[str]) -> tuple[list[tuple[str, str]], list[str]]:
    """(headers as (name, value) pairs, env var names that were unset or empty)."""
    out, missing = [], []
    for h, var in spec.headers.items():
        val = env.get(var, "")
        if val:
            out.append((h, val))
        else:
            missing.append(var)
    return out, missing


def egress_hosts(cfg: McpConfig) -> list[str]:
    """Public hosts the egress allowlist must admit. Loopback is not egress and is left out."""
    return sorted({s.host for s in cfg.servers if not s.is_loopback})


def health(cfg: McpConfig, env: dict[str, str] | os._Environ[str] | None = None) -> dict[str, object]:
    """The /healthz view. Names only: /healthz is unauthenticated, so no URL (a URL can carry a path that
    is itself a capability) and never a header value. `missing_header_env` names env VARS, not values."""
    env = os.environ if env is None else env
    missing = sorted({var for s in cfg.servers for var in resolve_headers(s, env)[1]})
    return {"servers": [s.name for s in cfg.servers], "error": cfg.error, "missing_header_env": missing}


if __name__ == "__main__":
    # `python3 mcp_config.py hosts` — one host per line, for deploy/entrypoint.sh. A config error prints
    # nothing on stdout (no hosts admitted) and the reason on stderr; exit 0 either way so `set -e` in the
    # entrypoint never takes the container down over an agent-mode extra.
    if sys.argv[1:] == ["hosts"]:
        cfg = load()
        if cfg.error:
            print(json.dumps({"event": "mcp.config_invalid", "reason": cfg.error}), file=sys.stderr)
        for h in egress_hosts(cfg):
            print(h)
        sys.exit(0)
    print("usage: mcp_config.py hosts", file=sys.stderr)
    sys.exit(2)
