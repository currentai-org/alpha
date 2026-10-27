// A lock across every instance that shares this database, for work whose state lives
// somewhere with no compare-and-set of its own (an owner's first key in the custodial bucket). (CUR-4116)
import { sql } from "drizzle-orm";
import { getDb, withTransaction } from "./client";

/**
 * Run `fn` holding a transaction-scoped Postgres advisory lock on `name`; a second caller with the
 * same name waits until the first commits. The lock is released with the transaction, so a crashed
 * instance cannot hold it.
 *
 * The transaction holds one of this instance's pool connections (`PG_POOL_MAX`, 1 when unset) for as
 * long as `fn` runs. Keep it to a few network calls, and never call it from inside another transaction's work.
 */
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	return withTransaction(async () => {
		await getDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
		return fn();
	});
}
