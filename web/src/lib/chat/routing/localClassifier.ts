/**
 * The local `DraftClassifier`: the synchronous heuristic, refined by three real language detectors
 * loaded on first use (so none weighs on the chat's first paint):
 *
 *   - the low-resource detector behind the answer-level "I can't answer reliably in X yet" notice
 *     (`languageFallback.ts`, CUR-742/1841) — Quechua, Yucatec Maya, Tzeltal, Yoruba; no false
 *     positives on held-out Tatoeba sentences of five words or more;
 *   - `eld` (Efficient Language Detector, extrasmall database), an n-gram detector built for short
 *     text over 60 languages. It decides whenever both the word lists and franc name one of its
 *     languages: it separates French from Catalan, Spanish, Italian and Dutch where the word lists
 *     confuse them, and passes all of `catalanSpanish.spec.ts` (CUR-4080);
 *   - `franc`, a character n-gram detector over ~190 languages, for the long tail eld lacks
 *     (Galician, Indonesian, Swahili, Pashto…). It is unreliable on short text (a 7-word Portuguese
 *     question scores Wolof first), so its confidence is scaled by length and by its margin over the
 *     runner-up, and on short text the function-word answer wins a disagreement.
 *
 * Runs entirely in the browser.
 */
import { heuristicClassify, round, ruledOut, wordScores } from './heuristic';
import type { DraftAnalysis, DraftClassifier, LanguageDecision } from './classifier';
import { applyDialect } from './dialects';

type FrancAll = (text: string, opts?: { minLength?: number; only?: string[] }) => [string, number][];
type Eld = { detect: (text: string) => { language: string; getScores: () => Record<string, number> } };
interface Detectors {
	francAll: FrancAll;
	eld: Eld;
	detectLowResource: (text: string) => string | null;
}

let detectors: Promise<Detectors> | undefined;
/** Loads both detectors once; later calls share the same promise. */
export function loadDetectors(): Promise<Detectors> {
	detectors ??= Promise.all([
		import('franc'),
		import('eld/extrasmall'),
		import('$lib/chat/server/textGeneration/languageFallback')
	]).then(([franc, eld, fallback]) => ({
		francAll: franc.francAll as FrancAll,
		eld: eld.eld,
		detectLowResource: fallback.detectLowResourceLanguage
	}));
	return detectors;
}

/** eld's ISO 639-1 codes, as the ISO 639-3 codes franc and the word lists use. */
const ELD_LANGUAGES: Record<string, string> = {
	am: 'amh', ar: 'arb', az: 'azj', be: 'bel', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'ces', da: 'dan',
	de: 'deu', el: 'ell', en: 'eng', es: 'spa', et: 'est', eu: 'eus', fa: 'pes', fi: 'fin', fr: 'fra',
	gu: 'guj', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', hy: 'hye', is: 'isl', it: 'ita', ja: 'jpn',
	ka: 'kat', kn: 'kan', ko: 'kor', ku: 'kmr', lo: 'lao', lt: 'lit', lv: 'lvs', ml: 'mal', mr: 'mar',
	ms: 'zlm', nl: 'nld', no: 'nob', or: 'ory', pa: 'pan', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus',
	sk: 'slk', sl: 'slv', sq: 'als', sr: 'srp', sv: 'swe', ta: 'tam', te: 'tel', th: 'tha', tl: 'tgl',
	tr: 'tur', uk: 'ukr', ur: 'urd', vi: 'vie', yo: 'yor', zh: 'cmn'
};
const ELD_KNOWS = new Set(Object.values(ELD_LANGUAGES));
/**
 * Below this relative gap between eld's top two scores its pick is a coin toss (Catalan and Spanish
 * drafts made only of words both share land at 0.01–0.03), so the word lists and franc decide as before.
 * The narrowest right French read in the CUR-4080 probe had a gap of 0.048.
 */
const ELD_MIN_GAP = 0.035;

/** eld's read when it is clear, or undefined to leave the text to the word lists and franc. */
function eldRead(t: string, eld: Eld, excluded: Set<string>): LanguageDecision | undefined {
	const ranked = Object.entries(eld.detect(t).getScores())
		.map(([code, score]) => [ELD_LANGUAGES[code], score] as const)
		.filter(([code]) => code && !excluded.has(code))
		.sort((a, b) => b[1] - a[1]);
	if (!ranked.length || ranked[0][1] <= 0) return undefined;
	const [[top, best], ...rest] = ranked;
	const gap = (best - (rest[0]?.[1] ?? 0)) / best;
	if (gap < ELD_MIN_GAP) return undefined;
	const confidence = round(Math.min(0.95, 0.6 + 1.5 * gap));
	return applyDialect(t, {
		value: top,
		confidence,
		alternatives: rest.slice(0, 3).map(([value, score]) => ({ value, confidence: round((score / best) * confidence) })),
		signal: 'ngram'
	});
}

