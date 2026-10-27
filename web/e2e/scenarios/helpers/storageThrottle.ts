import { expect, type APIResponse, type Page } from '@playwright/test';

// Every preview and develop shares one Hugging Face storage token, capped at 3,000 Hub calls
// per 5-minute window. When another run spends it, the storage routes answer a busy 503 whose
// Retry-After is the seconds left in that window (hubThrottle.ts reads it from Hugging Face). Waiting
// the window out held a shard for up to five minutes, and several shards waiting at once spent the next
// window together, so a spec fails at once and names the throttle instead. A toPass that failed as "did
// not answer 200" would read as our bug.

const STORAGE_LIST = '/chat/api/storage';

/** Retry-After's seconds on a busy 503 from the storage routes, or null for any other answer. */
function busySeconds(res: APIResponse): number | null {
	if (res.status() !== 503) return null;
	const seconds = Number(res.headers()['retry-after']);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Fails this test at once, naming the cause, when Hugging Face is throttling the shared storage token.
 * Called before a toPass poll that reads the bucket, which would otherwise time out as a wrong answer.
 */
export async function failIfStorageThrottled(page: Page): Promise<void> {
	const seconds = busySeconds(await page.request.get(STORAGE_LIST));
	expect(
		seconds,
		`Hugging Face is throttling the shared storage token for another ${seconds}s: infrastructure, not this change`
	).toBeNull();
}
