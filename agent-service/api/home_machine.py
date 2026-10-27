"""Each conversation's home machine, so its sandbox calls reach the machine holding its workdir (CUR-4435).

A conversation's workdir is local disk on whichever machine first served it (`_sandbox_workdir`, `_resolve_workdir`
in app.py), and Fly's proxy balances requests across the app's machines. Chat pins an agent turn's follow-ups
with `Fly-Force-Instance-Id`, but its sandbox MCP calls and artifact downloads carry no pin, so on a two-machine
app a code call could land on the other machine and silently start in an empty workdir.

The fix here is rendezvous hashing: every machine computes the same home for a conversation from the app's machine
list, and a request that lands elsewhere is answered with `fly-replay`, which Fly's proxy follows to the home
machine (fly.io/docs/networking/dynamic-request-routing). `prefer_instance` rather than `instance`, so a stopped
home falls back to any machine instead of failing; a request that already carries `fly-replay-src` is served
where it landed, so a fallback can never bounce. Adding or removing a machine moves only the conversations whose
home it was, the property rendezvous hashing exists for.

The machine list comes from Fly's internal DNS: the TXT record on `vms.<app>.internal` lists each machine as
`<id> <region>`, comma-separated (fly.io/docs/networking/private-networking). The machine API socket (`/.fly/api`) is not used: it serves no requests
in this environment, root's included. The egress filter keeps the
app's uid off port 53, so the entrypoint runs `python3 home_machine.py --write <file>` as root on a timer and
the server reads the file. No file, one machine, or no Fly environment means every request is served where it
lands, today's behaviour.

This is the interim for CUR-4434, which moves workspaces off the machine altogether.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

MACHINES_FILE = os.environ.get("AGENT_MACHINES_FILE", "/run/agent-machines")
_FLY_DNS = "fdaa::3"  # Fly's internal resolver, on every machine's private network
# Fly's proxy cannot replay a request over 1 MB (fly.io/docs/networking/dynamic-request-routing, "Requirements
# and Limitations"), so a larger one, such as a sandbox write near its 2 MB cap, is served where it landed.
REPLAY_MAX_BYTES = 1_000_000

_cache: dict[str, object] = {"mtime": None, "ids": ()}


def machine_ids(path: str = MACHINES_FILE) -> tuple[str, ...]:
    """The app's machine ids from the entrypoint's file, re-read only when it changes. Empty when absent."""
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return ()
    if _cache["mtime"] != mtime:
        try:
            ids = tuple(sorted({line.strip() for line in Path(path).read_text().splitlines() if line.strip()}))
        except OSError:
            return ()
        _cache.update(mtime=mtime, ids=ids)
    return _cache["ids"]  # type: ignore[return-value]


def home_for(conversation: str, ids: tuple[str, ...]) -> str | None:
    """The machine with the highest hash of (machine, conversation): the same answer on every machine."""
    if not ids or not conversation:
        return None
    return max(ids, key=lambda m: hashlib.sha256(f"{m}\x00{conversation}".encode()).digest())


def replay_target(
    conversation: str | None, headers: dict[str, str], *, self_id: str | None, ids: tuple[str, ...] | None = None
) -> str | None:
    """The machine to replay this request to, or None to serve it here.

    Served here when: no conversation, no machine id of our own (not on Fly), fewer than two machines, the
    request was already replayed once (`fly-replay-src`), the caller pinned a machine itself
    (`fly-force-instance-id`, an agent turn's follow-up to the machine running its task), the body is too large
    for Fly to replay, or we are the home."""
    if not conversation or not self_id:
        return None
    if "fly-replay-src" in headers or "fly-force-instance-id" in headers:
        return None
    try:
        if int(headers.get("content-length") or 0) > REPLAY_MAX_BYTES:
            return None
    except ValueError:
        return None
    ids = machine_ids() if ids is None else ids
    if len(ids) < 2 or self_id not in ids:
        return None
    home = home_for(conversation, ids)
    return None if home in (None, self_id) else home


def replay_header(target: str) -> str:
    return f"prefer_instance={target}"


def parse_vms_txt(text: str) -> list[str]:
    """Machine ids from a `vms.<app>.internal` TXT value: `"<id> <region>,<id> <region>"`."""
    return sorted({entry.split()[0] for entry in text.split(",") if entry.strip()})


def _list_from_dns(app_name: str) -> list[str]:
    import dns.resolver  # only the root writer needs it, and only on Fly

    resolver = dns.resolver.Resolver(configure=False)
    resolver.nameservers = [_FLY_DNS]
    resolver.lifetime = 5
    answer = resolver.resolve(f"vms.{app_name}.internal", "TXT")
    return parse_vms_txt("".join(s.decode() for record in answer for s in record.strings))


def write(path: str) -> int:
    """Root-side writer: list the app's machines and replace `path` atomically. Exit 0 with nothing written off Fly."""
    app_name = os.environ.get("FLY_APP_NAME")
    if not app_name:
        return 0
    try:
        ids = _list_from_dns(app_name)
    except Exception as e:  # noqa: BLE001 — a failed refresh keeps the last good file
        print(json.dumps({"event": "machines.refresh_failed", "error": type(e).__name__}), file=sys.stderr)
        return 1
    tmp = f"{path}.tmp"
    Path(tmp).write_text("".join(f"{i}\n" for i in ids))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--write":
        sys.exit(write(sys.argv[2]))
    print("usage: home_machine.py --write <file>", file=sys.stderr)
    sys.exit(2)
