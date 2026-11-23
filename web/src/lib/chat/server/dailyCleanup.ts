/**
 * The daily TTL cleanup: expired guest conversations, guest files, safety records, pairings and the
 * rest of what db/cleanup.ts deletes. Two callers run it. On Vercel, the cron in vercel.json calls
 * routes/chat/api/cleanup, which checks CRON_SECRET and then calls runDailyCleanup. On a self-hosted
 * Alpha, nothing calls that route, so each server process runs it on its own daily timer
 * (dailyCleanupSchedule.ts), with no HTTP and no secret. Every step deletes only what is already past
 * its date, so two processes running it the same day delete nothing twice.
 */
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

/** One cleanup run, start to finish. Each step after the database cleanup is its own: a failure there
 *  is logged and reported, and the steps around it still run. */
export async function runDailyCleanup(now: Date = new Date()) {
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
	const counts = await cleanupExpired(now, { guestConversations: !expiryOn });
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	logger.info({ counts, total }, "TTL cleanup");
	// Guest attachments in the bucket, 30 days from upload. Its own step, so a bucket failure
	// is logged and the database cleanup above still reports.
	const guestFiles = await sweepExpiredGuestFiles(RETENTION_MS, now).catch((e) => {
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
	const conversationExpiry = await sweepExpiredConversations(now, () => expiryOn)
		.then(async (sweep) => ({ sweep, counts: await countExpiringConversations() }))
		.catch((e) => {
			logger.error({ err: e instanceof Error ? e.message : String(e) }, "[cleanup] conversation expiry failed");
			return { error: true as const };
		});
	logger.info({ conversationExpiry }, "[cleanup] conversation expiry");
	return { deleted: counts, total, guestFiles: guestFiles ?? null, uncollectedPairings, conversationExpiry };
}

/** The in-process schedule's run: the same cleanup, then one line an operator can look for in the
 *  server log to confirm it ran. Never throws, so a failed run leaves tomorrow's in place. */
export async function runScheduledCleanup(): Promise<void> {
	try {
		const report = await runDailyCleanup();
		logger.info(
			{
				total: report.total,
				// With the conversation-expiry flag off, cleanupExpired deletes guest conversations; with it on,
				// that sweep stands down and the expiry sweep deletes them (with signed-in ones), counted here.
				guestConversations: report.deleted.conversations,
				expiredConversations: "sweep" in report.conversationExpiry ? report.conversationExpiry.sweep.deleted : null,
				guestFilesDeleted: report.guestFiles && "deleted" in report.guestFiles ? report.guestFiles.deleted : null,
			},
			"[cleanup] daily cleanup finished"
		);
	} catch (e) {
		logger.error({ err: e instanceof Error ? e.message : String(e) }, "[cleanup] daily cleanup failed");
	}
}
