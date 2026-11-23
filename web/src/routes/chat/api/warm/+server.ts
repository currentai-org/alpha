import { runInBackground } from "$lib/chat/server/vercelBackground";
import { warmPagePing } from "$lib/chat/server/warm";
import { resolveProbeRequest } from "$lib/chat/server/textGeneration/faultInjection";
import { probeAndRecord } from "$lib/chat/server/modelProbe";
import type { RequestHandler } from "./$types";

// Client-pinged warmup (TTFT). The chat input hits this on load/focus, so a cold backend's wake overlaps
// the user's read/type window instead of stalling the first turn.
//
// The warm runs in the BACKGROUND (runInBackground → Vercel waitUntil) and the route returns 204
// IMMEDIATELY. Best-effort + server-throttled, so repeat pings are cheap. 204 = accepted; body is irrelevant.
//
// Page legs (warm.ts): the deployment probes and pruning run from the scheduled job at
// /chat/api/probes. On Vercel a page ping also runs this instance's process legs, as it always has,
// and two of those (the error and agent-route counters) record a probe; off Vercel each process's own
// keepalive runs them instead.

// The kept-alive background legs can legitimately run long (moderation warm ≤90s),
// and the Vercel project default of 300s covers them with room to spare. NO per-route
// `export const config` here: it splits adapter-vercel's function layout and can drop routes from
// the catchall manifest, and any `maxDuration` below 300 would only lower the ceiling. Set any
// genuine non-default adapter-globally in sveltekit.config.js.

export const GET: RequestHandler = async ({ platform, request }) => {
	// A spec runs the cron's model probe on one model now, under its own busy scope, and reads
	// the verdict. Preview and development only, behind the fault-inject secret (faultInjection.ts).
	const probe = await resolveProbeRequest(request);
	if (probe) {
		const { models } = await import("$lib/chat/server/models");
		const model = models.find((m) => m.id === probe.model);
		if (!model) return Response.json({ error: `no registered model ${probe.model}` }, { status: 404 });
		const verdict = await probeAndRecord(model, { refuse: probe.refuse, scope: probe.scope });
		return Response.json({ model: model.id, scope: probe.scope, verdict });
	}
	await runInBackground(warmPagePing(), platform?.context);
	return new Response(null, { status: 204 });
};
