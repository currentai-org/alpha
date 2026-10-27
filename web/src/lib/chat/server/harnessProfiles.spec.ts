import { describe, expect, it, vi } from "vitest";

const error = vi.fn();
const warn = vi.fn();
vi.mock("./logger", () => ({ logger: { error: (...a: unknown[]) => error(...a), info: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn() } }));

const { contextTokensFor, firstChunkMsFor, generationTimeoutMsFor, silentGiveUpMsFor, flattensRolesUnprobed, opensReasoningUntagged, replyLanguageRuleFits, restatesRuleAfterFence, takesStrictLane } =
	await import("./harnessProfiles");
const qualification = (await import("./data/model-qualification.json")).default as { checks: Record<string, unknown> };

describe("harness profiles (CUR-2697)", () => {
	it("has a row for every model with a qualification record, so nothing MODEL_ALLOWLIST can offer falls to the plain harness unseen", () => {
		error.mockClear();
		for (const id of Object.keys(qualification.checks)) replyLanguageRuleFits(id);
		expect(error.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual([]);
	});

	it("gives Mistral Large 3 no extra, only the one rule it was measured to be hurt by turned off", () => {
		expect(replyLanguageRuleFits("mistral-large-2512")).toBe(false);
		expect(opensReasoningUntagged("mistral-large-2512")).toBe(false);
		expect(restatesRuleAfterFence("mistral-large-2512")).toBe(false);
	});

	it("keeps the reply-language sentence for Large 4 (preview), since Large 3's measurement is not Large 4's (CUR-3027)", () => {
		error.mockClear();
		expect(replyLanguageRuleFits("mistral-large-2610")).toBe(true);
		expect(contextTokensFor("mistral-large-2610")).toBe(524_288);
		expect(error).not.toHaveBeenCalled();
	});

	it("looks up exactly, case-insensitive and with the :provider suffix stripped, and never by prefix", () => {
		expect(opensReasoningUntagged("BSC-LT/ALIA-40b-instruct:nextbit")).toBe(true);
		expect(restatesRuleAfterFence("speakleash/Bielik-11B-v3.0-Instruct:plgrid")).toBe(true);
		// A sibling build does not inherit a row by sharing a prefix.
		expect(restatesRuleAfterFence("speakleash/Bielik-11B-v3.0-Instruct-preview")).toBe(false);
	});

	it("gives an unlisted model the plain harness and logs it once, never another model's profile", () => {
		error.mockClear();
		expect(replyLanguageRuleFits("example/unlisted-model-7b")).toBe(true);
		expect(restatesRuleAfterFence("Example/Unlisted-Model-7B:someprovider")).toBe(false);
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("matches a name the provider sent back without logging it, since that is not a catalog entry", () => {
		error.mockClear();
		expect(opensReasoningUntagged("openai/swiss-ai/apertus-70b-instruct")).toBe(false);
		expect(error).not.toHaveBeenCalled();
	});

	it("puts every Apertus row, and nothing else, on the strict lane and the unprobed flatten (CUR-2697)", () => {
		const apertus = Object.keys(qualification.checks).filter((id) => id.toLowerCase().startsWith("swiss-ai/"));
		expect(apertus.length).toBeGreaterThan(0);
		for (const id of Object.keys(qualification.checks)) {
			const isApertus = apertus.includes(id);
			expect([id, takesStrictLane(id)]).toEqual([id, isApertus]);
			expect([id, flattensRolesUnprobed(id)]).toEqual([id, isApertus]);
		}
		expect(takesStrictLane("swiss-ai/Apertus-v1.5-70B:infomaniak")).toBe(true);
		expect(takesStrictLane("zai-org/glm-5.2")).toBe(false);
	});

	it("keeps an unlisted Apertus-looking id off the strict lane and quiet, since only an exact row opts in", () => {
		error.mockClear();
		expect(takesStrictLane("swiss-ai/apertus-70b-instruct")).toBe(false);
		expect(flattensRolesUnprobed("swiss-ai/apertus-70b-instruct")).toBe(false);
		expect(error).not.toHaveBeenCalled();
	});

	it("keeps the reply-language sentence when no model is named", () => {
		expect(replyLanguageRuleFits(undefined)).toBe(true);
		expect(opensReasoningUntagged(undefined)).toBe(false);
	});
});

describe("contextTokensFor (CUR-2893)", () => {
	it("gives Mistral its published 262144 and every self-hosted lane the measured 32000 floor", () => {
		expect(contextTokensFor("mistral-large-2512")).toBe(262_144);
		expect(contextTokensFor("Mistral-Small-2603:mistral")).toBe(262_144);
		expect(contextTokensFor("mistral-medium-2604")).toBe(262_144);
		expect(contextTokensFor("swiss-ai/apertus-v1.5-70b")).toBe(32_000);
		expect(contextTokensFor("zai-org/glm-5.2:scaleway")).toBe(32_000);
	});

	it("falls to the 32000 floor, never a larger number, for a model with no row", () => {
		expect(contextTokensFor("someone/new-model")).toBe(32_000);
		expect(contextTokensFor(undefined)).toBe(32_000);
	});
});

describe("firstChunkMsFor (CUR-3487)", () => {
	it("gives SEA-LION 4.8 an allowance above its measured 16s prefill and under the screen's 25s", () => {
		const ms = firstChunkMsFor("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B");
		expect(ms).toBeGreaterThan(16_000);
		expect(ms).toBeLessThan(25_000);
	});

	it("gives Apertus 1.5 70B 30s, past its lane's 9.8s p90, so neither the hedge nor the move-on fires before it (CUR-4403)", () => {
		expect(firstChunkMsFor("swiss-ai/apertus-v1.5-70b")).toBe(30_000);
	});

	it("returns null, so the fleet defaults apply, for every other model and an unlisted one", () => {
		expect(firstChunkMsFor("mistral-large-2512")).toBeNull();
		expect(firstChunkMsFor("swiss-ai/apertus-v1.5-70b-thinking")).toBeNull();
		expect(firstChunkMsFor("aisingapore/Gemma-SEA-LION-v4-27B-IT")).toBeNull();
		expect(firstChunkMsFor("someone/new-model")).toBeNull();
		expect(firstChunkMsFor(undefined)).toBeNull();
	});
});

describe("silentGiveUpMsFor (CUR-3939)", () => {
	it("gives the models measured fast on production a give-up past the 8s hedge and under the 45s watchdog", () => {
		for (const id of ["swiss-ai/apertus-v1.5-8b", "mistral-large-2512", "zai-org/GLM-5.2", "speakleash/Bielik-11B-v3.0-Instruct"]) {
			const ms = silentGiveUpMsFor(id);
			expect(ms, id).toBeGreaterThan(8_000);
			expect(ms, id).toBeLessThan(45_000);
		}
	});

	it("gives Apertus 1.5 70B a give-up past its own 30s hedge and under its own 60s watchdog (CUR-4403)", () => {
		const id = "swiss-ai/apertus-v1.5-70b";
		expect(silentGiveUpMsFor(id)).toBe(45_000);
		expect(silentGiveUpMsFor(id)!).toBeGreaterThan(firstChunkMsFor(id)!);
		expect(silentGiveUpMsFor(id)!).toBeLessThan(generationTimeoutMsFor(id)!);
	});

	it("leaves the models measured past 20s, and any unlisted model, on the watchdog", () => {
		for (const id of [
			"BSC-LT/ALIA-40b-instruct",
			"aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B",
			"aisingapore/Qwen-SEA-LION-v4-32B-IT",
			"aisingapore/Gemma-SEA-LION-v4-27B-IT",
			"someone/new-model",
		])
			expect(silentGiveUpMsFor(id), id).toBeNull();
		expect(silentGiveUpMsFor(undefined)).toBeNull();
	});

	// A missing row on a user's local endpoint or the agent route is expected, and an error line
	// for it counted toward axiom-alert's server-errors. A catalog id with no row must still log at error. (CUR-4358)
	it("logs a missing row at error for an unknown catalog id, at warn for a local endpoint or the agent route", () => {
		error.mockClear();
		warn.mockClear();
		replyLanguageRuleFits("acme/never-heard-of-it-cur4358");
		expect(error.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual(["acme/never-heard-of-it-cur4358"]);
		error.mockClear();
		replyLanguageRuleFits("local:ce4969c63b0ca773ce030e45:unsloth/qwen3.5-4b-gguf");
		replyLanguageRuleFits("potluck-agent");
		expect(error).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(2);
		expect((warn.mock.calls[1][0] as { model: string }).model).toBe("potluck-agent");
	});
});

describe("generationTimeoutMsFor (CUR-4403)", () => {
	it("gives Apertus 1.5 70B a 60s watchdog floor, past the fleet's 45s", () => {
		expect(generationTimeoutMsFor("swiss-ai/apertus-v1.5-70b")).toBe(60_000);
		expect(generationTimeoutMsFor("swiss-ai/Apertus-v1.5-70B:phoeniqs")).toBe(60_000);
	});

	it("returns null, so the fleet watchdog applies unchanged, for every other catalog model and an unlisted one", () => {
		const others = Object.keys(qualification.checks).filter((id) => id.toLowerCase() !== "swiss-ai/apertus-v1.5-70b");
		expect(others.length).toBeGreaterThan(3);
		for (const id of [...others, "swiss-ai/apertus-v1.5-70b-thinking", "someone/new-model"])
			expect(generationTimeoutMsFor(id), id).toBeNull();
		expect(generationTimeoutMsFor(undefined)).toBeNull();
	});
});

describe("autoRepickGiveUpFor — Auto waits as long as each model's healthy first word takes (CUR-4539)", () => {
	it("waits 40s for ALIA, 25s for the SEA-LION rows and the 20s default for Medium, Large 3 and an unknown model", async () => {
		const { autoRepickGiveUpFor } = await import("./autoRepickGate");
		expect(autoRepickGiveUpFor("BSC-LT/ALIA-40b-instruct")).toBe(40_000);
		expect(autoRepickGiveUpFor("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")).toBe(25_000);
		expect(autoRepickGiveUpFor("aisingapore/Gemma-SEA-LION-v4-27B-IT")).toBe(25_000);
		for (const id of ["mistral-medium-2604", "mistral-large-2512", "someone/new-model", undefined])
			expect(autoRepickGiveUpFor(id), String(id)).toBe(20_000);
	});

	it("never waits past the model's watchdog, so the browser still gets to ask Auto again", async () => {
		const { autoRepickGiveUpFor } = await import("./autoRepickGate");
		for (const id of ["BSC-LT/ALIA-40b-instruct", "aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B", "aisingapore/Gemma-SEA-LION-v4-27B-IT"])
			expect(autoRepickGiveUpFor(id), id).toBeLessThan(generationTimeoutMsFor(id) ?? 45_000);
	});
});
