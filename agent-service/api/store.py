"""Durable task store (SQLite) for the agent service — closes the "state is in-memory, lost on restart"
maturity gap. The live in-memory dict still holds runtime handles (the agent subprocess, cancel flag) for
RUNNING tasks; this is the durable record of every task's outcome, so a restart/crash doesn't lose results,
and per-user spend can be summed across history for budgets (see app.py budget/rate-limit checks).

One machine by default: SQLite, WAL + a process-wide lock, safe for the thread-per-task model. With
`tasks_url` set (AGENT_TASKS_DATABASE_URL, agent-service's own Postgres) the task rows, their event logs and
cancel requests live there instead, so every machine of the app can serve any task (CUR-4443). The owning
machine renews a lease on each running task; a machine that finds a lapsed lease ends the task. Session
workdirs and the verify corpus stay in the local SQLite file: a workdir path names this machine's disk.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import LiteralString, cast

_TERMINAL = ("COMPLETED", "FAILED", "CANCELED")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    "user"          TEXT NOT NULL,
    state           TEXT NOT NULL,
    result          TEXT,
    result_truncated INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    summary         TEXT,
    verified        INTEGER NOT NULL DEFAULT 0,
    model_calls     INTEGER NOT NULL DEFAULT 0,
    tokens          INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL,
    artifacts       TEXT,
    -- The deadline the CALLER stated, in seconds, or NULL when it said nothing. Deliberately not the
    -- EFFECTIVE wall clock: the effective value equals the server ceiling whenever the caller is silent,
    -- so counting "below the ceiling" would silently re-interpret every historical row the day
    -- AGENT_WALL_CLOCK_SECS moves. NULL-vs-set answers "did a caller ask" for all time, and the value
    -- itself gives the distribution of what they asked for.
    caller_wall_clock INTEGER,
    -- CUR-855/846: the client's honesty-caveat verdict for this task (endpointAgent.ts's serviceFlagged
    -- gates on this being non-blank). Was in-memory only — a task reconstructed from this store after
    -- eviction or a restart got its real `result` back but never its caveat, which is the false-confidence
    -- outcome this field exists to prevent. NULL/absent reads as "" in Python, same as never-set.
    unrun_detail    TEXT,
    session_expired INTEGER,
    -- CUR-4443: the machine running the task, the time its lease runs out, and a cancel asked for on
    -- another machine. Only a shared store reads them; on one machine they stay NULL and 0.
    owner           TEXT,
    lease_until     REAL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    -- CUR-4603: the executor model the task ran on; NULL on a row from before, which ran on AGENT_MODEL.
    model           TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks("user", created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

-- CUR-4443: each task's event stream, so a machine other than the owner can replay it. Written only when
-- the store is shared; one machine streams from its in-memory buffer.
CREATE TABLE IF NOT EXISTS task_events (
    task_id   TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    type      TEXT NOT NULL,
    data      TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
);
"""

_LOCAL_SCHEMA = """
-- CUR-196: maps a (user, session_id) pair to the workdir it persists across turns. Separate table, not a
-- tasks column — a session outlives any single task row and isn't keyed by task id at all.
CREATE TABLE IF NOT EXISTS session_workdirs (
    user          TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    workdir       TEXT NOT NULL,
    created_at    REAL NOT NULL,
    last_used_at  REAL NOT NULL,
    PRIMARY KEY (user, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_workdirs_last_used ON session_workdirs(last_used_at);

-- CUR-596 item 2: every Tier 1 (deterministic expect_sorted_by/expect_columns rejection) and Tier 2
-- (best-of-N value disagreement) catch, durably — the labeled corpus CUR-654 needs before it can start
-- building an LLM critic. Fire-and-discard through attempt_rejections/unrun_detail alone (both in-memory,
-- both dead with the process) would leave nothing for CUR-654 to train against.
CREATE TABLE IF NOT EXISTS verify_corpus (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    created_at  REAL NOT NULL,
    tier        TEXT NOT NULL,   -- "tier1" | "tier2"
    kind        TEXT NOT NULL,   -- "expect_sorted_by" | "expect_columns" | "value_disagreement"
    prompt      TEXT NOT NULL,
    code        TEXT,            -- best-effort snapshot of what the agent wrote this attempt
    output      TEXT,            -- the attempt's answer text
    detail      TEXT NOT NULL    -- the verify/disagreement reason
);
CREATE INDEX IF NOT EXISTS idx_verify_corpus_created ON verify_corpus(created_at);
"""

