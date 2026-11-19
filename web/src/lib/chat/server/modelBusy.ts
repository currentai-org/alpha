// A circuit breaker on models that answer nobody. A turn or a probe that ends on a
// 429, a gateway timeout, a 404 or other 5xx, or a last lane that sends no first chunk before
// its deadline counts as one failure. Two in a row from turns mark the model busy, and one failed probe
// does on its own: the probe's request is fixed and tiny and already retried once on the same lane, so
// its failure is not a blip, and waiting for more would leave the model in Auto for more probe
// intervals. Auto skips a busy model while anything else can answer, and the picker shows it as
// unavailable right now; a hand pick still sends to it. Only answers clear the mark: CLEAR_AFTER first
// chunks in a row from the model, on real turns or the warm cron's probe (modelProbe.ts), with no
// failure between them. One answer used to clear it, and a lane answering every other call
// flipped in and out of Auto every few minutes. A model that recovers is back in Auto within a few
// probes, with no deploy or flag.
//
// One column carries both directions. Below BUSY_AFTER, `consecutive_failures` counts failures and an
// answer zeroes it. The failure that marks a model busy lifts the count to BUSY_HOLD, each answer takes
// one off, and any failure puts it back at BUSY_HOLD, so the count falls below BUSY_AFTER only after
// CLEAR_AFTER answers in a row.
//
// The count does not decay with time. A window that restarts after ten quiet minutes never
// collects three failures at a low turn rate, so a model refusing every call would never be marked. The mark itself is trusted only while its evidence is recent (BUSY_MARK_STALE_MS):
// the probe refreshes it every few minutes while the model keeps failing. A mark lapses only when
// nothing has looked at the model for that long, which means the cron stopped.
//
// State lives in `alert_state` under `busy:<gateway id>`, the table and upsert shape alerting.ts uses
// for rate-limit trips. Nothing here pages anyone. Every write is best-effort and never awaited by a
// turn: a lost write costs one wrong pick, never a turn.
//
// A `scope` keeps a spec's marks apart from everyone's. The fault-injected probe and the chat shell
// both take one only behind the fault-inject gate (faultInjection.ts `resolveBusyScope`), and a scoped
// key (`busy@<scope>:<id>`) never matches the unscoped `busy:%` read, so no visitor sees it.

import { and, eq, gt, gte, like, lt, sql } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { alertState } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";

/** Failures in a row, with no answer between them, before the model counts as busy.
 *
 *  Two. Runs of failed turns arrive in back-to-back pairs about a minute apart, usually a
 *  visitor's Retry. The warm probe answers every PROBE_EVERY_MINUTES and an answer resets the count,
 *  so at three no turn run would ever mark a model; at two each pair does. A wrong mark costs Auto that model only until the next
 *  probe answers, at most a few minutes.
 *  @internal exported for its unit tests */
export const BUSY_AFTER = 2;
/** Answers in a row, with no failure between them, before a busy model is back in Auto.
 *  @internal exported for its unit tests */
export const CLEAR_AFTER = 3;
/** The count a busy model holds: CLEAR_AFTER answers take it just below BUSY_AFTER.
 *  @internal exported for its unit tests */
export const BUSY_HOLD = BUSY_AFTER + CLEAR_AFTER - 1;
/** How long a busy mark is trusted after its last failure. The probe refreshes a failing model's mark
 *  every few minutes, so this only lapses a mark nothing has re-checked, never a live one.
 *  @internal exported for its unit tests */
export const BUSY_MARK_STALE_MS = 30 * 60 * 1000;
/** How long a spec's scoped rows are kept before the next scoped write prunes them. */
const SCOPED_ROW_TTL_MS = 60 * 60 * 1000;

/** @internal exported for its unit tests */
export function busyKeyPrefix(scope?: string): string {
	return scope ? `busy@${scope}:` : "busy:";
}

/** @internal exported for its unit tests */
export interface BusyRow {
	consecutiveFailures: number;
	updatedAt: Date;
}

/** The row after one more failure. The count carries across any quiet gap; only answers lower it.
 *  A `decisive` failure (a probe's) marks the model busy at once. A failure that leaves the model busy
 *  sets the count to BUSY_HOLD, so it takes CLEAR_AFTER answers in a row from there to clear.
 *  @internal exported for its unit tests */
export function afterFailure(row: BusyRow | undefined, now: Date, decisive = false): BusyRow {
	const counted = (row?.consecutiveFailures ?? 0) + 1;
	const busy = decisive || counted >= BUSY_AFTER;
	return { consecutiveFailures: busy ? BUSY_HOLD : counted, updatedAt: now };
}

