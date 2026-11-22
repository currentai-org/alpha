import { describe, it, expect, vi, beforeEach } from "vitest";

// serverPosthogHost reads PUBLIC_POSTHOG_HOST through the `config` proxy; mock it with a mutable object.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const DEFAULT = "https://eu.i.posthog.com";

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
});

describe("serverPosthogHost — a relative browser proxy path is never a server host", () => {
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
		cfg.PUBLIC_POSTHOG_HOST = "  https://eu.i.posthog.com  ";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe(DEFAULT);
	});
});

// with a relative browser host, the server reaches the same PostHog the /rs proxy forwards to.
describe("serverPosthogHost — follows POSTHOG_INGEST_HOST when the browser host is relative", () => {
	it("uses POSTHOG_INGEST_HOST behind a relative /rs browser host", async () => {
		cfg.PUBLIC_POSTHOG_HOST = "/rs";
		cfg.POSTHOG_INGEST_HOST = "https://ph.example.org";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe("https://ph.example.org");
	});

	it("an absolute PUBLIC_POSTHOG_HOST still wins over POSTHOG_INGEST_HOST", async () => {
		cfg.PUBLIC_POSTHOG_HOST = "https://ph.example.net";
		cfg.POSTHOG_INGEST_HOST = "https://eu.i.posthog.com";
		const { serverPosthogHost } = await import("./posthogHost");
		expect(serverPosthogHost()).toBe("https://ph.example.net");
	});
});
