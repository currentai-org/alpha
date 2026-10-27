/**
 * The one tokenizer shared by the language profiles' generator
 * (`scripts/gen-language-profiles.mts`) and the runtime detector (`languageFallback.ts`). A profile
 * built with one normalization and scored with another silently degrades every score, so both sides
 * import this file rather than keeping two copies. No imports, and only erasable TypeScript, so the
 * generator can load it with Node's own type stripping. (CUR-1841)
 */

/**
 * Lowercase, drop every combining mark, fold apostrophe-like marks to "'".
 *
 * Marks are dropped rather than kept because the same word arrives with and without them: Yoruba tone
 * marks and Yucatec vowel accents are routinely omitted on a phone keyboard, and the UDHR transcriptions
 * differ from each other in which marks they stack (see languageFallback.ts's note on Yoruba's
 * precomposed-plus-combining vowels). After this every character of Latin-script text is one UTF-16
 * code unit, so a trigram is always exactly three code units long.
 */
function normalizeForTrigrams(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['´ʼ’‘`]/g, "'");
}

/** Every character trigram of every word, each word padded with one space on both sides. */
export function trigrams(s: string): string[] {
	const out: string[] = [];
	for (const w of normalizeForTrigrams(s).match(/[\p{L}']+/gu) ?? []) {
		const p = ` ${w} `;
		for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
	}
	return out;
}