/** The count after one answer: one off a live busy mark's hold, or zero for a model short of busy or a
 *  mark that has already lapsed. Lowering a lapsed mark would restamp it and pull a model that just
 *  answered back out of Auto for another BUSY_MARK_STALE_MS.
 *  @internal exported for its unit tests */
export function afterAnswer(row: BusyRow, now: Date): number {
	return isBusy(row, now) ? row.consecutiveFailures - 1 : 0;
}

/** @internal exported for its unit tests */
export function isBusy(row: BusyRow | undefined, now: Date): boolean {
	return (
		!!row &&
		row.consecutiveFailures >= BUSY_AFTER &&
		now.getTime() - row.updatedAt.getTime() < BUSY_MARK_STALE_MS
	);
}

/** A turn or probe on `model` got no answer: every lane answered 429 or timed out, or the last one
 *  stayed silent past its deadline. Resolves to the row written, or null when the write failed. */
export async function noteFailed(
	model: string,
	scope?: string,
	{ decisive = false }: { decisive?: boolean } = {}
): Promise<BusyRow | null> {
	try {
		const db = getDb();
		const key = busyKeyPrefix(scope) + model;
		const [row] = await db.select().from(alertState).where(eq(alertState.key, key));
		const next = afterFailure(row, new Date(), decisive);
		await db
			.insert(alertState)
			.values({ key, firing: false, lastFiredAt: null, ...next })
			.onConflictDoUpdate({ target: alertState.key, set: next });
		if (next.consecutiveFailures >= BUSY_AFTER && (row?.consecutiveFailures ?? 0) < BUSY_AFTER) {
			logger.warn({ model, scope, failures: next.consecutiveFailures }, "[busy] model marked busy; Auto skips it");
		}
		if (scope) await pruneScopedRows();
		return next;
	} catch (e) {
		logger.warn({ model, err: e instanceof Error ? e.message : String(e) }, "[busy] noteFailed failed");
		return null;
	}
}

/** `model` produced a first chunk. One read, a no-op unless a count is running; a busy model moves one
 *  answer closer to clearing. The write is a compare-and-set on the row it read, so a failure recorded
 *  in between is never overwritten; a lost race drops this answer, which only delays the clear. */
export async function noteAnswered(model: string, scope?: string): Promise<void> {
	try {
		const db = getDb();
		const key = busyKeyPrefix(scope) + model;
		const [row] = await db
			.select()
			.from(alertState)
			.where(and(eq(alertState.key, key), gt(alertState.consecutiveFailures, 0)));
		if (!row) return;
		const now = new Date();
		const next = afterAnswer(row, now);
		const written = await db
			.update(alertState)
			.set({ consecutiveFailures: next, updatedAt: now })
			.where(
				and(
					eq(alertState.key, key),
					eq(alertState.consecutiveFailures, row.consecutiveFailures),
					sql`date_trunc('milliseconds', ${alertState.updatedAt}) = ${row.updatedAt.toISOString()}::timestamptz`
				)
			)
			.returning({ key: alertState.key });
		if (!written.length) return;
		if (row.consecutiveFailures >= BUSY_AFTER && next < BUSY_AFTER) {
			logger.info({ model, scope }, "[busy] model answered enough in a row; back in Auto");
		} else if (next >= BUSY_AFTER) {
			logger.info({ model, scope, answersToClear: next - BUSY_AFTER + 1 }, "[busy] model answered; still busy");
		}
	} catch (e) {
		logger.warn({ model, err: e instanceof Error ? e.message : String(e) }, "[busy] noteAnswered failed");
	}
}

/** Gateway ids marked busy right now. Empty on any read failure, so Auto falls back to its normal pick. */
export async function busyModels(now = new Date(), scope?: string): Promise<string[]> {
	const prefix = busyKeyPrefix(scope);
	try {
		const rows = await getDb()
			.select()
			.from(alertState)
			.where(
				and(
					like(alertState.key, `${prefix}%`),
					gte(alertState.consecutiveFailures, BUSY_AFTER),
					gte(alertState.updatedAt, new Date(now.getTime() - BUSY_MARK_STALE_MS))
				)
			);
		return rows.map((r) => r.key.slice(prefix.length));
	} catch (e) {
		logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[busy] busyModels failed");
		return [];
	}
}

/** Drops spec-scoped rows older than an hour, so preview runs do not accumulate them. */
async function pruneScopedRows(): Promise<void> {
	await getDb()
		.delete(alertState)
		.where(
			and(like(alertState.key, "busy@%"), lt(alertState.updatedAt, new Date(Date.now() - SCOPED_ROW_TTL_MS)))
		);
}
