// The one set of rules for sending a failed model request again, driven through withRetry,
// the only way a caller reaches them. The contracts are the SDK's (what is retryable, where the host's
// wait is read from) plus the turn's deadline: a wait that cannot fit is never started. (CUR-2432)
import { describe, it, expect, vi } from "vitest";
import { isRateLimited, rateLimitDetail, withRetry, type RetryPolicy } from "./retryPolicy";

const policy: RetryPolicy = { maxAttempts: 3, baseMs: 1_000, maxMs: 8_000, reserveMs: 10_000 };
const status = (s: number, headers?: Record<string, string>) =>
	Object.assign(new Error(`${s}`), { status: s, ...(headers ? { headers: new Headers(headers) } : {}) });
const named = (name: string) => Object.assign(new Error(name), { name });

/** Fails once with `err`, then answers. Returns how many sends ran and the waits taken between them. */
async function onceThenOk(
	err: unknown,
	opts: { deadlineAt?: number; now?: number; random?: () => number } = {}
) {
	const waits: number[] = [];
	let sends = 0;
	const result = await withRetry(
		async () => {
			if (sends++ === 0) throw err;
			return "answer";
		},
		{
			policy,
			deadlineAt: opts.deadlineAt,
			now: () => opts.now ?? 1_000_000,
			random: opts.random,
			sleep: async (ms) => {
				waits.push(ms);
			},
		}
	).catch((e: unknown) => e);
	return { result, sends, waits };
}

describe("what counts as worth sending again, by the SDK's rules", () => {
	it("retries 408, 409, 429, every 5xx and a connection failure", async () => {
		for (const err of [
			...[408, 409, 429, 500, 502, 503, 529].map((s) => status(s)),
			named("APIConnectionError"),
			named("APIConnectionTimeoutError"),
		])
			expect((await onceThenOk(err)).result).toBe("answer");
	});

	it("never resends a cancelled request, another 4xx, or an error with no status", async () => {
		for (const err of [
			...[400, 401, 403, 404, 422].map((s) => status(s)),
			named("AbortError"),
			named("APIUserAbortError"),
			new Error("boom"),
		]) {
			const { result, sends } = await onceThenOk(err);
			expect(result).toBe(err);
			expect(sends).toBe(1);
		}
	});

	it("reads a 429 from either status field", () => {
		expect(isRateLimited(status(429))).toBe(true);
		expect(isRateLimited({ statusCode: 429 })).toBe(true);
		expect(isRateLimited(status(503))).toBe(false);
		expect(isRateLimited(null)).toBe(false);
	});
});

describe("the wait before the resend", () => {
	it("prefers the host's retry-after-ms, then retry-after in seconds", async () => {
		expect((await onceThenOk(status(429, { "retry-after-ms": "250", "retry-after": "9" }))).waits).toEqual([250]);
		expect((await onceThenOk(status(429, { "retry-after": "2" }))).waits).toEqual([2_000]);
	});

	it("reads retry-after as an HTTP date, measured from now", async () => {
		const now = Date.parse("2026-09-30T12:00:00Z");
		const err = status(429, { "retry-after": "Wed, 30 Sep 2026 12:00:03 GMT" });
		expect((await onceThenOk(err, { now })).waits).toEqual([3_000]);
	});

	it("reads a plain header record as well as a Headers object", async () => {
		expect((await onceThenOk({ status: 429, headers: { "retry-after": "1" } })).waits).toEqual([1_000]);
	});

	it("backs off with full jitter when the host named no wait, or a nonsense one", async () => {
		for (const headers of [undefined, { "retry-after": "-1" }, { "retry-after": "soon" }])
			expect((await onceThenOk(status(429, headers), { random: () => 0.999 })).waits).toEqual([999]);
	});

	it("widens the jitter ceiling each attempt and stops once the attempts are spent", async () => {
		const waits: number[] = [];
		const send = vi.fn(async () => Promise.reject(status(503)));
		await expect(
			withRetry(send, {
				policy,
				random: () => 0.5,
				sleep: async (ms) => {
					waits.push(ms);
				},
			})
		).rejects.toMatchObject({ status: 503 });
		expect(send).toHaveBeenCalledTimes(3);
		expect(waits).toEqual([500, 1_000]);
	});
});

describe("the turn's deadline", () => {
	const now = 1_000_000;

	it("gives up at once when the wait plus the answer's reserve would pass the deadline", async () => {
		const err = status(429, { "retry-after": "5" });
		const { result, sends, waits } = await onceThenOk(err, { now, deadlineAt: now + 12_000 });
		expect(result).toBe(err);
		expect(sends).toBe(1);
		expect(waits).toEqual([]);
	});

	it("waits when the wait and the reserve both fit", async () => {
		const { result, waits } = await onceThenOk(status(429, { "retry-after": "1" }), {
			now,
			deadlineAt: now + 12_000,
		});
		expect(result).toBe("answer");
		expect(waits).toEqual([1_000]);
	});
});

describe("reporting and cancelling", () => {
	it("reports each retry with the wait and whether the host chose it", async () => {
		const onRetry = vi.fn();
		const send = vi
			.fn<(attempt: number) => Promise<string>>()
			.mockRejectedValueOnce(status(429, { "retry-after-ms": "40" }))
			.mockResolvedValueOnce("answer");
		await expect(withRetry(send, { policy, sleep: async () => {}, onRetry })).resolves.toBe("answer");
		expect(onRetry).toHaveBeenCalledWith({ attempt: 0, delayMs: 40, hostAsked: true, status: 429 });
	});

	it("does not send again when the turn is cancelled during the wait", async () => {
		const ctrl = new AbortController();
		const send = vi.fn(async () => Promise.reject(status(429, { "retry-after-ms": "5000" })));
		const pending = withRetry(send, { policy, signal: ctrl.signal });
		ctrl.abort(new Error("stopped"));
		await expect(pending).rejects.toThrow("stopped");
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("what a 429 said, for the failover log (SOL-200)", () => {
	it("keeps the host's wait and the upstream body from an SDK RateLimitError", () => {
		const err = Object.assign(new Error("429 Rate limit exceeded"), {
			status: 429,
			headers: new Headers({ "retry-after": "12" }),
			error: { message: "Rate limit reached for key sk-…: 60 requests per minute", type: "rate_limit" },
		});
		expect(rateLimitDetail(err)).toEqual({
			retryAfterMs: 12_000,
			upstream: '{"message":"Rate limit reached for key sk-…: 60 requests per minute","type":"rate_limit"}',
		});
	});

	it("cuts a long upstream body to 500 characters", () => {
		const err = Object.assign(new Error("429"), { status: 429, error: "x".repeat(2_000) });
		expect(rateLimitDetail(err).upstream).toHaveLength(500);
	});

	it("falls back to the message, with no wait, for a bare 429 that carries neither", () => {
		const err = Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
		expect(rateLimitDetail(err)).toEqual({ upstream: "429 Rate limit exceeded" });
	});

	it("returns nothing for a plain object 429 with no body, headers or message", () => {
		expect(rateLimitDetail({ status: 429 })).toEqual({});
	});
});
