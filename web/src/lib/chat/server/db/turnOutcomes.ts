/**
 * Per-turn terminal outcomes — the numerator+denominator for the turn-outcome RATE alert (CUR-89).
 *
 * One row per terminal turn, written best-effort from the `[turn] outcome` site. It exists because no
 * existing table answers "what fraction of real turns did not produce an answer": generations.status
 * collapses to complete|error and marks an interrupted/empty turn `complete` (generations.ts:55) —
 * exactly the failure the rate alert has to catch. The `[turn] outcome` log line has the right
 * taxonomy but lives in Axiom, which the warm cron cannot read.
 *
 * Stores ONLY the outcome label + decline kind + time to first token + a timestamp — never any user text.
 */
import { and, count, desc, eq, gt, gte, inArray, isNotNull, lt, max } from "drizzle-orm";
import { logger } from "$lib/chat/server/logger";
import { getDb } from "./client";
import { newId } from "./ids";
import { turnOutcomes } from "./schema";

/** Persist one turn outcome. Best-effort by design: the caller runs it through runInBackground, which
 *  keeps the Vercel function alive until the write lands. This fires at turn FINALIZATION, so a bare
 *  fire-and-forget could be frozen out before the Neon round-trip completes and silently undercount the
 *  rate's denominator.
 *
 *  IT LOGS ITS OWN FAILURE, and that is the point rather than tidiness. runInBackground does
 *  `work.catch(() => {})` (vercelBackground.ts:34), so a rejection from here reaches nothing — no log,
 *  no probe, no trace. That matters because of what consumes these rows: warmTurnOutcomeRate refuses to
 *  record a healthy zero when the READ fails, but a broken WRITER does not fail the read. It produces a
 *  successful count of an undercounted table, which is indistinguishable from quiet traffic. At low
 *  traffic against a 6h window and TURN_OUTCOME_MIN_SAMPLE of 15, losing even a fraction of
 *  writes pins the probe below its floor permanently — it then never evaluates and never alerts, which
 *  is the always-green trap that probe was written to close, reintroduced one layer down.
 *
 *  Still never rethrows: a failed metrics write must not affect a turn that already answered. */
export async function recordTurnOutcome(
	outcome: string,
	declineKind: string | null,
	ttftMs: number | null = null
): Promise<void> {
	try {
		await getDb()
			.insert(turnOutcomes)
			.values({ id: newId(), outcome, declineKind, ttftMs: ttftMs === null ? null : Math.round(ttftMs) });
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e), outcome },
			"[turn-outcome] write failed — the rate probe's denominator is undercounted"
		);
	}
}

/** Count terminal turns by outcome over the last `windowMs`. The alerting probe's distribution. */
export async function countTurnOutcomes(windowMs: number): Promise<Record<string, number>> {
	const since = new Date(Date.now() - windowMs);
	const rows = await getDb()
		.select({ outcome: turnOutcomes.outcome, n: count() })
		.from(turnOutcomes)
		.where(gte(turnOutcomes.createdAt, since))
		.groupBy(turnOutcomes.outcome);
	return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
}

/** Time to first token of the newest `limit` completed turns in the last `windowMs`, newest first, for the
 *  first-token median probe (CUR-2243). Turns written before the column existed carry no time and are
 *  left out rather than counted as fast. */
export async function recentCompleteTtfts(windowMs: number, limit: number): Promise<number[]> {
	const since = new Date(Date.now() - windowMs);
	const rows = await getDb()
		.select({ ttftMs: turnOutcomes.ttftMs })
		.from(turnOutcomes)
		.where(
			and(gte(turnOutcomes.createdAt, since), eq(turnOutcomes.outcome, "complete"), isNotNull(turnOutcomes.ttftMs))
		)
		.orderBy(desc(turnOutcomes.createdAt))
		.limit(limit);
	return rows.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]));
}

/** The evidence a firing rate alert needs to clear (CUR-2242): when the newest failed turn in the window
 *  happened, and how many turns completed after it. Two small aggregates rather than the rows, because
 *  the window can hold thousands of rows. `newestFailureAt` is null when the window
 *  holds no failure at all. */
export async function turnOutcomeRecovery(
	windowMs: number,
	failureOutcomes: readonly string[]
): Promise<{ newestFailureAt: Date | null; completesSinceFailure: number }> {
	const since = new Date(Date.now() - windowMs);
	const db = getDb();
	const [newest] = await db
		.select({ at: max(turnOutcomes.createdAt) })
		.from(turnOutcomes)
		.where(and(gte(turnOutcomes.createdAt, since), inArray(turnOutcomes.outcome, [...failureOutcomes])));
	const newestFailureAt = newest?.at ?? null;
	if (!newestFailureAt) return { newestFailureAt: null, completesSinceFailure: 0 };
	const [after] = await db
		.select({ n: count() })
		.from(turnOutcomes)
		.where(and(gt(turnOutcomes.createdAt, newestFailureAt), eq(turnOutcomes.outcome, "complete")));
	return { newestFailureAt, completesSinceFailure: after?.n ?? 0 };
}

/** Delete rows older than `retentionMs` so this alerting table never becomes the conversations-table
 *  problem (load-test rows that look like data loss when they age out). Best-effort. */
export async function pruneTurnOutcomes(retentionMs: number): Promise<number> {
	const cutoff = new Date(Date.now() - retentionMs);
	const deleted = await getDb().delete(turnOutcomes).where(lt(turnOutcomes.createdAt, cutoff)).returning({
		id: turnOutcomes.id,
	});
	return deleted.length;
}
