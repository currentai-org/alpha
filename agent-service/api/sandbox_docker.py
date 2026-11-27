"""Each conversation in a hardened Docker container of its own, for a self-hosted stack.

The local counterpart of `sandbox_e2b.py`, behind the same `SandboxBackend` interface, for a host with Docker and no
E2B install. Every call goes to the Docker Engine API at `DOCKER_HOST`, which is the sockguard socket proxy
(`selfhost/sockguard.yaml`), never the raw socket: the backend refuses a `unix://` host, and the proxy refuses a
create that binds a host path, runs privileged, shares a host namespace, adds a capability or passes a device.

- One container per conversation, named from `key_for(principal, conversation)`, so `connect` finds it by name from
  a fresh process and a create race ends in Docker's own name conflict rather than two sandboxes.
- Each container runs as a non-root user with every capability dropped, no-new-privileges, a read-only root
  filesystem, a size-capped tmpfs home holding the workspace, CPU, memory and process limits, a fixed
  environment with nothing from the image's own, and no host mount. The image is pinned by digest (`DockerConfig.image` must carry `@sha256:`).
- The run-code tier has no network at all. The agent tier gets an internal network of its own, with no route out,
  and the model gateway's container joined to it under the gateway's host name: the one destination e2b allows.
- The workspace lives in tmpfs, so there is no pause: a stopped container would lose it. `pause` is a no-op, and
  the idle sweep removes a container unused past the limit. `reap` removes every container and network this backend
  made, and the service runs it at start, since a restarted service cannot reattach to a process it started.
- Files go through `exec` (base64 over argv out, base64 on stdout back), so the proxy needs no archive endpoint.

Nothing imports this module unless `AGENT_SANDBOX_BACKEND=docker`, and the `docker` package is imported only here.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import shlex
import socket
import struct
import threading
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from sandbox_backend import (
    CannotAttach,
    ExecResult,
    Handle,
    OnWait,
    Proc,
    SandboxError,
    StdioStreams,
    Tier,
    key_for,
    owner_for,
    sandbox_env,
)
from sandbox_e2b import WORK, _AsyncProc, stdin_writer, workspace_path

HOME = "/home/user"
_BOUNDARY = "\x1e"
_LABEL = "org.aipotluck.sandbox"  # on every container and network this backend makes; `reap` and `sweep` read it
_PREFIX = "alpha-sbx-"
_CHUNK = 48 * 1024  # raw bytes per write call: 64 KiB of base64, half of Linux's 128 KiB cap on one argument
_TEARDOWN_SECS = 10.0
_TIMED_OUT = (124, 137)  # `timeout`'s own exit, and SIGKILL's
# The container's PID 1: stays up, reaps any orphaned process within a minute, and exits on SIGTERM.
_PID1 = "trap 'exit 0' TERM; while :; do sleep 60 & wait $!; done"


@dataclass
class DockerConfig:
    docker_host: str  # tcp://sockguard:2375; never unix://, which would be the raw socket
    image: str  # repo@sha256:...; a tag alone could change under a running deployment
    allow_tag: bool = False  # a tag is accepted when the operator's own build made it (the self-host compose file)
    user: str = "1000:1000"
    cpus: float = 1.0
    memory_mb: int = 1024
    pids: int = 256
    tmpfs_mb: int = 512  # the home directory, which holds the workspace
    gateway_host: str = ""  # the agent tier's one destination, by the name its URL uses
    gateway_container: str = ""  # the gateway's container, joined to each agent sandbox's network
    api_version: str = "1.43"  # pinned, so the client never asks /version first

    def __post_init__(self) -> None:
        if not self.docker_host.startswith("tcp://"):
            raise ValueError("DOCKER_HOST for the docker sandbox is the socket proxy's tcp:// address, never a socket")
        if "@sha256:" not in self.image and not self.allow_tag:
            raise ValueError("AGENT_SANDBOX_IMAGE is pinned by digest (name@sha256:...)")
        if bool(self.gateway_host) != bool(self.gateway_container):
            raise ValueError("the agent tier's gateway needs both its host name and its container")


def _status(e: BaseException) -> int | None:
    return getattr(e, "status_code", None)


def _name(key: str) -> str:
    return _PREFIX + key


class DockerBackend:
    name = "docker"

    def __init__(self, cfg: DockerConfig, *, client: Any = None, log_event: Callable[..., None] | None = None):
        if client is None:
            import docker  # lazy: only this backend needs the package

            client = docker.APIClient(base_url=cfg.docker_host, version=cfg.api_version, timeout=600)
        self._api = client
        self._cfg = cfg
        self._log_event = log_event
        self._key_locks = [threading.Lock() for _ in range(64)]
        self._last_use: dict[str, float] = {}  # key -> wall time of its last connect; lost on restart, as is the sandbox
        self._clock: Callable[[], float] = time.time

    def _log(self, event: str, **fields: object) -> None:
        if self._log_event is not None:
            self._log_event(event, **fields)

    # -- the container's shape --------------------------------------------------------------------------------

    def host_config(self, tier: Tier, network: str) -> dict[str, Any]:
        """The create body's HostConfig. Everything a sandbox may have is here; anything absent is Docker's default
        of none (no binds, no devices, no added capabilities)."""
        c = self._cfg
        return {
            "Privileged": False,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges:true"],
            "ReadonlyRootfs": True,
            "Tmpfs": {
                HOME: f"rw,nosuid,nodev,size={c.tmpfs_mb}m,uid={c.user.split(':')[0]},gid={c.user.split(':')[-1]},mode=0700",
                "/tmp": "rw,nosuid,nodev,noexec,size=64m",  # noqa: S108 — inside the sandbox
            },
            "NanoCpus": int(c.cpus * 1e9),
            "Memory": c.memory_mb * 1024 * 1024,
            "MemorySwap": c.memory_mb * 1024 * 1024,  # equal to Memory: no swap on top
            "PidsLimit": c.pids,
            "NetworkMode": network,
            # No Docker init: its PID 1 would keep the image's own ENV lines in /proc/1/environ, readable by the
            # code. `_PID1` reaps instead, started from a clean environment.
            "Init": False,
            "RestartPolicy": {"Name": "no"},
        }

    def _labels(self, key: str, tier: Tier, owner: str) -> dict[str, str]:
        return {_LABEL: "1", f"{_LABEL}.key": key, f"{_LABEL}.tier": tier.value, f"{_LABEL}.owner": owner}

    def _env(self) -> list[str]:
        """The code's whole environment, the same fixed set the host-local runner gives (`sandbox_env`)."""
        return [f"{k}={v}" for k, v in sandbox_env(HOME).items()]

    # -- lifecycle --------------------------------------------------------------------------------------------

    def _inspect(self, name: str) -> dict | None:
        try:
            return self._api.inspect_container(name)
        except Exception as e:  # a 404 is "none yet"; anything else is the proxy or daemon down
            if _status(e) == 404:
                return None
            raise SandboxError("the sandbox host can't be reached right now; try again in a minute") from e

    def find(self, principal: str, conversation: str, tier: Tier) -> Handle | None:
        key = key_for(principal, conversation)
        info = self._inspect(_name(key))
        if info is None:
            return None
        if (info.get("Config", {}).get("Labels") or {}).get(f"{_LABEL}.tier") != tier.value:
            raise SandboxError("this conversation's sandbox was made for another tier")
        if not (info.get("State") or {}).get("Running"):
            # Stopped (a daemon restart, an OOM kill): its tmpfs workspace is gone, so start clean.
            self._remove(key)
            return None
        self._last_use[key] = self._clock()
        return Handle(key=key, tier=tier, ref=info["Id"])

    def connect(self, principal: str, conversation: str, tier: Tier, *, on_wait: OnWait | None = None,
                cancelled: Callable[[], bool] | None = None, tool: str | None = None) -> Handle:
        key = key_for(principal, conversation)
        with self._key_locks[hash(key) % len(self._key_locks)]:
            found = self.find(principal, conversation, tier)
            if found is not None:
                return found
            return self._create(key, tier, owner_for(principal))

    def _network_for(self, key: str, tier: Tier) -> str:
        """"none" for run-code; for the agent tier an internal network of the sandbox's own with the gateway on it."""
        c = self._cfg
        if tier is Tier.RUN_CODE or not c.gateway_container:
            return "none"
        net = _name(key)
        try:
            self._api.create_network(net, driver="bridge", internal=True, labels={_LABEL: "1", f"{_LABEL}.key": key})
        except Exception as e:  # 409: left by a create that lost a race or failed half-way; reuse it
            if _status(e) != 409:
                raise SandboxError("the sandbox could not be started; try again") from e
        try:
            self._api.connect_container_to_network(c.gateway_container, net, aliases=[c.gateway_host])
        except Exception as e:  # already connected is the state we want
            if _status(e) not in (403, 409) or "already exists" not in str(e):
                raise SandboxError("the sandbox could not reach the model gateway; try again") from e
        return net

    def _create(self, key: str, tier: Tier, owner: str) -> Handle:
        c = self._cfg
        network = self._network_for(key, tier)
        try:
            created = self._api.create_container(
                c.image,
                entrypoint=["env", "-i", *self._env(), "sh", "-c", _PID1],
                command=[],
                user=c.user,
                working_dir=HOME,
                environment=self._env(),
                labels=self._labels(key, tier, owner),
                name=_name(key),
                hostname="sandbox",
                host_config=self.host_config(tier, network),
            )
        except Exception as e:  # 409: another thread or process made it first
            if _status(e) == 409:  # another thread or process made it first: use that one
                info = self._inspect(_name(key))
                if info is not None:
                    self._last_use[key] = self._clock()
                    return Handle(key=key, tier=tier, ref=info["Id"])
            self._log("sandbox.create_failed", tier=tier.value, status=_status(e), detail=str(e)[:300])
            raise SandboxError("the sandbox could not be started; try again") from e
        cid = created["Id"]
        self._api.start(cid)
        h = Handle(key=key, tier=tier, ref=cid)
        self._last_use[key] = self._clock()
        # From the home directory: an exec whose working directory does not exist yet fails before it runs.
        res = self._run(h, ["mkdir", "-p", WORK], 30, workdir=HOME)
        if res.code != 0:
            self._log("sandbox.create_failed", tier=tier.value, status=res.code, detail=res.stderr[:300])
            self._remove(key)
            raise SandboxError("the sandbox could not be started; try again")
        return h

    def _remove(self, key: str) -> bool:
        """Remove the key's container and network. True if a container went."""
        gone = False
        try:
            self._api.remove_container(_name(key), force=True)
            gone = True
        except Exception as e:  # 404: already gone
            if _status(e) != 404:
                raise SandboxError("a sandbox of this conversation could not be removed; the idle sweep will retry") from e
        self._remove_network(_name(key))
        self._last_use.pop(key, None)
        return gone

    def _remove_network(self, net: str) -> None:
        if self._cfg.gateway_container:
            with contextlib.suppress(Exception):
                self._api.disconnect_container_from_network(self._cfg.gateway_container, net, force=True)
        try:
            self._api.remove_network(net)
        except Exception as e:  # noqa: BLE001 — none for a run-code sandbox; reap takes any other leftover
            if _status(e) != 404:
                self._log("sandbox.network_remove_failed", detail=str(e)[:300])

    def destroy(self, principal: str, conversation: str) -> int:
        return int(self._remove(key_for(principal, conversation)))

    def kill(self, h: Handle) -> None:
        self._remove(h.key)

    def pause(self, h: Handle) -> None:
        """Nothing: the workspace is tmpfs, which a stopped container loses. The idle sweep removes it later."""

    def _ours(self) -> list[dict]:
        return self._api.containers(all=True, filters={"label": [f"{_LABEL}=1"]})

    def sweep(self, older_than_secs: float, *, running_older_than_secs: float | None = None,
              keep: frozenset[str] = frozenset()) -> list[str]:
        """Remove every sandbox of ours unused for longer than the limit, returning their keys. Last use is this
        process's last connect, or the container's creation for one it has not seen since starting. An agent
        sandbox also goes past `running_older_than_secs`. A key in `keep` is never removed."""
        now = self._clock()
        killed: list[str] = []
        for info in self._ours():
            labels = info.get("Labels") or {}
            key = labels.get(f"{_LABEL}.key", "")
            if not key or key in keep:
                continue
            unused = now - self._last_use.get(key, float(info.get("Created", now)))
            limit = older_than_secs
            if running_older_than_secs is not None and labels.get(f"{_LABEL}.tier") == Tier.AGENT.value:
                limit = min(limit, running_older_than_secs)
            if unused > limit:
                with contextlib.suppress(SandboxError):
                    if self._remove(key):
                        killed.append(key)
        return killed

    def reap(self) -> int:
        """Remove every container and network this backend made. Run at service start: a restarted service cannot
        reattach to a process it started, and a sandbox no task holds would otherwise wait for the idle sweep."""
        n = 0
        for info in self._ours():
            key = (info.get("Labels") or {}).get(f"{_LABEL}.key", "")
            if key and self._remove(key):
                n += 1
        for net in self._api.networks(filters={"label": [f"{_LABEL}=1"]}):
            self._remove_network(net.get("Name", ""))
        self._log("sandbox.reaped", count=n)
        return n

    def pool_load(self) -> dict[int, int]:
        return {1: sum(1 for i in self._ours() if i.get("State") == "running")}

    # -- commands ---------------------------------------------------------------------------------------------

    def _exec(self, h: Handle, argv: list[str], *, env: dict[str, str] | None = None, stdin: bool = False,
              workdir: str = WORK) -> str:
        # `env -i`: an image's own ENV lines (a base image's GPG_KEY, say) would otherwise reach every command,
        # since Docker merges a container's environment into the image's and has no way to drop a name.
        environment = [*self._env(), *(f"{k}={v}" for k, v in (env or {}).items())]
        return self._api.exec_create(h.ref, ["env", "-i", *environment, *argv], stdin=stdin, stdout=True,
                                     stderr=True, user=self._cfg.user, workdir=workdir)["Id"]

    def exec(self, h: Handle, argv: list[str], timeout: float, *, stdin: str | None = None) -> ExecResult:
        cmd = shlex.join(argv)
        if stdin is not None:
            self.write(h, ".stdin", stdin.encode())
            cmd = f"{cmd} < .stdin; s=$?; rm -f .stdin; exit $s"
        return self._run(h, ["sh", "-c", cmd], timeout)

    def _run(self, h: Handle, argv: list[str], timeout: float, *, workdir: str = WORK) -> ExecResult:
        secs = max(1, int(timeout))
        t0 = time.monotonic()
        try:
            eid = self._exec(h, ["timeout", "-s", "KILL", str(secs), *argv], workdir=workdir)
            out, err = self._api.exec_start(eid, demux=True)
            code = self._api.exec_inspect(eid).get("ExitCode")
        except Exception as e:  # the proxy or daemon down, said in words the model can pass on
            raise SandboxError("the sandbox can't be reached right now; try again in a minute") from e
        ms = int((time.monotonic() - t0) * 1000)
        stdout, stderr = (out or b"").decode("utf-8", "replace"), (err or b"").decode("utf-8", "replace")
        if code in _TIMED_OUT and ms >= secs * 1000 - 500:
            return ExecResult(stdout, stderr, None, ms, timed_out=True)
        return ExecResult(stdout, stderr, code, ms)

    def _resolved(self, h: Handle, rel: str) -> str:
        target = workspace_path(rel)
        res = self.exec(h, ["realpath", "-m", "--", target], 15)
        real = res.stdout.strip()
        if res.code != 0 or (real != WORK and not real.startswith(WORK + "/")):
            raise SandboxError(f"{rel!r} is outside the workspace")
        return real

    # -- files ------------------------------------------------------------------------------------------------

    def read(self, h: Handle, path: str, limit: int) -> bytes:
        real = self._resolved(h, path)
        res = self.exec(h, ["sh", "-c", 'test -f "$1" || exit 3; head -c "$2" -- "$1" | base64 -w0',
                            "_", real, str(int(limit))], 60)
        if res.code == 3:
            raise SandboxError(f"{path!r} is not a file in the workspace")
        if res.code != 0:
            raise SandboxError(f"{path!r} could not be read")
        return base64.b64decode(res.stdout)[:limit]

    def write(self, h: Handle, path: str, data: bytes) -> None:
        real = self._resolved(h, path)
        first = self.exec(h, ["sh", "-c", 'test -d "$1" && exit 3; mkdir -p -- "$(dirname -- "$1")" && : > "$1"',
                              "_", real], 15)
        if first.code == 3 or real == WORK:
            raise SandboxError(f"{path!r} is a directory")
        if first.code != 0:
            raise SandboxError(f"{path!r} could not be written")
        for i in range(0, len(data), _CHUNK):
            chunk = base64.b64encode(data[i:i + _CHUNK]).decode()
            res = self.exec(h, ["sh", "-c", 'printf %s "$1" | base64 -d >> "$2"', "_", chunk, real], 60)
            if res.code != 0:
                raise SandboxError(f"{path!r} could not be written")

    def list(self, h: Handle, limit: int) -> list[tuple[str, int]]:
        res = self.exec(h, ["find", WORK, "-type", "f", "-printf", f"%P\t%s{_BOUNDARY}"], 30)
        out: list[tuple[str, int]] = []
        for rec in res.stdout.split(_BOUNDARY):
            rel, _, size = rec.partition("\t")
            if rel and size.isdigit() and not rel.startswith(".stdin"):
                out.append((rel, int(size)))
        return sorted(out)[:limit]

    # -- long processes ---------------------------------------------------------------------------------------

    def _start_stream(self, h: Handle, argv: list[str], env: dict[str, str]) -> tuple[str, str, socket.socket]:
        """Start `argv` with stdin open, its pid written where `_kill_proc` finds it; returns (exec id, pidfile,
        the exec's raw socket)."""
        pidfile = f"/tmp/.proc-{uuid.uuid4().hex}"  # noqa: S108 — inside the sandbox
        eid = self._exec(h, ["sh", "-c", 'echo $$ > "$0"; exec "$@"', pidfile, *argv], env=env, stdin=True)
        sock = self._api.exec_start(eid, socket=True)
        return eid, pidfile, getattr(sock, "_sock", sock)

    def _exit_code(self, eid: str, wait_secs: float = 3.0) -> int | None:
        """The exec's exit code once Docker records it: the stream can end a moment before the exec reads as done."""
        deadline = time.monotonic() + wait_secs
        while True:
            try:
                info = self._api.exec_inspect(eid)
            except Exception:  # noqa: BLE001 — the proxy or daemon gone: the code is unknown, not an error here
                return None
            if not info.get("Running") or time.monotonic() >= deadline:
                return info.get("ExitCode")
            time.sleep(0.1)

    def _kill_proc(self, h: Handle, pidfile: str) -> None:
        with contextlib.suppress(Exception):
            self.exec(h, ["sh", "-c", 'kill -KILL "$(cat "$1")" 2>/dev/null; rm -f "$1"', "_", pidfile], 10)

    def spawn(self, h: Handle, argv: list[str], env: dict[str, str]) -> Proc:
        eid, pidfile, sock = self._start_stream(h, argv, env)

        def lines() -> Iterator[str]:
            buf = b""
            for stream, data in frames(sock):
                if stream != 1:
                    continue
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    yield line.decode("utf-8", "replace") + "\n"
            if buf:
                yield buf.decode("utf-8", "replace")

        def wait(timeout: float | None) -> int | None:
            deadline = None if timeout is None else time.monotonic() + timeout
            while True:
                info = self._api.exec_inspect(eid)
                if not info.get("Running"):
                    return info.get("ExitCode")
                if deadline is not None and time.monotonic() >= deadline:
                    return None
                time.sleep(0.2)

        return Proc(id=eid, lines=lines(), write=lambda s: sock.sendall(s.encode()), wait=wait,
                    kill=lambda: self._kill_proc(h, pidfile))

    def attach(self, h: Handle, proc_id: str) -> Proc:
        raise CannotAttach("the docker sandbox cannot reconnect to a process an earlier service process started")

    @asynccontextmanager
    async def open_stdio(self, h: Handle, argv: list[str], env: dict[str, str]) -> AsyncIterator[StdioStreams]:
        """`argv` in the sandbox with its stdio bridged to asyncio streams for an ACP session. Leaving the block
        kills the process; the sandbox stays for the conversation's next task."""
        loop = asyncio.get_running_loop()
        eid, pidfile, sock = await asyncio.to_thread(self._start_stream, h, argv, env)
        reader, errs = asyncio.StreamReader(), asyncio.StreamReader()
        proc = _AsyncProc(errs)
        done = asyncio.Event()

        def finish(code: int | None) -> None:
            proc.returncode = code
            reader.feed_eof()
            errs.feed_eof()
            done.set()

        def pump() -> None:
            code: int | None = None
            try:
                for stream, data in frames(sock):
                    loop.call_soon_threadsafe((reader if stream == 1 else errs).feed_data, data)
            except OSError:
                pass
            finally:
                code = self._exit_code(eid)
                loop.call_soon_threadsafe(finish, code)

        threading.Thread(target=pump, name=f"sandbox-stdio-{h.key[:8]}", daemon=True).start()

        async def send(b: bytes) -> None:
            await asyncio.to_thread(sock.sendall, b)

        try:
            yield reader, stdin_writer(send, loop), proc
        finally:
            if proc.returncode is None:
                await asyncio.to_thread(self._kill_proc, h, pidfile)
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(done.wait(), _TEARDOWN_SECS)
            with contextlib.suppress(OSError):
                sock.close()


def _recv_exact(sock: socket.socket, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        got = sock.recv(n - len(buf))
        if not got:
            return None
        buf += got
    return buf


def frames(sock: socket.socket) -> Iterator[tuple[int, bytes]]:
    """(stream, payload) frames of Docker's multiplexed exec stream (no TTY): an 8-byte header, stream 1 stdout and
    2 stderr, then a big-endian uint32 length. Ends at EOF."""
    while True:
        head = _recv_exact(sock, 8)
        if head is None:
            return
        stream, size = head[0], struct.unpack(">I", head[4:8])[0]
        data = _recv_exact(sock, size) if size else b""
        if data is None:
            return
        yield stream, data
