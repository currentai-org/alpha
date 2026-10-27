// The warm cron's model probe (CUR-4042). Without it, a model is marked busy only after three
// visitors in a row have failed on it, so the first visitors to reach a dead model always fail, and at
// low traffic the mark is never set. The probe sends each picker model one tiny turn every few
// minutes and marks it busy, or clears the mark, from the result. Nobody has to fail first.
//
// A probe is a real turn in miniature: the model's own `getEndpoint()`, so the same lanes, failover,
// hedging and last-lane give-up a visitor's turn gets, with the first-token deadline the conversation
// route's watchdog gives that model (turnDeadlines.ts). It goes red for what a visitor would hit: a 429,
// a gateway timeout or 5xx, a 404 (the router has no working entry for the model, CUR-4629), a lane that
// sends nothing in time, an empty completion, or the model's own lanes giving up so that another model
// answers in its place. Any other 4xx is our request's fault, says nothing about the model, and is logged
// without a verdict. The probe's request is fixed and answers on a served model, so a 404 to it means
// the model is not being served, not that we asked wrongly.
//
// Cost: PROBE_EVERY_MINUTES apart per model, so 1440 / 4 = 360 probes per model per day, each a
// two-message prompt cut at its first chunk. A refusing lane is retried once on the same lane, as a turn
// is, so a dead model's probe is at most two upstream calls per lane.
//
// Staggered by slot: each model has one minute in every PROBE_EVERY_MINUTES, so at most
// ceil(models / 4) probes run on any one tick. The cron is not the only caller of /chat/api/warm (the chat
// input pings it on load), so each probe also claims its model in `alert_state` (`probe:<id>`) and runs
// only when no instance has probed it within PROBE_CLAIM_MS.

import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { alertState } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";
import { noteAnswered, noteFailed } from "$lib/chat/server/modelBusy";
import { firstTokenDeadlineMs } from "$lib/chat/server/turnDeadlines";
import { NoFirstChunkError } from "$lib/chat/server/endpoints/failover";
import { isHardUpstreamFailure } from "$lib/chat/server/endpoints/retryPolicy";
import type { Endpoint } from "$lib/chat/server/endpoints/types";
import { DEFAULT_ANSWER_RESERVE } from "$lib/chat/server/endpoints/openai/endpointOai";
import { sameServedModel } from "../../../../config/picker";

/** Minutes between two probes of one model. @internal exported for its unit tests */
export const PROBE_EVERY_MINUTES = 4;
/** A claim older than this lets the next due tick probe again: half a minute under the interval, so a
 *  late cron tick never skips a whole round. */
const PROBE_CLAIM_MS = (PROBE_EVERY_MINUTES * 60 - 30) * 1000;

/** What the probe needs of a registry model. */
export interface ProbeTarget {
	id: string;
	getEndpoint: (opts?: { recordBusy?: boolean }) => Promise<Endpoint>;
}

type ProbeVerdict =
	| { ok: true; ms: number; served?: string; identity: "match" | "mismatch" | "unknown" }
	| { ok: false; ms: number; reason: string }
	| { ok: null; ms: number; reason: string };

/** The models due on this minute's tick: model `i` of the id-sorted list runs when the minute since the
 *  epoch falls in its slot. @internal exported for its unit tests */
export function dueThisMinute(ids: string[], nowMs: number): string[] {
	const slot = Math.floor(nowMs / 60_000) % PROBE_EVERY_MINUTES;
	return [...ids].sort().filter((_, i) => i % PROBE_EVERY_MINUTES === slot);
}

const statusOf = (e: unknown): number | undefined => {
	const s = (e as { status?: unknown } | null)?.status;
	return typeof s === "number" ? s : undefined;
};

/** A failure that says the model is not answering, as opposed to one that says our request was wrong.
 *  @internal exported for its unit tests */
export function countsAsDown(e: unknown): boolean {
	if (e instanceof NoFirstChunkError) return true;
	const status = statusOf(e);
	if (status === undefined) return true; // a dropped connection or a thrown network error
	return status === 429 || isHardUpstreamFailure(e);
}

/**
 * @internal exported for its unit tests.
 * One probe of `model`: send a tiny turn and wait for its first chunk, no longer than a visitor's turn
 * would. `refuse` (the `every_lane_rate_limited` fault, preview only) makes every lane throw a 429 before
 * any request leaves.
 */
