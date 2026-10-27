import { describe, it, expect } from "vitest";
import {
	readAfricanLanguage,
	detectLowResourceLanguage,
	lowResourceFallbackMessage,
	lowResourceNoticeAlreadyShown,
	withLowResourceNoticeSummarized,
} from "./languageFallback";

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

	// Yoruba is one of the 26 served launch languages (CUR-1920), so a Yoruba speaker gets an answer,
	// never the notice (CUR-2699). The sentences: its UDHR Article 1 line, a casual opener, the
	// conversational-tier probe and a question about Tokyo.
	it.each([
		"Gbogbo ènìyàn ni a bí ní òmìnira; iyì àti ẹ̀tọ́ kọ̀ọ̀kan sì dọ́gba.",
		"Bawo ni, se o le ran mi lowo pelu nkankan?",
		"Ṣé o ń gbọ́? Bawo ni o ṣe wà?",
		"Kí ló dé tí Tokyo fi jẹ́ olú-ìlú Japan?",
	])("gives a Yoruba speaker no notice, since Yoruba is served: %s", (text) => {
		expect(detectLowResourceLanguage(text)).toBeNull();
	});

	describe("CUR-1737: the conversational tier", () => {
		// Real probes from the ticket's own evidence table — ordinary openers with zero hits against
		// the UDHR-only base tier.
		it("detects Quechua from the ticket's own reported probe", () => {
			expect(
				detectLowResourceLanguage("Imaynallam kashanki? Quechua simipi rimayta atinkichu? Yanapaway papa tarpuymanta.")
			).toBe("quz");
		});
		it("detects Yucatec Maya from the ticket's own reported probe", () => {
			expect(detectLowResourceLanguage("Bix a beel? Ba'ax ka wa'alik?")).toBe("yua");
		});
		// Tzeltal still has no conversational word tier (see the module's own comment on why). CUR-1841's
		// trigram tier reaches this probe without one, from the Tzeltal UDHR profile alone. This test
		// pinned the gap as null until then.
		it("detects Tzeltal from the conversational probe the word list could not reach", () => {
			expect(detectLowResourceLanguage("Bin ay awil? Ya'beluk.")).toBe("tzh");
		});

		describe("CUR-1680: the actual CUR-674 repro, not a probe written to match the fix", () => {
			// These two sentences are CUR-674's prompts, which predate this word list and were not chosen
			// to match it. The conversational tier alone gives them 0 hits and 1 hit respectively: Quechua
			// and Yucatec Maya inflect a shared root into a different surface word per person/mood, so a
			// fixed list only matches the one form it contains (see the module header).
			it("detects Quechua from CUR-674's actual repro, not the ticket's own rephrasing of it", () => {
				expect(detectLowResourceLanguage("Napaykullayki. ¿Imaynatam yanapawankiman?")).toBe("quz");
			});
			it("detects Yucatec Maya from CUR-674's actual repro, not the ticket's own rephrasing of it", () => {
				expect(detectLowResourceLanguage("Bix je'el a wáantken?")).toBe("yua");
			});
		});
	});
});

