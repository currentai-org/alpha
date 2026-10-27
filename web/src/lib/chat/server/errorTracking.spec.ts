import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above module-level consts, so the config store is created inside the factory and
// retrieved after — referencing an outer const in the factory throws "cannot access before initialization".
vi.mock("$lib/chat/server/config", () => ({ config: {} as Record<string, string> }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const captureException = vi.fn();
vi.mock("posthog-node", () => ({
	PostHog: class {
		captureException = captureException;
		async shutdown() {}
	},
}));

const { config: configMock } = (await import("$lib/chat/server/config")) as unknown as {
	config: Record<string, string>;
};

// errorTracking caches its client init (`initAttempted`) and holds the counter at module scope, so a
// FRESH instance is required per test — otherwise the first unconfigured test pins client=undefined for
// the whole file and every later assertion about delivery silently tests nothing.
const fresh = async () => {
	vi.resetModules();
	return import("./errorTracking");
};

beforeEach(() => {
	captureException.mockClear();
	for (const k of Object.keys(configMock)) delete configMock[k];
});

describe("error counter (feeds the warm rate probe)", () => {
	it("counts an exception even when PostHog is unconfigured — alerting must not depend on analytics", async () => {
		const { captureServerException, takeErrorCount } = await fresh();
		await captureServerException(new Error("boom"));
		expect(takeErrorCount()).toBe(1);
		expect(captureException).not.toHaveBeenCalled(); // no key ⇒ nothing sent, but still counted
	});

	// THE load-bearing one. Without the reset the value is a cumulative TOTAL, so a single spike parks it
	// above the threshold forever: the probe reports unhealthy on every future tick, the alert never
	// recovers, and the channel gets muted — the exact failure alerting exists to avoid.
	it("RESETS on read, so the value is a rate per tick and not a running total", async () => {
		const { captureServerException, takeErrorCount } = await fresh();
		await captureServerException(new Error("a"));
		await captureServerException(new Error("b"));
		expect(takeErrorCount()).toBe(2);
		expect(takeErrorCount()).toBe(0); // second read of the same window sees nothing new
		await captureServerException(new Error("c"));
		expect(takeErrorCount()).toBe(1);
	});

	it("never throws, so an error handler cannot fail while reporting an error", async () => {
		configMock.PUBLIC_POSTHOG_KEY = "phc_test";
		const { captureServerException, takeErrorCount } = await fresh();
		captureException.mockImplementationOnce(() => {
			throw new Error("posthog exploded");
		});
		await expect(captureServerException(new Error("boom"))).resolves.toBeUndefined();
		expect(takeErrorCount()).toBe(1); // and it still counted for the alert
	});
});

describe("PostHog delivery", () => {
	it("sends the errorId the user was shown, so a support report maps to one grouped exception", async () => {
		configMock.PUBLIC_POSTHOG_KEY = "phc_test";
		const { captureServerException } = await fresh();
		const err = new Error("boom");
		await captureServerException(err, {
			errorId: "abc123",
			url: "https://www.aipotluck.org/chat",
			routeId: "/chat",
			status: 500,
			method: "POST",
		});
		expect(captureException).toHaveBeenCalledTimes(1);
		const [sentError, distinctId, props] = captureException.mock.calls[0];
		expect(sentError).toBe(err);
		expect(distinctId).toBe("aipotluck-server"); // attributed to the deployment, not to a user
		expect(props.error_id).toBe("abc123");
		expect(props.route_id).toBe("/chat");
		expect(props.status).toBe(500);
	});

	// An exception report must not become a side channel for conversation content. This asserts the
	// SHAPE of what leaves the process, not merely that something left.
	it("sends no request body, headers, or user text", async () => {
		configMock.PUBLIC_POSTHOG_KEY = "phc_test";
		const { captureServerException } = await fresh();
		await captureServerException(new Error("boom"), { errorId: "x", url: "https://x/chat" });
		const props = captureException.mock.calls[0][2];
		expect(Object.keys(props).sort()).toEqual([
			"$current_url",
			"error_id",
			"method",
			"route_id",
			"status",
		]);
	});
});
