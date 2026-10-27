import { json } from "$lib/chat/server/api/utils/json";
import { logger } from "$lib/chat/server/logger";
import { hubRateLimitedError, hubRateLimitedUrl } from "./custodialStorage";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { hubRetryAfterSeconds } from "./hubThrottle";

/** The Hub URL Hugging Face throttled, found anywhere in `e`'s cause chain, or null when it wasn't a
 *  throttle. A wipe or a read wraps the Hub's error, so the throttle is often one or two causes down. */
export function hubThrottledUrl(e: unknown): string | null {
	for (let err = e, depth = 0; err && depth < 4; err = (err as { cause?: unknown }).cause, depth++) {
		const url = hubRateLimitedUrl(err);
		if (url !== null) return url;
	}
	return null;
}

/**
 * The answer to a request that failed because Hugging Face throttled the storage token: a 503 whose
 * `message` says storage is busy and whose `Retry-After` is when the token's window resets
 * (CUR-3120, CUR-3680). `error()` cannot set a header, so it is a Response. Null when it wasn't a
 * throttle, for the caller to answer as it otherwise would.
 */
export function hubBusyResponse(e: unknown, message: string, scope: string): Response | null {
	const url = hubThrottledUrl(e);
	if (url === null) return null;
	const retryAfter = hubRetryAfterSeconds();
	logger.warn({ url, retryAfter }, `[${scope}] Hugging Face rate-limited the storage token`);
	return json({ message }, { status: 503, headers: { "retry-after": String(retryAfter) } });
}

/**
 * `storage_hub_rate_limited` (preview only, see faultInjection.ts) answers as Hugging Face
 * does when it throttles the token, so a spec reaches the busy answer through the real route. (CUR-3120)
 */
export async function throwIfHubRateLimitFault(request: Request): Promise<void> {
	if ((await resolveFaultInjection(request)) === "storage_hub_rate_limited") {
		throw hubRateLimitedError("https://huggingface.co/api/buckets (fault injection)");
	}
}
