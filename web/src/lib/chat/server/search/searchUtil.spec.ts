import { describe, it, expect } from "vitest";
import { reconstructAbstract, detectWikiLang } from "./searchUtil";

describe("reconstructAbstract", () => {
	it("orders words by their positions", () => {
		expect(reconstructAbstract({ Hello: [0], world: [1] })).toBe("Hello world");
		expect(reconstructAbstract({ b: [1], a: [0], c: [2] })).toBe("a b c");
	});
	it("handles a word that repeats at multiple positions", () => {
		expect(reconstructAbstract({ the: [0, 2], cat: [1], sat: [3] })).toBe("the cat the sat");
	});
	it("returns empty string for null/undefined", () => {
		expect(reconstructAbstract(null)).toBe("");
		expect(reconstructAbstract(undefined)).toBe("");
	});
});

describe("detectWikiLang", () => {
	it("detects non-Latin scripts confidently", () => {
		expect(detectWikiLang("東京タワー")).toBe("ja"); // kana present → Japanese, not Chinese
		expect(detectWikiLang("北京的历史")).toBe("zh"); // Han only
		expect(detectWikiLang("서울의 역사")).toBe("ko");
		expect(detectWikiLang("Привет мир")).toBe("ru");
		expect(detectWikiLang("مرحبا بالعالم")).toBe("ar");
	});
	it("returns null for English (English-only search)", () => {
		expect(detectWikiLang("what is the current status of the EU AI Act")).toBeNull();
	});
	it("detects a Latin language only with >=2 distinctive stopwords", () => {
		expect(detectWikiLang("quel est le statut de la loi")).toBe("fr");
		expect(detectWikiLang("the los angeles lakers")).toBeNull(); // only 'los' → not enough
	});
	it("returns null for empty input", () => {
		expect(detectWikiLang("   ")).toBeNull();
	});
});
