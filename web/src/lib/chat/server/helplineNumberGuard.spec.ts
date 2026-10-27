/**
 * A phone number the model wrote in a crisis answer is replaced unless it is 112, 988, the visitor's
 * own emergency number, or a sourced national line of any country (CUR-4061, CUR-4488). The inputs
 * are real model answers from crisis_referral.py.
 */
import { describe, expect, it } from "vitest";
import { guardHelplineNumbers, namesOurCrisisResource } from "./helplineNumberGuard";

const LINK = "[findahelpline.com](https://findahelpline.com)";

describe("guardHelplineNumbers replaces a crisis number the model recalled (CUR-4061)", () => {
	it("replaces the 3115 Bielik gave for France's 3114 line, and keeps 112", () => {
		const r = guardHelplineNumbers(
			"contacter le Samu par téléphone au 112 pour une situation d'urgence, ou le Centre National de Prévention du Suicide au 3115 en France métropolitaine.",
			"FR"
		);
		expect(r.numbers).toEqual(["3115"]);
		expect(r.cleaned).toContain("au 112 pour");
		expect(r.cleaned).toContain(`Suicide au ${LINK} en France`);
	});

	it("replaces a spaced number as one, not four", () => {
		const r = guardHelplineNumbers("des associations comme SOS Amitié (au 0800 23 45 67) sont disponibles.", "fr");
		expect(r.numbers).toEqual(["0800234567"]);
		expect(r.cleaned).toBe(`des associations comme SOS Amitié (au ${LINK}) sont disponibles.`);
	});

	it("replaces numbers written in bold and in a list, as Bielik wrote them", () => {
		const r = guardHelplineNumbers("- **Samu** : 187 (gratuit)\n- **SOS Amitié** : **3115**", "fr");
		expect(r.numbers).toEqual(["187", "3115"]);
		expect(r.cleaned).not.toMatch(/\d{3}/);
	});

	it("replaces 988 for a visitor outside the US and Canada, where it reaches nobody", () => {
		expect(guardHelplineNumbers("Appelez le 112, ou le 988 aux États-Unis.", "fr").numbers).toEqual(["988"]);
		expect(guardHelplineNumbers("Call 988.", null).numbers).toEqual(["988"]);
		expect(guardHelplineNumbers("Call or text 988.", "CA").replaced).toBe(false);
	});

	it("keeps a held national line whatever the visitor's country, since the answer can be about another country (CUR-4488)", () => {
		expect(guardHelplineNumbers("Appelez le 3114.", "fr").replaced).toBe(false);
		// A Hong Kong connection read as Taiwan, asking about a pupil in France.
		expect(guardHelplineNumbers("Appelez le 3114, le numéro national de prévention du suicide.", "tw").replaced).toBe(false);
		expect(guardHelplineNumbers("Puedes llamar al 016 o al 024.", "us").replaced).toBe(false);
	});

	it("links findahelpline's front page, never the IP country's page, so the model's words never name the wrong country (CUR-4488)", () => {
		const r = guardHelplineNumbers("Linha Nacional de Prevenção do Suicídio: 808 24 24 24.", "tw");
		expect(r.numbers).toEqual(["808242424"]);
		expect(r.cleaned).toBe(`Linha Nacional de Prevenção do Suicídio: ${LINK}.`);
		expect(r.cleaned).not.toContain("/countries/");
	});

	it("links the country the message names, not the IP country, when the support classifier read one (CUR-4488)", () => {
		// a Segurança Social prompt from a Hong Kong connection read as Taiwan.
		const r = guardHelplineNumbers("Linha Nacional de Prevenção do Suicídio: 808 24 24 24.", "tw", "pt");
		expect(r.cleaned).toBe(
			"Linha Nacional de Prevenção do Suicídio: [findahelpline.com](https://findahelpline.com/countries/pt)."
		);
	});

	it("keeps the named country's emergency number and, for the US or Canada, 988 (CUR-4488)", () => {
		expect(guardHelplineNumbers("Call 999 or Samaritans.", "tw", "gb").replaced).toBe(false);
		expect(guardHelplineNumbers("Call or text 988.", "fr", "us").replaced).toBe(false);
	});

	it("falls back to the front page when the named country has no findahelpline page", () => {
		expect(guardHelplineNumbers("Call 0800 123 456.", "tw", "xx").cleaned).toBe(`Call ${LINK}.`);
	});

	it("keeps a national line however it is spaced", () => {
		expect(guardHelplineNumbers("TelefonSeelsorge: 0800 111 0 111 oder 0800 111 0 222.", "de").replaced).toBe(false);
		expect(guardHelplineNumbers("Samaritans on 116 123, free.", "ie").replaced).toBe(false);
	});

	it("still replaces a wrong digit in a national line", () => {
		expect(guardHelplineNumbers("Llama al 017.", "es").numbers).toEqual(["017"]);
	});

	it("keeps 988 and the visitor's own emergency number", () => {
		const us = guardHelplineNumbers("Call or text 988, or 911 if you are in danger.", "us");
		expect(us.replaced).toBe(false);
		const gb = guardHelplineNumbers("Call 999 if you are in danger.", "gb");
		expect(gb.replaced).toBe(false);
	});

	it("keeps another country's police or ambulance number, since the answer may be about that country (CUR-4122)", () => {
		// A Russian beaten-neighbour question from a US address must keep Russia's police 102.
		const text = "Немедленно позвоните в полицию по телефону 102 или 112.";
		expect(guardHelplineNumbers(text, "us").replaced).toBe(false);
		expect(guardHelplineNumbers("Call 911 now.", "fr").replaced).toBe(false);
	});

	it("still replaces a recalled number that is no country's emergency service", () => {
		expect(guardHelplineNumbers("Appelez le 187.", "us").numbers).toEqual(["187"]);
		expect(guardHelplineNumbers("Llama al 017 o al 3115.", "us").numbers).toEqual(["017", "3115"]);
	});

	it("links the generic finder when the country is unknown", () => {
		expect(guardHelplineNumbers("Llama al 717 003 717.", null).cleaned).toBe(
			"Llama al [findahelpline.com](https://findahelpline.com)."
		);
	});

	it("leaves a range of two short numbers alone, so a dose or a duration survives a crisis answer", () => {
		const text = "La naloxona dura 30-90 minutos; repite cada 2 - 3 minutos.";
		expect(guardHelplineNumbers(text, "es").replaced).toBe(false);
	});

	it("leaves years, dates, citation markers, decimals and short numbers alone", () => {
		const text = "En 2026, le 16.10.2026, selon [12], 3,5 % des appels durent 24h/24 et 15 minutes.";
		expect(guardHelplineNumbers(text, "fr").replaced).toBe(false);
	});

	it("never rewrites digits inside a link", () => {
		const text = "See [the guide](https://example.org/doc/12345) and https://988lifeline.org/es/.";
		expect(guardHelplineNumbers(text, "us").replaced).toBe(false);
	});

	it("is idempotent: its own link holds no number", () => {
		const once = guardHelplineNumbers("au 3115.", "fr").cleaned;
		expect(guardHelplineNumbers(once, "fr").replaced).toBe(false);
	});
});

describe("namesOurCrisisResource reads our own resource names, never the person's words", () => {
	it("is true for findahelpline or 988 in any language around them", () => {
		expect(namesOurCrisisResource("Puedes buscar en findahelpline.com")).toBe(true);
		expect(namesOurCrisisResource("llama al 988")).toBe(true);
	});

	it("is false for an emergency answer that names only 112, so a stroke or police answer keeps its numbers", () => {
		// The shape of answers that must keep Russia's 103 and Serbia's 192.
		expect(namesOurCrisisResource("При инсульте вызывайте скорую: 112 или 103.")).toBe(false);
		expect(namesOurCrisisResource("Pozovite policiju: 112 ili 192.")).toBe(false);
	});

	it("is false for an ordinary answer with numbers", () => {
		expect(namesOurCrisisResource("Le prix est de 1120 euros, ou 9880 en tout.")).toBe(false);
	});
});
