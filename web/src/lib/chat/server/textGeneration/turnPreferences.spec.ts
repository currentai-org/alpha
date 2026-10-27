import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure resolution-logic test — proves the fallback chain, not the DB read itself (the stateful suite
// covers real collections.settings behavior elsewhere, e.g. layoutData.spec.ts). It only checks that
// resolveTurnPreferences picks the right value once handed a document. That a setting change reaches the
// model on a real turn is proved by a live probe, not here (CUR-1443).

let findOneResult: {
	replyInUserLanguage?: boolean;
	selfReferenceAsPerson?: boolean;
	customPrompts?: Record<string, string>;
	customPromptsEnabled?: Record<string, boolean>;
} | null = null;
let flagValue = true;

vi.mock("$lib/chat/server/database", () => ({
	collections: { settings: { findOne: async () => findOneResult } },
}));
vi.mock("$lib/chat/server/auth", () => ({ authCondition: () => ({}) }));
vi.mock("./replyLanguageGate", () => ({ replyLanguageRuleEnabled: () => flagValue }));

const { resolveTurnPreferences, effectivePreprompt } = await import("./turnPreferences");
const { ANSWER_DEFAULTS } = await import("$lib/chat/answerPreferences");

beforeEach(() => {
	findOneResult = null;
	flagValue = true;
});

describe("resolveTurnPreferences", () => {
	it("falls back to the flag for replyInUserLanguage when no Settings document exists", async () => {
		flagValue = false;
		const prefs = await resolveTurnPreferences({} as App.Locals);
		expect(prefs.replyInUserLanguage).toBe(false);
	});

	it("falls back to the flag when a Settings document exists but the field is unset", async () => {
		flagValue = true;
		findOneResult = {};
		const prefs = await resolveTurnPreferences({} as App.Locals);
		expect(prefs.replyInUserLanguage).toBe(true);
	});

	it("the account's explicit value wins over the flag in both directions", async () => {
		flagValue = true;
		findOneResult = { replyInUserLanguage: false };
		expect((await resolveTurnPreferences({} as App.Locals)).replyInUserLanguage).toBe(false);

		flagValue = false;
		findOneResult = { replyInUserLanguage: true };
		expect((await resolveTurnPreferences({} as App.Locals)).replyInUserLanguage).toBe(true);
	});

	it("defaults selfReferenceAsPerson to false with no flag to fall back on", async () => {
		findOneResult = {};
		expect((await resolveTurnPreferences({} as App.Locals)).selfReferenceAsPerson).toBe(false);
	});

	it("carries an explicit selfReferenceAsPerson through on the top-level field as on the row", async () => {
		findOneResult = { selfReferenceAsPerson: true };
		const prefs = await resolveTurnPreferences({} as App.Locals);
		expect(prefs.selfReferenceAsPerson).toBe(true);
		expect(prefs.answer?.selfReferenceAsPerson).toBe(true);
	});

	it("never looks up Settings, and returns the flag/defaults, when locals is undefined (no session)", async () => {
		flagValue = false;
		findOneResult = { replyInUserLanguage: true }; // would flip the result if wrongly consulted
		const prefs = await resolveTurnPreferences(undefined);
		expect(prefs.replyInUserLanguage).toBe(false);
		expect(prefs.selfReferenceAsPerson).toBe(false);
	});
});

describe("answer preferences on the turn path (CUR-3929)", () => {
	it("resolves an empty row to the defaults, every field present", async () => {
		findOneResult = {};
		expect((await resolveTurnPreferences({} as App.Locals)).answer).toEqual(ANSWER_DEFAULTS);
	});

	it("resolves a set field and fills the rest", async () => {
		findOneResult = { tone: "plain", answerLanguage: "pt" } as typeof findOneResult;
		expect((await resolveTurnPreferences({} as App.Locals)).answer).toEqual({
			...ANSWER_DEFAULTS,
			tone: "plain",
			answerLanguage: "pt",
		});
	});

	it("ignores a stored explainTerms, off the page under rule 4.6: an old row with it on resolves to the defaults (CUR-4288)", async () => {
		findOneResult = { explainTerms: true } as typeof findOneResult;
		expect((await resolveTurnPreferences({} as App.Locals)).answer).toEqual(ANSWER_DEFAULTS);
	});

	it("gives the defaults with no session, without a lookup", async () => {
		findOneResult = { tone: "formal" } as typeof findOneResult;
		expect((await resolveTurnPreferences(undefined)).answer).toEqual(ANSWER_DEFAULTS);
	});
});

describe("Personalization on the turn path (CUR-1443)", () => {
	it("reads the instructions as saved now, so an edit reaches a chat created before it", async () => {
		findOneResult = { customPrompts: { "*": "  End with Lugano.  " } };
		const prefs = await resolveTurnPreferences({} as App.Locals);
		expect(prefs.personalInstructions).toBe("End with Lugano.");
		expect(effectivePreprompt("what the chat was created with", prefs)).toBe("End with Lugano.");
	});

	it("falls back to the conversation's own preprompt when the instructions are empty or switched off", async () => {
		findOneResult = { customPrompts: { "*": "End with Lugano." }, customPromptsEnabled: { "*": false } };
		expect(effectivePreprompt("model default", await resolveTurnPreferences({} as App.Locals))).toBe("model default");
		findOneResult = { customPrompts: { "*": "   " } };
		expect(effectivePreprompt(undefined, await resolveTurnPreferences({} as App.Locals))).toBeUndefined();
	});

	it("has no instructions with no session", async () => {
		expect((await resolveTurnPreferences(undefined)).personalInstructions).toBeNull();
	});
});
