import { describe, expect, it, vi } from "vitest";
import { browserLanguageNote, messageLanguageNote, weakLanguageNote } from "./replyLanguage";
import { readMessageLanguage } from "../declineCopy";
import { nativeLanguages, weakLanguages } from "../harnessProfiles";

const ALIA = nativeLanguages("BSC-LT/ALIA-40b-instruct");

describe("browserLanguageNote", () => {
	it("names Catalan for ALIA when the browser asks for Catalan", () => {
		expect(browserLanguageNote("ca", ALIA)).toBe(
			"The person's browser is set to Catalan. Write your whole answer in Catalan, unless they write to you in another language."
		);
	});

	it("names Spanish for ALIA when the browser asks for Spanish", () => {
		expect(browserLanguageNote("es", ALIA)).toContain("set to Spanish");
	});

	it("names nothing when the browser asks for English, so ALIA is never told to answer in English", () => {
		expect(browserLanguageNote("en", ALIA)).toBeUndefined();
	});

	it("names nothing when the browser sends no language", () => {
		expect(browserLanguageNote(undefined, ALIA)).toBeUndefined();
	});

	it("names nothing for a model with no native languages on its profile, whatever the browser asks for", () => {
		expect(browserLanguageNote("ca", nativeLanguages("mistral-large-2512"))).toBeUndefined();
	});
});

describe("messageLanguageNote (CUR-3898): on a browser in no language the model is built for, the message names its own", () => {
	const reads = (tag: string | undefined) => vi.fn(async () => tag);

	it("names Catalan for ALIA when the message reads as Catalan", async () => {
		expect(await messageLanguageNote("Ets una persona de veritat?", ALIA, reads("cat"))).toEqual({
			language: "cat",
			note: "The person wrote in Catalan. Write your whole answer in Catalan.",
		});
	});

	it("names Spanish for ALIA when the message reads as Spanish", async () => {
		expect((await messageLanguageNote("¿Eres una persona de verdad?", ALIA, reads("spa")))?.note).toContain("wrote in Spanish");
	});

	it("names nothing for an English message, so ALIA is never told to answer in English", async () => {
		expect(await messageLanguageNote("Are you a real person?", ALIA, reads("eng"))).toBeUndefined();
	});

	it("names nothing when the detectors can't be loaded", async () => {
		expect(await messageLanguageNote("Ets una persona de veritat?", ALIA, reads(undefined))).toBeUndefined();
	});

	it("names nothing and reads nothing for a model with no native languages", async () => {
		const read = reads("cat");
		expect(await messageLanguageNote("Ets una persona de veritat?", nativeLanguages("mistral-large-2512"), read)).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
	});

	it("the real detectors read the Spanish and Catalan identity questions that got English answers on www", async () => {
		expect((await messageLanguageNote("¿Eres una persona de verdad?", ALIA, readMessageLanguage))?.language).toBe("spa");
		expect((await messageLanguageNote("Ets una persona de veritat?", ALIA, readMessageLanguage))?.language).toBe("cat");
	});
});

describe("weakLanguageNote (CUR-2237)", () => {
	const APERTUS = weakLanguages("swiss-ai/apertus-v1.5-70b");
	const clefSays = (answer: string | null | undefined) => vi.fn(async () => answer);

	it("names Hausa for Apertus on the probe's own short question when Clef reads it as Hausa", async () => {
		const ask = clefSays("hau");
		expect(await weakLanguageNote("Menene babban birnin Japan?", APERTUS, ask)).toEqual({
			language: "hau",
			note: "The person wrote in Hausa. Write your whole answer in Hausa, including any lists, and do not switch to English.",
		});
		expect(ask).toHaveBeenCalledWith("Menene babban birnin Japan?", APERTUS);
	});

	it("names nothing when Clef answered and chose another language", async () => {
		expect(await weakLanguageNote("Ina so in koyi yadda ake dafa shinkafa da miya.", APERTUS, clefSays(null))).toBeUndefined();
	});

	it("names nothing when Clef can't be asked, since no second detector stands behind it", async () => {
		expect(await weakLanguageNote("Menene babban birnin Japan?", APERTUS, clefSays(undefined))).toBeUndefined();
	});

	it("asks Clef about a short Ethiopic question, which the script read can't pin to Amharic over Tigrinya", async () => {
		const ask = clefSays("amh");
		expect((await weakLanguageNote("የጃፓን ዋና ከተማ ምንድን ነው?", APERTUS, ask))?.language).toBe("amh");
		expect(ask).toHaveBeenCalledOnce();
	});

	it("skips Clef when the word lists are sure of another language", async () => {
		const ask = clefSays("hau");
		expect(await weakLanguageNote("¿Cuál es la capital de Japón?", APERTUS, ask)).toBeUndefined();
		expect(ask).not.toHaveBeenCalled();
	});

	it("names nothing and asks nothing for a model with no weak languages", async () => {
		const ask = clefSays("hau");
		expect(await weakLanguageNote("Menene babban birnin Japan?", weakLanguages("BSC-LT/ALIA-40b-instruct"), ask)).toBeUndefined();
		expect(ask).not.toHaveBeenCalled();
	});

	it("never names a language off the model's list, even when Clef picks one", async () => {
		expect(await weakLanguageNote("Ano ang kabisera ng Japan?", APERTUS, clefSays("tgl"))).toBeUndefined();
	});
});
