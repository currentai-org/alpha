import { describe, expect, it } from "vitest";
import { chromeCopy, chromeLanguage, gapCardCopy } from "./chromeCopy";
import { failoverLine, liveActiveLine, UNKNOWN_MODEL_LABEL } from "./components/chat/liveRequestLabels";
import { preferredLanguage } from "./constants/starterShelf";

describe("chromeLanguage (CUR-1575, CUR-2394)", () => {
	it("follows the browser's first choice when there is a table for it", () => {
		expect(chromeLanguage(preferredLanguage("fr-FR,fr;q=0.9,en;q=0.8"))).toBe("fr");
		expect(chromeLanguage(preferredLanguage("es-MX,es;q=0.9"))).toBe("es");
		expect(chromeLanguage(preferredLanguage("de-CH,de;q=0.9,en;q=0.5"))).toBe("de");
	});

	it("falls back to English for a language it has no copy for, rather than guessing a neighbour", () => {
		expect(chromeLanguage(preferredLanguage("pl-PL,pl;q=0.9"))).toBe("en");
		expect(chromeLanguage(preferredLanguage("ca-ES,ca;q=0.9,es;q=0.8"))).toBe("en");
	});

	it("falls back to English when the browser sends no header", () => {
		expect(chromeLanguage(preferredLanguage(null))).toBe("en");
		expect(chromeLanguage(undefined)).toBe("en");
	});
});

describe("gapCardCopy (CUR-2394, CUR-2885)", () => {
	it("translates the whole web-search gap card, its sentence included, for a French browser", () => {
		const { copy, line } = gapCardCopy("fr", "websearch", "a Google-scale open web search index");
		expect(copy.gapAction).toBe(chromeCopy("fr").gapAction);
		expect(line).toBe("Aucun index de recherche ouvert ne couvre encore tout le web.");
	});

	it("says the web-search gap to the person who asked, never as roadmap copy, in every language", () => {
		for (const lang of ["en", "fr", "es", "de", "it", "pt", "nl"]) {
			const { line } = gapCardCopy(lang, "websearch", "a Google-scale open web search index");
			expect(line, lang).not.toMatch(/google|open stack|stack/i);
			expect(line, lang).toMatch(/\.$/);
		}
	});

	it("keeps the whole card English, never half translated, when the gap has no line in the visitor's language", () => {
		const { copy, line } = gapCardCopy("fr", "some-new-node", "an open dataset of farm yields");
		expect(copy).toBe(chromeCopy("en"));
		expect(line).toBe("The open stack still needs an open dataset of farm yields.");
	});
});

describe("live request log in the browser's language (CUR-1575)", () => {
	const fr = chromeCopy("fr");

	it("writes the active line in French, the model's name untouched", () => {
		const line = liveActiveLine({ answered: true, modelLabel: "Apertus", copy: fr });
		expect(line).toBe(fr.generating("Apertus"));
		expect(line).toContain("Apertus");
		expect(line).not.toMatch(/generating/);
	});

	it("translates the unknown-model placeholder instead of leaving 'The model' in a French line", () => {
		const line = liveActiveLine({ answered: true, modelLabel: UNKNOWN_MODEL_LABEL, copy: fr });
		expect(line).toContain("Le modèle");
		expect(line).not.toContain(UNKNOWN_MODEL_LABEL);
	});

	it("keeps English when no copy is passed, so existing callers read as before", () => {
		expect(liveActiveLine({ phase: null, answered: false, modelLabel: "Apertus" })).toBe("Working on it…");
	});

	it("writes the failover line in French", () => {
		const failover = { from: "Apertus", to: "GLM", reason: "skipped" as const };
		expect(failoverLine(failover)).toMatch(/switched to/);
		expect(failoverLine(failover, fr)).not.toMatch(/switched to|skipped/);
	});
});
