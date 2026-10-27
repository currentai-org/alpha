"""Where a conversation's code runs, behind one interface (CUR-4438, part of CUR-4434).

Today every conversation's code runs as a bubblewrap child of this service, on its kernel and under its uid, and the
conversation's files are a directory on this machine's disk. CUR-4434 moves each conversation into a sandbox of its
own (gVisor on Kubernetes, or a Firecracker VM) whose workspace the platform keeps. The tools chat calls
(`sandbox_mcp.py`) are written against this interface so that move is a backend swap, not a rewrite:

- `connect(principal, conversation, tier)` creates the conversation's sandbox or resumes it, and returns a handle.
  The sandbox is found from `key_for(principal, conversation)` alone, so any service machine can serve any call.
- `exec` runs a command to completion with a timeout; `read`, `write` and `list` work on the workspace through the
  backend, never on a host path the service opens itself, once the backend is remote.
- `pause` keeps the workspace and stops paying for compute; `kill` ends the sandbox and its workspace.
- `spawn` starts a long process with streamed output, and `attach` reconnects to one still running after this
  service restarts. A backend that cannot reattach raises `CannotAttach`.
- `open_stdio` starts a process and hands back its stdio as asyncio streams, which is what an ACP session to
  agent mode's Hermes runs over (`acp_client._acp_run`, CUR-4450).

`Tier` is the agentic tier the sandbox serves (CUR-4450):
it decides the egress policy. Run-code tools get none; agent mode reaches only the model gateway, with the credential
added outside the sandbox. The model never picks its own tier.

`BwrapBackend` is today's behaviour moved behind the interface, unchanged. Its file operations still run in this
process, confined by `confine`, because its workspace is a host directory; that is one of the things CUR-4434 ends.
"""

from __future__ import annotations

import asyncio
import enum
import hashlib
import shutil
import subprocess
import time
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


class SandboxError(Exception):
    """A request the backend will not carry out, with a reason fit to show the model."""


class SandboxBusy(SandboxError):
    """The sandbox host has no room for a new sandbox right now; an existing one still resumes."""


# What the person is told while a connect waits for a slot on a full host (CUR-4584). The agent task's status event
# and the run-code tools' MCP progress both carry it, and chat shows it as the turn's live line.
SANDBOX_WAIT_TEXT = "Waiting for a free sandbox…"

# Called once, with SANDBOX_WAIT_TEXT, when a connect starts waiting for a slot.
OnWait = Callable[[str], None]


class SandboxAccountLimit(SandboxError):
    """The account already has its share of live sandboxes; the message says what frees one (CUR-4553)."""


class CannotAttach(SandboxError):
    """This backend cannot reconnect to a process started by an earlier service process."""


class Tier(enum.StrEnum):
    RUN_CODE = "run_code"  # chat's in-turn tools: no network at all
    AGENT = "agent"  # agent mode: the model gateway only, credential added outside


def key_for(principal: str, conversation: str) -> str:
    """The name a sandbox is found by. Hashing keeps account ids out of backend metadata and object names."""
    return hashlib.sha256(f"{principal}\x00{conversation}".encode()).hexdigest()[:40]


def owner_for(principal: str) -> str:
    """The name an account's sandboxes are counted by: every sandbox of one principal carries it, so the live ones
    can be listed without the conversation. Hashed like `key_for`, and salted apart from it."""
    return hashlib.sha256(f"owner\x00{principal}".encode()).hexdigest()[:40]


@dataclass
class Handle:
    key: str
    tier: Tier
    ref: object = None  # backend-specific: a host path, a sandbox id, an object name
    slot: int = 1  # which of a pooled backend's hosts holds it (E2B, CUR-4529); 1 for a backend with one


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    code: int | None
    ms: int
    timed_out: bool = False


@dataclass
class Proc:
    """A spawned long process. `lines` yields its stdout lines until it exits; `id` is what `attach` takes."""

    id: str
    lines: Iterator[str]
    write: Callable[[str], None]
    wait: Callable[[float | None], int | None]
    kill: Callable[[], None]
    extra: dict[str, object] = field(default_factory=dict)


class StdioProc(Protocol):
    """What an ACP session needs of the process behind `open_stdio`: its stderr for the ops log, its exit code."""

    @property
    def stderr(self) -> asyncio.StreamReader | None: ...
    @property
    def returncode(self) -> int | None: ...


StdioStreams = tuple[asyncio.StreamReader, asyncio.StreamWriter, StdioProc]


class SandboxBackend(Protocol):
    name: str

    def connect(self, principal: str, conversation: str, tier: Tier, *, on_wait: OnWait | None = None,
                cancelled: Callable[[], bool] | None = None) -> Handle: ...
    def find(self, principal: str, conversation: str, tier: Tier) -> Handle | None: ...
    def destroy(self, principal: str, conversation: str) -> int: ...
    def sweep(self, older_than_secs: float) -> list[str]: ...
    def pool_load(self) -> dict[int, int]: ...
    def exec(self, h: Handle, argv: list[str], timeout: float, *, stdin: str | None = None) -> ExecResult: ...
    def read(self, h: Handle, path: str, limit: int) -> bytes: ...
    def write(self, h: Handle, path: str, data: bytes) -> None: ...
    def list(self, h: Handle, limit: int) -> list[tuple[str, int]]: ...
    def pause(self, h: Handle) -> None: ...
    def kill(self, h: Handle) -> None: ...
    def spawn(self, h: Handle, argv: list[str], env: dict[str, str]) -> Proc: ...
    def attach(self, h: Handle, proc_id: str) -> Proc: ...
    def open_stdio(self, h: Handle, argv: list[str], env: dict[str, str]) -> AbstractAsyncContextManager[StdioStreams]: ...


