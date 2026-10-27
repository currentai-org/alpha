"""A task's workspace when Hermes ran in the conversation's own sandbox, not on this machine (CUR-4483).

app.py's post-attempt readers (artifacts, moderation, quarantine, the verifier, best-of-N reset, snapshot and
restore) were written against a local directory. When the attempt ran remotely its files exist only in the
guest, so each of those readers takes a `RemoteWork` in place of the path and gets the same answer from
inside the guest, through `SandboxBackend.exec`. Nothing is copied back to this machine wholesale: a reader
fetches only the files it reads, bounded by its own cap.

Every command runs inside the guest, which holds no credential of ours and no other account's files, so the
symlink and FIFO guards the local readers need (a link to /data/tasks.db there is another tenant's database)
protect nothing here. Containment is still kept, so a link the agent planted reads as "not a file" rather
than as the guest's own /etc: a reader asked for a workspace file gets a workspace file or nothing.

Listings and orderings match the local readers exactly, so a task serves the same artifacts in the same
order whichever backend ran it.
"""

from __future__ import annotations

import base64
import shlex
import time
import uuid
from dataclasses import dataclass

from sandbox_backend import Handle, SandboxBackend, SandboxError

QUARANTINE_DIRNAME = "agent-quarantine"
SNAPSHOT_ROOT = "/home/user/.snapshots"  # outside the workspace, so a reset never touches a kept snapshot
_RS = "\x00"                             # record separator; find prints it, and no file name can hold it
_CMD_SECS = 60.0
# The local walk prunes only these TOP-LEVEL directories; a top-level file named hermes-home-notes.txt is work.
_PRUNE = f"-mindepth 1 -type d \\( -path './hermes-home*' -o -path ./{QUARANTINE_DIRNAME} \\) -prune"


def _walk_key(rel: str) -> tuple[tuple[int, str], ...]:
    """os.walk's order with sorted entries: a directory's files first, then each subdirectory in turn."""
    parts = rel.split("/")
    return (*((1, p) for p in parts[:-1]), (0, parts[-1]))


