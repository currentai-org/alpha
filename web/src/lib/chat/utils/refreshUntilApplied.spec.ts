import { describe, expect, test, vi } from "vitest";

import { refreshUntilApplied } from "./refreshUntilApplied";

/**
 * Models the SvelteKit behavior the helper exists for: `invalidate()` resolves whether or not it
 * APPLIED (a load superseded by a newer invalidation returns before update(), so the reactive
 * value keeps its identity). The harness's `invalidate` applies (swaps identity) only on the
 * attempts the test marks as winning the router's latest-wins token.
 */
function harness(appliesOnAttempt: (attempt: number) => boolean) {
	let current: object = { gen: 0 };
	let attempt = 0;
	const invalidate = vi.fn(async () => {
		attempt += 1;
		if (appliesOnAttempt(attempt)) {
			current = { gen: attempt }; // every applied load constructs a fresh identity
		}
	});
	return {
		invalidate,
		getCurrent: () => current,
		/** A concurrent (poller/devtools) invalidation applying between our attempts. */
		externalApply: () => {
			current = { external: true };
		},
	};
}

describe("refreshUntilApplied", () => {
	test("first attempt applies → observed, one call", async () => {
		const h = harness(() => true);

		await expect(
			refreshUntilApplied({ getCurrent: h.getCurrent, invalidate: h.invalidate })
		).resolves.toBe(true);
		expect(h.invalidate).toHaveBeenCalledTimes(1);
	});

	test("superseded attempts resolve without applying → retries until one applies", async () => {
		// Attempts 1 and 2 are superseded (resolve, no apply); attempt 3 wins the token.
		const h = harness((attempt) => attempt === 3);

		await expect(
			refreshUntilApplied({ getCurrent: h.getCurrent, invalidate: h.invalidate })
		).resolves.toBe(true);
		expect(h.invalidate).toHaveBeenCalledTimes(3);
	});

	test("attempt budget exhausted without an apply → false (liveness over a permanent wait)", async () => {
		const h = harness(() => false);

		await expect(
			refreshUntilApplied({ getCurrent: h.getCurrent, invalidate: h.invalidate })
		).resolves.toBe(false);
		expect(h.invalidate).toHaveBeenCalledTimes(3); // default budget
	});

	test("a superseding external apply satisfies the loop — its data is strictly fresher", async () => {
		const h = harness(() => false); // our own attempts never apply…
		const invalidate = vi.fn(async () => {
			await h.invalidate();
			h.externalApply(); // …but the superseding load lands right after our first attempt
		});

		await expect(
			refreshUntilApplied({ getCurrent: h.getCurrent, invalidate })
		).resolves.toBe(true);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	test("`before` stays fixed across attempts — an early external apply is never re-awaited", async () => {
		// If the loop re-captured `before` per attempt, the external apply after attempt 1 would be
		// treated as the new baseline and attempt 2 would run. Pinned: it must exit instead.
		const h = harness(() => false);
		let calls = 0;
		const invalidate = vi.fn(async () => {
			calls += 1;
			if (calls === 1) h.externalApply();
		});

		await expect(
			refreshUntilApplied({ getCurrent: h.getCurrent, invalidate })
		).resolves.toBe(true);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	test("honors a custom attempt budget", async () => {
		const h = harness(() => false);

		await expect(
			refreshUntilApplied({ getCurrent: h.getCurrent, invalidate: h.invalidate, attempts: 1 })
		).resolves.toBe(false);
		expect(h.invalidate).toHaveBeenCalledTimes(1);
	});

	test("a rejecting invalidate propagates — the caller's finally owns hold release", async () => {
		const current = {}; // stable identity: the refresh never applies
		const invalidate = vi.fn(async () => {
			throw new Error("load failed");
		});

		await expect(
			refreshUntilApplied({ getCurrent: () => current, invalidate })
		).rejects.toThrow("load failed");
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});
