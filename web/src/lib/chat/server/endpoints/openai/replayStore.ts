// Where a model replay recording lives, so one run's recording is the next run's hit (SOL-148).
//
// Scoped the way the GitHub Actions cache is: a run reads its own branch's recordings, then develop's,
// then the cassettes committed with the build, and writes only to its own branch. A PR run then
// falls back to the newest ok recording any other branch made of the same request (SOL-180): the key
// is the whole request, so that answer is as good as a live one, and many PR misses are keys another branch has
// recorded. Develop reads only its own. Another branch's recording is read only when it went to the same upstream host and its answer
// finished (modelReplay.ts records nothing else), so it is the answer this branch's request would get.
// All scopes share a dedicated Neon database, `REPLAY_DATABASE_URL`, set on preview only. A PR
// preview's own database is deleted with the PR, taking its recordings with it, so a store there
// almost never hits. Develop's database is kept out of it, so a PR run neither waits on
// develop nor writes into its live data.
//
// A store that is unset or unreachable throws, and modelReplay.ts reads that as a miss: live in
// `new_episodes` mode, a failed turn in `none` mode. So does a call past its deadline (SOL-209): a
// lookup's median is 8 ms, but one stalled connection holds every lookup on its instance, for longer
// than any turn lives. A call past its deadline drops the client, so the next opens a
// fresh connection. An entry nobody has read for PRUNE_AFTER_MS is deleted.

import postgres from "postgres";
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import type { Cassette } from "./modelReplay";

const PRUNE_AFTER_DAYS = 14;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
/** Well past a healthy lookup (p99 under 60 ms) and well inside a turn's 8 s hedge. */
const LOOKUP_DEADLINE_MS = 3_000;
/** A record runs after the answer has gone to the visitor, so it can wait longer. */
const RECORD_DEADLINE_MS = 15_000;

/** This deployment's scope: the branch it was built from. A local dev server is `local`. */
export function replayScope(env: NodeJS.ProcessEnv = process.env): string {
	return env.VERCEL_GIT_COMMIT_REF || "local";
}

/** The scopes a run reads, in order: its own, then develop's. */
export function readScopes(scope: string): string[] {
	return scope === "develop" ? ["develop"] : [scope, "develop"];
}

let _sql: postgres.Sql | null = null;
let _ready: Promise<unknown> | null = null;

/** The store's client, with its table created on first use. Throws when the store is not configured. */
async function store(): Promise<postgres.Sql> {
	if (!_sql) {
		const url = config.REPLAY_DATABASE_URL;
		if (!url) throw new Error("REPLAY_DATABASE_URL is not set");
		// A few connections per function instance, behind Neon's pooler, since one instance serves many
		// turns at once. The connect timeout covers waking a suspended compute.
		_sql = postgres(url, { max: 4, prepare: false, connect_timeout: 10, idle_timeout: 60 });
	}
	const sql = _sql;
	_ready ??= sql`
		create table if not exists model_replay (
			scope text not null,
			hash text not null,
			doc jsonb not null,
			recorded_at timestamptz not null default now(),
			last_hit_at timestamptz not null default now(),
			primary key (scope, hash)
		)`.then(() => sql`create index if not exists model_replay_last_hit_at on model_replay (last_hit_at)`)
		.then(() => sql`create index if not exists model_replay_hash on model_replay (hash)`);
	try {
		await _ready;
	} catch (err) {
		_ready = null;
		throw err;
	}
	return sql;
}

/** A recorded 429 is read only until its `refusedUntil`; after that its request misses again. (CUR-3982) */
function expired(doc: Cassette, now: number): boolean {
	return doc.refusedUntil !== undefined && Date.parse(doc.refusedUntil) <= now;
}

class StoreDeadline extends Error {}

/** Ends the client without waiting on it, so a stalled connection is not reused. */
function dropClient(): void {
	const old = _sql;
	_sql = null;
	_ready = null;
	void old?.end({ timeout: 0 }).catch(() => {});
}

