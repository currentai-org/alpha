/**
 * Daily TTL garbage collection endpoint, invoked by the Vercel cron in vercel.json.
 *
 * Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the CRON_SECRET env var is set
 * (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs). We require it in production —
 * an unauthenticated endpoint that deletes rows is an abuse vector, so we refuse rather than run open.
 * In local dev (no secret) it's open so you can hit `GET /api/cleanup` directly; the standalone
 * `scripts/verify-cleanup.ts` exercises the same `cleanupExpired()` against the local Docker Postgres.
 */
import { type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { cronAuthorized } from "$lib/chat/server/cronAuth";
import { cleanupExpired } from "$lib/chat/server/db/cleanup";
import { sweepUncollectedPairings } from "$lib/chat/server/managedInference/sweepUncollectedPairings";
import { sweepExpiredGuestFiles } from "$lib/chat/server/storage/custodialStorage";
import { RETENTION_MS } from "$lib/chat/constants/retention";
import { logger } from "$lib/chat/server/logger";
import { ensureFlagsPolled } from "$lib/chat/server/flags";
import {
	conversationExpiryEnabled,
	countExpiringConversations,
	sweepExpiredConversations,
} from "$lib/chat/server/conversationExpiry";

export const GET: RequestHandler = async ({ request }) => {
	if (!(await cronAuthorized(request))) {
		return json({ error: "unauthorized" }, { status: 401 });
	}
	// Before cleanupExpired, which deletes the expired pairing rows this reads. Its own step
	// for the same reason as the guest files below: a failure is logged, and the rest still runs.
	const uncollectedPairings = await sweepUncollectedPairings().catch((e) => {
		logger.error({ err: e instanceof Error ? e.message : String(e) }, "[cleanup] uncollected pairing sweep failed");
		return { error: true as const };
	});
	if ("endpointsRemoved" in uncollectedPairings && uncollectedPairings.endpointsRemoved > 0) {
		logger.info(uncollectedPairings, "[cleanup] removed managed endpoints whose pairing was never collected");
	}
	// Conversation expiry reads a deployment flag; with it on, it deletes guest conversations
	// from their creation, and cleanupExpired's older guest sweep by `updatedAt` stands down.
	await ensureFlagsPolled();
	const expiryOn = conversationExpiryEnabled();
	const counts = await cleanupExpired(new Date(), { guestConversations: !expiryOn });
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	logger.info({ counts, total }, "TTL cleanup");
	// Guest attachments in the bucket, 30 days from upload. Its own step, so a bucket failure
	// is logged and the database cleanup above still reports.
	const guestFiles = await sweepExpiredGuestFiles(RETENTION_MS).catch((e) => {
		logger.error({ err: e instanceof Error ? e.name : String(e) }, "[cleanup] guest file sweep failed");
		return { error: true as const };
	});
	if (guestFiles && "failed" in guestFiles && (guestFiles.failed || guestFiles.undated)) {
		logger.warn(guestFiles, "[cleanup] guest file sweep left files behind");
	}
	// Conversation expiry: every conversation and My files file past its date. Deletes only
	// with the `conversation-expiry` flag on for this deployment; with it off the run refuses and logs what
	// it WOULD delete, as counts by age, never an id or a title. Its own step, so a failure here leaves the
	// rest of the report intact.
	const conversationExpiry = await sweepExpiredConversations(new Date(), () => expiryOn)
		.then(async (sweep) => ({ sweep, counts: await countExpiringConversations() }))
		.catch((e) => {
			logger.error({ err: e instanceof Error ? e.message : String(e) }, "[cleanup] conversation expiry failed");
			return { error: true as const };
		});
	logger.info({ conversationExpiry }, "[cleanup] conversation expiry");
	return json({ ok: true, deleted: counts, total, guestFiles: guestFiles ?? null, uncollectedPairings, conversationExpiry });
};
