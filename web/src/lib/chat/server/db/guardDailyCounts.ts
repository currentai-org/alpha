/**
 * Daily counts of log-action guard hits (CUR-3915). Today the only log-action rules are the self-harm
 * distress rules, so this is how often distress came up, and never who or when within the day. See
 * `guardDailyCounts` in schema.ts for why it is a count and not a log line.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./client";
import { guardDailyCounts } from "./schema";

/** How long a distress answer may wait on its count. */
const COUNT_TIMEOUT_MS = 300;

/**
 * Add one to the UTC day's count for each rule key. Never rejects, so a failed count never fails the turn.
 * A failure is not logged: that line would exist only because a distress hit happened, and the Vercel
 * drain would tie it to the request, which is the per-hit record this table exists to avoid. A database failure
 * still shows, through every other write the same turn makes.
 */
export async function countGuardHitsSafe(
	ruleKeys: readonly string[],
	now = new Date(),
	timeoutMs = COUNT_TIMEOUT_MS
): Promise<void> {
	if (ruleKeys.length === 0) return;
	const day = now.toISOString().slice(0, 10);
	const write = getDb()
		.insert(guardDailyCounts)
		.values([...new Set(ruleKeys)].map((ruleKey) => ({ day, ruleKey, count: 1 })))
		.onConflictDoUpdate({
			target: [guardDailyCounts.day, guardDailyCounts.ruleKey],
			set: { count: sql`${guardDailyCounts.count} + 1` },
		})
		.then(() => undefined);
	// The caller awaits this before the distress answer goes out, so a slow database waits at most this
	// long; a write still in flight then finishes or fails on its own.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([write, deadline]);
	} catch {
		// Deliberately silent; see above.
	} finally {
		clearTimeout(timer);
		write.catch(() => {});
	}
}

