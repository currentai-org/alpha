// The voice read-aloud uses comes from the language of the answer being read (CUR-3151). Kokoro
// (readAloudSpeech.ts) pronounces a text by its voice's language, so each language it covers has its own
// voice here. A language outside them is refused here: the visitor is told there is no voice for it yet,
// and may ask for the English voice instead. Nothing plays in a voice of another language unasked
// (CUR-3989).
import { heuristicClassify } from "$lib/chat/routing/heuristic";
import { loadDetectors, refineLanguage } from "$lib/chat/routing/localClassifier";
import { fromIso1, languageName, parentLanguage } from "$lib/chat/routing/languages";

/** ISO 639-1 code → the Kokoro voice that reads it. Kokoro has no German or Catalan voice. The list is
 *  the one DeepInfra returns for an unknown voice; the Portuguese voices are Brazilian.
 *  @internal exported for its unit tests */
export const KOKORO_VOICES = {
	en: "af_heart",
	es: "ef_dora",
	fr: "ff_siwis",
	hi: "hf_alpha",
	it: "if_sara",
	ja: "jf_alpha",
	pt: "pf_dora",
	zh: "zf_xiaobei",
} as const satisfies Record<string, string>;

/** The accent a voice speaks where the language has national variants the detector can't tell apart, so
 *  the player can say whose accent it is. The detector returns `por` with no region, and every Kokoro
 *  Portuguese voice is Brazilian, so an answer for someone in Portugal is read in a Brazilian accent.
 *  @internal exported for its unit tests */
const VOICE_ACCENTS: Partial<Record<keyof typeof KOKORO_VOICES, string>> = {
	pt: "Brazilian Portuguese",
};

/** The accent to name under the player for an ISO 639-1 code, when its voice has a regional one. */
export function voiceAccent(code: string): string | undefined {
	return Object.hasOwn(VOICE_ACCENTS, code) ? VOICE_ACCENTS[code as keyof typeof VOICE_ACCENTS] : undefined;
}

/** Detected 639-3 tag → ISO 639-1 code. The detectors name Chinese by an individual language (`cmn`),
 *  so the macrolanguage is listed beside it. */
const VOICES: Record<string, string> = {
	...Object.fromEntries(Object.keys(KOKORO_VOICES).map((code) => [fromIso1(code), code])),
	zho: "zh",
	eng: "en",
	fra: "fr",
};

/** The Kokoro voice for an ISO 639-1 code, or undefined when Kokoro has none. */
export function kokoroVoice(code: string): string | undefined {
	return Object.hasOwn(KOKORO_VOICES, code) ? KOKORO_VOICES[code as keyof typeof KOKORO_VOICES] : undefined;
}

export type ReadAloudVoice =
	| { ok: true; code: string; tag: string }
	| { ok: false; tag: string; name: string };

/** The voice for a detected language tag (`por-PT`, `cat-valencia`, `eng`). An undetermined tag reads
 *  in English, as every answer did before this; any other language without a voice is refused by name.
 *  @internal exported for its unit tests */
export function voiceForLanguage(tag: string): ReadAloudVoice {
	if (tag === "und") return { ok: true, code: "en", tag };
	const base = tag.split("-")[0];
	const code = VOICES[base] ?? VOICES[parentLanguage(tag) ?? ""];
	if (code) return { ok: true, code, tag };
	return { ok: false, tag, name: languageName(base) };
}

/** Detect the language of the text about to be read, with the same detectors the composer uses
 *  (function words, then franc and the low-resource detector), and pick its voice. `question` is the
 *  person's message, which settles a one-line answer the detectors can't. `fallbackLanguage` is the
 *  ISO 639-1 code of the visitor's browser language, the voice for an answer with too few letters to
 *  place when the question doesn't place it either. */
