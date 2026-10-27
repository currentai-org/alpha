import { describe, it, expect, vi, afterEach } from "vitest";
import { loadAudioClip } from "./loadAudioClip";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("loadAudioClip", () => {
	it("resolves to an object URL built from the fetched bytes", async () => {
		const blob = new Blob(["clip bytes"]);
		const fetchMock = vi.fn(async () => new Response(blob, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const url = await loadAudioClip("https://space.hf.space/clip.wav");

		expect(url).toMatch(/^blob:/);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://space.hf.space/clip.wav",
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it("rejects on a non-OK response instead of returning a broken URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 }))
		);

		await expect(loadAudioClip("https://space.hf.space/missing.wav")).rejects.toThrow(/404/);
	});

	it("rejects on a network error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("network error");
			})
		);

		await expect(loadAudioClip("https://space.hf.space/clip.wav")).rejects.toThrow(
			"network error"
		);
	});

	it("aborts and rejects once the request outlives timeoutMs (a stalled load, CUR-851)", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					// Mirrors the real bug: the request never settles on its own — only the caller's
					// own AbortController moves it, exactly like the stalled <audio> load never firing
					// an error by itself.
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				})
		);
		vi.stubGlobal("fetch", fetchMock);

		const pending = loadAudioClip("https://space.hf.space/stalled.wav", 10_000);
		const assertion = expect(pending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
	});
});
