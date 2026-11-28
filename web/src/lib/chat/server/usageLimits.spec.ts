import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({ mockConfig: {} as Record<string, string | undefined> }));
vi.mock("$lib/chat/server/config", () => ({ config: mockConfig }));

async function loadUsageLimits() {
	vi.resetModules();
	return (await import("$lib/chat/server/usageLimits")).usageLimits;
}

describe("a stack that sets no RATE_LIMIT still limits each session per minute", () => {
	beforeEach(() => {
		for (const key of Object.keys(mockConfig)) delete mockConfig[key];
	});

	it("applies 20 messages a minute when RATE_LIMIT and USAGE_LIMITS are unset", async () => {
		expect((await loadUsageLimits())?.messagesPerMinute).toBe(20);
	});

	it("applies 20 when RATE_LIMIT is blank, as an empty .env line leaves it", async () => {
		mockConfig.RATE_LIMIT = "  ";
		mockConfig.USAGE_LIMITS = "";
		expect((await loadUsageLimits())?.messagesPerMinute).toBe(20);
	});

	it("takes the operator's RATE_LIMIT, and 0 still turns the limit off", async () => {
		mockConfig.RATE_LIMIT = "35";
		expect((await loadUsageLimits())?.messagesPerMinute).toBe(35);
		mockConfig.RATE_LIMIT = "0";
		expect((await loadUsageLimits())?.messagesPerMinute).toBe(0);
	});

	it("lets USAGE_LIMITS.messagesPerMinute win over RATE_LIMIT", async () => {
		mockConfig.RATE_LIMIT = "35";
		mockConfig.USAGE_LIMITS = '{"messagesPerMinute": 8}';
		expect((await loadUsageLimits())?.messagesPerMinute).toBe(8);
	});
});
