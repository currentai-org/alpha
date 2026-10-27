import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors flags.spec.ts's own mocking shape — flags.ts lazily imports posthog-node and reads env
// through the config proxy, both mocked so the fallback ladder can be driven without a network.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const getAllFlags = vi.fn();
class FakePostHog {
	getAllFlags = getAllFlags;
	getFeatureFlag = vi.fn();
	async shutdown() {}
}
vi.mock("posthog-node", () => ({ PostHog: FakePostHog }));

beforeEach(async () => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	getAllFlags.mockReset();
	const flags = await import("./flags");
	flags.__resetFlagsForTest();
});

// On cold start (before PostHog's first successful poll) this flag fails closed unconditionally,
// regardless of what the LLM_SUMMARIZATION env var says. (CUR-891)
describe("conversationTitlesEnabled — cold start fails closed (CUR-891)", () => {
	it("is off before PostHog has ever been polled, even when LLM_SUMMARIZATION=true", async () => {
		cfg.PUBLIC_POSTHOG_KEY = "phc_test";
		cfg.LLM_SUMMARIZATION = "true";
		const { conversationTitlesEnabled } = await import("./conversationTitles");
		expect(conversationTitlesEnabled()).toBe(false);
	});

	it("still turns on once PostHog has actually polled it on", async () => {
		cfg.PUBLIC_POSTHOG_KEY = "phc_test";
		getAllFlags.mockResolvedValue({ "conversation-titles": true });
		const flags = await import("./flags");
		await flags.refreshFlags();
		const { conversationTitlesEnabled } = await import("./conversationTitles");
		expect(conversationTitlesEnabled()).toBe(true);
	});
});
