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
import { dev } from "$app/environment";
import { env } from "$env/dynamic/private";
import { cleanupExpired } from "$lib/chat/server/db/cleanup";
import { sweepUncollectedPairings } from "$lib/chat/server/managedInference/sweepUncollectedPairings";
import { sweepExpiredGuestFiles } from "$lib/chat/server/storage/custodialStorage";
import { RETENTION_MS } from "$lib/chat/constants/retention";
import { logger } from "$lib/chat/server/logger";

function authorized(request: Request): boolean {
	const secret = env.CRON_SECRET;
	if (!secret) return dev; // open in dev only; refuse in prod when unconfigured
	const header = request.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

export const GET: RequestHandler = async ({ request }) => {
	if (!authorized(request)) {
		return json({ error: "unauthorized" }, { status: 401 });
	}
	// Before cleanupExpired, which deletes the expired pairing rows this reads. Its own step
	// for the same reason as the guest files below: a failure is logged, and the rest still runs. (CUR-4110)
	const uncollectedPairings = await sweepUncollectedPairings().catch((e) => {
		logger.error({ err: e instanceof Error ? e.message : String(e) }, "[cleanup] uncollected pairing sweep failed");
		return { error: true as const };
	});
	if ("endpointsRemoved" in uncollectedPairings && uncollectedPairings.endpointsRemoved > 0) {
		logger.info(uncollectedPairings, "[cleanup] removed managed endpoints whose pairing was never collected");
	}
	const counts = await cleanupExpired();
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	logger.info({ counts, total }, "TTL cleanup");
	// Guest attachments in the bucket, 30 days from upload. Its own step, so a bucket failure
	// is logged and the database cleanup above still reports. (CUR-2183)
	const guestFiles = await sweepExpiredGuestFiles(RETENTION_MS).catch((e) => {
		logger.error({ err: e instanceof Error ? e.name : String(e) }, "[cleanup] guest file sweep failed");
		return { error: true as const };
	});
	if (guestFiles && "failed" in guestFiles && (guestFiles.failed || guestFiles.undated)) {
		logger.warn(guestFiles, "[cleanup] guest file sweep left files behind");
	}
	return json({ ok: true, deleted: counts, total, guestFiles: guestFiles ?? null, uncollectedPairings });
};