/** Runs `call`, or throws after `ms` and drops the client the call was stuck on. */
async function bounded<T>(ms: number, what: string, call: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new StoreDeadline(`replay store ${what} passed its ${ms} ms deadline`)), ms);
	});
	try {
		return await Promise.race([call(), deadline]);
	} catch (err) {
		if (err instanceof StoreDeadline) dropClient();
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The recording for `hash`: the first of this run's read scopes, in their order, and failing those, the
 * newest ok recording any other scope made against the same upstream `host`, or else the newest
 * unexpired 429 from that host (CUR-3982), since the host's limit is shared. Every unexpired 429 ranks
 * below every good recording, whatever scope each sits in (CUR-3996). Develop reads other scopes too
 * since SOL-208: its run mocks a miss instead of recording, so the recording a PR made for a changed
 * prompt is the only one develop will have. Null when none has one.
 */
export async function lookup(
	hash: string,
	scope = replayScope(),
	host?: string,
	now = Date.now(),
	deadlineMs = LOOKUP_DEADLINE_MS
): Promise<{ cassette: Cassette; scope: string } | null> {
	return bounded(deadlineMs, "lookup", () => lookupNow(hash, scope, host, now));
}

async function lookupNow(
	hash: string,
	scope: string,
	host: string | undefined,
	now: number
): Promise<{ cassette: Cassette; scope: string } | null> {
	const scopes = readScopes(scope);
	const sql = await store();
	const rows = (
		await sql<{ scope: string; doc: Cassette }[]>`
		select scope, doc from model_replay where hash = ${hash} order by recorded_at desc`
	).filter((r) => !expired(r.doc, now));
	// A good recording anywhere this run may read beats a refusal, even one in an earlier read scope:
	// the refusal says the limit was spent, the answer says what the model said.
	const foreign = !!host;
	const pick = (pool: typeof rows) =>
		scopes.map((s) => pool.find((r) => r.scope === s)).find(Boolean) ??
		(foreign ? pool.find((r) => r.doc.host === host && r.doc.status >= 200 && r.doc.status < 300) : undefined);
	const refusals = rows.filter((r) => r.doc.refusedUntil !== undefined);
	const row =
		pick(rows.filter((r) => r.doc.refusedUntil === undefined)) ??
		scopes.map((s) => refusals.find((r) => r.scope === s)).find(Boolean) ??
		(foreign ? refusals.find((r) => r.doc.host === host && r.doc.status === 429) : undefined);
	if (!row) return null;
	void sql`update model_replay set last_hit_at = now() where scope = ${row.scope} and hash = ${hash}`.catch((err: unknown) =>
		logger.warn({ hash, err: String(err) }, "[replay] could not stamp last_hit_at")
	);
	return { cassette: row.doc, scope: row.scope };
}

let lastPrunedAt = 0;

/** Records `cassette` under `scope`, and at most hourly per instance prunes entries unread for 14 days. */
export async function record(
	cassette: Cassette,
	scope = replayScope(),
	now = Date.now(),
	deadlineMs = RECORD_DEADLINE_MS
): Promise<void> {
	return bounded(deadlineMs, "record", () => recordNow(cassette, scope, now));
}

async function recordNow(cassette: Cassette, scope: string, now: number): Promise<void> {
	const sql = await store();
	await sql`
		insert into model_replay (scope, hash, doc) values (${scope}, ${cassette.requestHash}, ${sql.json(cassette)})
		on conflict (scope, hash) do update set doc = excluded.doc, last_hit_at = now()`;
	if (now - lastPrunedAt < PRUNE_EVERY_MS) return;
	lastPrunedAt = now;
	await sql`delete from model_replay where last_hit_at < now() - make_interval(days => ${PRUNE_AFTER_DAYS})`.catch(
		(err: unknown) => logger.warn({ err: String(err) }, "[replay] prune failed")
	);
}