/** Below this many characters franc's top answer is noise; the word lists decide. */
const FRANC_MIN_CHARS = 12;
/** At and above this many characters franc's margin is taken at face value. */
const FRANC_FULL_CHARS = 90;
/** franc's confidence from which its pick of a language eld lacks is taken over eld's. */
const FRANC_SURE = 0.5;

export function refineLanguage(text: string, heuristic: LanguageDecision, d: Detectors): LanguageDecision {
	const t = text.trim();
	if (heuristic.value === 'und' && t.length < 3) return heuristic;

	const low = d.detectLowResource(t);
	if (low) {
		return applyDialect(t, {
			value: low,
			confidence: 0.8,
			alternatives: heuristic.value !== 'und' ? [{ value: heuristic.value, confidence: heuristic.confidence }] : [],
			signal: 'low-resource'
		});
	}

	// A script that names its language outright needs nothing more.
	if (heuristic.signal === 'script' && heuristic.confidence >= 0.85) return heuristic;
	if (heuristic.signal === 'dialect' && heuristic.alternatives[0]?.confidence >= 0.85) return heuristic;
	if (t.length < FRANC_MIN_CHARS) return heuristic;

	const excluded = ruledOut(t);
	const ranked = d.francAll(t, { minLength: 3 }).filter(([code]) => code !== 'und' && !excluded.has(code));
	if (!ranked.length) return heuristic;
	const [[top], second] = ranked;

	// The heuristic's base language (before any dialect) is what franc can agree with.
	const heuristicBase = heuristic.signal === 'dialect' ? heuristic.alternatives[0]?.value : heuristic.value;
	const margin = 1 - (second?.[1] ?? 0);
	const lengthFactor = Math.min(1, t.length / FRANC_FULL_CHARS);
	const francConfidence = round(Math.min(0.95, (0.35 + 1.4 * margin) * lengthFactor));

	// eld can only name a neighbour of a language it lacks (Spanish or Portuguese for Galician, Malay
	// for Indonesian), so it steps aside when the text has real evidence of one: franc names it and
	// the word lists count it too, franc names it with some confidence, or the word lists name it on
	// two words or more. One stray hit misleads on short text: "Traduis cette phrase…" scores Galician
	// on franc, and "Aide-moi…" on the Galician word list (moi).
	const words = heuristic.signal === 'words' ? wordScores(t) : [];
	const eldLacks =
		(!ELD_KNOWS.has(top) && (francConfidence >= FRANC_SURE || words.some((w) => w.lang === top))) ||
		(words[0] !== undefined && !ELD_KNOWS.has(words[0].lang) && words[0].hits >= 2);
	if (!eldLacks) {
		const read = eldRead(t, d.eld, excluded);
		if (read) return read;
	}
	const francAlternatives = ranked.slice(1, 4).map(([value, score]) => ({ value, confidence: round(score * francConfidence) }));

	if (heuristicBase === top) {
		return {
			...heuristic,
			confidence: round(Math.min(0.97, Math.max(heuristic.confidence, francConfidence) + 0.1)),
			alternatives: heuristic.alternatives.length ? heuristic.alternatives : francAlternatives
		};
	}
	// The word lists tied and franc names one of the tied languages (Catalan and Spanish share their
	// short words, so they tie often): franc breaks the tie, at the word lists' confidence.
	if (heuristic.signal === 'words') {
		const scores = words;
		const tied = scores.filter((s) => s.hits === scores[0].hits).map((s) => s.lang);
		if (tied.length > 1 && tied.includes(top)) {
			return applyDialect(t, {
				value: top,
				confidence: round(Math.max(heuristic.confidence, francConfidence)),
				alternatives: [{ value: heuristic.value, confidence: heuristic.confidence }, ...francAlternatives].slice(0, 4),
				signal: 'ngram'
			});
		}
	}
	if (heuristic.value !== 'und' && heuristic.confidence >= francConfidence) return heuristic;
	return applyDialect(t, {
		value: top,
		confidence: francConfidence,
		alternatives: [
			...(heuristic.value !== 'und' ? [{ value: heuristic.value, confidence: heuristic.confidence }] : []),
			...francAlternatives
		].slice(0, 4),
		signal: 'ngram'
	});
}

export const localClassifier: DraftClassifier = async (text, opts = {}) => {
	const started = performance.now();
	const base = heuristicClassify(text);
	const d = await loadDetectors();
	opts.signal?.throwIfAborted();
	const analysis: DraftAnalysis = {
		...base,
		language: refineLanguage(text, base.language, d),
		source: 'local'
	};
	analysis.elapsedMs = Math.round(performance.now() - started);
	return analysis;
};
