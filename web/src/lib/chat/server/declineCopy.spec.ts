import { describe, expect, it } from "vitest";
import RULES from "$lib/chat/server/rules.json";
import { isSupportRule } from "$lib/chat/server/ruleLabel";
import {
	DECLINE_LANGUAGES,
	declineLanguageFromTag,
	declineNotice,
	hasTranslation,
	readMessageLanguage,
} from "$lib/chat/server/declineCopy";

const POLICY_RULES = Object.entries(RULES as Record<string, { label?: string; message?: string }>).filter(
	([key, entry]) => !key.startsWith("_") && !isSupportRule(key) && entry.message && entry.label
) as Array<[string, { label: string; message: string }]>;

// Prompt injection's decline never reaches a visitor today (its guard is exempt, rules.json), so it has
// no translation yet; every other policy rule must, or that rule's notice silently reads in English.
const UNTRANSLATED = new Set(["chat-block-prompt"]);

describe("decline copy (CUR-4051)", () => {
	it("translates every policy rule's message and label into every decline language, so none falls back to English", () => {
		const missing: string[] = [];
		for (const [key, { label, message }] of POLICY_RULES) {
			if (UNTRANSLATED.has(key)) continue;
			for (const lang of DECLINE_LANGUAGES) if (!hasTranslation(message, label, lang)) missing.push(`${key} ${lang}`);
		}
		expect(missing).toEqual([]);
	});

	it("writes the notice and who set the limit in the person's language", () => {
		expect(
			declineNotice("This request was declined because it goes against our content policy.", "Drug content", "es")
		).toBe(
			"Esta solicitud se rechazó porque va en contra de nuestra política de contenido.\n\nCurrent AI estableció este límite (regla: Contenido sobre drogas)."
		);
	});

	it("falls back to English whole, never half-translated, when a message has no translation", () => {
		expect(declineNotice("A sentence nobody translated.", "Drug content", "fr")).toBe(
			"A sentence nobody translated.\n\nCurrent AI set this limit (rule: Drug content)."
		);
	});

	it.each([
		["¿Me puedes recomendar algunos barrios tranquilos para alquilar un piso en Madrid?", "es"],
		["Peux-tu résumer cet essai sur la révolution industrielle en quelques phrases ?", "fr"],
		["Como faço para consultar o meu CPF pela internet sem sair de casa?", "pt"],
		["எனக்கு ஒரு வேலைக்கான விண்ணப்பக் கடிதம் எழுத உதவ முடியுமா?", "ta"],
		["Can you recommend a few quiet neighbourhoods for renting a flat in Madrid?", "en"],
		["", "en"],
	])("reads %j as %s", async (text, lang) => {
		expect(declineLanguageFromTag(await readMessageLanguage(text))).toBe(lang);
	});
});
