/**
 * Per-turn terminal outcomes — the numerator+denominator for the turn-outcome RATE alert.
 *
 * One row per terminal turn, written best-effort from the `[turn] outcome` site. It exists because no
 * existing table answers "what fraction of real turns did not produce an answer": generations.status
 * collapses to complete|error and marks an interrupted/empty turn `complete` (generations.ts:55) —
 * exactly the failure the rate alert has to catch. The `[turn] outcome` log line has the right
 * taxonomy but lives in Axiom, which the warm cron cannot read.
 *
 * Stores ONLY the outcome label, decline kind, time to first token, failure layer, served model id and a
 * timestamp — never any user text.
 */
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { logger } from "$lib/chat/server/logger";
import { getDb } from "./client";
import { newId } from "./ids";
import { turnOutcomes } from "./schema";
import type { FailureLayer } from "$lib/chat/utils/failureLayer";
import type { OutcomeAgg } from "../turnBurnRate";

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
	ttftMs: number | null = null,
	attribution: { failureLayer: FailureLayer | null; model: string | null } = { failureLayer: null, model: null }
): Promise<void> {
	try {
		await getDb()
			.insert(turnOutcomes)
			.values({
				id: newId(),
				outcome,
				declineKind,
				ttftMs: ttftMs === null ? null : Math.round(ttftMs),
				failureLayer: attribution.failureLayer,
				model: attribution.model,
			});
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e), outcome },
			"[turn-outcome] write failed — the rate probe's denominator is undercounted"
		);
	}
}

/** Turns over the last 6 hours by outcome, failure layer and model, counted in each burn-rate window
 *  (turnBurnRate.ts). One indexed scan of the 6h range; the windows are FILTER clauses on it. */
export async function countTurnOutcomeWindows(): Promise<OutcomeAgg[]> {
	const t = turnOutcomes.createdAt;
	const n = (minutes: number) =>
		sql<number>`count(*) filter (where ${t} >= now() - make_interval(mins => ${minutes}))`.mapWith(Number);
	const rows = await getDb()
		.select({
			outcome: turnOutcomes.outcome,
			failureLayer: turnOutcomes.failureLayer,
			model: turnOutcomes.model,
			n5m: n(5),
			n30m: n(30),
			n1h: n(60),
			n6h: n(360),
		})
		.from(turnOutcomes)
		.where(sql`${t} >= now() - interval '6 hours'`)
		.groupBy(turnOutcomes.outcome, turnOutcomes.failureLayer, turnOutcomes.model);
	return rows.map((r) => ({
		outcome: r.outcome,
		failureLayer: r.failureLayer,
		model: r.model,
		counts: { "5m": r.n5m, "30m": r.n30m, "1h": r.n1h, "6h": r.n6h },
	}));
}

/** Time to first token of the newest `limit` completed turns in the last `windowMs`, newest first, for the
 *  first-token median probe. Turns written before the column existed carry no time and are
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

/** Delete rows older than `retentionMs` so this alerting table never grows without bound. Best-effort. */
export async function pruneTurnOutcomes(retentionMs: number): Promise<number> {
	const cutoff = new Date(Date.now() - retentionMs);
	const deleted = await getDb().delete(turnOutcomes).where(lt(turnOutcomes.createdAt, cutoff)).returning({
		id: turnOutcomes.id,
	});
	return deleted.length;
}
