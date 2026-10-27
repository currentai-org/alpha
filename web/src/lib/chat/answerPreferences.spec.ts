import { describe, expect, it } from "vitest";
import {
	activePreset,
	ANSWER_DEFAULTS,
	ANSWER_LANGUAGES,
	ANSWER_PREFERENCE_KEYS,
	EMOJIS,
	fixedLanguage,
	FORMATS,
	isDefault,
	languageName,
	LENGTHS,
	PRESET_FIELDS,
	PRESET_NAMES,
	PRESETS,
	resolveAnswerPreferences,
	TONES,
} from "./answerPreferences";

// The one list the schema, the resolver, the prompt carriers and the page read. These pin
// the contracts the rest of the feature leans on: an unset field is the default, an unknown value is
// the default too, and `auto` names no language. (CUR-3929)
describe("resolveAnswerPreferences", () => {
	it("resolves an empty row, a null row and an undefined row to the defaults", () => {
		expect(resolveAnswerPreferences({})).toEqual(ANSWER_DEFAULTS);
		expect(resolveAnswerPreferences(null)).toEqual(ANSWER_DEFAULTS);
		expect(resolveAnswerPreferences(undefined)).toEqual(ANSWER_DEFAULTS);
	});

	it("keeps every set value and fills the rest", () => {
		expect(resolveAnswerPreferences({ tone: "plain", suggestions: false })).toEqual({
			...ANSWER_DEFAULTS,
			tone: "plain",
			suggestions: false,
		});
	});

	it("falls back to the default for a value outside the list, so no prompt carrier sees a word it has no clause for", () => {
		const row = { tone: "warm", answerLength: "huge", answerLanguage: "xx", suggestions: "no" } as never;
		expect(resolveAnswerPreferences(row)).toEqual(ANSWER_DEFAULTS);
	});

	it("names every key of the resolved shape once", () => {
		expect([...ANSWER_PREFERENCE_KEYS].sort()).toEqual(Object.keys(ANSWER_DEFAULTS).sort());
	});

	it("defaults are members of their own lists", () => {
		expect(TONES).toContain(ANSWER_DEFAULTS.tone);
		expect(LENGTHS).toContain(ANSWER_DEFAULTS.answerLength);
		expect(ANSWER_LANGUAGES).toContain(ANSWER_DEFAULTS.answerLanguage);
		expect(FORMATS).toContain(ANSWER_DEFAULTS.answerFormat);
		expect(EMOJIS).toContain(ANSWER_DEFAULTS.emojis);
	});

	it("resolves the milestone 7 fields the same way: set values kept, unknown ones defaulted (CUR-549)", () => {
		expect(resolveAnswerPreferences({ answerFormat: "prose", emojis: "helpful", showServing: false })).toEqual({
			...ANSWER_DEFAULTS,
			answerFormat: "prose",
			emojis: "helpful",
			showServing: false,
		});
		expect(resolveAnswerPreferences({ answerFormat: "table", emojis: "lots" } as never)).toEqual(ANSWER_DEFAULTS);
	});

	it("never reads a stored explainTerms, off the page under rule 4.6, so an old row with it on resolves to the defaults (CUR-4288)", () => {
		const resolved = resolveAnswerPreferences({ explainTerms: true } as never);
		expect(resolved).toEqual(ANSWER_DEFAULTS);
		expect("explainTerms" in resolved).toBe(false);
	});
});

// A preset writes exactly PRESET_FIELDS and is read back over exactly PRESET_FIELDS, so the
// write and the comparison cannot drift, and a field outside the list is the person's own. (CUR-549)
describe("presets", () => {
	it("every preset names every preset field and no other, with values from the lists", () => {
		for (const name of PRESET_NAMES) {
			expect(Object.keys(PRESETS[name]).sort(), name).toEqual([...PRESET_FIELDS].sort());
			expect(TONES, name).toContain(PRESETS[name].tone);
			expect(LENGTHS, name).toContain(PRESETS[name].answerLength);
			expect(FORMATS, name).toContain(PRESETS[name].answerFormat);
			expect(EMOJIS, name).toContain(PRESETS[name].emojis);
		}
	});

	it("writes no explainTerms from any preset: the explanatory preset sets the detailed length and nothing about terms (CUR-4288)", () => {
		for (const name of PRESET_NAMES) expect("explainTerms" in PRESETS[name], name).toBe(false);
		expect(PRESETS.explanatory.answerLength).toBe("detailed");
	});

	it("names no field a preset must leave alone: language, suggestions, self-reference, the receipt", () => {
		for (const key of ["answerLanguage", "suggestions", "selfReferenceAsPerson", "showServing"]) {
			expect(PRESET_FIELDS as readonly string[]).not.toContain(key);
		}
	});

	it("the neutral preset is Alpha's defaults over the preset fields, derived, so the two cannot drift", () => {
		for (const key of PRESET_FIELDS) expect(PRESETS.neutral[key], key).toBe(ANSWER_DEFAULTS[key]);
	});

	it("round-trips: resolving a preset's fields reads back as that preset", () => {
		for (const name of PRESET_NAMES) {
			expect(activePreset(resolveAnswerPreferences(PRESETS[name])), name).toBe(name);
		}
	});

	it("a fresh row reads neutral, since an unset field counts as its default", () => {
		expect(activePreset(resolveAnswerPreferences({}))).toBe("neutral");
	});

	it("one later change to a preset field reads custom", () => {
		const plain = resolveAnswerPreferences(PRESETS.plain);
		expect(activePreset({ ...plain, answerLength: "detailed" })).toBe("custom");
	});

	it("a change outside the preset fields leaves the preset shown", () => {
		const formal = resolveAnswerPreferences(PRESETS.formal);
		expect(activePreset({ ...formal, answerLanguage: "pt", suggestions: false, showServing: false })).toBe("formal");
	});

	it("presets differ from one another over the preset fields, so each button means something", () => {
		const seen = new Set(PRESET_NAMES.map((n) => JSON.stringify(PRESETS[n])));
		expect(seen.size).toBe(PRESET_NAMES.length);
	});
});

describe("isDefault", () => {
	it("is true only while the row leaves the key unset", () => {
		expect(isDefault({}, "tone")).toBe(true);
		expect(isDefault({ tone: "neutral" }, "tone")).toBe(false);
		expect(isDefault({ tone: "plain" }, "tone")).toBe(false);
	});
});

describe("fixedLanguage", () => {
	it("is undefined for auto and the code otherwise", () => {
		expect(fixedLanguage({ answerLanguage: "auto" })).toBeUndefined();
		expect(fixedLanguage({ answerLanguage: "pt" })).toBe("pt");
	});
});

describe("languageName", () => {
	it("names each fixed language in English, never as a bare code", () => {
		for (const code of ANSWER_LANGUAGES.filter((c) => c !== "auto")) {
			expect(languageName(code)).not.toBe(code);
			expect(languageName(code)).not.toBe(code.toUpperCase());
		}
		expect(languageName("pt")).toBe("Portuguese");
		expect(languageName("ca")).toBe("Catalan");
	});
});