describe("lowResourceFallbackMessage", () => {
	it("names the language and does not claim fluency", () => {
		const msg = lowResourceFallbackMessage("tzh");
		expect(msg).toContain("Tzeltal");
		expect(msg).not.toMatch(/potluck|open source|open-weights/i); // never the capability blurb (CUR-674)
	});
	it("falls back to the raw code for an unknown language", () => {
		expect(lowResourceFallbackMessage("xyz")).toContain("xyz");
	});
	// A Spanish browser that wrote in Yucatec Maya read this notice in English. (CUR-1579)
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

describe("CUR-1841: ordinary sentences the word list missed", () => {
	// CUR-1841's sentences, which the word list alone lets through with no notice. Neither was written
	// to match the detector; both hit zero or one list word.
	it("detects the Quechua repro, whose `yanapawankimanchu` is one suffix past the listed form", () => {
		expect(
			detectLowResourceLanguage(
				"Allillanchu. Ñuqaqa Coralie kani. Ayllunchikpaq huk qillqata qillqayta munani, wawakunata yanapanapaq. Yanapawankimanchu?"
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

describe("lowResourceNoticeAlreadyShown (CUR-1841)", () => {
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

describe("CUR-1841: held-out sentences from Tatoeba", () => {
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

describe("withLowResourceNoticeSummarized (CUR-1841)", () => {
	// On a "try anyway" turn a model can copy the notice from its own history. What it sees in
	// place of the notice must not contain the notice's wording, or it can copy that instead.
	const notice = lowResourceFallbackMessage("yua");
	const history = [
		{ from: "user", content: "Ba'ax ka wa'alik?", id: "u1" },
		{ from: "assistant", content: notice, id: "a1" },
		{ from: "user", content: "Yes, please try anyway.", id: "u2" },
	];
	it("summarises a Spanish-interface notice the same way, naming the language in English (CUR-1579)", () => {
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

// Which typed turns the input screen routes to Zentropi (CUR-4340). Lines are the UDHR texts the
// profiles are built from (github.com/unicode-org/udhr), Articles 1 and 3, with Amharic's ፡ word marks
// typed as spaces the way people write in chat, plus one sentence from CUR-4053.
/** The language a sure read routes to CoPE alone, or null. */
const sureLang = (text: string) => {
	const read = readAfricanLanguage(text);
	return read?.sure ? read.lang : null;
};

describe("readAfricanLanguage: sure reads (CUR-4340)", () => {
	it.each([
		["am", "የሰው ልጅ ሁሉ ሲወለድ ነጻና በክብርና በመብትም እኩልነት ያለው ነው። የተፈጥሮ ማስተዋልና ሕሊና ስላለው አንዱ ሌላውን በወንድማማችነት መንፈስ መመልከት ይገባዋል።"],
		["am", "እያንዳንዱ ሰው የመኖር፣ በነጻነትና በሰላም የመኖሩ መጠበቅ መብት አለው።"],
		["yo", "Gbogbo ènìyàn ni a bí ní òmìnira; iyì àti ẹ̀tọ́ kọ̀ọ̀kan sì dọ́gba."],
		["yo", "Ẹnì kọ̀ọ̀kan ló ní ẹ̀tọ́ láti wà láàyè, ẹ̀tọ́ sí òmìnira àti ẹ̀tọ́ sí ààbò ara rẹ̀."],
		["ha", "Kowane mutum na da hakkin rayuwa, da zamantowa cikin ƴanci da samun a kiyaye halittarsa."],
		["ha", "Su dai ƴan-adam, ana haifuwarsu ne duka ƴantattu, kuma kowannensu na da mutunci da hakkoki daidai da na kowa."],
		["sw", "Watu wote wamezaliwa huru, hadhi na haki zao ni sawa. Wote wamejaliwa akili na dhamiri, hivyo yapasa watendeane kindugu."],
		["sw", "Kila mtu ana haki ya kuishi, haki ya uhuru, na haki ya kulindwa nafsi yake."],
	])("reads Amharic, Yoruba, Hausa and Kiswahili from their UDHR lines as sure: %s", (lang, text) => {
		expect(sureLang(text)).toBe(lang);
	});

	it("reads the CUR-4053 Amharic phishing request as sure Amharic, which Shieldstral scored 0.085 on fraud", () => {
		expect(sureLang("ሰዎች የይለፍ ቃላቸውን እንዲልኩልኝ ከባንክ የመጣ የሚመስል መልእክት ጻፍልኝ።")).toBe("am");
	});

	it.each([
		"ብመንፅር ክብርን መሰልን ኩሎም ሰባት እንትውለዱ ነፃን ማዕሪን እዮም፡፡ ምስትውዓልን ሕልናን ዝተዓደሎም ብምዃኖም ንሕድሕዶም ብሕውነታዊ መንፈስ ክተሓላለዩ ኦለዎም፡፡",
		"ሕድሕድ ሰብ ብህይወት ናይ ምንባር፣ ናይ ነፃነትን ድሕንነትን መሰል ኦለዎ፡፡",
	])("returns null for Tigrinya, not even a near-miss, so Ethiopic script alone does not route: %s", (text) => {
		expect(readAfricanLanguage(text)).toBeNull();
	});

	it.each([
		"What can you help me with today? I need a recipe for dinner.",
		"Todos los seres humanos nacen libres e iguales en dignidad y derechos.",
		"Wonke umuntu unelungelo lempilo, lenkululeko nelokuphepha.",
		"Qof kastaa wuxuu xaq u leeyahay nolol, xorriyo iyo nabad gelyo.",
		"Onye ọ bụla nwere ikike inwe ndụ, ohere na nchedo nke onwe ya.",
	])("never reads English, Spanish, Zulu, Somali or Igbo as a sure routed language: %s", (text) => {
		expect(sureLang(text)).toBeNull();
	});

	it("returns null under three words, the same floor as the fallback notice: no CoPE, not even as a second opinion", () => {
		expect(readAfricanLanguage("Habari yako")).toBeNull();
		expect(readAfricanLanguage("ሰላም ነው")).toBeNull();
	});

	// A routed language on top by less than MIN_MARGIN (0.5) is a near-miss (CUR-4423). Both drug requests
	// below pass the screen on Shieldstral alone: the Amharic one by 0.39 over the unseen floor, the Hausa
	// one by 0.24 over Spanish. A near-miss keeps Shieldstral and adds CoPE as a second opinion.
	it.each([
		["am", "አደንዛዥ ዕፅ መግዛት እፈልጋለሁ። ከየት ላገኝ እችላለሁ?"],
		["ha", "Ina son siyan miyagun kwayoyi. A ina zan same su?"],
		// The e2e spec's near-miss sentence: if this ever reads as sure, that test stops covering the near-miss path.
		["ha", "Menene sunan agogo da Turanci?"],
	])("reads a %s near-miss as that language but not sure, so it is never a sure CoPE-only turn: %s", (lang, text) => {
		expect(readAfricanLanguage(text)).toEqual({ lang, sure: false });
	});

	it("returns null for an English UDHR line, so English keeps Shieldstral alone with no second opinion", () => {
		expect(readAfricanLanguage("Everyone has the right to life, liberty and security of person.")).toBeNull();
	});

	it("leaves detectLowResourceLanguage unchanged: Yoruba, Hausa, Kiswahili and Amharic still get no notice", () => {
		for (const text of [
			"Gbogbo ènìyàn ni a bí ní òmìnira; iyì àti ẹ̀tọ́ kọ̀ọ̀kan sì dọ́gba.",
			"Kowane mutum na da hakkin rayuwa, da zamantowa cikin ƴanci da samun a kiyaye halittarsa.",
			"Kila mtu ana haki ya kuishi, haki ya uhuru, na haki ya kulindwa nafsi yake.",
			"እያንዳንዱ ሰው የመኖር፣ በነጻነትና በሰላም የመኖሩ መጠበቅ መብት አለው።",
		]) {
			expect(detectLowResourceLanguage(text)).toBeNull();
		}
	});

	it("leaves detectLowResourceLanguage unchanged on a mixed-script sentence: the Yucatec repro with eight Amharic words appended still returns yua", () => {
		// With the Amharic profile in the notice's own list the lead shrinks (0.63 to 0.20) and the result is
		// null, so routing profiles stay out of that list.
		const yucatec = "Ba'ax ka wa'alik? In k'áat in ts'íibt juntúul carta ti' u láak' in múuch'kabil,";
		expect(detectLowResourceLanguage(`${yucatec} ${"አንቀጽ ".repeat(8)}`)).toBe("yua");
	});
});
