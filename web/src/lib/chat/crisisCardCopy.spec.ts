import { describe, expect, it } from "vitest";

import { cardText, pickCardCopy } from "./crisisCardCopy";

const CATALOGS = ["en", "es", "fr", "de"] as const;

describe("where the support card's copy comes from (CUR-4103)", () => {
	it("Catalan, Italian and Portuguese come from the card-only table", () => {
		for (const lang of ["ca", "it", "pt"]) expect(pickCardCopy(lang, CATALOGS, "fr")).toEqual({ kind: "card", lang });
	});

	it("a language a UI catalog carries uses that catalog, not the table (es)", () => {
		expect(pickCardCopy("es", CATALOGS, "fr")).toEqual({ kind: "catalog", locale: "es" });
	});

	it("a language neither carries falls back to English, never the UI's language (sw)", () => {
		expect(pickCardCopy("sw", CATALOGS, "fr")).toEqual({ kind: "catalog", locale: "en" });
	});

	it("no classified language uses the UI's language", () => {
		expect(pickCardCopy(undefined, CATALOGS, "de")).toEqual({ kind: "catalog", locale: "de" });
	});

	it("an inherited object key is not a card language", () => {
		expect(pickCardCopy("toString", CATALOGS, "fr")).toEqual({ kind: "catalog", locale: "en" });
	});
});

describe("the card-only table", () => {
	it("fills {country} and {number} and keeps every placeholder the catalog strings carry", () => {
		expect(cardText("it", "chat_crisis_dangerNumber", { number: "112" })).toBe("Se sei in pericolo immediato, chiama il 112.");
		for (const lang of ["ca", "it", "pt"] as const) {
			expect(cardText(lang, "chat_crisis_helplinesIn")).toContain("{country}");
			expect(cardText(lang, "chat_crisis_dangerNumber")).toContain("{number}");
			expect(cardText(lang, "chat_crisis_dangerGeneric")).toContain("112");
			expect(cardText(lang, "chat_crisis_usNote")).toContain("988");
		}
	});
});
