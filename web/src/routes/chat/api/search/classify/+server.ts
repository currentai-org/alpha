import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { decideWebSearch } from "$lib/chat/server/search/runSearch";
// The search decision a chat turn makes, exposed for probes. It runs decideWebSearch itself rather
// than calling one decider per strategy, so it answers with what a real turn decides, including which
// decider ran and whether it fell back to the recency regex (CUR-2108). verify-prod-config.mjs reads
// `decider` and `fallback` off it to prove the configured gate is the one deciding. No client calls
// it: client-side search was retired (runSearch.ts).
//
// Returns { shouldSearch, query?, decider, fallback?, ok }. `ok` is false exactly when `fallback` is
// set, i.e. the configured decider produced no verdict.

export const GET: RequestHandler = async ({ locals, url, getClientAddress }) => {
	requireAuth(locals);

	const q = url.searchParams.get("q")?.trim();
	if (!q) {
		throw error(400, "missing query");
	}
	if (q.length > 400) {
		throw error(400, "query too long");
	}

	// This route reaches a real model call (decideWebSearch's deciders) behind only
	// requireAuth, which any anonymous session satisfies. Same limiter, same keying, same placement (before the first model-reaching branch) as its three
	// siblings /api/search, /api/second-opinion, /api/transcribe (CUR-832, CUR-926).
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});

	// No serving model is passed, and that is the correct answer: decideWebSearch falls back to
	// `defaultModel`, which since CUR-243 IS what a default turn gets. Reintroduce a serving-model
	// argument WITH any future per-request substitution, or this route answers for a different model
	// than the turn it claims to describe.
	const d = await decideWebSearch(q, locals);
	return json(
		{
			shouldSearch: d.search,
			...(d.preShaped ? { query: d.query } : {}),
			decider: d.decider,
			...(d.fallback ? { fallback: d.fallback } : {}),
			ok: d.fallback === undefined,
		},
		{ headers: { "cache-control": "no-store" } }
	);
};
