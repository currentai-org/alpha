import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_BUSY_FALLBACK_SECONDS, hubFetch, hubRetryAfterSeconds, resetHubThrottle } from "./hubThrottle";

// Hugging Face counts the storage token's calls over 5-minute fixed windows and says when the
// window resets in `RateLimit`'s `t`. A busy answer's Retry-After is that reset, and a call made before
// it fails busy without spending quota the window no longer has. (CUR-3680)
const throttled = (t: number) =>
	new Response(null, { status: 429, headers: { ratelimit: `"api";r=0;t=${t}`, "ratelimit-policy": `"fixed window";"api";q=3000;w=300` } });

describe("hubFetch", () => {
	const inner = vi.fn<typeof fetch>();

	beforeEach(() => {
		vi.useFakeTimers({ now: new Date("2026-10-10T02:00:00Z") });
		resetHubThrottle();
		inner.mockReset();
		vi.stubGlobal("fetch", inner);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("makes Retry-After the window's reset from RateLimit's t, not a fixed 30 s", async () => {
		inner.mockResolvedValue(throttled(170));
		const res = await hubFetch("https://huggingface.co/api/buckets/x/tree");
		expect(res.status).toBe(429);
		expect(hubRetryAfterSeconds()).toBe(170);
		vi.advanceTimersByTime(70_000);
		expect(hubRetryAfterSeconds()).toBe(100);
	});

	it("answers 429 without calling Hugging Face until the window resets, then calls again", async () => {
		inner.mockResolvedValueOnce(throttled(170));
		await hubFetch("https://huggingface.co/api/buckets/x/tree");
		expect(inner).toHaveBeenCalledTimes(1);

		const held = await hubFetch("https://huggingface.co/api/buckets/x/tree");
		expect(held.status).toBe(429);
		expect(inner).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(170_000);
		inner.mockResolvedValueOnce(new Response("[]", { status: 200 }));
		expect((await hubFetch("https://huggingface.co/api/buckets/x/tree")).status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(2);
	});

	it("falls back to 30 s, and holds calls that long, when a 429 carries no RateLimit header", async () => {
		inner.mockResolvedValue(new Response(null, { status: 429 }));
		await hubFetch("https://huggingface.co/api/buckets/x/tree");
		expect(hubRetryAfterSeconds()).toBe(HUB_BUSY_FALLBACK_SECONDS);
		expect(HUB_BUSY_FALLBACK_SECONDS).toBe(30);
	});

	it("passes a success through and records no throttle", async () => {
		inner.mockImplementation(async () => new Response("[]", { status: 200, headers: { ratelimit: `"api";r=1870;t=129` } }));
		expect((await hubFetch("https://huggingface.co/api/buckets/x/tree")).status).toBe(200);
		expect(hubRetryAfterSeconds()).toBe(HUB_BUSY_FALLBACK_SECONDS);
		await hubFetch("https://huggingface.co/api/buckets/x/tree");
		expect(inner).toHaveBeenCalledTimes(2);
	});

	// A listing page gets 15 s, body included, so a tree listing that never answers cannot hold GET /chat/api/storage until the socket closes. (CUR-3980)
	const hangsUntilAborted: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

	it("answers a tree listing Hugging Face never answers as busy (429) after the deadline, instead of hanging", async () => {
		inner.mockImplementation(hangsUntilAborted);
		const pending = hubFetch("https://huggingface.co/api/buckets/x/tree/main/users%2Fu?recursive=true");
		await vi.advanceTimersByTimeAsync(15_000);
		expect((await pending).status).toBe(429);
	});

	it("holds no later call after a missed listing deadline, since a slow listing is not a Hub rate limit", async () => {
		inner.mockImplementationOnce(hangsUntilAborted);
		const pending = hubFetch("https://huggingface.co/api/buckets/x/tree/main");
		await vi.advanceTimersByTimeAsync(15_000);
		expect((await pending).status).toBe(429);

		inner.mockResolvedValueOnce(new Response(null, { status: 200 }));
		expect((await hubFetch("https://huggingface.co/api/buckets/x/commit/main", { method: "POST" })).status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(2);
	});

	it("leaves an upload with no deadline, since its size sets how long it takes", async () => {
		inner.mockImplementation(hangsUntilAborted);
		let settled = false;
		void hubFetch("https://huggingface.co/api/buckets/x/commit/main", { method: "POST" }).finally(() => (settled = true));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settled).toBe(false);
	});

	it("rethrows when the caller itself aborted the listing, rather than calling it busy", async () => {
		inner.mockImplementation(hangsUntilAborted);
		const caller = new AbortController();
		const pending = hubFetch("https://huggingface.co/api/buckets/x/tree/main", { signal: caller.signal });
		caller.abort();
		await expect(pending).rejects.toThrow("aborted");
	});
});