def confine(work: str, rel: str) -> Path:
    """`rel` resolved inside `work`, or SandboxError. Symlinks are resolved first, so a link the code planted
    pointing outside the workdir is refused rather than followed by the service process."""
    if not rel or "\x00" in rel:
        raise SandboxError("a path is required")
    root = Path(work).resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise SandboxError(f"{rel!r} is outside the workspace")
    return target


_ENV_BASE = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1",
    "MPLBACKEND": "Agg",
}


def sandbox_env(home: str) -> dict[str, str]:
    """The code's whole environment: a fixed set of names, nothing inherited from the service."""
    return {**_ENV_BASE, "HOME": home, "TMPDIR": home}


class BwrapBackend:
    """Today's sandbox: a bwrap child of this service, the workspace a directory on this machine."""

    name = "bwrap"

    def __init__(self, *, sandbox_prefix: Callable[[str], list[str]], workdir_for: Callable[[str, str], str],
                 existing_workdir: Callable[[str, str], str | None] | None = None):
        self._prefix = sandbox_prefix
        self._workdir_for = workdir_for
        self._existing_workdir = existing_workdir

    def connect(self, principal: str, conversation: str, tier: Tier, *, on_wait: OnWait | None = None,
                cancelled: Callable[[], bool] | None = None) -> Handle:
        # A child of this machine is never refused for room, so there is nothing to wait for.
        return Handle(key=key_for(principal, conversation), tier=tier, ref=self._workdir_for(principal, conversation))

    def find(self, principal: str, conversation: str, tier: Tier) -> Handle | None:
        work = self._existing_workdir(principal, conversation) if self._existing_workdir else None
        return Handle(key=key_for(principal, conversation), tier=tier, ref=work) if work else None

    def destroy(self, principal: str, conversation: str) -> int:
        return 0     # the workspace is the session's directory, which its own delete removes

    def sweep(self, older_than_secs: float) -> list[str]:
        return []    # likewise: the session reaper's rmtree is the sweep

    def pool_load(self) -> dict[int, int]:
        return {}    # the sandboxes are children of this machine, not a pool of hosts

    def _argv(self, h: Handle, argv: list[str]) -> list[str]:
        # Run-code gets no network at all, allowlisted hosts included; agent mode keeps the machine's
        # nftables allowlist, which is how it reaches the gateway today.
        net = ["--unshare-net"] if h.tier is Tier.RUN_CODE else []
        return [*self._prefix(str(h.ref)), *net, *argv]

    def exec(self, h: Handle, argv: list[str], timeout: float, *, stdin: str | None = None) -> ExecResult:
        work = str(h.ref)
        t0 = time.monotonic()
        try:
            proc = subprocess.run(
                self._argv(h, argv),
                cwd=work,
                env=sandbox_env(work),
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            out = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            return ExecResult(out, "", None, int((time.monotonic() - t0) * 1000), timed_out=True)
        return ExecResult(proc.stdout, proc.stderr, proc.returncode, int((time.monotonic() - t0) * 1000))

    def read(self, h: Handle, path: str, limit: int) -> bytes:
        target = confine(str(h.ref), path)
        if not target.is_file():
            raise SandboxError(f"{path!r} is not a file in the workspace")
        with open(target, "rb") as f:
            return f.read(limit)

    def write(self, h: Handle, path: str, data: bytes) -> None:
        target = confine(str(h.ref), path)
        if target == Path(str(h.ref)).resolve() or target.is_dir():
            raise SandboxError(f"{path!r} is a directory")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def list(self, h: Handle, limit: int) -> list[tuple[str, int]]:
        root = Path(str(h.ref))
        out: list[tuple[str, int]] = []
        for p in sorted(root.rglob("*")):
            if p.is_symlink() or not p.is_file():
                continue
            rel = str(p.relative_to(root))
            out.append((rel, p.stat().st_size))
            if len(out) >= limit:
                break
        return out

    def pause(self, h: Handle) -> None:
        """Nothing runs between calls, so there is nothing to pause."""

    def kill(self, h: Handle) -> None:
        shutil.rmtree(str(h.ref), ignore_errors=True)

    def spawn(self, h: Handle, argv: list[str], env: dict[str, str]) -> Proc:
        work = str(h.ref)
        p = subprocess.Popen(
            self._argv(h, argv),
            cwd=work,
            env={**sandbox_env(work), **env},
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

        def lines() -> Iterator[str]:
            yield from p.stdout or ()

        def write(s: str) -> None:
            if p.stdin is None:
                raise SandboxError("the process has no stdin")
            p.stdin.write(s)
            p.stdin.flush()

        def wait(timeout: float | None) -> int | None:
            try:
                return p.wait(timeout)
            except subprocess.TimeoutExpired:
                return None

        return Proc(id=str(p.pid), lines=lines(), write=write, wait=wait, kill=p.kill, extra={"popen": p})

    def attach(self, h: Handle, proc_id: str) -> Proc:
        raise CannotAttach("a bwrap process dies with the service process that started it")

    @asynccontextmanager
    async def open_stdio(self, h: Handle, argv: list[str], env: dict[str, str]) -> AsyncIterator[StdioStreams]:
        """The launch `acp.spawn_agent_process` does, with this backend's prefix. `env` is passed as the caller
        built it, over acp's default inherited names, exactly as agent mode's launch has always done; leaving it
        is the stdin close, terminate, kill that acp's transport does, and bwrap's `--die-with-parent` takes
        the tree with it."""
        from acp.transports import spawn_stdio_transport  # lazy: run-code never needs the acp package

        command, *args = self._argv(h, argv)
        async with spawn_stdio_transport(command, *args, env=env, cwd=str(h.ref)) as streams:
            yield streams
