// A `fetch` for @huggingface/hub calls that counts them against the request making them.
// A shared storage token has a Hub budget of 3000 calls per 5 minutes, so it matters which route
// spends them. Every custodialStorage.ts call on that token passes `fetch: hubFetch`,
// and hooks/handle.ts puts the request's tally on its "Request completed" line. A linked bucket's
// calls run on the person's own token and are left out, so the count is the shared token's alone.
import { logger } from "$lib/chat/server/logger";
import { getRequestContext } from "$lib/chat/server/requestContext";

const REPO_TYPES = new Set(["models", "datasets", "spaces", "buckets"]);

/** "GET tree", "POST preupload", "GET resolve", "POST whoami-v2"; a call to another host (Xet's CAS)
 *  is named by its host. Reads the URL's own structure, never a repo or file name. */
function hubCallKind(method: string, url: URL): string {
	if (url.hostname !== "huggingface.co") return `${method} ${url.hostname}`;
	const seg = url.pathname.split("/").filter(Boolean);
	let op: string | undefined;
	if (seg[0] === "api") op = REPO_TYPES.has(seg[1]) ? (seg[4] ?? "info") : seg[1];
	else op = REPO_TYPES.has(seg[0]) ? seg[3] : seg[2];
	return `${method} ${op ?? "root"}`;
}

function requestUrl(input: RequestInfo | URL): URL {
	if (input instanceof URL) return input;
	return new URL(typeof input === "string" ? input : input.url);
}

function method(input: RequestInfo | URL, init?: RequestInit): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

export const hubFetch: typeof fetch = async (input, init) => {
	const ctx = getRequestContext();
	if (ctx) {
		const kind = hubCallKind(method(input, init), requestUrl(input));
		ctx.hubCalls ??= {};
		ctx.hubCalls[kind] = (ctx.hubCalls[kind] ?? 0) + 1;
	}
	const res = await fetch(input, init);
	if (res.status === 429) {
		if (ctx) ctx.hubThrottled = (ctx.hubThrottled ?? 0) + 1;
		logger.warn(hubThrottleFields(method(input, init), requestUrl(input), res), "hub rate limited");
	}
	return res;
};

/** What a Hub 429 says about the limit it hit. The token's account has more than one quota ("api"
 *  and "resolvers" today), and `ratelimit-policy` names them while `ratelimit` gives what is left in
 *  each, so these headers are the only record of which one ran out. Logged on every 429, inside a
 *  request or not, with the call kind and never the URL path or the body, which can name a file. */
function hubThrottleFields(m: string, url: URL, res: Response): Record<string, string> {
	const fields: Record<string, string> = { hub_call_kind: hubCallKind(m, url) };
	for (const [header, key] of [
		["ratelimit", "hub_ratelimit"],
		["ratelimit-policy", "hub_ratelimit_policy"],
		["retry-after", "hub_retry_after"],
	] as const) {
		const value = res.headers.get(header);
		if (value) fields[key] = value.slice(0, 200);
	}
	return fields;
}

/** The fields hooks/handle.ts adds to "Request completed", or nothing when the request made no Hub
 *  call: `hub_calls` (total), `hub_throttled` (429s), `hub_call_kinds` ("GET tree:2,POST commit:1"). */
export function hubCallSummary(): Record<string, string | number> {
	const ctx = getRequestContext();
	const calls = ctx?.hubCalls;
	if (!calls) return {};
	const entries = Object.entries(calls).sort(([a], [b]) => a.localeCompare(b));
	return {
		hub_calls: entries.reduce((n, [, c]) => n + c, 0),
		hub_throttled: ctx.hubThrottled ?? 0,
		hub_call_kinds: entries.map(([k, c]) => `${k}:${c}`).join(","),
	};
}
