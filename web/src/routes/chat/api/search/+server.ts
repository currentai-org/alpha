import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { openSearch } from "$lib/chat/server/search/openSearch";
import { contextualizeQuery, type RewriteTurn } from "$lib/chat/server/search/queryRewrite";
import type { OpenSearchResult } from "$lib/chat/types/Search";

// Open-knowledge search endpoint: the client calls this when the user turns on
// web search (or accepts the "search open sources?" affordance). Returns
// numbered sources + an evidence block the chat turn is then grounded on.
// Open sources only (Wikipedia + Firecrawl + OpenAlex) — see $lib/chat/server/search/openSearch.
async function runSearch(q: string, locals: App.Locals | undefined) {
	if (q.length > 400) {
		throw error(400, "query too long");
	}
	try {
		const outcome = await openSearch(q, { timeoutMs: 9000, locals });
		// Strip the SERVER-LOCAL relevanceVerified bit: /api/search serializes OpenSearchResult raw to the
		// client, and a verification claim must never ride a client-reachable wire type (else a client
		// could echo it back as "already verified" and force grounding). Return the wire fields only.
		const wire: OpenSearchResult = {
			query: outcome.query,
			sources: outcome.sources,
			evidence: outcome.evidence,
			asOf: outcome.asOf,
		};
		return json(wire, { headers: { "cache-control": "no-store" } });
	} catch {
		throw error(502, "search failed");
	}
}

// GET: a standalone query needing no conversation context (the common path).
export const GET: RequestHandler = async ({ locals, url, getClientAddress }) => {
	requireAuth(locals);
	const q = url.searchParams.get("q")?.trim();
	if (!q) {
		throw error(400, "missing query");
	}
	// This route has its own model call (openSearch's rewrite) and web fetches, and
	// requireAuth alone doesn't meter anything — a guest cookie could loop it with zero counter.
	// Same limiter, same keying as the chat turn (conversation/[id]/+server.ts): session first,
	// falling back to the bare sessionId a guest always carries. (CUR-832)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});
	return runSearch(q, locals);
};

// POST: a follow-up query that may carry conversation history for coreference rewriting — e.g.
// "what most recent research says about it?" is rewritten to a standalone query BEFORE searching, so
// the open web returns on-topic sources instead of junk. History rides in the body (never the URL,
// per the no-PII-in-query-strings rule); the rewrite is best-effort and falls back to the raw query.
export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	requireAuth(locals);
	const body = (await request.json().catch(() => ({}))) as {
		q?: unknown;
		history?: unknown;
	};
	const rawQ = typeof body.q === "string" ? body.q.trim() : "";
	if (!rawQ) {
		throw error(400, "missing query");
	}
	if (rawQ.length > 400) {
		// Reject before the rewrite model call, not just at search time.
		throw error(400, "query too long");
	}
	// Gate BEFORE contextualizeQuery's rewrite call, the first model spend on this path. (CUR-832)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});
	const history: RewriteTurn[] = Array.isArray(body.history)
		? body.history
				.filter(
					(m): m is RewriteTurn =>
						!!m &&
						typeof m === "object" &&
						(m.from === "user" || m.from === "assistant") &&
						typeof m.content === "string"
				)
				.slice(-4)
		: [];
	const q = history.length ? await contextualizeQuery(rawQ, history, locals) : rawQ;
	return runSearch(q, locals);
};
