// A live vendor test that hard-fails on a transient HTTP status (a gateway 504, arXiv's 429
// rate limit) with no retry is indistinguishable from a genuinely broken contract. This is the one
// shared retry for the live specs' vendor calls.
//
// Retries exactly ONCE, and only for statuses the caller explicitly names as transient. A blanket
// retry-on-any-failure would mask a real broken contract as flakiness, which is the opposite of what
// these tests exist to catch. (CUR-1303)
export async function fetchRetryOnce(
	attempt: () => Promise<Response>,
	opts: { retryableStatuses: readonly number[]; delayMs?: number }
): Promise<Response> {
	const first = await attempt();
	if (!opts.retryableStatuses.includes(first.status)) return first;
	if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
	return attempt();
}
