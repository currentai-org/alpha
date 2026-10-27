import { describe, it, expect, vi } from "vitest";
import { fetchRetryOnce } from "./fetchRetryOnce";

function fakeResponse(status: number): Response {
	return new Response(null, { status });
}

describe("fetchRetryOnce", () => {
	it("retries once and returns the second response when the first hits a listed status", async () => {
		const attempt = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(fakeResponse(504))
			.mockResolvedValueOnce(fakeResponse(200));

		const res = await fetchRetryOnce(attempt, { retryableStatuses: [504] });

		expect(res.status).toBe(200);
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it("does not retry when the first response's status isn't in the retryable list", async () => {
		const attempt = vi.fn<() => Promise<Response>>().mockResolvedValue(fakeResponse(500));

		const res = await fetchRetryOnce(attempt, { retryableStatuses: [504] });

		expect(res.status).toBe(500);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("retries EXACTLY once — a still-broken contract surfaces the retry's own failure, not an infinite loop", async () => {
		const attempt = vi.fn<() => Promise<Response>>().mockResolvedValue(fakeResponse(504));

		const res = await fetchRetryOnce(attempt, { retryableStatuses: [504] });

		expect(res.status).toBe(504);
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it("does not retry a status the caller didn't name, even a related one (429 named, 504 returned)", async () => {
		const attempt = vi.fn<() => Promise<Response>>().mockResolvedValue(fakeResponse(504));

		const res = await fetchRetryOnce(attempt, { retryableStatuses: [429] });

		expect(res.status).toBe(504);
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});
