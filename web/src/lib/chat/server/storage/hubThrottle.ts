/**
 * The storage token's rate limit, as Hugging Face reports it (CUR-3680).
 *
 * Hugging Face counts the token's Hub calls over 5-minute fixed windows (3,000 a window on the team
 * plan) and sends `RateLimit: "api";r=<remaining>;t=<seconds until reset>` on every response. The Hub
 * SDK's `HubApiError` keeps none of it, so every Hub call in custodialStorage.ts passes `hubFetch`,
 * which reads `t` on a 429. Until that reset, a call answers 429 here without reaching Hugging Face:
 * the window has nothing left to give, and spending more calls in it only lengthens the throttle for
 * every preview sharing the token. The SDK turns that 429 into its own `HubApiError`, so every caller's
 * existing throttle handling applies unchanged.
 *
 * Per serverless instance: another instance learns the reset from its own first 429.
 */
import { hubFetch as countedFetch } from "./hubFetch";

/** Seconds a throttled caller is told to wait when Hugging Face sent no reset. */
export const HUB_BUSY_FALLBACK_SECONDS = 30;

/** When the current window resets, in epoch ms, once a 429 has said so; 0 when nothing is known. */
let resetAt = 0;

/** The `t` parameter of a `RateLimit` header: seconds until the window resets. */
function resetSeconds(header: string | null): number | null {
	const t = header?.match(/;\s*t=(\d+)/)?.[1];
	return t === undefined ? null : Number(t);
}

/** How long a tree listing page may take, response body included, before it is answered as busy. */
const HUB_LISTING_DEADLINE_MS = 15_000;

const busy = () => new Response(null, { status: 429, statusText: "Too Many Requests" });

function isTreeListing(input: RequestInfo | URL, init?: RequestInit): boolean {
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
	return method === "GET" && url.pathname.split("/").includes("tree");
}

/**
 * A tree listing that stops answering would hold GET /chat/api/storage until
 * the socket closes. A listing page gets HUB_LISTING_DEADLINE_MS, body included, and a miss
 * answers 429 like a throttle, so callers retry it and the route says storage is busy. A miss arms no
 * reset: one slow listing is not Hugging Face's rate limit, and must not hold every other call. The body is
 * read inside the deadline because the SDK reads it after fetch resolves, past any timer here.
 * Uploads and downloads keep no deadline: their size, not the Hub, sets how long they take. (CUR-3980)
 */
async function withListingDeadline(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response | null> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), HUB_LISTING_DEADLINE_MS);
	const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
	try {
		const res = await countedFetch(input, { ...init, signal });
		const body = await res.arrayBuffer();
		return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
	} catch (e) {
		if (deadline.signal.aborted && !init?.signal?.aborted) return null;
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

export const hubFetch: typeof fetch = async (input, init) => {
	if (Date.now() < resetAt) return busy();
	// Counted against the request (CUR-3682) only when it reaches Hugging Face.
	const res = isTreeListing(input, init) ? await withListingDeadline(input, init) : await countedFetch(input, init);
	if (!res) return busy();
	if (res.status === 429) {
		const seconds = resetSeconds(res.headers.get("ratelimit")) ?? HUB_BUSY_FALLBACK_SECONDS;
		resetAt = Date.now() + seconds * 1000;
	}
	return res;
};

/** The Retry-After for a busy answer: seconds until the window resets, or the fallback when unknown. */
export function hubRetryAfterSeconds(): number {
	const left = resetAt - Date.now();
	return left > 0 ? Math.ceil(left / 1000) : HUB_BUSY_FALLBACK_SECONDS;
}

/** Forget the recorded reset. For tests. */
export function resetHubThrottle(): void {
	resetAt = 0;
}
