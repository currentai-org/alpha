import { describe, expect, it } from "vitest";

import { catalog } from "$lib/chat/routing/catalog";
import { paraglideMiddleware } from "$lib/paraglide/server.js";
// Registers the request-locale strategy that hooks.server installs in the app.
import "$lib/i18n/server";
import { knownWeakSpotFor } from "./modelWeakSpots";

async function inLocale<T>(locale: string, read: () => T): Promise<T> {
	const result: { value?: T } = {};
	await paraglideMiddleware(
		new Request(`https://www.example.com${locale === "en" ? "" : `/${locale}`}/alpha`),
		async () => {
			result.value = read();
			return new Response();
		}
	);
	return result.value as T;
}

describe("knownWeakSpotFor", () => {
	it("gives each of the three models measured failing on develop's chat path a sentence", () => {
		for (const id of [
			"BSC-LT/ALIA-40b-instruct",
			"speakleash/Bielik-11B-v3.0-Instruct",
			"aisingapore/Gemma-SEA-LION-v4-27B-IT"
		]) {
			const gatewayId = catalog.find(
				(m) => m.gatewayId?.toLowerCase() === id.toLowerCase()
			)?.gatewayId;
			// A key that matches no offered model would show nothing and say nothing about it.
			expect(gatewayId, `${id} is not a catalog gatewayId`).toBeDefined();
			expect(knownWeakSpotFor(gatewayId)).toMatch(/\w.*\.$/);
		}
	});

	it("leads each sentence with the model's picker name, so the line says which model it means", () => {
		expect(knownWeakSpotFor("BSC-LT/ALIA-40b-instruct")).toMatch(
			/^ALIA 40B is easier to talk into ignoring its rules than other models here\./
		);
		expect(knownWeakSpotFor("speakleash/Bielik-11B-v3.0-Instruct")).toMatch(/^Bielik 11B v3 sometimes /);
		expect(knownWeakSpotFor("aisingapore/Gemma-SEA-LION-v4-27B-IT")).toMatch(
			/^SEA-LION v4 \(Gemma\) 27B may describe /
		);
	});

	it("leaves every model that passed on the chat path without one", () => {
		for (const id of [
			"mistral-large-2512",
			"swiss-ai/apertus-v1.5-70b",
			"swiss-ai/apertus-v1.5-70b-thinking",
			"aisingapore/Qwen-SEA-LION-v4-32B-IT"
		]) {
			expect(knownWeakSpotFor(id)).toBeUndefined();
		}
		expect(knownWeakSpotFor(undefined)).toBeUndefined();
	});

	it("says ALIA 40B's weak spot in the request's language, not English, for a French, Spanish or German visitor", async () => {
		const en = await inLocale("en", () => knownWeakSpotFor("BSC-LT/ALIA-40b-instruct"));
		for (const locale of ["fr", "es", "de"]) {
			const line = await inLocale(locale, () => knownWeakSpotFor("BSC-LT/ALIA-40b-instruct"));
			expect(line, locale).toContain("ALIA 40B");
			expect(line, locale).not.toBe(en);
		}
	});

	// The answer settings each picker model failed on the develop preview probe, k=5 (CUR-4289). Typed
	// out, not read from the module, so a dropped or added setting turns these red.
	it("names, for each picker model that failed an answer setting, exactly the settings it failed", () => {
		expect(knownWeakSpotFor("mistral-large-2610")).toBe(
			"Mistral Large 4 does not always follow these answer settings: Suggestions: Off."
		);
		expect(knownWeakSpotFor("zai-org/GLM-5.2")).toBe(
			"GLM 5.2 does not always follow these answer settings: Answer length: Short, Answer language."
		);
		expect(knownWeakSpotFor("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")).toBe(
			"SEA-LION v4.8 (Nemotron) 120B does not always follow these answer settings: Tone: Plain."
		);
	});

	it("keeps ALIA 40B's and Bielik 11B v3's rule-breaking sentence first, then names the answer settings each failed", () => {
		expect(knownWeakSpotFor("BSC-LT/ALIA-40b-instruct")).toBe(
			"ALIA 40B is easier to talk into ignoring its rules than other models here. " +
				"ALIA 40B does not always follow these answer settings: Suggestions: Off."
		);
		expect(knownWeakSpotFor("speakleash/Bielik-11B-v3.0-Instruct")).toBe(
			"Bielik 11B v3 sometimes goes along with a message that tells it to ignore its instructions or take on a new role. " +
				"Bielik 11B v3 does not always follow these answer settings: Plain language, Answer length: Short, Suggestions: Off, Format: Prose."
		);
	});

	it("names no answer setting for Mistral Medium 3.5, the default, or Mistral Large 3, which kept the promise of every setting", () => {
		expect(knownWeakSpotFor("mistral-medium-2604")).toBeUndefined();
		expect(knownWeakSpotFor("mistral-large-2512")).toBeUndefined();
	});

	it("names the failed answer settings by the labels of the visitor's language", async () => {
		const de = await inLocale("de", () => knownWeakSpotFor("speakleash/Bielik-11B-v3.0-Instruct"));
		expect(de).toContain("Einfache Sprache, Antwortlänge: Kurz, Vorschläge: Aus, Format: Fließtext");
	});
});
