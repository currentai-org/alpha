import { runInBackground } from "$lib/chat/server/vercelBackground";
import { warmAll } from "$lib/chat/server/warm";
import { cronAuthorized } from "$lib/chat/server/cronAuth";
import type { RequestHandler } from "./$types";

// The scheduled job: health and SLO probes, pruning, the upstream warm and the external
// heartbeat, once a minute. vercel.json's cron calls it on Vercel; on any other host a scheduler does
// (scripts/jelastic/install-crons.sh, or a compose or Kubernetes cron that curls it with the bearer).
// One call per tick for the whole deployment: each process keeps its own state fresh by itself
// (keepalive.ts), so this does not need to reach every process.
//
// CRON_SECRET-gated, unlike the page's /chat/api/warm, because it raises alerts and writes rows.
// Returns 202 once the work is scheduled; the work itself runs in the background (Vercel waitUntil, or
// the shutdown registry elsewhere). No per-route `export const config`: see the warm route's header.

export const GET: RequestHandler = async ({ platform, request }) => {
	if (!(await cronAuthorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
	await runInBackground(warmAll(), platform?.context);
	return new Response(null, { status: 202 });
};
