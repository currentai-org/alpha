/**
 * Conversation expiry on the official instance: everything a person makes is deleted
 * RETENTION_DAYS after it was created, so a breach or a fumbled migration reaches at most that vocab-ok:security
 * much of anyone's data. People who want long history export it or run their own Alpha.
 *
 * "Everything" is every conversation (signed in or a guest's, pinned or not, sealed or not: the server
 * needs no key to delete a row) and every file in My files. Alpha keeps no memory items yet; when it
 * does, they join this sweep on the same rule.
 *
 * The `conversation-expiry` flag is the switch, deployment-scoped (every visitor on a deployment lives
 * under the same rule), off in code and off on a self-hosted install. Nothing here deletes a row unless
 * that flag reads on for this deployment; with it off, the daily cron only counts (`dryRun`), and the
 * older guest sweep in db/cleanup.ts (by `updatedAt`) keeps running as before.
 *
 * A conversation expires at `greatest(created_at, launch) + window`, a file at
 * `greatest(uploaded_at, launch) + window`. `launch` is the moment this deployment's sweep first ran
 * with the flag on, kept in the `config` table, so everything that existed before then gets the full
 * window from launch day, with the notice on screen the whole time. The sweep clears the marker on any
 * run with the flag off, so switching expiry off and on again restarts everyone's clock rather than
 * releasing a backlog the moment it comes back on. No column stores an expiry: the date is derived from
 * two facts we already keep, and the page's "N days left" derives it the same way
 * (constants/retention.ts, conversationExpiresAt).
 *
 * A deleted conversation goes through deleteConversationsCascade, so its attachments, its folder in our
 * bucket, its share links and its agent session go with it, and its safety reports are detached and kept.
 * Quarantined uploads are kept, as CSAM-match evidence (sweepExpiredGuestFiles skips them).
 */
import { lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db/client";
import * as schema from "./db/schema";
import { collections } from "./database";
import { flagEnabledOr } from "./flags";
import { logger } from "./logger";
import { deleteConversationsCascade } from "./db/deleteConversations";
import { sweepExpiredGuestFiles } from "./storage/custodialStorage";
import { RETENTION_DAYS, RETENTION_MS, conversationExpiresAt } from "$lib/chat/constants/retention";

/** PostHog flag key. Owner: chat. Deployment-scoped; see the header. */
export const CONVERSATION_EXPIRY_FLAG = "conversation-expiry";

/** The `config` row holding when this deployment's expiry started (ISO string). */
const CONVERSATION_EXPIRY_LAUNCH_KEY = "conversation-expiry-launched-at";

/** Conversations deleted per batch; the sweep runs batches until none are due or its time is up. */
const SWEEP_BATCH = 500;

/** How long one run keeps taking batches, well inside the cron's time; what is left goes tomorrow. */
const SWEEP_TIME_BUDGET_MS = 40_000;

/** Is conversation expiry on for this deployment? Off when PostHog says nothing. */
export function conversationExpiryEnabled(): boolean {
	return flagEnabledOr(CONVERSATION_EXPIRY_FLAG, () => false);
}

async function readExpiryLaunch(): Promise<Date | null> {
	const row = await collections.config.findOne({ key: CONVERSATION_EXPIRY_LAUNCH_KEY });
	const at = row?.value ? new Date(row.value) : null;
	return at && !Number.isNaN(at.getTime()) ? at : null;
}

let launchCache: { at: Date; readAt: number } | null = null;
const LAUNCH_CACHE_MS = 5 * 60 * 1000;

/**
 * readExpiryLaunch, cached per instance for a few minutes: the conversation page reads it on every load.
 * Only a recorded launch is kept; while there is none each read goes to the table, so the first sweep's
 * marker shows on every instance at once.
 */
async function cachedExpiryLaunch(): Promise<Date | null> {
	if (launchCache && Date.now() - launchCache.readAt < LAUNCH_CACHE_MS) return launchCache.at;
	const at = await readExpiryLaunch();
	launchCache = at ? { at, readAt: Date.now() } : null;
	return at;
}

/**
 * When this conversation will be deleted, for the page's days-left badge and delete-date banner, or null
 * while expiry is off for this deployment. Every conversation expires on the same rule, so only its
 * creation time matters.
 */
export async function conversationExpiryFor(conv: { createdAt?: Date | null }, now = new Date()): Promise<Date | null> {
	if (!conversationExpiryEnabled()) return null;
	return conversationExpiresAt(conv.createdAt ?? null, await cachedExpiryLaunch(), now);
}

const c = schema.conversations;

function expiresAt(launch: Date): SQL {
	return sql`(greatest(${c.createdAt}, ${launch.toISOString()}::timestamptz) + make_interval(days => ${RETENTION_DAYS}))`;
}

/** Counts only, never an id, a user or a title: what a dry run reports and the cron logs. */
export type ExpiryDryRun = {
	mode: "dry-run";
	flagOn: boolean;
	/** When this deployment's expiry started (ISO), or null when it has not. */
	launchedAt: string | null;
	/** Conversations by age since creation, in days. */
	byAgeDays: { under7: number; from7to29: number; from30to59: number; from60to89: number; over89: number; unknown: number };
	/** Conversations whose expiry has passed at `now`, with launch as recorded (or `now` if none). */
	wouldDeleteNow: number;
	/** Of all conversations, how many are a guest's, pinned, or sealed: kinds the sweep now covers too. */
	guests: number;
	pinned: number;
	sealed: number;
};

export type ExpirySweep =
	| { mode: "refused"; reason: "flag-off"; deleted: 0 }
	| {
			mode: "swept";
			launchedAt: string;
			deleted: number;
			failed: number;
			/** True when the time budget ran out with conversations still due; the next run takes them. */
			more: boolean;
			/** My files past their date; undefined where this deployment has no bucket, or before launch + window. */
			files?: { deleted: number; failed: number; undated: number };
		};

/** Any sealed part, by key presence. Counted only: a sealed conversation is deleted like any other. */
const sealed: SQL = sql`(jsonb_exists(${c.doc}, 'sealedTitle') OR jsonb_exists(${c.doc}, 'sealedPreprompt') OR jsonb_path_exists(${c.doc}, '$.messages[*].sealed'))`;

/**
 * Count, by age bucket, what conversation expiry would delete. Reads only, whatever the flag says.
 */
export async function countExpiringConversations(now = new Date()): Promise<ExpiryDryRun> {
	const launch = (await readExpiryLaunch()) ?? now;
	const age = sql`(${now.toISOString()}::timestamptz - ${c.createdAt})`;
	const [row] = await getDb()
		.select({
			under7: sql<number>`count(*) filter (where ${age} < interval '7 days')`.mapWith(Number),
			from7to29: sql<number>`count(*) filter (where ${age} >= interval '7 days' and ${age} < interval '30 days')`.mapWith(Number),
			from30to59: sql<number>`count(*) filter (where ${age} >= interval '30 days' and ${age} < interval '60 days')`.mapWith(Number),
			from60to89: sql<number>`count(*) filter (where ${age} >= interval '60 days' and ${age} < interval '90 days')`.mapWith(Number),
			over89: sql<number>`count(*) filter (where ${age} >= interval '90 days')`.mapWith(Number),
			unknown: sql<number>`count(*) filter (where ${c.createdAt} is null)`.mapWith(Number),
			wouldDeleteNow: sql<number>`count(*) filter (where ${expiresAt(launch)} < ${now.toISOString()}::timestamptz)`.mapWith(Number),
			guests: sql<number>`count(*) filter (where ${c.userId} is null)`.mapWith(Number),
			pinned: sql<number>`count(*) filter (where ${c.pinned})`.mapWith(Number),
			sealed: sql<number>`count(*) filter (where ${sealed})`.mapWith(Number),
		})
		.from(c);
	const { wouldDeleteNow, guests, pinned, sealed: sealedCount, ...byAgeDays } = row;
	return {
		mode: "dry-run",
		flagOn: conversationExpiryEnabled(),
		launchedAt: (await readExpiryLaunch())?.toISOString() ?? null,
		byAgeDays,
		wouldDeleteNow,
		guests,
		pinned,
		sealed: sealedCount,
	};
}

/**
 * Delete every conversation and My files file whose expiry has passed. Refuses, deleting nothing, unless
 * the `conversation-expiry` flag reads on for this deployment; a refused run also clears the launch
 * marker, so the clock restarts if expiry is switched on again. `enabled` exists for the tests.
 */
export async function sweepExpiredConversations(
	now = new Date(),
	enabled: () => boolean = conversationExpiryEnabled
): Promise<ExpirySweep> {
	if (!enabled()) {
		await collections.config.deleteOne({ key: CONVERSATION_EXPIRY_LAUNCH_KEY });
		launchCache = null;
		return { mode: "refused", reason: "flag-off", deleted: 0 };
	}
	// First writer wins: an existing marker is never moved forward or back.
	await collections.config.updateOne(
		{ key: CONVERSATION_EXPIRY_LAUNCH_KEY },
		{ $setOnInsert: { value: now.toISOString() } },
		{ upsert: true }
	);
	const launch = (await readExpiryLaunch()) ?? now;
	launchCache = null;

	const started = Date.now();
	let deleted = 0;
	let failed = 0;
	// A batch whose every delete failed is skipped past, not retried, so one stuck owner cannot spin the loop.
	const skip = new Set<string>();
	let more = true;
	while (more && Date.now() - started < SWEEP_TIME_BUDGET_MS) {
		const due = (
			await getDb()
				.select({ id: c.id, userId: c.userId, sessionId: c.sessionId })
				.from(c)
				.where(lt(expiresAt(launch), sql`${now.toISOString()}::timestamptz`))
				.limit(SWEEP_BATCH + skip.size + 1)
		).filter((r) => !skip.has(r.id));
		const batch = due.slice(0, SWEEP_BATCH);
		more = due.length > SWEEP_BATCH;
		if (batch.length === 0) break;
		// One cascade per owner, so each owner's bucket folders go with their rows: a signed-in person's
		// under users/<id>/, a guest's under guests/<session>/.
		const byOwner = new Map<string, { ownerId?: string; guestSessionId?: string; ids: string[] }>();
		for (const { id, userId, sessionId } of batch) {
			const key = userId ? `u:${userId}` : `g:${sessionId ?? ""}`;
			const group = byOwner.get(key) ?? (userId ? { ownerId: userId, ids: [] } : { guestSessionId: sessionId ?? undefined, ids: [] });
			group.ids.push(id);
			byOwner.set(key, group);
		}
		for (const { ownerId, guestSessionId, ids } of byOwner.values()) {
			try {
				deleted += await deleteConversationsCascade(ids, ownerId, guestSessionId);
			} catch (e) {
				// A bucket failure leaves that owner's conversations in place for tomorrow's run.
				failed += ids.length;
				for (const id of ids) skip.add(id);
				logger.error({ err: e instanceof Error ? e.name : String(e), n: ids.length }, "[conversation-expiry] delete failed");
			}
		}
	}

	// My files, each on its own upload time. Before launch + window nothing uploaded can be due, since an
	// upload from before launch counts from launch day.
	const files =
		launch.getTime() + RETENTION_MS <= now.getTime()
			? await sweepExpiredGuestFiles(RETENTION_MS, now, "users")
			: undefined;

	return { mode: "swept", launchedAt: launch.toISOString(), deleted, failed, more, ...(files ? { files } : {}) };
}
