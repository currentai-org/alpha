import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (_key: string, fallback: () => boolean) => fallback(),
}));

import { withNativeFirst } from "./nativeRolesFirst";

const NATIVE = ["system", "user", "assistant", "user"];
const FLAT = ["user"];

describe("withNativeFirst (CUR-1886)", () => {
	it("serves the native shape and never sends the flattened one when the native attempt succeeds", async () => {
		const sent: string[][] = [];
		const out = await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			attempt: async (m) => (sent.push(m), "ok"),
		});
		expect(out).toEqual({ result: "ok", shape: "native" });
		expect(sent).toEqual([NATIVE]);
	});

	it("resends flattened, once, when the native attempt errors — the gateway rejecting roles", async () => {
		const sent: string[][] = [];
		const out = await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			attempt: async (m) => {
				sent.push(m);
				if (m === NATIVE) throw new Error("503 substituted");
				return "flat-ok";
			},
		});
		expect(out.shape).toBe("flat-retry");
		expect(out.result).toBe("flat-ok");
		expect(out.reason).toContain("503");
		expect(sent).toEqual([NATIVE, FLAT]);
	});

	it("does not send a flattened resend when the native attempt is rate-limited (429); the 429 surfaces (CUR-2330)", async () => {
		const sent: string[][] = [];
		const rateLimited = Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
		await expect(
			withNativeFirst({
				native: NATIVE,
				flat: () => FLAT,
				attempt: async (m) => {
					sent.push(m);
					if (m === NATIVE) throw rateLimited;
					return "flat-ok";
				},
			})
		).rejects.toBe(rateLimited);
		expect(sent).toEqual([NATIVE]);
	});

	it("still resends flattened on a 400 from the native attempt: only a rate limit skips the resend (CUR-2330)", async () => {
		const sent: string[][] = [];
		const rejected = Object.assign(new Error("400 roles not supported"), { status: 400 });
		const out = await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			attempt: async (m) => {
				sent.push(m);
				if (m === NATIVE) throw rejected;
				return "flat-ok";
			},
		});
		expect(out.shape).toBe("flat-retry");
		expect(sent).toEqual([NATIVE, FLAT]);
	});

	it("a native attempt that hangs costs the hedge delay, not its whole hang: flat serves and native is cancelled (CUR-2012)", async () => {
		let nativeSignal: AbortSignal | undefined;
		const t0 = Date.now();
		const out = await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			hedgeAfterMs: 20,
			attempt: (m, signal) => {
				if (m !== NATIVE) return Promise.resolve("flat-ok");
				nativeSignal = signal;
				return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
			},
		});
		expect(out).toMatchObject({ shape: "flat-retry", result: "flat-ok", reason: "no headers in 20ms" });
		expect(nativeSignal?.aborted).toBe(true);
		expect(Date.now() - t0).toBeLessThan(500);
	});

	it("a slow native attempt still serves if it answers before the flattened one, and the flattened one is cancelled (CUR-2012)", async () => {
		let flatSignal: AbortSignal | undefined;
		const out = await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			hedgeAfterMs: 10,
			attempt: (m, signal) => {
				if (m === NATIVE) return new Promise((r) => setTimeout(() => r("native-ok"), 40));
				flatSignal = signal;
				return new Promise((r) => setTimeout(() => r("flat-ok"), 200));
			},
		});
		expect(out.shape).toBe("native");
		expect(out.result).toBe("native-ok");
		expect(out.reason).toContain("native won the hedge");
		expect(flatSignal?.aborted).toBe(true);
	});

	it("waits for the native attempt when the hedged flattened request fails first", async () => {
		const out = await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			hedgeAfterMs: 10,
			attempt: (m) =>
				m === NATIVE
					? new Promise((r) => setTimeout(() => r("native-ok"), 60))
					: Promise.reject(new Error("400 at capacity")),
		});
		expect(out).toMatchObject({ shape: "native", result: "native-ok" });
	});

	it("rejects with the flattened error when both shapes fail — never hangs and never resolves empty", async () => {
		await expect(
			withNativeFirst({
				native: NATIVE,
				flat: () => FLAT,
				hedgeAfterMs: 10,
				attempt: (m) => Promise.reject(new Error(m === NATIVE ? "native-err" : "flat-err")),
			})
		).rejects.toThrow("flat-err");
	});

	it("does NOT resend when the caller aborted — the person who asked has gone", async () => {
		const caller = new AbortController();
		const attempt = vi.fn(async (_m: string[], signal: AbortSignal | undefined) => {
			caller.abort();
			throw signal?.reason ?? new Error("aborted");
		});
		await expect(
			withNativeFirst({ native: NATIVE, flat: () => FLAT, attempt, signal: caller.signal })
		).rejects.toBeDefined();
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("clears the hedge once native headers arrive: no flattened request is sent and the stream is never cut", async () => {
		let signalSeen: AbortSignal | undefined;
		const sent: string[][] = [];
		await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			hedgeAfterMs: 20,
			attempt: async (m, signal) => (sent.push(m), (signalSeen = signal), "ok"),
		});
		await new Promise((r) => setTimeout(r, 60));
		expect(signalSeen?.aborted).toBe(false);
		expect(sent).toEqual([NATIVE]);
	});

	it("passes the caller's abort through to the native attempt", async () => {
		const caller = new AbortController();
		let signalSeen: AbortSignal | undefined;
		await withNativeFirst({
			native: NATIVE,
			flat: () => FLAT,
			signal: caller.signal,
			attempt: async (_m, signal) => ((signalSeen = signal), "ok"),
		});
		caller.abort();
		expect(signalSeen?.aborted).toBe(true);
	});
});