@dataclass
class RemoteWork:
    backend: SandboxBackend
    handle: Handle
    root: str
    local: str = ""   # this machine's scratch for the same task: raw.log and HERMES_HOME staging live there

    def __str__(self) -> str:
        return self.root

    def _sh(self, script: str, timeout: float = _CMD_SECS):
        return self.backend.exec(self.handle, ["bash", "-c", script], timeout)

    def _ok(self, script: str, what: str, timeout: float = _CMD_SECS):
        """`_sh` for a command whose answer the caller relies on. A failed or timed-out command raises rather
        than reading as an empty workspace: a listing that came back empty because `find` died would let
        moderation pass files it never saw."""
        res = self._sh(script, timeout)
        if res.timed_out or res.code != 0:
            why = "timed out" if res.timed_out else f"exit {res.code}: {res.stderr.strip()[-200:]}"
            raise SandboxError(f"{what} failed in the sandbox ({why})")
        return res

    def files(self, limit: int, since: float | None = None) -> list[tuple[str, int]]:
        """`_artifact_paths` for the guest: regular files, top-level hermes-home* and quarantine dirs pruned,
        raw.log skipped, one entry past `limit` so the caller can see the cap bite."""
        r = shlex.quote(self.root)
        before = time.time()
        res = self._ok(f"date +%s.%N && cd {r} && find . {_PRUNE} -o -type f -printf '%s\\t%T@\\t%P\\0'",
                       "listing the workspace")
        # `since` is this machine's clock and the mtimes are the guest's, which can lag after a resume from a
        # snapshot. The guest's `date` ran inside this call, so its offset from our midpoint converts `since`.
        guest_now, _, listing = res.stdout.partition("\n")
        if since is not None:
            try:
                since += float(guest_now) - (before + time.time()) / 2
            except ValueError as e:
                raise SandboxError("listing the workspace failed in the sandbox (no guest clock)") from e
        rows: list[tuple[str, int, float]] = []
        for rec in listing.split(_RS):
            size, mtime, rel = [*rec.split("\t", 2), "", ""][:3]   # the name last: it may hold a tab
            if not rel or rel == "raw.log" or not size.isdigit():
                continue
            try:
                t = float(mtime)
            except ValueError:
                continue
            if since is not None and t < since:
                continue
            rows.append((rel, int(size), t))
        rows.sort(key=lambda row: _walk_key(row[0]))
        return [(rel, size) for rel, size, _t in rows[: limit + 1]]

    def read(self, rel: str, limit: int) -> bytes | None:
        """At most `limit` bytes of one regular file inside the root, or None when it isn't one. A link as the
        last component is refused, as `_read_artifact`'s O_NOFOLLOW does, since a snapshot never captures one.
        A read that fails in the guest raises: moderation must not skip a file because one exec hiccuped."""
        if not rel or "\x00" in rel or rel.startswith("/") or ".." in rel.split("/"):
            return None
        root = shlex.quote(self.root)
        p = shlex.quote(f"{self.root}/{rel}")
        res = self._sh(f'set -o pipefail; [ -L {p} ] && exit 3; r=$(realpath -e -- {p}) || exit 3; case "$r" in {root}/*) ;; *) exit 3;; esac; '
                       f'[ -f "$r" ] || exit 3; head -c {int(limit)} -- "$r" | base64 -w0')
        if res.code == 3 and not res.timed_out:     # the guard's own answer: not a regular file in the root
            return None
        if res.timed_out or res.code != 0:
            why = "timed out" if res.timed_out else f"exit {res.code}"
            raise SandboxError(f"reading {rel!r} failed in the sandbox ({why})")
        try:
            return base64.b64decode(res.stdout.strip(), validate=True)
        except ValueError as e:
            raise SandboxError(f"reading {rel!r} returned garbled output") from e

    def top_level(self) -> list[tuple[str, bool]]:
        """(name, is_dir) for each top-level entry, sorted; a link counts as not a directory."""
        res = self._ok(f"find {shlex.quote(self.root)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\0'",
                       "listing the workspace's top level")
        out = []
        for rec in res.stdout.split(_RS):
            kind, _, name = rec.partition("\t")
            if name:
                out.append((name, kind == "d"))
        return sorted(out)

    def reset(self) -> None:
        """`_reset_scratch`: everything but the exact name hermes-home goes."""
        self._ok(f"find {shlex.quote(self.root)} -mindepth 1 -maxdepth 1 ! -name hermes-home -exec rm -rf -- {{}} +",
                 "clearing the workspace")

    def snapshot(self) -> RemoteWork:
        """`_snapshot_scratch`: every regular file `files` would list, copied to a fresh directory outside the
        workspace. Returns that copy as its own RemoteWork, so the snapshot readers work on it unchanged."""
        dest = f"{SNAPSHOT_ROOT}/{uuid.uuid4().hex}"
        d = shlex.quote(dest)
        self._ok(f"set -o pipefail; mkdir -p {d} && cd {shlex.quote(self.root)} && "
                 f"find . {_PRUNE} -o -type f ! -path ./raw.log -print0 | "
                 f"tar --null --no-recursion -T - -cf - | tar -xf - -C {d}", "snapshotting the workspace")
        return RemoteWork(self.backend, self.handle, dest, self.local)

    def restore(self, snapshot: RemoteWork) -> None:
        """`_restore_scratch`: clear every top-level entry except a hermes-home* directory, then copy the
        snapshot back in."""
        r = shlex.quote(self.root)
        self._ok(f"cd {r} && for e in * .[!.]* ..?*; do [ -e \"$e\" ] || [ -L \"$e\" ] || continue; "
                 f"case \"$e\" in hermes-home*) [ -d \"$e\" ] && [ ! -L \"$e\" ] && continue;; esac; "
                 f"rm -rf -- \"$e\"; done; cp -a {shlex.quote(snapshot.root)}/. {r}/", "restoring the workspace")

    def drop(self) -> None:
        """Delete this snapshot. Refuses anything that isn't one, so a mixed-up call can't empty a workspace."""
        if self.root.startswith(SNAPSHOT_ROOT + "/"):
            self._sh(f"rm -rf -- {shlex.quote(self.root)}")

    def quarantine(self, rel: str) -> bool:
        """Move one workspace file under the quarantine directory, keeping its relative path. A move that fails
        deletes the file instead: a file moderation blocked must not stay where the download route finds it."""
        src = shlex.quote(f"{self.root}/{rel}")
        dst = shlex.quote(f"{self.root}/{QUARANTINE_DIRNAME}/{rel}")
        return self._sh(f"{{ mkdir -p -- \"$(dirname -- {dst})\" && mv -f -- {src} {dst}; }} || rm -f -- {src}").code == 0

    def run(self, command: str, timeout: float):
        """A verifier `check_cmd`, in the root, in the same guest the agent ran in."""
        return self._sh(f"cd {shlex.quote(self.root)} || exit 97\n{command}", timeout)
