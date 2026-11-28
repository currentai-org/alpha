"""A person's own connectors on an agent turn, relayed by the model gateway.

The web app picks the turn owner's connectors (Google, to start with) and sends each as `{name, url, headers}`
on `/run`, with a short-lived access token in the headers. The service keeps them in the task's memory and
registers them on the attempt's gateway grant. The engine in the sandbox is given `<gateway>/mcp/<name>` with
the task nonce as its bearer, so the token itself never enters the sandbox: the gateway swaps it in.

What the gateway enforces here, and nothing else does on an agent turn:

- **Destination.** Each grant relays a name to the one URL the web app sent for it, normalised once at grant
  time. The engine names only the connector, never a URL, and redirects are not followed.
- **Read-only tools only.** No person answers an ask-first prompt mid-task, so `tools/call` is relayed only for
  a tool whose listing on this grant carried `readOnlyHint: true`, the rule chat applies before it runs a tool
  without asking (web `serverTools.ts`, `isReadOnly`). The first listing on a grant pins each tool's hash,
  computed as chat's `toolSha256` does; a tool that is listed again with a different hash is refused for the
  rest of the grant.
- **Expiry reaches the person.** A 401 or 403 from the connector is recorded on the grant, and the service turns
  it into a "reconnect" line on the task's answer.

Pure functions and one dataclass, so the rules are tested without a gateway or a connector.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
MAX_CONNECTORS = 4
MAX_HEADERS = 4
MAX_HEADER_VALUE = 8192
_DEFAULT_PORTS = {"http": 80, "https": 443}
# What the person reads in a notice, for the connectors this service knows by name.
_DISPLAY = {"google": "Google"}


def display_name(name: str) -> str:
    return _DISPLAY.get(name, name)


def normalise_url(url: object) -> str | None:
    """The URL as the gateway compares and dials it, or None when it is not one the gateway relays to.

    http or https only, a host, no credentials and no fragment. The scheme and host are lower-cased and a
    default port is dropped, so two spellings of one address compare equal."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        return None
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if scheme not in _DEFAULT_PORTS or not host or parts.username or parts.password or parts.fragment:
        return None
    if ":" in host:  # an IPv6 literal keeps its brackets in the authority
        host = f"[{host}]"
    netloc = host if port in (None, _DEFAULT_PORTS[scheme]) else f"{host}:{port}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def check_headers(headers: object) -> dict[str, str] | None:
    """The headers to send upstream, or None when any is malformed. Values are never echoed back."""
    if not isinstance(headers, dict) or len(headers) > MAX_HEADERS:
        return None
    out: dict[str, str] = {}
    for k, v in headers.items():
        if not isinstance(k, str) or not _HEADER_NAME_RE.match(k) or not isinstance(v, str):
            return None
        if not v or len(v) > MAX_HEADER_VALUE or "\r" in v or "\n" in v:
            return None
        out[k] = v
    return out


def _canonical_json(value: object) -> str:
    """Object keys sorted at every depth, as web's serverTools.ts `canonicalJson` writes them. An integral float
    is written as an integer, as JavaScript does."""
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{_canonical_json(v)}" for k, v in items) + "}"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return json.dumps(value, ensure_ascii=False)


def tool_sha256(tool: dict) -> str:
    """The hash chat pins a tool by: its name, description, input schema and annotations."""
    picked = {k: tool[k] for k in ("name", "description", "inputSchema", "annotations") if k in tool}
    return hashlib.sha256(_canonical_json(picked).encode()).hexdigest()


def is_read_only(tool: dict) -> bool:
    """Only an explicit `readOnlyHint: true` counts. An absent annotation is a write, as the MCP spec's defaults say."""
    ann = tool.get("annotations")
    return isinstance(ann, dict) and ann.get("readOnlyHint") is True


@dataclass
class Relay:
    """One connector on one grant: where it goes, what it carries, and the listing it was pinned to."""
    url: str
    headers: dict[str, str] = field(repr=False)
    # tool name -> (sha256, read_only), from the first listing this grant relayed
    pinned: dict[str, tuple[str, bool]] = field(default_factory=dict)
    # tools listed again with a different hash; refused for the rest of the grant
    changed: set[str] = field(default_factory=set)

    def record_listing(self, tools: list) -> None:
        for t in tools:
            if not isinstance(t, dict) or not isinstance(t.get("name"), str):
                continue
            name, sha = t["name"], tool_sha256(t)
            seen = self.pinned.get(name)
            if seen is None:
                self.pinned[name] = (sha, is_read_only(t))
            elif seen[0] != sha:
                self.changed.add(name)

    def refusal(self, tool: object) -> str | None:
        """Why a `tools/call` for `tool` is refused, or None to relay it."""
        if not isinstance(tool, str) or not tool:
            return "the call names no tool"
        if tool in self.changed:
            return f"{tool} changed after it was listed"
        pin = self.pinned.get(tool)
        if pin is None:
            return f"{tool} was not in the connector's listing"
        if not pin[1]:
            return f"{tool} is not marked read-only"
        return None


def jsonrpc_messages(raw: bytes, content_type: str | None) -> list[dict]:
    """The JSON-RPC messages in a Streamable HTTP body: one JSON object or a batch, or an SSE stream of them."""
    text = raw.decode("utf-8", "replace")
    chunks: list[str] = []
    if (content_type or "").lower().startswith("text/event-stream"):
        data: list[str] = []
        for line in [*text.splitlines(), ""]:
            if line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
            elif not line.strip() and data:
                chunks.append("\n".join(data))
                data = []
    else:
        chunks.append(text)
    out: list[dict] = []
    for c in chunks:
        try:
            v = json.loads(c)
        except ValueError:
            continue
        for m in v if isinstance(v, list) else [v]:
            if isinstance(m, dict):
                out.append(m)
    return out


def listed_tools(messages: list[dict]) -> list:
    out: list = []
    for m in messages:
        res = m.get("result")
        if isinstance(res, dict) and isinstance(res.get("tools"), list):
            out.extend(res["tools"])
    return out


def refused_call_text(server: str, tool: str, reason: str) -> str:
    return (f"Refused by the gateway: {reason}. An agent task may only use read-only tools from "
            f"{display_name(server)}, so this call was not sent.")


def unauthorized_text(server: str) -> str:
    return (f"{display_name(server)} refused this task's access. The person needs to reconnect "
            f"{display_name(server)} in Settings, then run the task again.")


def tool_error(msg_id: object, text: str) -> dict:
    """A JSON-RPC result the engine shows the model as a failed tool call."""
    return {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": text}], "isError": True}}


def rpc_error(msg_id: object, text: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32001, "message": text}}
