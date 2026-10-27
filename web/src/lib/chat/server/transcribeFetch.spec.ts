import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionStalled, fetchWithStallRetry, upstreamContentType } from "./transcribeFetch";

// The contract under test: one attempt gets 15s, and there are two of them.
const ATTEMPT_MS = 15_000;

// A fetch that never answers until its signal aborts, which is how a stalled upstream looks.
function stalled(signal: AbortSignal): Promise<Response> {
	return new Promise((_, reject) => {
		signal.onabort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
	});
}

describe("fetchWithStallRetry (CUR-2328)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts a second attempt at 15s when the first never answers, and returns its answer", async () => {
		const starts: number[] = [];
		const send = vi.fn((signal: AbortSignal) => {
			starts.push(Date.now());
			return starts.length === 1 ? stalled(signal) : Promise.resolve(new Response('{"text":"hi"}'));
		});
		const t0 = Date.now();
		const pending = fetchWithStallRetry(send);
		await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
		const { response, attempts } = await pending;
		expect(starts.map((s) => s - t0)).toEqual([0, ATTEMPT_MS]);
		expect(await response.json()).toEqual({ text: "hi" });
		expect(attempts.map((a) => a.outcome)).toEqual(["stalled", "answered"]);
	});

	it("gives up after two stalls at 30s rather than waiting out a minute", async () => {
		const pending = fetchWithStallRetry(stalled);
		const outcome = expect(pending).rejects.toBeInstanceOf(TranscriptionStalled);
		await vi.advanceTimersByTimeAsync(2 * ATTEMPT_MS);
		await outcome;
	});

	it("does not retry an upstream error status, since that is an answer, not a stall", async () => {
		const send = vi.fn(() => Promise.resolve(new Response("bad", { status: 503 })));
		const { response, attempts } = await fetchWithStallRetry(send);
		expect(response.status).toBe(503);
		expect(send).toHaveBeenCalledTimes(1);
		expect(attempts).toHaveLength(1);
	});
});

describe("upstreamContentType (CUR-2802)", () => {
	it("sends an mp4 recording as audio/m4a, the name the transcriber accepts for that container", () => {
		expect(upstreamContentType("audio/mp4")).toBe("audio/m4a");
		expect(upstreamContentType("audio/mp4;codecs=opus")).toBe("audio/m4a");
	});

	it("sends every other type unchanged", () => {
		expect(upstreamContentType("audio/webm;codecs=opus")).toBe("audio/webm;codecs=opus");
		expect(upstreamContentType("audio/ogg")).toBe("audio/ogg");
	});
});
