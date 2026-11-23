/**
 * Daily TTL garbage collection endpoint, invoked by the Vercel cron in vercel.json. A server off Vercel
 * has no such cron and runs the same cleanup on an in-process timer instead
 * ($lib/chat/server/dailyCleanupSchedule.ts); this route is the Vercel caller.
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
import { runDailyCleanup } from "$lib/chat/server/dailyCleanup";

export const GET: RequestHandler = async ({ request }) => {
	if (!(await cronAuthorized(request))) {
		return json({ error: "unauthorized" }, { status: 401 });
	}
	return json({ ok: true, ...(await runDailyCleanup()) });
};
