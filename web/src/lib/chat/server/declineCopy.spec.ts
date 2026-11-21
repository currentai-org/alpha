import { describe, expect, it, vi } from "vitest";
import RULES from "$lib/chat/server/rules.json";
import { isSupportRule } from "$lib/chat/server/ruleLabel";
import {
	DECLINE_LANGUAGES,
	declineLanguageFromTag,
	declineMessage,
	declineNotice,
	hasTranslation,
	logDeclineLanguage,
	readMessageLanguage,
} from "$lib/chat/server/declineCopy";

const POLICY_RULES = Object.entries(RULES as Record<string, { label?: string; message?: string }>).filter(
	([key, entry]) => !key.startsWith("_") && !isSupportRule(key) && entry.message && entry.label
) as Array<[string, { label: string; message: string }]>;

// Prompt injection's decline never reaches a visitor today (its guard is exempt, rules.json), so it has
// no translation yet; every other policy rule must, or that rule's notice silently reads in English.
const UNTRANSLATED = new Set(["chat-block-prompt"]);

describe("decline copy", () => {
	it("translates every policy rule's message and label into every decline language, so none falls back to English", () => {
		const missing: string[] = [];
		for (const [key, { label, message }] of POLICY_RULES) {
			if (UNTRANSLATED.has(key)) continue;
			for (const lang of DECLINE_LANGUAGES) if (!hasTranslation(message, label, lang)) missing.push(`${key} ${lang}`);
		}
		expect(missing).toEqual([]);
	});

	// The support card above the decline carries the emergency number, picked per country, so the decline
	// names none.
	it("the crisis-support message is translated into every decline language, keeps the findahelpline link and 988, and names no emergency number", () => {
		const crisis = (RULES as Record<string, { message?: string }>)["chat-block-self-harm"]?.message ?? "";
		expect(crisis).not.toBe("");
		for (const lang of DECLINE_LANGUAGES) {
			const text = declineMessage(crisis, lang);
			expect(text, `${lang} falls back to English`).not.toBe(crisis);
			expect(text, `${lang} lost the findahelpline link`).toContain("[findahelpline.com](https://findahelpline.com)");
			expect(text, `${lang} names 112`).not.toMatch(/\b112\b/);
			expect(text, `${lang} lost 988`).toContain("988");
		}
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

describe("[turn] decline-language line", () => {
	const lineOf = (info: ReturnType<typeof vi.fn>) => info.mock.calls.find((c) => c[1] === "[turn] decline-language")?.[0];

	it("logging does not hold the caller: the call returns while the second read is still pending, and the line follows once it settles", async () => {
		const info = vi.fn();
		let settle!: (v: { lang: string }) => void;
		const slow = new Promise<{ lang: string }>((r) => (settle = r));
		const logged = logDeclineLanguage({
			logger: { info },
			conversationId: "c1",
			noticeLanguage: Promise.resolve("ca"),
			signal: slow,
			capMs: 5_000,
		});
		// The caller moved on (it does not await `logged`); nothing is logged while the read is pending.
		expect(info).not.toHaveBeenCalled();
		settle({ lang: "fr" });
		await logged;
		expect(lineOf(info)).toEqual({ conversationId: "c1", declineLanguage: "ca", declineSignalLanguage: "fr" });
	});

	it("a read slower than the cap logs the line with declineSignalLanguage null rather than waiting on it", async () => {
		const info = vi.fn();
		await logDeclineLanguage({
			logger: { info },
			conversationId: "c2",
			noticeLanguage: Promise.resolve("fr"),
			signal: new Promise(() => {}),
			capMs: 10,
		});
		expect(lineOf(info)).toEqual({ conversationId: "c2", declineLanguage: "fr", declineSignalLanguage: null });
	});

	it("a read that rejects logs the line with declineSignalLanguage null", async () => {
		const info = vi.fn();
		await logDeclineLanguage({
			logger: { info },
			conversationId: "c3",
			noticeLanguage: Promise.resolve("en"),
			signal: Promise.reject(new Error("down")),
		});
		expect(lineOf(info)?.declineSignalLanguage).toBeNull();
	});
});
