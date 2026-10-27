import { describe, it, expect, vi, beforeEach } from "vitest";
import { FLAG_KEY_NAMES } from "./flagKeys";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
const flagOn = vi.fn(() => true);
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => flagOn() }));
const error = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { error: (...a: unknown[]) => error(...a), warn: vi.fn(), info: vi.fn() },
}));

const { READ_ALOUD_FLAG, readAloudEnabled } = await import("./readAloudGate");

// Read-aloud has two places that can switch it off: server synthesis and the composer toggle
// (CUR-225). Turning the feature on server-side alone produces audio nobody can reach: the rollout
// reads as successful and every user sees nothing.
//
// Both answer to readAloudEnabled(), and this file makes a divergence between them go red. Without
// it, a toggle hardcoded back to `hidden` while the flag stays wired everywhere else passes the whole
// fast suite.
//
// The composer half of that invariant (the toggle is offered iff readAloudEnabled) is tested as
// behaviour in src/lib/chat/components/chat/composerTools.spec.ts (the composer renders its tools from
// composerTools()), not as a source-text scan (a test should not assert on source text).

describe("read-aloud has ONE gate, not two", () => {
	beforeEach(() => {
		for (const k of Object.keys(cfg)) delete cfg[k];
		flagOn.mockReturnValue(true);
	});

	it("registers its key, so refreshFlags reconciles it against PostHog", () => {
		expect(FLAG_KEY_NAMES).toContain(READ_ALOUD_FLAG);
	});

	// The Space's address used to be a second, undocumented switch. (CUR-3151)
	it("is on with the flag and the router credential alone", () => {
		cfg.HF_TOKEN = "hf_test";
		expect(readAloudEnabled()).toBe(true);
	});

	it("is off when the flag is off, even with the credential set", () => {
		cfg.HF_TOKEN = "hf_test";
		flagOn.mockReturnValue(false);
		expect(readAloudEnabled()).toBe(false);
	});

	it("withholds read aloud and logs an error (fail loud) when the flag is on but HF_TOKEN is unset", () => {
		expect(readAloudEnabled()).toBe(false);
		expect(error).toHaveBeenCalledWith(
			{ flag: READ_ALOUD_FLAG },
			expect.stringContaining("HF_TOKEN is unset")
		);
	});
});
