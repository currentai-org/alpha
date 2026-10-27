/**
 * SSE lifetime vs platform maxDuration invariant.
 *
 * This route holds a streaming Response open for up to MAX_LIFETIME_MS, then closes it gracefully so the
 * client's EventSource reconnects. When the lifetime is not comfortably under the function's maxDuration,
 * the platform kill wins the race instead: every invocation runs the full limit, is billed for it, and
 * dies as "Vercel Runtime Timeout Error: Task timed out".
 *
 * The margin must absorb the poll loop's worst-case overshoot past the deadline (one POLL_INTERVAL_MS
 * tick + one Mongo query + event emits). 45s is an engineering margin far above that, not a proof —
 * the loop also re-checks the deadline right after each tick to keep the overshoot to one poll's work.
 */
import { describe, expect, it } from "vitest";
import { MAX_LIFETIME_MS, PLATFORM_MAX_DURATION_MS } from "./lifetime";

const SAFETY_MARGIN_MS = 45_000;

describe("conversations/updates SSE lifetime", () => {
	// NOT `export const config = { maxDuration }`: a per-route config can drop routes from the
	// catchall manifest (see scripts/verify-route-configs.mjs). The route documents the platform limit
	// as a plain constant instead; this pins the two against each other.
	it("documents the platform kill limit it budgets against", () => {
		expect(PLATFORM_MAX_DURATION_MS).toBe(300_000);
	});

	it("closes the stream comfortably before the platform kill", () => {
		expect(MAX_LIFETIME_MS + SAFETY_MARGIN_MS).toBeLessThanOrEqual(PLATFORM_MAX_DURATION_MS);
	});
});