export async function readAloudVoice(
	text: string,
	question?: string,
	fallbackLanguage?: string
): Promise<ReadAloudVoice> {
	const detectors = await loadDetectors();
	if (letterCount(text) < MIN_LETTERS_TO_DETECT) return wordlessVoice(question, fallbackLanguage, detectors);
	const detected = refineLanguage(text, heuristicClassify(text).language, detectors).value;
	const voice = voiceForLanguage(detected);
	if (text.trim().length < VOICELESS_CHECK_CHARS) {
		// A one-line answer has too few words to place: "La capitale de la France est Paris." scores
		// Spanish on "la", "de" and "es". Read it in the question's language when franc
		// counts that language among the answer's leaders. A question in a language the answer doesn't
		// resemble ("How do I say I am fine in French?") leaves the answer's own detection alone. An answer
		// with nothing to detect ("Paris.") takes the question's voice outright.
		if (!question?.trim()) return voice;
		const asked = questionVoice(question, detectors);
		if (!asked.ok || (voice.ok && asked.code === voice.code)) return voice;
		if (detected === "und") return asked;
		const askedBase = asked.tag.split("-")[0];
		const leaders = detectors.francAll(text, { minLength: 3 }).slice(0, FRANC_LEADERS);
		return leaders.some(([code]) => code === askedBase) ? asked : voice;
	}
	if (!voice.ok) return voice;
	// A wrong voice is worse than none. The composer's detector lets a weak function-word match beat
	// franc, which suits routing: a long Yoruba answer can score Italian 0.51
	// on words like "di" while franc ranks Yoruba first and Italian far below. When franc puts a
	// language with no voice first and leaves the detected one out of its leaders, refuse in that
	// language's name. A close neighbour franc prefers keeps the detected voice: Portuguese ranks
	// second behind Galician, 0.007 apart.
	const ranked = detectors.francAll(text, { minLength: 3 }).filter(([code]) => code !== "und");
	const top = ranked[0];
	if (!top) return voice;
	const detectedBase = detected.split("-")[0];
	if (ranked.slice(0, FRANC_LEADERS).some(([code]) => code === detectedBase)) return voice;
	const francVoice = voiceForLanguage(top[0]);
	return francVoice.ok ? voice : francVoice;
}

/** The voice of the person's question. The function-word lists call short French and Portuguese
 *  questions Spanish too ("la", "de"), so franc's ranking leads here: its first language with a voice
 *  that the word lists also scored. Franc alone misreads short English ("How do I say I am fine in
 *  French?" ranks Slovene first), and the word lists settle that. */
function questionVoice(question: string, detectors: Awaited<ReturnType<typeof loadDetectors>>): ReadAloudVoice {
	const words = heuristicClassify(question).language;
	const scored = new Set([words.value, ...words.alternatives.map((a) => a.value)].map((tag) => tag.split("-")[0]));
	for (const [code] of detectors.francAll(question, { minLength: 3 }).slice(0, FRANC_LEADERS)) {
		const voice = voiceForLanguage(code);
		if (voice.ok && code !== "und" && scored.has(code)) return voice;
	}
	return voiceForLanguage(refineLanguage(question, words, detectors).value);
}

/** The voice for an answer with too few letters for any detector: "Yes, 64.00 + 7.50 = 71.50." has
 *  three, and franc names them Central Atlas Tamazight with full confidence, so such an answer is
 *  never refused on franc's pick. The question decides it when its function
 *  words place it, since franc alone misplaces a short question too (it ranks "Check: does 64.00 plus
 *  7.50 equal 71.50?" Portuguese); then the browser's language when Kokoro has a voice for it; then
 *  English, as an undetermined answer always read. */
function wordlessVoice(
	question: string | undefined,
	fallbackLanguage: string | undefined,
	detectors: Awaited<ReturnType<typeof loadDetectors>>
): ReadAloudVoice {
	if (question?.trim() && heuristicClassify(question).language.value !== "und") {
		// A question placed in a language Kokoro has no voice for refuses in that language's name, so a
		// short German answer is offered in English rather than read in it unasked (CUR-3989).
		return questionVoice(question, detectors);
	}
	const code = fallbackLanguage?.toLowerCase().split("-")[0];
	if (code && kokoroVoice(code)) return { ok: true, code, tag: fromIso1(code) };
	return voiceForLanguage("und");
}

/** Letters in any script, the only part of a text a language detector reads. Digits, signs and
 *  punctuation tell it nothing. */
function letterCount(text: string): number {
	return text.match(/\p{L}/gu)?.length ?? 0;
}

/** Below this many letters the answer has nothing to detect. Four or five short words; every
 *  one-line answer the detectors are trusted with above ("La capital de España es Madrid.") has more. */
const MIN_LETTERS_TO_DETECT = 20;
/** Below this, franc's first pick is too noisy to overrule the detector with. */
const VOICELESS_CHECK_CHARS = 200;
/** How far down franc's ranking the detected language may sit and still count as recognised. Scores
 *  can't draw this line: franc gave Italian over 0.8 on the Yoruba answer. */
const FRANC_LEADERS = 5;
