import { describe, it, expect } from "vitest";
import {
	detectLowResourceLanguage,
	lowResourceFallbackMessage,
	lowResourceNoticeAlreadyShown,
	withLowResourceNoticeSummarized,
} from "../../shared/languageFallback";

describe("detectLowResourceLanguage", () => {
	// Real excerpts from the actual UDHR translations this table is sourced from (see the module
	// header) — not fabricated sample sentences, since a made-up "Quechua-ish" sentence proves nothing
	// about whether the detector fires on the real thing.
	it("detects Cusco Quechua from its own UDHR title line", () => {
		expect(detectLowResourceLanguage("PACHATIN LLAQTAKUNAPI RUNAQ ALLIN KANANPAQ JATUN KAMACHIKUY")).toBe(
			"quz"
		);
	});
	it("detects Yucatec Maya from its own UDHR opening line", () => {
		expect(
			detectLowResourceLanguage(
				"Tumeen u kuxtal wíinik x‐maʼa palitzilil, u chíimpoltaʼal yetel u chaʼabal u kuxtal yóokʼol kaab"
			)
		).toBe("yua");
	});
	it("detects Tzeltal from its own UDHR preamble line, apostrophe mark and all", () => {
		expect(
			detectLowResourceLanguage("Pasbil sok albil yu´un te Tso´b´tomba Lumetik tey ta spisil balumilaletik")
		).toBe("tzh");
	});
	it("matches a plain ASCII apostrophe the same as the source's typographic mark", () => {
		// Nobody types ´ (U+00B4) or ʼ (U+02BC) on an ordinary keyboard — real users type '. The two
		// Tzeltal words below are "yu´un"/"sk´an" in the source; typed with a plain apostrophe here.
		expect(detectLowResourceLanguage("ya sk'an yu'un te winiketike")).toBe("tzh");
	});
	it("requires >=2 distinct hits, same threshold as detectWikiLang", () => {
		expect(detectLowResourceLanguage("the jatun festival was fun this year")).toBeNull(); // only 1 hit
	});
	it("returns null for English", () => {
		expect(detectLowResourceLanguage("what can you help me with today")).toBeNull();
	});
	it("returns null for empty input", () => {
		expect(detectLowResourceLanguage("   ")).toBeNull();
	});

	// Yoruba is a language the app serves, so a Yoruba speaker gets an answer, never the notice. The
	// sentences: its UDHR Article 1 line, a casual opener, the
	// conversational-tier probe and a question about Tokyo.
	it.each([
		"Gbogbo ènìyàn ni a bí ní òmìnira; iyì àti ẹ̀tọ́ kọ̀ọ̀kan sì dọ́gba.",
		"Bawo ni, se o le ran mi lowo pelu nkankan?",
		"Ṣé o ń gbọ́? Bawo ni o ṣe wà?",
		"Kí ló dé tí Tokyo fi jẹ́ olú-ìlú Japan?",
	])("gives a Yoruba speaker no notice, since Yoruba is served: %s", (text) => {
		expect(detectLowResourceLanguage(text)).toBeNull();
	});

	describe("the conversational tier", () => {
		// Ordinary openers that match no word of the UDHR-only base tier.
		it("detects Quechua from the ticket's own reported probe", () => {
			expect(
				detectLowResourceLanguage("Imaynallam kashanki? Quechua simipi rimayta atinkichu? Yanapaway papa tarpuymanta.")
			).toBe("quz");
		});
		it("detects Yucatec Maya from the ticket's own reported probe", () => {
			expect(detectLowResourceLanguage("Bix a beel? Ba'ax ka wa'alik?")).toBe("yua");
		});
		// Tzeltal has no conversational word tier (see the module's own comment on why). The trigram
		// tier reaches this probe without one, from the Tzeltal UDHR profile alone.
		it("detects Tzeltal from the conversational probe the word list could not reach", () => {
			expect(detectLowResourceLanguage("Bin ay awil? Ya'beluk.")).toBe("tzh");
		});

		describe("the actual repro, not a probe written to match the fix", () => {
			// These two sentences were written before this word list and were not chosen to match it.
			// The conversational tier alone matches none and one of their words respectively: Quechua
			// and Yucatec Maya inflect a shared root into a different surface word per person/mood, so a
			// fixed list only matches the one form it contains (see the module header).
			it("detects Quechua from the actual repro, not the ticket's own rephrasing of it", () => {
				expect(detectLowResourceLanguage("Napaykullayki. ¿Imaynatam yanapawankiman?")).toBe("quz");
			});
			it("detects Yucatec Maya from the actual repro, not the ticket's own rephrasing of it", () => {
				expect(detectLowResourceLanguage("Bix je'el a wáantken?")).toBe("yua");
			});
		});
	});
});

