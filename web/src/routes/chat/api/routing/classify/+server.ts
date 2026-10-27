import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { autoRoutingEnabled } from "$lib/chat/server/autoRoutingGate";
import { clefConfig, clefRoutingEnabled } from "$lib/chat/server/clefRoutingGate";
import { ClefError, classifyWithClef, clefFetch, takeClefRead } from "$lib/chat/server/clefClassify";
import { logger } from "$lib/chat/server/logger";
import { resolveReplayMode } from "$lib/chat/server/textGeneration/faultInjection";

// Auto's hosted draft read (routing/clef.ts): the composer posts the draft after a pause in typing and
// gets back Clef's language, task size and skill probabilities, which it merges over its local read.
// The key stays here; the browser never sees it. The draft is never logged, only its length.
//
// A scenario run's read is answered from the model replay store (SOL-201), keyed like a model answer,
// so CI does not spend the Clef quota real visitors share. Production never replays: resolveReplayMode
// needs the fault-inject token, which only preview and development deployments hold.
//
// 404 when the `clef-routing` or `auto-routing` flag is off, which the client reads as "stop asking"
// for the rest of the page's life. 429 past the per-session allowance (clefClassify.ts).

const MAX_BODY_CHARS = 8_000;

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	if (!autoRoutingEnabled() || !clefRoutingEnabled()) error(404, "not found");
	const cfg = clefConfig();
	if (!cfg) error(404, "not found");

	const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
	const text = typeof body?.text === "string" ? body.text.trim() : "";
	if (!text) error(400, "missing text");
	if (text.length > MAX_BODY_CHARS) error(413, "draft too long");

	if (!takeClefRead(String(locals.user?._id ?? locals.sessionId))) error(429, "too many draft reads");

	try {
		const verdict = await classifyWithClef(text, cfg, clefFetch(await resolveReplayMode(request)));
		logger.debug({ ms: verdict.elapsedMs, chars: text.length, model: verdict.model }, "[clef] draft read");
		return json(verdict, { headers: { "cache-control": "no-store" } });
	} catch (e) {
		const status = e instanceof ClefError ? e.status : 502;
		logger.warn({ status, chars: text.length, err: e instanceof Error ? e.message : String(e) }, "[clef] draft read failed");
		error(status, "draft read unavailable");
	}
};
