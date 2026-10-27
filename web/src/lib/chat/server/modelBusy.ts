// A circuit breaker on models that answer nobody (CUR-4043, CUR-4042). A turn or a probe that ends on a
// 429, a gateway timeout, a 404 or other 5xx (CUR-4629), or a last lane that sends no first chunk before
// its deadline counts as one failure. Two in a row from turns mark the model busy, and one failed probe
// does on its own: the probe's request is fixed and tiny and already retried once on the same lane, so
// its failure is not a blip, and waiting for more would leave the model in Auto for more probe
// intervals. Auto skips a busy model while anything else can answer, and the picker shows it as
// unavailable right now; a hand pick still sends to it. Only an answer clears the mark: a first chunk
// from the model on a real turn or on the warm cron's probe (modelProbe.ts), so a model that recovers is
// back in Auto from its first answered probe, with no deploy or flag.
//
// The count does not decay with time (CUR-4042). A window that restarts after ten quiet minutes never
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

import { and, eq, gt, gte, like, lt } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { alertState } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";

/** Failures in a row, with no answer between them, before the model counts as busy.
 *
 *  Two (CUR-4629). Runs of failed turns arrive in back-to-back pairs about a minute apart, usually a
 *  visitor's Retry. The warm probe answers every PROBE_EVERY_MINUTES and an answer resets the count,
 *  so at three no turn run would ever mark a model; at two each pair does. A wrong mark costs Auto that model only until the next
 *  probe answers, at most a few minutes.
 *  @internal exported for its unit tests */
export const BUSY_AFTER = 2;
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

/** The row after one more failure. The count carries across any quiet gap; only an answer resets it.
 *  A `decisive` failure (a probe's) marks the model busy at once.
 *  @internal exported for its unit tests */
export function afterFailure(row: BusyRow | undefined, now: Date, decisive = false): BusyRow {
	const counted = (row?.consecutiveFailures ?? 0) + 1;
	return { consecutiveFailures: decisive ? Math.max(counted, BUSY_AFTER) : counted, updatedAt: now };
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

/** `model` produced a first chunk, so it is answering again. One conditional update, a no-op unless a count was running. */
export async function noteAnswered(model: string, scope?: string): Promise<void> {
	try {
		const cleared = await getDb()
			.update(alertState)
			.set({ consecutiveFailures: 0, updatedAt: new Date() })
			.where(and(eq(alertState.key, busyKeyPrefix(scope) + model), gt(alertState.consecutiveFailures, 0)))
			.returning({ failures: alertState.consecutiveFailures });
		if (cleared.length) logger.info({ model, scope }, "[busy] model answered; busy count cleared");
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
