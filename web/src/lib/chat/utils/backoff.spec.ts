import { describe, it, expect, vi } from "vitest";
import { jitteredDelay, retryWithBackoff } from "./backoff";

describe("jitteredDelay", () => {
	it("returns 0 when the RNG yields 0", () => {
		expect(jitteredDelay(0, { random: () => 0 })).toBe(0);
		expect(jitteredDelay(5, { random: () => 0 })).toBe(0);
	});
	it("approaches the exponential ceiling as the RNG approaches 1", () => {
		// attempt 2, base 300 -> ceil 1200; random just under 1 -> ~1199
		expect(jitteredDelay(2, { baseMs: 300, random: () => 0.999 })).toBe(1198);
	});
	it("clamps the ceiling to maxMs", () => {
		// base 300 * 2^10 = 307200, clamped to maxMs 1000; random 1(-) -> <=999
		expect(jitteredDelay(10, { baseMs: 300, maxMs: 1000, random: () => 0.999 })).toBeLessThan(1000);
	});
	it("grows the ceiling exponentially with attempt", () => {
		const max = (a: number) => jitteredDelay(a, { baseMs: 100, maxMs: 1e9, random: () => 0.999 });
		expect(max(1)).toBeGreaterThan(max(0));
		expect(max(2)).toBeGreaterThan(max(1));
	});
});

describe("retryWithBackoff", () => {
	const noSleep = () => Promise.resolve();

	it("returns the first success without retrying", async () => {
		const fn = vi.fn().mockResolvedValue("ok");
		await expect(retryWithBackoff(fn, { sleep: noSleep })).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries then succeeds", async () => {
		const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
		await expect(retryWithBackoff(fn, { sleep: noSleep, random: () => 0 })).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("throws the last error after exhausting attempts", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("always"));
		await expect(retryWithBackoff(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow("always");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("does not retry when shouldRetry returns false", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("fatal"));
		await expect(
			retryWithBackoff(fn, { attempts: 5, shouldRetry: () => false, sleep: noSleep })
		).rejects.toThrow("fatal");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("reports each retry via onRetry", async () => {
		const onRetry = vi.fn();
		const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
		await retryWithBackoff(fn, { sleep: noSleep, onRetry, random: () => 0 });
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, 0);
	});
});