describe("lowResourceFallbackMessage", () => {
	it("names the language and does not claim fluency", () => {
		const msg = lowResourceFallbackMessage("tzh");
		expect(msg).toContain("Tzeltal");
		expect(msg).not.toMatch(/potluck|open source|open-weights/i); // never the capability blurb
	});
	it("falls back to the raw code for an unknown language", () => {
		expect(lowResourceFallbackMessage("xyz")).toContain("xyz");
	});
	// A Spanish browser that writes in Yucatec Maya must read this notice in Spanish, not English.
	it("is written in the interface language, naming the language in that language", () => {
		expect(lowResourceFallbackMessage("yua", "es")).toMatch(/^Todavía no puedo responder con fiabilidad en maya yucateco:/);
		expect(lowResourceFallbackMessage("quz", "fr")).toMatch(/^Je ne peux pas encore répondre de façon fiable en quechua :/);
		expect(lowResourceFallbackMessage("tzh", "de")).toMatch(/^Auf Tzeltal kann ich noch nicht zuverlässig antworten:/);
	});
	it("stays English for an English, missing or untranslated interface language", () => {
		for (const ui of ["en", undefined, null, "ja"]) {
			expect(lowResourceFallbackMessage("yua", ui)).toBe(lowResourceFallbackMessage("yua"));
		}
		expect(lowResourceFallbackMessage("yua")).toMatch(/^I can't yet answer reliably in Yucatec Maya —/);
	});
});

describe("ordinary sentences the word list missed", () => {
	// Sentences the word list alone lets through with no notice. Neither was written to match the
	// detector; each hits at most one list word.
	it("detects the Quechua repro, whose `yanapawankimanchu` is one suffix past the listed form", () => {
		expect(
			detectLowResourceLanguage(
				"Allillanchu. Ñuqaqa Ada kani. Ayllunchikpaq huk qillqata qillqayta munani, wawakunata yanapanapaq. Yanapawankimanchu?"
			)
		).toBe("quz");
	});
	it("detects the Yucatec Maya repro, which holds no listed word at all", () => {
		expect(
			detectLowResourceLanguage("Ba'ax ka wa'alik? In k'áat in ts'íibt juntúul carta ti' u láak' in múuch'kabil,")
		).toBe("yua");
	});
	it("still detects the Yucatec repro typed without its accents, the way a phone keyboard sends it", () => {
		expect(
			detectLowResourceLanguage("Ba'ax ka wa'alik? In k'aat in ts'iibt juntuul carta ti' u laak' in muuch'kabil,")
		).toBe("yua");
	});

	// A false positive hands someone a canned "I can't answer" where they get an answer today, so the
	// trigram tier must stay silent on ordinary text in languages it does not target.
	it.each([
		"Can you help me write a short letter to my landlord about the broken heating?",
		"¿Me puedes ayudar a escribir una carta corta para mi familia en el pueblo?",
		"Você pode me ajudar a planejar uma viagem de três dias para Lisboa?",
		"Peux-tu m'expliquer comment fonctionne la photosynthèse, en termes simples ?",
		"const total = items.reduce((acc, item) => acc + item.price, 0);",
		"https://www.aipotluck.org/chat/conversation/abc123 is not loading for me",
	])("returns null for ordinary non-target text: %s", (text) => {
		expect(detectLowResourceLanguage(text)).toBeNull();
	});
	// Every false positive seen while tuning was a sentence this short; MIN_WORDS exists for them.
	it("returns null for a two-word Swahili sentence the trigram tier once read as Quechua", () => {
		expect(detectLowResourceLanguage("Nina haraka.")).toBeNull();
	});
});

describe("lowResourceNoticeAlreadyShown", () => {
	const notice = lowResourceFallbackMessage("quz");
	it("is false for a conversation that has not shown the notice", () => {
		expect(
			lowResourceNoticeAlreadyShown([
				{ from: "user", content: "Allillanchu?" },
				{ from: "assistant", content: "Hello! How can I help?" },
			])
		).toBe(false);
	});
	it("is true once the real notice text is an assistant message, so 'try anyway' gets an attempt", () => {
		expect(
			lowResourceNoticeAlreadyShown([
				{ from: "user", content: "Allillanchu. Yanapawankimanchu?" },
				{ from: "assistant", content: notice },
				{ from: "user", content: "Yes, please try anyway." },
			])
		).toBe(true);
	});
	it("ignores the notice's wording when the person typed it themselves", () => {
		expect(lowResourceNoticeAlreadyShown([{ from: "user", content: notice }])).toBe(false);
	});
	it.each(["es", "fr", "de", "it", "pt", "nl"])("recognises the %s notice, so a localised notice is not shown twice (CUR-1579)", (ui) => {
		for (const lang of ["quz", "yua", "tzh"]) {
			expect(lowResourceNoticeAlreadyShown([{ from: "assistant", content: lowResourceFallbackMessage(lang, ui) }])).toBe(true);
		}
	});
	it("is false for an ordinary answer that opens the way a notice does", () => {
		expect(
			lowResourceNoticeAlreadyShown([
				{ from: "assistant", content: "Auf Deutsch kann ich gern antworten. Was möchten Sie wissen?" },
				{ from: "assistant", content: "Todavía no puedo responder con fiabilidad en este momento, pero lo intento." },
			])
		).toBe(false);
	});
});

describe("held-out sentences from Tatoeba", () => {
	// The first three sentences of five or more words in each language on tatoeba.org (sorted by
	// creation, CC BY 2.0 FR), taken in order whether or not they hit. Nothing here
	// was used to build the profiles or pick the thresholds.
	it.each([
		["14012392", "Ama pipaqpas millayta munaychu, qampa millayniykin ñanmanta hamuchkan."],
		["13990335", "Viracochaqa huk generacionta ñawpaq hatun runakunata rumimanta ruwarqan."],
		["13990331", "Viracochaqa huk ñawpa hatun runakunata rumimanta ruwarqan."],
	])("detects Quechua in Tatoeba #%s", (_id, text) => {
		expect(detectLowResourceLanguage(text)).toBe("quz");
	});
	it("detects Yucatec Maya in Tatoeba #12689008", () => {
		expect(detectLowResourceLanguage("A wojéel ba'ax le e-booko'?")).toBe("yua");
	});
	// Known misses. Yucatec scores highest on both, but K'iche' and Mam come within MIN_MARGIN, so the
	// tier stays silent rather than risk naming the wrong Mayan language. Pinned so a change that closes
	// them has to flip these on purpose.
	it.each([
		["12689006", "Teeche' jach kíimak a wóol ti' in kiik"],
		["12689000", "Ka wojéel mixba'al ti' teen"],
	])("known miss: short Yucatec Tatoeba #%s loses to neighbouring Mayan profiles", (_id, text) => {
		expect(detectLowResourceLanguage(text)).toBeNull();
	});
});

describe("withLowResourceNoticeSummarized", () => {
	// On a "try anyway" turn a model can copy the notice from its own history. What it sees in
	// place of the notice must not contain the notice's wording, or it can copy that instead.
	const notice = lowResourceFallbackMessage("yua");
	const history = [
		{ from: "user", content: "Ba'ax ka wa'alik?", id: "u1" },
		{ from: "assistant", content: notice, id: "a1" },
		{ from: "user", content: "Yes, please try anyway.", id: "u2" },
	];
	it("summarises a Spanish-interface notice the same way, naming the language in English", () => {
		const out = withLowResourceNoticeSummarized([
			history[0],
			{ ...history[1], content: lowResourceFallbackMessage("yua", "es") },
			history[2],
		]);
		expect(out[1].content).not.toContain("Todavía no puedo");
		expect(out[1].content).toContain("Yucatec Maya");
	});
	it("replaces the notice with a note the model cannot copy as the notice", () => {
		const out = withLowResourceNoticeSummarized(history);
		expect(out[1].content).not.toContain("I can't yet answer reliably");
		expect(out[1].content).toContain("Yucatec Maya");
		expect(lowResourceNoticeAlreadyShown(out)).toBe(false);
	});
	it("keeps every other message, and each message's other fields, as they were", () => {
		const out = withLowResourceNoticeSummarized(history);
		expect(out[0]).toBe(history[0]);
		expect(out[2]).toBe(history[2]);
		expect(out[1].id).toBe("a1");
	});
	it("leaves a conversation with no notice untouched", () => {
		const plain = [{ from: "assistant", content: "Hello! How can I help?" }];
		expect(withLowResourceNoticeSummarized(plain)).toEqual(plain);
	});
});

describe("detectLowResourceLanguage: Amharic, Yoruba, Hausa and Kiswahili", () => {
	it("gives Yoruba, Hausa, Kiswahili and Amharic no notice", () => {
		for (const text of [
			"Gbogbo ènìyàn ni a bí ní òmìnira; iyì àti ẹ̀tọ́ kọ̀ọ̀kan sì dọ́gba.",
			"Kowane mutum na da hakkin rayuwa, da zamantowa cikin ƴanci da samun a kiyaye halittarsa.",
			"Kila mtu ana haki ya kuishi, haki ya uhuru, na haki ya kulindwa nafsi yake.",
			"እያንዳንዱ ሰው የመኖር፣ በነጻነትና በሰላም የመኖሩ መጠበቅ መብት አለው።",
		]) {
			expect(detectLowResourceLanguage(text)).toBeNull();
		}
	});

	it("still returns yua for the Yucatec repro with eight Amharic words appended (mixed script)", () => {
		// With an Amharic profile in the notice's own list the lead shrinks (0.63 to 0.20) and the result is
		// null, so no Amharic profile is in that list.
		const yucatec = "Ba'ax ka wa'alik? In k'áat in ts'íibt juntúul carta ti' u láak' in múuch'kabil,";
		expect(detectLowResourceLanguage(`${yucatec} ${"አንቀጽ ".repeat(8)}`)).toBe("yua");
	});
});
