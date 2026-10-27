/**
 * Lazy Drizzle client over postgres.js. Lazy so import-time has no side effects
 * (serverless-friendly: no eager connect at module load).
 *
 * postgres.js works for both local Postgres and Neon. On Neon serverless use a pooled
 * connection string (…-pooler.neon.tech) or @neondatabase/serverless; the API is the same.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;
let _sql: ReturnType<typeof postgres> | undefined;

/**
 * Positive integer from env, or `fallback` when the value is blank / invalid / ≤0.
 * Blank CI scaffold keys (`PG_POOL_MAX=`) must not become `Number("") === 0` — that
 * creates a zero-sized pool and every query hangs until Vitest's 30s timeout.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function databaseUrl(): string {
	// DATABASE_URL is canonical. On Vercel the Neon integration provisions POSTGRES_URL
	// (the pooled endpoint, correct for serverless with prepare:false below), so fall back
	// to it — lets the app reuse the integration's variable without copying the secret into
	// a second name.
	const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
	if (!url) throw new Error(
			"DATABASE_URL (or POSTGRES_URL) is not set. In a worktree, run scripts/local/worktree-setup.sh; for tests, `docker start aipotluck-dev-pg`."
		);
	return url;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

// The transaction `withTransaction` opened, if this call runs inside one. Every query in
// that scope has to go through it. A query that asked the pool instead would run outside the
// transaction, and with `PG_POOL_MAX` at 1 (its default when unset) it would wait forever on the
// connection the transaction itself is holding. (CUR-769)
const txScope = new AsyncLocalStorage<Db>();

export function getDb(): Db {
	const tx = txScope.getStore();
	if (tx) return tx;
	if (!_db) {
		_sql = postgres(databaseUrl(), {
			// Serverless: keep the pool small; one connection per function instance.
			max: parsePositiveInt(process.env.PG_POOL_MAX, 1),
			prepare: false,
			// Cold starts hit the Neon pooler before it's warm; the default connect timeout
			// can trip (write CONNECT_TIMEOUT …-pooler.neon.tech) on the first query of a
			// fresh function. Give the handshake real runway, and reap idle sockets so a frozen
			// serverless instance doesn't hold a pooler slot forever.
			connect_timeout: parsePositiveInt(process.env.PG_CONNECT_TIMEOUT, 30),
			// Idle reap must OUTLIVE the warm cron cadence (vercel.json pings /chat/api/warm every
			// 60s) or the warm can't work: the default 20s would reap the socket between crons, so
			// every between-cron first query paid the full pooler connect on its critical path
			// anyway. 150s keeps one connection per live instance alive across cron ticks at the
			// cost of holding a pooler slot ~2.5min into idleness.
			// ⚠️ COUPLED to that cron interval and enforced nowhere — lowering this below ~2× the
			// cron interval silently breaks the warm (no test fails; the db leg just starts paying
			// the pooler connect). See the matching note above warmDb in warm.ts. Note parsePositiveInt
			// means a blank/invalid value silently falls back to 150 rather than erroring — safe, but a
			// typo'd override will look applied and not be.
			idle_timeout: parsePositiveInt(process.env.PG_IDLE_TIMEOUT, 150),
		});
		_db = drizzle(_sql, { schema });
	}
	return _db;
}

/**
 * Run `fn` in one database transaction. Every collection write inside it (database.ts's adapter
 * reads `getDb()` per call) lands or rolls back together, and no other request sees any of it
 * until it commits. Nested calls join the outer transaction.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
	if (txScope.getStore()) return fn();
	// Drizzle's transaction handle carries the same query API as the database, minus
	// `$client`/batch helpers the adapter never touches.
	return getDb().transaction((tx) => txScope.run(tx as unknown as Db, fn));
}

export async function closeDb() {
	await _sql?.end({ timeout: 5 });
	_sql = undefined;
	_db = undefined;
}

/**
 * Fire a non-blocking `select 1` to warm the lazy postgres.js pool at COLD BOOT, so the first real
 * query of a fresh instance doesn't pay the Neon pooler connect on its critical path (the cold-instance
 * TTFT tax).
 *
 * Bundler-neutral: NO `$app/*` import lives here, because `database.ts`/this module are imported
 * DIRECTLY by the plain-tsx verify scripts (scripts/verify-drizzle-slice.ts, verify-cleanup.ts) where
 * `$app/environment` does not resolve — the SvelteKit-only `!building` guard lives at the
 * hooks.server.ts call site instead. Inert unless CALLED, so a tsx script importing this
 * module is untouched.
 *
 * Fully non-throwing and invisible on failure: presence-checks the env DIRECTLY (never `databaseUrl()`,
 * which THROWS when unset — a no-DB dev/test/build env must stay silent), honors the `PG_PRECONNECT=off`
 * kill switch, and swallows any connect error (the first real query retries the connect exactly as today).
 */
export function preconnectDb(): void {
	if (process.env.PG_PRECONNECT === "off") return;
	// Presence-check ONLY — do NOT call databaseUrl() (it throws when unset). No URL ⇒ nothing to warm
	// (a no-DB test/build env); getDb() would throw on connect anyway.
	if (!(process.env.DATABASE_URL ?? process.env.POSTGRES_URL)) return;
	try {
		void getDb()
			.execute(sql`select 1`)
			.catch(() => {});
	} catch {
		// getDb()/execute threw synchronously (e.g. a malformed URL) — invisible; the first real query
		// retries. A preconnect failure must never escape.
	}
}

export { schema };