# `CREATE TABLE IF NOT EXISTS` is a no-op against a database that already has the table, so a column added
# to _SCHEMA reaches a fresh dev box and never reaches an existing production database. Every
# column added after the first deploy needs a line here too. Idempotent: applied only when absent.
_ADD_COLUMNS = (("artifacts", "TEXT"), ("caller_wall_clock", "INTEGER"), ("session_expired", "INTEGER"),
                ("unrun_detail", "TEXT"), ("owner", "TEXT"), ("lease_until", "REAL"),
                ("cancel_requested", "INTEGER NOT NULL DEFAULT 0"), ("model", "TEXT"))

# Columns update() is allowed to set — guards against the SET clause interpolating an arbitrary/injected
# column name (values are already parameterized; this allowlists the keys too).
_UPDATABLE = {"state", "result", "result_truncated", "error", "summary", "verified",
              "model_calls", "tokens", "updated_at", "artifacts", "session_expired", "unrun_detail",
              "model"}


class _Tasks:
    """Where task rows, their events and cancel requests live: this machine's SQLite connection, or a shared
    Postgres. The queries are written once, for SQLite, with `"user"` quoted (a reserved word in Postgres)
    and `?` placeholders, which the Postgres side rewrites to `%s`; nothing else in them differs."""

    shared = False

    def run(self, sql: str, params: tuple = (), fetch: str | None = None):  # pragma: no cover — interface
        raise NotImplementedError

    def many(self, sql: str, rows: list[tuple]) -> None:  # pragma: no cover — interface
        raise NotImplementedError


class _SqliteTasks(_Tasks):
    def __init__(self, db: sqlite3.Connection, lock: threading.Lock):
        self._db, self._lock = db, lock

    def run(self, sql, params=(), fetch=None):
        with self._lock:
            cur = self._db.execute(sql, params)
            one = cur.fetchone() if fetch == "one" else None
            rows = cur.fetchall() if fetch == "all" else []
            self._db.commit()
        if fetch == "one":
            return dict(one) if one is not None else None
        if fetch == "all":
            return [dict(r) for r in rows]
        return cur.rowcount

    def many(self, sql, rows):
        with self._lock:
            self._db.executemany(sql, rows)
            self._db.commit()


class _PgTasks(_Tasks):
    """agent-service's own Postgres (CUR-4443). A small pool, because the run threads and the request
    threads write at once; `check` replaces a connection Neon closed while it sat idle."""

    shared = True

    def __init__(self, url: str):
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        self._pool = ConnectionPool(url, min_size=1, max_size=int(os.environ.get("AGENT_TASKS_POOL_MAX", "8")),
                                    kwargs={"autocommit": True, "row_factory": dict_row},
                                    check=ConnectionPool.check_connection, open=True)
        with self._pool.connection() as c:
            c.execute(cast(LiteralString, self._types(_SCHEMA)))
            for col, decl in _ADD_COLUMNS:
                c.execute(cast(LiteralString, f"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS {col} {self._types(decl)}"))
            c.execute("CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner) WHERE owner IS NOT NULL")

    @staticmethod
    def _types(ddl: str) -> str:
        # Postgres REAL is 4 bytes, which rounds an epoch timestamp by up to a couple of minutes; SQLite's
        # REAL is 8. Every timestamp column would compare wrong without this.
        return ddl.replace(" REAL", " DOUBLE PRECISION")

    @staticmethod
    def _pg(sql: str) -> LiteralString:
        # Every query reaching here is a literal in this file (column names from _UPDATABLE included).
        return cast(LiteralString, sql.replace("?", "%s"))

    def run(self, sql, params=(), fetch=None):
        with self._pool.connection() as c:
            cur = c.execute(self._pg(sql), params)
            if fetch == "one":
                return cur.fetchone()
            if fetch == "all":
                return cur.fetchall()
            return cur.rowcount

    def many(self, sql, rows):
        with self._pool.connection() as c, c.cursor() as cur:
            cur.executemany(self._pg(sql + " ON CONFLICT DO NOTHING"), rows)

    def close(self) -> None:
        self._pool.close()