export async function probeModel(
	model: ProbeTarget,
	{ refuse = false, deadlineMs = firstTokenDeadlineMs(model.id) }: { refuse?: boolean; deadlineMs?: number } = {}
): Promise<ProbeVerdict> {
	const started = Date.now();
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, deadlineMs);
	try {
		const endpoint = await model.getEndpoint({ recordBusy: false });
		const stream = await endpoint({
			messages: [{ from: "user", content: `hi ${randomUUID()}` }],
			preprompt: "You are a helpful assistant.",
			// The answer's own cap, not a small one: a model that reasons before its first visible chunk would
			// end a 16-token probe empty and be marked busy while answering every visitor. The probe stops at
			// its first chunk, so the cap costs nothing on a model that answers.
			generateSettings: { max_tokens: DEFAULT_ANSWER_RESERVE },
			locals: undefined,
			abortSignal: controller.signal,
			// The answer path's request, so the gateway treats it as a turn would (no cross-model fallback).
			servesUserAnswer: true,
			...(refuse ? { rateLimitEveryLane: true } : {}),
		});
		let served: string | undefined;
		for await (const out of stream) {
			// The model's own lanes gave up and a backup serving another model is about to answer.
			if (out.failover) return { ok: false, ms: Date.now() - started, reason: `backup-lane:${out.failover.to}` };
			served = out.routerMetadata?.model ?? served;
			const identity = !served ? "unknown" : sameServedModel(model.id, served) ? "match" : "mismatch";
			return { ok: true, ms: Date.now() - started, served, identity };
		}
		return { ok: false, ms: Date.now() - started, reason: "empty-completion" };
	} catch (e) {
		const ms = Date.now() - started;
		if (timedOut) return { ok: false, ms, reason: `no-first-chunk-${deadlineMs}ms` };
		const reason = statusOf(e) !== undefined ? `http-${statusOf(e)}` : e instanceof Error ? e.message : String(e);
		return countsAsDown(e) ? { ok: false, ms, reason } : { ok: null, ms, reason };
	} finally {
		clearTimeout(timer);
		controller.abort(); // closes the stream at its first chunk
	}
}

/** Probe `model` and record the verdict: a failure marks it busy at once (modelBusy.ts says why), an
 *  answer clears the mark. */
export async function probeAndRecord(
	model: ProbeTarget,
	opts: { refuse?: boolean; scope?: string; deadlineMs?: number } = {}
): Promise<ProbeVerdict> {
	const verdict = await probeModel(model, opts);
	const fields = { leg: "model-probe", model: model.id, ...verdict, ...(opts.scope ? { scope: opts.scope } : {}) };
	if (verdict.ok === true) {
		await noteAnswered(model.id, opts.scope);
		if (verdict.identity === "mismatch") logger.warn(fields, "[warm] probe answered, but under another model's name");
		else logger.info(fields, "[warm] probe answered");
	} else if (verdict.ok === false) {
		const row = await noteFailed(model.id, opts.scope, { decisive: true });
		logger.warn({ ...fields, failures: row?.consecutiveFailures }, "[warm] probe got no answer");
	} else {
		logger.warn(fields, "[warm] probe inconclusive: the request was refused for a reason that says nothing about the model");
	}
	return verdict;
}

/** Claims `id`'s probe for this round across instances. False when another instance probed it within
 *  PROBE_CLAIM_MS, or when the claim cannot be written (skipping a round is cheaper than doubling one). */
async function claimProbe(id: string, now: Date): Promise<boolean> {
	try {
		const rows = await getDb()
			.insert(alertState)
			.values({ key: `probe:${id}`, firing: false, lastFiredAt: null, consecutiveFailures: 0, updatedAt: now })
			.onConflictDoUpdate({
				target: alertState.key,
				set: { updatedAt: now },
				setWhere: and(
					eq(alertState.key, `probe:${id}`),
					lt(alertState.updatedAt, new Date(now.getTime() - PROBE_CLAIM_MS))
				),
			})
			.returning({ key: alertState.key });
		return rows.length > 0;
	} catch (e) {
		logger.warn({ model: id, err: e instanceof Error ? e.message : String(e) }, "[warm] probe claim failed; skipping");
		return false;
	}
}

/** The warm leg: probe every picker model whose slot is this minute and which no instance has just probed. */
export async function probeDueModels(targets: ProbeTarget[], now = new Date()): Promise<void> {
	const due = new Set(dueThisMinute(targets.map((t) => t.id), now.getTime()));
	await Promise.allSettled(
		targets
			.filter((t) => due.has(t.id))
			.map(async (t) => {
				if (await claimProbe(t.id, now)) await probeAndRecord(t);
			})
	);
}
