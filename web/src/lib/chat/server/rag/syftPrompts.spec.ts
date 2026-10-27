import { describe, it, expect, vi } from "vitest";

// Prompt-routed SyftHub matcher. Exercises the committed ./syftPrompts.json against the exact demo
// prompts, the normalization (case / apostrophes / whitespace), the union-across-rules behavior, and
// the fail-safe: any UNconfigured prompt must return NO endpoints (so index.ts runs no federated store).
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	matchSyftPromptEndpoints,
	normalizePrompt,
	isSyftEndpointPath,
	syftPromptRules,
} from "./syftPrompts";

const TAX = "cantonax_tax_office/federal-tax-administration-caseworker";
const HEALTH = "federal-office-public-health/federal-office-health-casework";
const MIGRATION = "cantonal-migration-office/state-secretariat-migration-caseworker";
const SOCIAL = "cantonal-social-services/cantonal-social-services-fsio-casework";
// Public (citizen-facing) variants — used by the first-person prompts.
const TAX_PUB = "cantonax_tax_office/federal-tax-administration-public";
const HEALTH_PUB = "federal-office-public-health/federal-office-health-public";
const MIGRATION_PUB = "cantonal-migration-office/state-secretariat-migration-public";
const SOCIAL_PUB = "cantonal-social-services/cantonal-social-services-fsio-public";

const P3 = "Applicant has Type 2 diabetes. Does that qualify, and what exactly counts as a 'documented complication'?";
const P7 =
	"The household already receives a carer's allowance and is now claiming the supplement. What's the combined cap, and is there precedent on a stacking dispute like this?";

describe("normalizePrompt", () => {
	it("lowercases, strips punctuation, and collapses whitespace", () => {
		expect(normalizePrompt("  Carer’s   Allowance!\n")).toBe("carer s allowance");
	});
	it("is null-safe", () => {
		expect(normalizePrompt(undefined as unknown as string)).toBe("");
	});
});

describe("isSyftEndpointPath", () => {
	it("accepts owner/slug and rejects anything else", () => {
		expect(isSyftEndpointPath(TAX)).toBe(true);
		expect(isSyftEndpointPath("no-slash")).toBe(false);
		expect(isSyftEndpointPath("too/many/slashes")).toBe(false);
		expect(isSyftEndpointPath("has space/slug")).toBe(false);
		expect(isSyftEndpointPath("")).toBe(false);
		expect(isSyftEndpointPath(42)).toBe(false);
	});
});

describe("matchSyftPromptEndpoints — the 7 configured demo prompts", () => {
	const cases: Array<[string, string, string[]]> = [
		[
			"rule 1 (COPD + B permit + Chronic Care Supplement)",
			"My applicant has COPD and holds a B permit. They've been registered for 11 months, with one 20-day gap. Do they qualify for the Chronic Care Supplement yet?",
			[HEALTH, MIGRATION, SOCIAL],
		],
		[
			"rule 2 (village bakery + disability allowance)",
			"Applicant runs a village bakery (self-employed) and had a loss year. She also receives a disability allowance. Is her income under the threshold?",
			[TAX, SOCIAL],
		],
		[
			"rule 3 (Type 2 diabetes + documented complication)",
			"Applicant has Type 2 diabetes. Does that qualify, and what exactly counts as a 'documented complication'?",
			[HEALTH, SOCIAL],
		],
		[
			"rule 4 (COPD reopened + backdate + IV pension)",
			"An earlier COPD application was refused in May and has now been reopened. Is there precedent for how far back we backdate the award — and does it matter that an IV pension application is also pending?",
			[HEALTH, SOCIAL],
		],
		[
			"rule 5 (G permit + residence condition)",
			"Has a cross-border commuter (G permit) with a qualifying condition ever been decided before? What was the reasoning on the residence condition?",
			[MIGRATION, HEALTH, SOCIAL],
		],
		[
			"rule 6 (another canton + accrued time)",
			"Applicant moved from another canton eight months into their registration period. Is there precedent that the accrued time carries across the move?",
			[MIGRATION, SOCIAL],
		],
		[
			"rule 7 (carer's allowance + combined cap)",
			"The household already receives a carer's allowance and is now claiming the supplement. What's the combined cap, and is there precedent on a stacking dispute like this?",
			[SOCIAL, TAX],
		],
		[
			"rule 8 (benefits cut + appeal + health) — public",
			"my benefits got cut and I don't know why, can I appeal, and does my health condition make a difference?",
			[SOCIAL_PUB, HEALTH_PUB],
		],
		[
			"rule 9 (residency permit + moved cantons) — public",
			"I'm here on a residency permit and just moved cantons, do I need to redo it, and does it affect my benefits?",
			[MIGRATION_PUB, SOCIAL_PUB],
		],
		[
			"rule 10 (lost job + income drop + spouse illness) — public",
			"I just lost my job, my income dropped, and my spouse has a chronic illness. What support can we get, and would our income disqualify us?",
			[SOCIAL_PUB, TAX_PUB, HEALTH_PUB],
		],
	];
	it.each(cases)("matches %s to its attached data stores", (_label, prompt, expected) => {
		expect(matchSyftPromptEndpoints(prompt)).toEqual(expected);
	});

	it("matches regardless of case, apostrophe style, and surrounding whitespace", () => {
		expect(matchSyftPromptEndpoints(`  ${P7.toUpperCase().replace(/'/g, "’")}  `)).toEqual([SOCIAL, TAX]);
	});

	it("is EXACT only — a wrapper, extra words, or a typo do NOT fire", () => {
		expect(matchSyftPromptEndpoints(`Please answer: ${P7}`)).toEqual([]); // wrapped
		expect(matchSyftPromptEndpoints(`Translate into French: ${P3}`)).toEqual([]); // wrapped
		expect(matchSyftPromptEndpoints(`${P7} thanks`)).toEqual([]); // trailing extra word
		expect(matchSyftPromptEndpoints(P7.replace("stacking", "stakcing"))).toEqual([]); // typo
		expect(matchSyftPromptEndpoints(`${P3}\n\n${P7}`)).toEqual([]); // two prompts
	});

	it("returns NO endpoints for an unconfigured prompt (everything else = no SyftHub)", () => {
		expect(matchSyftPromptEndpoints("what is the capital of France?")).toEqual([]);
		expect(matchSyftPromptEndpoints("write me a poem about the sea")).toEqual([]);
		expect(matchSyftPromptEndpoints("")).toEqual([]);
	});

	it("does NOT match on a shared keyword alone — the whole prompt is the trigger", () => {
		expect(matchSyftPromptEndpoints("does COPD count as a chronic condition?")).toEqual([]);
	});
});

describe("syftPromptRules (config integrity)", () => {
	it("loads all 10 committed rules, each with a prompt and valid endpoints", () => {
		const rules = syftPromptRules();
		expect(rules).toHaveLength(10);
		for (const r of rules) {
			expect(r.prompt.length).toBeGreaterThan(0);
			expect(r.endpoints.length).toBeGreaterThan(0);
			expect(r.endpoints.every(isSyftEndpointPath)).toBe(true);
		}
	});
});