_DUPLICATE = (sqlite3.IntegrityError,)
try:  # the error a duplicate task id raises on Postgres, so callers can catch either
    import psycopg.errors as _pg_errors

    _DUPLICATE = (sqlite3.IntegrityError, _pg_errors.UniqueViolation)
except ImportError:  # pragma: no cover — psycopg is in requirements.txt; a bare dev env may lack it
    pass


class Store:
    def __init__(self, path: str, tasks_url: str | None = None):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False + our own lock: the worker threads and the request threads share one conn.
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        # WAL + NORMAL: an OS crash / power loss can lose the LAST committed txn (an app crash cannot).
        # Set AGENT_DB_SYNC=FULL for fsync-every-commit durability at a write-latency cost.
        sync = os.environ.get("AGENT_DB_SYNC", "NORMAL").upper()
        if sync not in ("OFF", "NORMAL", "FULL", "EXTRA"):
            sync = "NORMAL"
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute(f"PRAGMA synchronous={sync}")
            self._db.executescript(_SCHEMA + _LOCAL_SCHEMA)
            have = {r["name"] for r in self._db.execute("PRAGMA table_info(tasks)")}
            for col, decl in _ADD_COLUMNS:
                if col not in have:
                    self._db.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")
            self._db.commit()
        self._tasks: _Tasks = _PgTasks(tasks_url) if tasks_url else _SqliteTasks(self._db, self._lock)
        if tasks_url:
            self.imported = self._import_local_tasks()

    def _import_local_tasks(self) -> int:
        """Move this machine's SQLite task rows into the shared store, keeping any already there. The spend
        ledger, caller history and old results live in those rows, so the switch to a shared store must not
        start them from zero. A move, not a copy: once the shared store holds a row, its prune and
        delete_for_user are the only ones that reach it, and a local copy left behind would come back on
        the next boot after either had removed it. The local rows go only after the insert succeeds."""
        with self._lock:
            rows = [dict(r) for r in self._db.execute("SELECT * FROM tasks")]
        if not rows:
            return 0
        cols = list(rows[0])
        quoted = ",".join(f'"{c}"' for c in cols)
        marks = ",".join("?" * len(cols))
        self._tasks.many(f"INSERT INTO tasks ({quoted}) VALUES ({marks})",  # noqa: S608 — local column names
                         [tuple(r[c] for c in cols) for r in rows])
        with self._lock:
            self._db.executemany("DELETE FROM tasks WHERE id=?", [(r["id"],) for r in rows])
            self._db.commit()
        return len(rows)

    @property
    def shared(self) -> bool:
        """True when other machines read and write the same task rows (CUR-4443)."""
        return self._tasks.shared

    def create(self, task_id: str, user: str, state: str, caller_wall_clock: int | None = None,
               owner: str | None = None, lease_until: float | None = None) -> None:
        now = time.time()
        # plain INSERT (not INSERT OR REPLACE): a task-id collision must error loudly, never clobber.
        self._tasks.run(
            'INSERT INTO tasks (id,"user",state,created_at,updated_at,caller_wall_clock,owner,lease_until) '
            "VALUES (?,?,?,?,?,?,?,?)",
            (task_id, user, state, now, now, caller_wall_clock, owner, lease_until),
        )

    def caller_deadline_count(self) -> int:
        """How many stored tasks arrived with a caller-stated deadline. Ever — that is the whole point.

        An in-process metrics counter cannot answer this on this service: the app runs
        `min_machines_running = 0`, so it scales to zero when idle and the counter resets, and /healthz would
        report 0 beside a durable tasks_total however often callers sent `wall_clock_secs`. A metric that answers a question about all time has to be as durable as the
        thing it is compared against."""
        row = self._tasks.run("SELECT COUNT(*) AS n FROM tasks WHERE caller_wall_clock IS NOT NULL", fetch="one")
        return int(row["n"])

    def update(self, task_id: str, **fields) -> None:
        if not fields:
            return
        fields = {k: (int(v) if isinstance(v, bool) else v) for k, v in fields.items()}
        fields["updated_at"] = time.time()
        bad = set(fields) - _UPDATABLE
        if bad:                                  # column-name allowlist — never interpolate an unknown key
            raise ValueError(f"store.update: disallowed columns {sorted(bad)}")
        cols = ", ".join(f"{k}=?" for k in fields)
        self._tasks.run(f"UPDATE tasks SET {cols} WHERE id=?",  # noqa: S608 — cols come from
                        (*fields.values(), task_id))           # _UPDATABLE, checked above; values are bound

    def prune(self, older_than_secs: float) -> int:
        """Delete TERMINAL tasks whose last update is older than the cutoff — retention so the durable store
        doesn't grow without bound (the live table is capped by MAX_TASKS; the DB wasn't). Returns # deleted.
        Their events go with them."""
        cutoff = time.time() - older_than_secs
        self._tasks.run(
            "DELETE FROM task_events WHERE task_id IN "
            "(SELECT id FROM tasks WHERE state IN (?,?,?) AND updated_at < ?)", (*_TERMINAL, cutoff)
        )
        return self._tasks.run("DELETE FROM tasks WHERE state IN (?,?,?) AND updated_at < ?", (*_TERMINAL, cutoff))

    def get_session_workdir(self, user: str, session_id: str) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT workdir FROM session_workdirs WHERE user=? AND session_id=?", (user, session_id),
            ).fetchone()
        return row["workdir"] if row else None

    def get_session_workdir_info(self, user: str, session_id: str) -> tuple[str, float] | None:
        """(workdir, last_used_at) for CUR-546's artifact fetch — needs last_used_at to state a real
        expiry, which get_session_workdir's callers (_run) have never needed. Separate method rather than
        widening get_session_workdir's return so that its one existing call site keeps its exact contract."""
        with self._lock:
            row = self._db.execute(
                "SELECT workdir, last_used_at FROM session_workdirs WHERE user=? AND session_id=?",
                (user, session_id),
            ).fetchone()
        return (row["workdir"], row["last_used_at"]) if row else None

    def touch_session_workdir(self, user: str, session_id: str, workdir: str) -> None:
        """Creates the row on first call; on a repeat call, sets workdir to whatever is passed AND bumps
        last_used_at. The caller (api/app.py's _run) always passes the workdir it actually used this turn
        — the SAME value on an ordinary reuse (so this is a no-op on workdir), or a NEW one when the prior
        directory was gone and a fresh one had to be made (the expired-session case). Both must land: an
        `ON CONFLICT` that updated only last_used_at would leave an expired session's row pointing at a
        directory that no longer exists, forever."""
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO session_workdirs (user, session_id, workdir, created_at, last_used_at) "
                "VALUES (?,?,?,?,?) "
                "ON CONFLICT(user, session_id) DO UPDATE SET "
                "workdir=excluded.workdir, last_used_at=excluded.last_used_at",
                (user, session_id, workdir, now, now),
            )
            self._db.commit()

    def prune_idle_sessions(self, older_than_secs: float) -> list[tuple[str, str, str]]:
        """Deletes session_workdirs rows idle past the cutoff, returning (user, session_id, workdir) for
        each — the actual rmtree happens in api/app.py, this module does no filesystem I/O."""
        cutoff = time.time() - older_than_secs
        with self._lock:
            rows = self._db.execute(
                "SELECT user, session_id, workdir FROM session_workdirs WHERE last_used_at < ?", (cutoff,),
            ).fetchall()
            self._db.execute("DELETE FROM session_workdirs WHERE last_used_at < ?", (cutoff,))
            self._db.commit()
        return [(r["user"], r["session_id"], r["workdir"]) for r in rows]

    def session_workdir_paths(self) -> set[str]:
        """Every currently-known session workdir path — so the boot-time stale-scratch sweep (which shares
        the same directory prefix/root) can skip them and leave their lifecycle to the idle reaper alone."""
        with self._lock:
            rows = self._db.execute("SELECT workdir FROM session_workdirs").fetchall()
        return {r["workdir"] for r in rows}

    def get(self, task_id: str) -> dict | None:
        return self._tasks.run("SELECT * FROM tasks WHERE id=?", (task_id,), fetch="one")

    def recover_orphans(self, owner: str | None = None) -> int:
        """On startup, any task still non-terminal was interrupted by the crash/restart — its agent process
        is gone. Mark it FAILED honestly rather than leaving a zombie WORKING row forever.

        CUR-218: AWAITING_CONFIRMATION gets a message naming what specifically happened, not the generic
        one — a human who answered (or was about to) deserves to know their answer never had anywhere to
        go, not just that the task failed for some unspecified reason. This is the correct degrade, not a
        bug: the worker thread and its `hermes acp` subprocess really are gone.

        CUR-4443: on a shared store only this machine's own tasks (`owner`) and ownerless rows are this
        restart's to end; another machine's running tasks are left to their owner, or to `fail_lapsed`."""
        now = time.time()
        # Two fixed WHERE tails, never caller text, so the concatenation below is not an injection path.
        scope, scope_args = ("", ()) if not self.shared else (" AND (owner=? OR owner IS NULL)", (owner,))
        awaiting = ("UPDATE tasks SET state='FAILED', error='interrupted by server restart while awaiting your answer', "
                    "summary='failed: server restart (awaiting confirmation)', updated_at=? "
                    "WHERE state='AWAITING_CONFIRMATION'")
        running = ("UPDATE tasks SET state='FAILED', error='interrupted by server restart', "
                   "summary='failed: server restart', updated_at=? WHERE state NOT IN (?,?,?,?)")
        n1 = self._tasks.run(awaiting + scope, (now, *scope_args))
        n2 = self._tasks.run(running + scope, (now, *_TERMINAL, "AWAITING_CONFIRMATION", *scope_args))
        return n1 + n2

    # ---- CUR-4443: what lets a second machine serve a task the first one runs --------------------------

    def renew_leases(self, owner: str, task_ids: list[str], until: float) -> list[str]:
        """The owner says these tasks are still alive, until `until`. Returns the ones it may no longer run:
        rows already terminal, which another machine ended after this owner's lease lapsed (a stalled
        tick, a database blip). The owner stops those rather than finish work nobody will read."""
        if not task_ids:
            return []
        marks = ",".join("?" * len(task_ids))
        self._tasks.run(
            f"UPDATE tasks SET lease_until=? WHERE owner=? AND id IN ({marks}) "  # noqa: S608 — marks are "?"
            "AND state NOT IN (?,?,?)",
            (until, owner, *task_ids, *_TERMINAL),
        )
        rows = self._tasks.run(
            f"SELECT id FROM tasks WHERE id IN ({marks}) AND state IN (?,?,?)",  # noqa: S608 — marks are "?"
            (*task_ids, *_TERMINAL), fetch="all",
        )
        return [r["id"] for r in rows]

    def fail_lapsed(self, now: float | None = None) -> list[dict]:
        """End every running task whose owner stopped renewing its lease, naming the machine that went
        quiet. Returns the ended rows (id, owner). Until a run can be reattached (CUR-4434) a task
        whose machine died is gone, and saying so beats a stream that never ends."""
        now = time.time() if now is None else now
        rows = self._tasks.run(
            "SELECT id, owner FROM tasks WHERE state NOT IN (?,?,?) AND lease_until IS NOT NULL AND lease_until < ?",
            (*_TERMINAL, now), fetch="all",
        )
        for r in rows:
            reason = f"the agent machine running this task ({r['owner']}) stopped responding"
            self._tasks.run(
                "UPDATE tasks SET state='FAILED', error=?, summary='failed: agent machine lost', updated_at=? "
                "WHERE id=? AND state NOT IN (?,?,?) AND lease_until < ?",
                (reason, now, r["id"], *_TERMINAL, now),
            )
        return rows

    def request_cancel(self, task_id: str) -> int:
        """A cancel asked on a machine that does not run the task; its owner picks it up (`cancels_for`)."""
        return self._tasks.run(
            "UPDATE tasks SET cancel_requested=1 WHERE id=? AND state NOT IN (?,?,?)", (task_id, *_TERMINAL)
        )

    def cancels_for(self, task_ids: list[str]) -> list[str]:
        """Which of the owner's running tasks another machine asked to cancel."""
        if not task_ids:
            return []
        marks = ",".join("?" * len(task_ids))
        rows = self._tasks.run(
            f"SELECT id FROM tasks WHERE cancel_requested=1 AND id IN ({marks})",  # noqa: S608 — marks are "?"
            tuple(task_ids), fetch="all",
        )
        return [r["id"] for r in rows]

    def append_events(self, rows: list[tuple[str, int, str, dict]]) -> None:
        """(task_id, seq, type, data) rows, in any order; a seq already stored is kept, not overwritten."""
        if not rows:
            return
        sql = "INSERT INTO task_events (task_id, seq, type, data) VALUES (?,?,?,?)"
        if not self.shared:
            sql = sql.replace("INSERT", "INSERT OR IGNORE", 1)
        self._tasks.many(sql, [(t, seq, typ, json.dumps(data)) for t, seq, typ, data in rows])

    def events_since(self, task_id: str, after_seq: int, limit: int = 500) -> list[tuple[int, str, dict]]:
        rows = self._tasks.run(
            "SELECT seq, type, data FROM task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?",
            (task_id, after_seq, limit), fetch="all",
        )
        return [(int(r["seq"]), r["type"], json.loads(r["data"])) for r in rows]

    def user_tokens_since(self, user: str, since_ts: float) -> int:
        row = self._tasks.run(
            'SELECT COALESCE(SUM(tokens),0) AS t FROM tasks WHERE "user"=? AND created_at>=?',
            (user, since_ts), fetch="one",
        )
        return int(row["t"])

    def user_tasks_since(self, user: str, since_ts: float) -> int:
        row = self._tasks.run(
            'SELECT COUNT(*) AS c FROM tasks WHERE "user"=? AND created_at>=?', (user, since_ts), fetch="one",
        )
        return int(row["c"])

    # A CALLER is the authenticated token subject; a PRINCIPAL is `caller` or `caller/<subject>`, where the
    # subject is self-asserted (X-Agent-Subject) so a visitor can be attributed without user accounts. The
    # two queries above ration one principal. These two ration a caller across every subject it has ever
    # named, which is the bound a self-asserted subject must not be able to get out from under: without it,
    # rotating the header mints a fresh bucket on demand and the ceiling stops existing.
    #
    # Prefix-matched with substr rather than LIKE. A caller id containing `%` or `_` — neither is excluded,
    # since the token subject is whatever the issuer put there — silently over-matches under LIKE, counting
    # OTHER callers' rows into this one's ceiling. That direction is a spurious 429 for an innocent caller
    # and it would be near-impossible to read off the logs.
    def caller_tasks_since(self, caller: str, since_ts: float) -> int:
        p = caller + "/"
        row = self._tasks.run(
            'SELECT COUNT(*) AS c FROM tasks WHERE ("user"=? OR substr("user",1,?)=?) AND created_at>=?',
            (caller, len(p), p, since_ts), fetch="one",
        )
        return int(row["c"])

    def caller_tokens_since(self, caller: str, since_ts: float) -> int:
        p = caller + "/"
        row = self._tasks.run(
            "SELECT COALESCE(SUM(tokens),0) AS t FROM tasks "
            'WHERE ("user"=? OR substr("user",1,?)=?) AND created_at>=?',
            (caller, len(p), p, since_ts), fetch="one",
        )
        return int(row["t"])

    def caller_history(self, caller: str) -> dict:
        """A caller's whole-lifetime footprint (CUR-470's accrual signal), not a windowed count like
        the two methods above — `first_seen` is `None` for a caller with no rows at all. Same
        prefix-match idiom as `caller_tasks_since`, same reason."""
        p = caller + "/"
        row = self._tasks.run(
            "SELECT MIN(created_at) AS first_seen, COUNT(*) AS c FROM tasks "
            'WHERE ("user"=? OR substr("user",1,?)=?)',
            (caller, len(p), p), fetch="one",
        )
        return {"first_seen": row["first_seen"], "task_count": int(row["c"])}

    def migrate_caller(self, caller: str, old_subject: str, new_subject: str) -> dict:
        """Re-key one caller's task rows from an old X-Agent-Subject onto a new one (CUR-761): the
        anonymous session a visitor accrued CUR-470 trust under and the account they then sign into
        are different subjects, so without this, signing in silently resets `caller_history` to zero
        instead of carrying the accrual forward — authentication should only ever raise a caller's
        trust ceiling, never zero it. A straight re-key, not a merge: `caller_history` is a live
        aggregate over this table (MIN(created_at)/COUNT(*)), so once the old rows carry the new
        subject they fold in automatically alongside whatever the new subject already had, and a
        returning signed-in user's own prior history is untouched. Idempotent — once migrated, no row
        matches `old_subject` any more, so a repeat call (a retried request, a double sign-in event)
        touches zero rows, mirroring migrateAnonymousConversations' contract on the chat side.
        Scoped to `caller` (the endpoint's own authenticated identity), never a value the request body
        supplies, so one caller cannot re-key another's rows.
        NOTE: does not touch `session_workdirs` — a live mid-conversation session's workdir mapping is
        keyed on the OLD principal and is not migrated here; out of scope here (CUR-761 is
        about trust-tier accrual, not session continuity across sign-in, and `session_workdirs`' PK is
        (user, session_id), so a blind re-key risks colliding with a row the new principal already
        owns)."""
        if not old_subject or not new_subject or old_subject == new_subject:
            return {"migrated": 0}
        old_principal = f"{caller}/{old_subject}"
        new_principal = f"{caller}/{new_subject}"
        n = self._tasks.run('UPDATE tasks SET "user"=? WHERE "user"=?', (new_principal, old_principal))
        return {"migrated": n}

    def delete_for_user(self, caller: str, subject: str) -> dict:
        """Delete every task row and session_workdirs row for ONE (caller, subject) principal — the
        account-deletion counterpart to migrate_caller's re-key (CUR-1722). Exact-principal match,
        not the caller-wide prefix match caller_tasks_since/caller_history use for rationing: this
        deletes one person's history, not every subject a caller has ever asserted.

        Returns the deleted session_workdirs paths too — this method does no filesystem I/O, the
        same contract prune_idle_sessions already uses; the caller rmtrees them.

        Does NOT touch verify_corpus: those rows are keyed by task_id, not by user, and are a
        deliberately separate training dataset with its own age-based retention (prune_corpus,
        CUR-654). Whether a per-user delete should reach it is an open question (CUR-1722)."""
        principal = f"{caller}/{subject}" if subject else caller
        with self._lock:
            workdir_rows = self._db.execute(
                "SELECT session_id, workdir FROM session_workdirs WHERE user=?", (principal,)
            ).fetchall()
            self._db.execute("DELETE FROM session_workdirs WHERE user=?", (principal,))
            self._db.commit()
        self._tasks.run('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE "user"=?)', (principal,))
        n = self._tasks.run('DELETE FROM tasks WHERE "user"=?', (principal,))
        return {
            "tasks_deleted": n,
            "workdirs": [(r["session_id"], r["workdir"]) for r in workdir_rows],
        }

    def delete_sessions(self, principal: str, session_ids: list[str]) -> list[str]:
        """Delete the named sessions' workdir rows for ONE principal and return their paths, for a deleted
        conversation (CUR-4484). The task rows stay: they are the account's history, which `delete_for_user`
        removes with the account. No filesystem I/O, as `prune_idle_sessions`; the caller rmtrees."""
        if not session_ids:
            return []
        marks = ",".join("?" * len(session_ids))
        with self._lock:
            rows = self._db.execute(
                f"SELECT workdir FROM session_workdirs WHERE user=? AND session_id IN ({marks})",  # noqa: S608
                (principal, *session_ids)).fetchall()
            self._db.execute(f"DELETE FROM session_workdirs WHERE user=? AND session_id IN ({marks})",  # noqa: S608
                             (principal, *session_ids))
            self._db.commit()
        return [r["workdir"] for r in rows]

    def count(self) -> int:
        return int(self._tasks.run("SELECT COUNT(*) AS c FROM tasks", fetch="one")["c"])

    def log_corpus(self, task_id: str, tier: str, kind: str, prompt: str,
                   code: str, output: str, detail: str) -> None:
        """One Tier 1/2 catch, for the CUR-654 corpus. Caller's job to keep `code`/`output` bounded —
        this method does no truncation of its own, so a caller that starts passing raw multi-MB scratch
        dumps would grow this table unbounded; see api/app.py's _corpus_snapshot_text for the cap in
        force today."""
        with self._lock:
            self._db.execute(
                "INSERT INTO verify_corpus (task_id,created_at,tier,kind,prompt,code,output,detail) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (task_id, time.time(), tier, kind, prompt, code, output, detail),
            )
            self._db.commit()

    def corpus_count(self) -> int:
        with self._lock:
            return int(self._db.execute("SELECT COUNT(*) AS c FROM verify_corpus").fetchone()["c"])

    def prune_corpus(self, older_than_secs: float) -> int:
        """Delete verify_corpus rows older than the cutoff. Unlike `prune` (terminal tasks only —
        RUNNING/WORKING rows are never touched), every row here is already a completed observation the
        moment it's written, so age alone decides. Tier 1 (expect_sorted_by/expect_columns rejections)
        logs on every real caller, independent of AGENT_VALUE_CONSISTENCY_CHECK — this table grows from
        live production traffic whether or not that flag is raised (CUR-596), so it needs its own retention
        rather than inheriting Tier 2's dark-by-default framing. Returns # deleted."""
        cutoff = time.time() - older_than_secs
        with self._lock:
            cur = self._db.execute("DELETE FROM verify_corpus WHERE created_at < ?", (cutoff,))
            self._db.commit()
            return cur.rowcount

    def close(self) -> None:
        with self._lock:
            self._db.close()
        if isinstance(self._tasks, _PgTasks):
            self._tasks.close()
