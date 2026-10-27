/**
 * A curated, pre-generation detector for a fixed, small set of languages where answers go wrong
 * (CUR-742): Quechua and Yucatec Maya get the English capability blurb, and Tzeltal leaks internal
 * scaffolding (CUR-674). It grows as failures are found and is not built for the long tail, the same
 * posture as `detectWikiLang` (searchUtil.ts), which documents the tradeoff for the adjacent
 * search-language problem.
 *
 * No off-the-shelf language-ID library: `franc` covers Quechua (quz/quy/qug) but neither Yucatec Maya
 * nor Tzeltal in any of its 163 languages, so it would solve one of three targets. The n-gram tier
 * below (CUR-1841) uses trigram profiles built for every target and its neighbours from the UDHR
 * corpus instead, so one method covers every target. The word list still answers first; see "The
 * trigram tier" further down for why and how well it does.
 *
 * Word list provenance: every word below is drawn from a cited source, not written from memory. Two
 * provenances:
 *
 * - The base tier (every language): the UDHR (Universal Declaration of Human Rights) translation for
 *   that language, official OHCHR translations archived by the "UDHR in Unicode" project at
 *   unicode.org/udhr (via the Wayback Machine). Picked by frequency and distinctiveness from the
 *   corpus. Exact source per language cited below.
 * - The conversational tier (quz and yua only, CUR-1737): the UDHR is legal-register prose with no
 *   greeting, no second-person verb form and no request, the whole register a chat opener uses, so the
 *   base tier alone does not fire on ordinary conversation (zero hits on five ordinary openers across
 *   all four languages). Sourced from each language's Wikivoyage phrasebook "Basics" section instead,
 *   which is written in that register. Cited per language below. **Tzeltal has no addition**: no
 *   Wikivoyage phrasebook page exists for it, and neither Omniglot's Tzeltal page, Wiktionary
 *   (its "Tzeltal lemmas" category holds 32 nature, kinship and animal entries, no greeting or verb of
 *   request) nor Glosbe carries a conversational Tzeltal wordlist; every candidate source was the same
 *   UDHR text already in the base tier. Left unaddressed rather than invented.
 * - Inflected forms (quz, yua; CUR-1680): Quechua and Yucatec Maya inflect the same root into a
 *   different surface word per person, mood and register, so a fixed word list only matches the one
 *   inflected form it contains. `imaynallam` does not match `imaynatam`; `yanapaway` (imperative) does
 *   not match `yanapawankiman` (conditional, "you would help me"). Three more attested forms cover
 *   CUR-674's prompts without inventing an inflection from memory:
 *   - `napaykullayki` (quz): a second, verbatim "Hello." (formal) entry on the same Wikivoyage Quechua
 *     phrasebook page cited above, printed next to `rimaykullayki` as an alternate.
 *   - `yanapawankiman` (quz): not a phrasebook entry, so built by rule rather than by memory. Vanenos'
 *     Quechua grammar course (vanenos.com, "Quechua Lesson 6") states the regular 2nd-person
 *     conditional as `muna-nki-man` ("you would love") and the `-wa-` object infix as "you to me:
 *     -wa-nki" (its own example: `kuyawankichu?`, "do you love me?"), and says "All verbs in Quechua
 *     are regular. There are no exceptions." Applying that rule to the already-cited root `yanapay`
 *     ("to help") gives `yanapa-wa-nki-man`, "you would help me", once the vowels elide.
 *   - `je'el` (yua): verbatim, from the same Wikivoyage Yucatec Maya phrasebook page cited below, where
 *     it opens the page's `je'el u páajtal...?` ("is it possible to ...?") construction, used dozens of
 *     times across the Directions/Shopping/Restaurant sections as the ordinary way to phrase a polite
 *     request.
 *
 * Not similarly sourced: LOW_RESOURCE_FALLBACK_MESSAGES. The UDHR is in third-person/impersonal
 * register throughout ("nobody shall be...", "everyone has the right...") and none of the three source
 * texts contains a first-person construction, so a chatbot's first-person disclaimer ("I don't speak
 * this well yet") cannot be adapted from it the way the word list can. See each message's own comment
 * for what it is.
 */

import { chromeLanguage } from "$lib/chat/chromeCopy";
import languageProfiles from "$lib/chat/server/data/language-profiles.json";
import { ZENTROPI_JUDGE, type RoutedLanguage } from "../../../../../config/safetyScreen";
import { trigrams } from "./trigrams";

