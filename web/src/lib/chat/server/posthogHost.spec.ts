import { describe, it, expect, vi, beforeEach } from "vitest";

// serverPosthogHost reads PUBLIC_POSTHOG_HOST through the `config` proxy; mock it with a mutable object.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const DEFAULT = "https://us.i.posthog.com";

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
});

describe("serverPosthogHost — a relative browser proxy path is never a server host (CUR-87)", () => {
	it("falls back to the absolute default when the host is the relative adblock-proxy path /rs", async () => {
		// This is the preview misconfiguration that makes getAllFlags return {} and pins every
		// flag to its env fallback while REPORTING healthy. The regression this file guards.
		cfg.PUBLIC_POSTHOG_HOST = "/rs";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe(DEFAULT);
	});

	it("falls back to the default when unset", async () => {
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe(DEFAULT);
	});

	it("falls back to the default when empty or whitespace", async () => {
		cfg.PUBLIC_POSTHOG_HOST = "   ";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe(DEFAULT);
	});

	it("rejects any relative path, not just /rs", async () => {
		cfg.PUBLIC_POSTHOG_HOST = "/ingest";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe(DEFAULT);
	});

	it("honors an absolute host — a first-party server-side proxy is allowed", async () => {
		cfg.PUBLIC_POSTHOG_HOST = "https://ph.aipotluck.org";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe("https://ph.aipotluck.org");
	});

	it("trims surrounding whitespace on an absolute host", async () => {
		cfg.PUBLIC_POSTHOG_HOST = "  https://us.i.posthog.com  ";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe(DEFAULT);
	});
});
