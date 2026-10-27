// Pure, dependency-free helpers for the open-web search engines. Kept out of
// openSearch.ts (which imports server config) so they unit-test with no mocking.

/** Reconstruct an abstract from OpenAlex's `abstract_inverted_index`
 *  (word -> [positions]). Returns "" when absent. */
export function reconstructAbstract(inv?: Record<string, number[]> | null): string {
	if (!inv) return "";
	const words: string[] = [];
	for (const [word, positions] of Object.entries(inv)) {
		for (const pos of positions) if (pos >= 0) words[pos] = word;
	}
	return words.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// Non-Latin scripts map cleanly to a Wikipedia language edition. (Han is split:
// any Kana present → Japanese, else Chinese.)
const SCRIPT_RANGES: { lang: string; re: RegExp }[] = [
	{ lang: "ja", re: /[぀-ヿ]/ }, // Hiragana/Katakana — checked before Han
	{ lang: "ko", re: /[가-힯]/ }, // Hangul
	{ lang: "zh", re: /[一-鿿]/ }, // Han
	{ lang: "ru", re: /[Ѐ-ӿ]/ }, // Cyrillic
	{ lang: "ar", re: /[؀-ۿ]/ }, // Arabic
	{ lang: "he", re: /[֐-׿]/ }, // Hebrew
	{ lang: "hi", re: /[ऀ-ॿ]/ }, // Devanagari
	{ lang: "el", re: /[Ͱ-Ͽ]/ }, // Greek
	{ lang: "th", re: /[฀-๿]/ }, // Thai
];

// Best-effort Latin-script detection: distinctive function words. Conservative
// (needs >=2 hits) and LOW-HARM by design — a hit only ADDS that language's
// Wikipedia edition alongside English, so a false positive is just an extra
// source the reranker drops. Does NOT reliably cover low-resource languages
// (Wolof, Fon, Sámi, …) — those need a real detector; flagged, not faked.
const LATIN_STOPWORDS: Record<string, string[]> = {
	fr: ["le", "la", "les", "des", "une", "est", "pour", "dans", "avec", "quel", "comment"],
	es: ["el", "los", "las", "una", "para", "con", "qué", "cómo", "está", "cuál"],
	de: ["der", "die", "das", "und", "ist", "für", "mit", "wie", "nicht", "welche"],
	pt: ["como", "está", "para", "uma", "não", "você", "qual", "isso"],
	it: ["come", "della", "per", "una", "gli", "che", "quale", "questo"],
	sw: ["ni", "na", "ya", "wa", "kwa", "katika", "nini", "habari", "gani"],
};

/** Detect a non-English Wikipedia edition to ALSO query, or null for English-only.
 *  Pure. Script detection is confident; Latin detection is best-effort (>=2 hits). */
export function detectWikiLang(query: string): string | null {
	const q = query.trim();
	if (!q) return null;
	for (const { lang, re } of SCRIPT_RANGES) if (re.test(q)) return lang;
	const tokens = q.toLowerCase().match(/[\p{L}]+/gu) ?? [];
	if (tokens.length === 0) return null;
	const set = new Set(tokens);
	let best: string | null = null;
	let bestHits = 1; // require >=2
	for (const [lang, words] of Object.entries(LATIN_STOPWORDS)) {
		const hits = words.reduce((acc, w) => acc + (set.has(w) ? 1 : 0), 0);
		if (hits > bestHits) {
			bestHits = hits;
			best = lang;
		}
	}
	return best;
}