// Apostrophe-like marks vary by source transcription (U+02BC MODIFIER LETTER APOSTROPHE in the Yucatec
// text, U+00B4 ACUTE ACCENT used as a standalone saltillo in the Tzeltal text) and none of them is what
// a person typing on an ordinary keyboard or phone produces — a straight apostrophe (U+0027) or, on a
// phone's smart-quote autocorrect, a curly right single quote (U+2019). Normalize all four to "'" on
// both sides of the comparison, or every real-world match on these two languages fails.
const APOSTROPHE_LIKE = /['´ʼ’]/g;
function normalizeApostrophes(s: string): string {
	return s.replace(APOSTROPHE_LIKE, "'");
}

const LOW_RESOURCE_LANG_WORDS: Record<string, string[]> = {
	// Cusco Quechua. Base tier source: UDHR translation, archived
	// https://unicode.org/udhr/d/udhr_quz.txt (OHCHR, 1996-2009). Picked from the actual
	// word-frequency distribution of that text.
	quz: [
		"llapa",
		"ñiqen",
		"jatun",
		"allin",
		"runa",
		"manan",
		"atinchu",
		"kausay",
		// Conversational tier (CUR-1737). Source: en.wikivoyage.org/wiki/Quechua_phrasebook, "Basics"
		// section. Every word below is copied verbatim from that page's example phrases, not typed from
		// memory. "imaynallam" and "yanapaway" match a probe like "Imaynallam kashanki? ... Yanapaway
		// papa tarpuymanta."; they are the source's "How are you?" and "Help!" entries.
		"rimaykullayki", // "Hello." (formal)
		"allillanchu", // "How are you?" (formal)
		"imaynallan", // "How are you?" (informal, one spelling)
		"imaynallam", // "How are you?" (informal, the other spelling)
		"kachkanki", // second-person "are [you]", from the same "How are you?" line
		"yanapaway", // "Help!"
		"sulpayki", // "Thank you." (formal)
		"arí", // "Yes."
		// Inflected forms (CUR-1680; provenance in the file header): one more Wikivoyage entry and one
		// rule-derived form, which together match "Napaykullayki. ¿Imaynatam yanapawankiman?" where the
		// conversational tier above does not.
		"napaykullayki", // "Hello." (formal, alternate to rimaykullayki)
		"yanapawankiman", // "you would help me" (yanapay + -wa- "me" + -nki-man conditional)
	],
	// Yucatec Maya. Base tier source: UDHR translation, archived
	// https://unicode.org/udhr/d/udhr_yua.txt (OHCHR, 1996-2009).
	yua: [
		"yetel",
		"tuláakal",
		"máak",
		"sijnal",
		"kuxtal",
		"tiʼal",
		"wíinik",
		"unaj",
		// Conversational tier (CUR-1737). Source: en.wikivoyage.org/wiki/Yucatec_Maya_phrasebook,
		// "Basics" section, verbatim. "bix" and "beel" match a probe like "Bix a beel? Ba'ax ka
		// wa'alik?"; the source's informal "Hello."/"How are you?" entry is "Bix a beel".
		"bix", // "Hello."/"How are you?" opener
		"beel", // from the same "Bix a beel" line
		"ma'alob", // "Fine, thank you." (also "good"/"well")
		"jaaj", // "Yes."
		"sa'asten", // "Excuse me." (getting attention)
		"áantaj", // "Help!"
		"k'aaba", // "name", from "What is your name?"
		"óolal", // from "Nib óolal" — "Thank you."
		// Inflected forms (CUR-1680; see file header). Matches "Bix jeʼel a wáantken?", which hits only
		// "bix" under the conversational tier above, one short of the 2-hit threshold.
		"je'el", // "is it possible" / "can" — opens the page's own "je'el u páajtal...?" construction
	],
	// Tzeltal, Oxchuc variety. Source: UDHR translation, archived
	// https://unicode.org/udhr/d/udhr_tzh.txt (OHCHR, 1996-2009).
	//
	// No conversational tier here, unlike quz and yua. No Tzeltal phrasebook, Wiktionary
	// word list or dictionary meeting this file's citation bar exists (Omniglot's sample text is the
	// same UDHR Article 1 already in the base tier). The tier is left out rather than typed from
	// memory, which this file's header forbids. Tzeltal conversational coverage is a known gap. (CUR-1737)
	tzh: ["winiketik", "spisil", "yu'un", "sk'an", "rerecho", "lumetik", "bit'il", "mach'a"],
};

/** Human-readable name for each code above, used only to name the language in the fallback message. */
const LOW_RESOURCE_LANG_NAMES: Record<string, string> = {
	quz: "Quechua",
	yua: "Yucatec Maya",
	tzh: "Tzeltal",
};

/** The word-list tier: >=2 distinct exact-word hits, same threshold as `detectWikiLang`. */
function detectByWordList(text: string): string | null {
	const q = normalizeApostrophes(text.trim().toLowerCase());
	if (!q) return null;
	const tokens = new Set(q.match(/[\p{L}']+/gu) ?? []);
	if (tokens.size === 0) return null;
	for (const [lang, words] of Object.entries(LOW_RESOURCE_LANG_WORDS)) {
		const hits = words.reduce((acc, w) => acc + (tokens.has(normalizeApostrophes(w)) ? 1 : 0), 0);
		if (hits >= 2) return lang;
	}
	return null;
}

// ── The trigram tier (CUR-1841) ──────────────────────────────────────────────────────────────────
// The word list matches only the exact inflected forms it holds, and Quechua and Yucatec Maya inflect
// every root into a different surface word per person, mood and register. On held-out Tatoeba
// sentences (tatoeba.org, never used to build anything here) it catches 3 of 631 Quechua, 1 of 33
// Yucatec Maya and 0 of 116 Yoruba.
//
// So a sentence the list misses is scored against character-trigram profiles of every language in
// `data/language-profiles.json` (built by scripts/gen-language-profiles.mts from the same UDHR corpus
// the word list cites) and assigned to the nearest. Trigrams see inside an inflected word, which is
// what the list cannot do. It fires only when the nearest language is a target, it beats the nearest
// non-target by MIN_MARGIN, and the text has MIN_WORDS words.
//
// Both thresholds were chosen on odd-numbered Tatoeba lines and reported on even-numbered ones:
//   all lengths:      Quechua 148/316, Yoruba 38/58, Yucatec 11/17; 1 false positive in 2,257
//                     sentences across 16 control languages
//   five words or more (closer to a chat message): Quechua 88/106, Yoruba 23/27, Yucatec 10/11;
//                     0 false positives in 3,105
// A false positive costs more than a miss: it hands someone writing in Swahili or Finnish a canned
// "I can't answer" where they would otherwise get an answer. The false positives in tuning were sentences
// of five words or fewer, which is what MIN_WORDS is for.
const MIN_MARGIN = 0.5;
const MIN_WORDS = 3;
// Below this many trigrams there is too little text to score at all.
const MIN_TRIGRAMS = 6;
// Log-probability charged for a trigram a profile does not hold.
const UNSEEN = Math.log(1e-5);

/** Profile code -> the target it counts as. Profiles not listed here are controls. */
const TRIGRAM_TARGETS: Record<string, string> = {
	quz: "quz",
	quy: "quz",
	qug: "quz",
	yua: "yua",
	tzh: "tzh",
	// Yoruba is a served launch language (A2; CUR-1920, CUR-2699), so its profile is a control: Yoruba
	// text lands on it and gets no notice. Its serving quality is CUR-1104's.
};

type RawProfiles = Record<string, { grams: string; counts: number[] }>;
type Profiles = [string, Map<string, number>][];

function buildProfiles(raw: RawProfiles): Profiles {
	return Object.entries(raw).map(([code, { grams, counts }]) => {
		const total = counts.reduce((a, n) => a + n, 0);
		const m = new Map<string, number>();
		counts.forEach((n, i) => m.set(grams.slice(i * 3, i * 3 + 3), Math.log(n / total)));
		return [code, m];
	});
}

const RAW = languageProfiles as { profiles: RawProfiles; routingProfiles: RawProfiles };
const PROFILES = buildProfiles(RAW.profiles);

/** The target the nearest profile counts as, and how far it beats the nearest profile of any other
 *  target. Null when the text is too short to score, the nearest profile is a control, or no rival exists. */
function rankByTrigrams<T extends string>(
	text: string,
	targets: Readonly<Record<string, T>>,
	profiles: Profiles
): { target: T; margin: number } | null {
	if ((text.match(/[\p{L}']+/gu) ?? []).length < MIN_WORDS) return null;
	const grams = trigrams(text);
	if (grams.length < MIN_TRIGRAMS) return null;
	const scores = profiles
		.map(([code, m]) => [code, grams.reduce((acc, g) => acc + (m.get(g) ?? UNSEEN), 0) / grams.length] as const)
		.sort((a, b) => b[1] - a[1]);
	const target = targets[scores[0][0]];
	if (!target) return null;
	const rival = scores.find(([code]) => targets[code] !== target);
	return rival ? { target, margin: scores[0][1] - rival[1] } : null;
}

function detectByTrigrams<T extends string>(
	text: string,
	targets: Readonly<Record<string, T>>,
	profiles: Profiles
): T | null {
	const rank = rankByTrigrams(text, targets, profiles);
	return rank && rank.margin >= MIN_MARGIN ? rank.target : null;
}

/**
 * Detect one of the fixed low-resource languages above, or null (falls through to the normal path
 * for anything not explicitly listed). Pure. The word list answers first, so every
 * sentence it already caught still resolves the same way; the trigram tier only adds hits it missed.
 */
export function detectLowResourceLanguage(text: string): string | null {
	return detectByWordList(text) ?? detectByTrigrams(text, TRIGRAM_TARGETS, PROFILES);
}

// The input screen's language routing (CUR-4340): the same scorer and thresholds, over every profile
// above plus Amharic and its Tigrinya control from `routingProfiles`, with the routed languages in
// web/config/safetyScreen.ts as the targets. Yoruba, Hausa and Kiswahili are controls above and
// targets here. Ethiopic script alone does not route: Tigrinya and Tigre share it.
const ROUTING_PROFILES: Profiles = [...PROFILES, ...buildProfiles(RAW.routingProfiles)];

/** The routed language (am, yo, ha, sw) the scorer ranks first, and whether it clears MIN_MARGIN
 *  (`sure`). Pure, no network call. A sure turn screens with CoPE; a turn read as one but not sure is a
 *  near-miss, screened by Shieldstral with CoPE as a second opinion: "where can I buy drugs" in Amharic
 *  (margin 0.39) and in Hausa (0.24) both are (CUR-4423). Null, exactly where the scorer has no routed
 *  language on top, screens with Shieldstral alone. */
export function readAfricanLanguage(text: string): { lang: RoutedLanguage; sure: boolean } | null {
	const rank = rankByTrigrams<RoutedLanguage>(text, ZENTROPI_JUDGE.routedLanguages, ROUTING_PROFILES);
	return rank ? { lang: rank.target, sure: rank.margin >= MIN_MARGIN } : null;
}

type NoticeLanguage = ReturnType<typeof chromeLanguage>;

/**
 * The notice in the visitor's interface language, the same language as the status line above
 * it (chromeCopy.ts). The notice's whole job is to be legible to the person, so a Spanish browser
 * that wrote in Yucatec Maya must not get it in English. Each version suggests English plus
 * the interface language; the English one suggests English or Spanish. Written by the team, not
 * reviewed by a native speaker, like the rest of chromeCopy.ts. (CUR-1579)
 */
const NOTICES: Record<NoticeLanguage, { text: (name: string) => string; names: Partial<Record<string, string>> }> = {
	en: {
		text: (name) =>
			`I can't yet answer reliably in ${name} — my training in it is limited, and I'm likely to make ` +
			`mistakes or slip into another language without meaning to. I can still try if you'd like, but ` +
			`you may get a better answer in English or Spanish.`,
		names: {},
	},
	es: {
		text: (name) =>
			`Todavía no puedo responder con fiabilidad en ${name}: mi entrenamiento en esta lengua es limitado, ` +
			`y es probable que cometa errores o que pase a otro idioma sin querer. Aun así puedo intentarlo si ` +
			`quieres, pero quizá obtengas una mejor respuesta en español o en inglés.`,
		names: { quz: "quechua", yua: "maya yucateco", tzh: "tseltal" },
	},
	fr: {
		text: (name) =>
			`Je ne peux pas encore répondre de façon fiable en ${name} : mon entraînement dans cette langue est ` +
			`limité, et je risque de faire des erreurs ou de passer à une autre langue sans le vouloir. Je peux ` +
			`quand même essayer si vous le souhaitez, mais vous obtiendrez sans doute une meilleure réponse en ` +
			`français ou en anglais.`,
		names: { quz: "quechua", yua: "maya yucatèque", tzh: "tzeltal" },
	},
	de: {
		text: (name) =>
			`Auf ${name} kann ich noch nicht zuverlässig antworten: Mein Training in dieser Sprache ist begrenzt, ` +
			`und ich mache wahrscheinlich Fehler oder wechsle ungewollt in eine andere Sprache. Ich kann es ` +
			`trotzdem versuchen, wenn Sie möchten, aber auf Deutsch oder Englisch bekommen Sie wahrscheinlich ` +
			`eine bessere Antwort.`,
		names: { quz: "Quechua", yua: "Yukatekisch", tzh: "Tzeltal" },
	},
	it: {
		text: (name) =>
			`Non riesco ancora a rispondere in modo affidabile in ${name}: il mio addestramento in questa lingua ` +
			`è limitato, ed è probabile che faccia errori o che passi a un'altra lingua senza volerlo. Posso ` +
			`comunque provarci, se vuoi, ma potresti ottenere una risposta migliore in italiano o in inglese.`,
		names: { quz: "quechua", yua: "maya yucateco", tzh: "tzeltal" },
	},
	pt: {
		text: (name) =>
			`Ainda não consigo responder de forma confiável em ${name}: meu treinamento nessa língua é limitado, ` +
			`e é provável que eu cometa erros ou passe para outro idioma sem querer. Posso tentar mesmo assim, ` +
			`se quiser, mas talvez você obtenha uma resposta melhor em português ou em inglês.`,
		names: { quz: "quíchua", yua: "maia iucateque", tzh: "tzeltal" },
	},
	nl: {
		text: (name) =>
			`Ik kan nog niet betrouwbaar antwoorden in het ${name}: mijn training in deze taal is beperkt, en ik ` +
			`maak waarschijnlijk fouten of schakel onbedoeld over naar een andere taal. Ik kan het toch proberen ` +
			`als je wilt, maar in het Nederlands of Engels krijg je waarschijnlijk een beter antwoord.`,
		names: { quz: "Quechua", yua: "Yucateeks Maya", tzh: "Tzeltal" },
	},
};

/** How much of a rendered notice an assistant message must start with to count as that notice. Long
 *  enough to pass the language's name in every version, so no ordinary answer matches it. */
const NOTICE_PREFIX = 80;

/** The language code of the notice this assistant message is, in any interface language, else null. */
function noticeLanguage(content: string): string | null {
	for (const uiLang of Object.keys(NOTICES)) {
		for (const lang of Object.keys(LOW_RESOURCE_LANG_NAMES)) {
			if (content.startsWith(lowResourceFallbackMessage(lang, uiLang).slice(0, NOTICE_PREFIX))) return lang;
		}
	}
	return null;
}

/**
 * Whether this conversation has already shown the notice. It ends by offering to try anyway,
 * so whatever the person sends next — "yes, try anyway", or a reply in the language itself — is their
 * answer to that offer, and a second notice would just repeat the question they answered. (CUR-1841)
 */
export function lowResourceNoticeAlreadyShown(
	messages: ReadonlyArray<{ from: string; content: string }>
): boolean {
	return messages.some((m) => m.from === "assistant" && noticeLanguage(m.content) !== null);
}

/**
 * The history the model sees once the notice has been shown (CUR-1841). Left verbatim, the notice reads
 * to the model as something it said, and on a "try anyway" turn a model can copy it word for word
 * instead of attempting an answer. A short note that the offer was made keeps the context and gives it
 * nothing to copy.
 */
export function withLowResourceNoticeSummarized<T extends { from: string; content: string }>(
	messages: ReadonlyArray<T>
): T[] {
	return messages.map((m) => {
		const lang = m.from === "assistant" ? noticeLanguage(m.content) : null;
		if (!lang) return m;
		const name = LOW_RESOURCE_LANG_NAMES[lang];
		return {
			...m,
			content: `(Earlier I said my ${name} is limited and offered to try anyway. The person's next message answers that offer.)`,
		};
	});
}

/**
 * The pre-stored, honest fallback — never generated, so it can't hallucinate or leak scaffolding text
 * the way asking the model to draft its own disclaimer does (CUR-674).
 *
 * Written in the visitor's interface language (NOTICES above), never in the low-resource language
 * itself: see this file's header for why the UDHR corpus can ground the WORD LIST above but not a
 * first-person sentence. NOT reviewed by a speaker of any of these three languages — do not let this
 * ship without that sign-off (CUR-742).
 */
export function lowResourceFallbackMessage(lang: string, uiLang?: string | null): string {
	const notice = NOTICES[chromeLanguage(uiLang)];
	return notice.text(notice.names[lang] ?? LOW_RESOURCE_LANG_NAMES[lang] ?? lang);
}
