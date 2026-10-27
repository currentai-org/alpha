/**
 * The synchronous heuristic classifier: scripts, function words, dialect markers, structural signals
 * for task size and simple skill checks. No libraries and no network, so it can answer instantly on
 * any path (a message sent before the debounced analysis finished, the bentos, first paint). The
 * browser classifier (`localClassifier.ts`) refines its language answer; a hosted classifier would
 * replace it. See `classifier.ts` for the contract.
 */
import { isExplicitLookupRequest, isRecencyQueryDenoised } from '$lib/chat/search/recency';
import { classifyQueryIntent } from '$lib/chat/search/queryIntent';
import { applyDialect } from './dialects';
import { languageName } from './languages';
import type { Decision, Difficulty, DraftAnalysis, LanguageDecision, SkillHint } from './classifier';

// ── Language ─────────────────────────────────────────────────────────────────────────────────────

// Scripts that name their language outright (or nearly). Confidence is lower where one script
// serves several languages (Arabic, Cyrillic, Devanagari); the n-gram tier refines those.
const SCRIPTS: [RegExp, string, number][] = [
	[/[぀-ヿ]/, 'jpn', 0.95], // kana before Han: Japanese text mixes both
	[/[가-힯]/, 'kor', 0.95],
	[/[一-鿿]/, 'cmn', 0.85],
	[/[฀-๿]/, 'tha', 0.95],
	[/[က-႟]/, 'mya', 0.9],
	[/[ក-៿]/, 'khm', 0.95],
	[/[຀-໿]/, 'lao', 0.95],
	[/[஀-௿]/, 'tam', 0.95],
	[/[ఀ-౿]/, 'tel', 0.95],
	[/[ಀ-೿]/, 'kan', 0.95],
	[/[ഀ-ൿ]/, 'mal', 0.95],
	[/[ঀ-৿]/, 'ben', 0.8],
	[/[਀-੿]/, 'pan', 0.9],
	[/[઀-૿]/, 'guj', 0.95],
	[/[ऀ-ॿ]/, 'hin', 0.65],
	[/[ሀ-፿]/, 'amh', 0.8],
	[/[Ⴀ-ჿ]/, 'kat', 0.95],
	[/[԰-֏]/, 'hye', 0.95],
	[/[֐-׿]/, 'heb', 0.9],
	[/[Ͱ-Ͽ]/, 'ell', 0.9],
	[/[؀-ۿ]/, 'arb', 0.6],
	[/[Ѐ-ӿ]/, 'rus', 0.55]
];

// Short, distinctive function words per Latin-script language, as sets. Scored by hits; ties go to
// the earlier entry, so the more common language wins an ambiguous one. A stand-in for the real
// classifier on text too short for n-grams — not a vocabulary to grow per complaint.
const WORDS: [string, string[]][] = [
	['eng', ['the', 'and', 'is', 'what', 'how', 'you', 'with', 'this', 'that', 'can', 'for', 'are']],
	['spa', ['el', 'la', 'que', 'de', 'los', 'por', 'una', 'cómo', 'qué', 'para', 'es', 'y', 'puedes']],
	// Catalan writes el, la, de, que and es as often as Spanish does, so they count for both: on
	// Spanish's list alone they outvote a Catalan word in nearly every Catalan sentence.
	['cat', ['què', 'amb', 'els', 'les', 'és', 'per', 'com', 'una', 'aquest', 'molt', 'perquè', 'pots', 'el', 'la', 'de', 'que', 'es']],
	['glg', ['non', 'unha', 'como', 'moi', 'polo', 'pola', 'cos', 'isto', 'teño']],
	['eus', ['eta', 'da', 'zer', 'nola', 'bat', 'dut', 'dago', 'ez', 'baina', 'zure']],
	['fra', ['le', 'les', 'est', 'une', 'des', 'que', 'pour', 'avec', 'comment', 'pas', 'je', 'vous']],
	['deu', ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'wie', 'mit', 'ein', 'eine', 'kannst']],
	['ita', ['il', 'che', 'di', 'una', 'come', 'per', 'sono', 'non', 'della', 'puoi', 'cosa', 'gli']],
	['por', ['o', 'que', 'não', 'uma', 'como', 'para', 'você', 'com', 'é', 'os', 'isso', 'pode']],
	['nld', ['de', 'het', 'een', 'en', 'is', 'niet', 'hoe', 'wat', 'kun', 'je', 'met', 'dat']],
	['pol', ['nie', 'jest', 'się', 'jak', 'czy', 'co', 'to', 'na', 'że', 'mi', 'dla', 'możesz']],
	['ind', ['yang', 'dan', 'ini', 'itu', 'apa', 'bagaimana', 'saya', 'tidak', 'dengan', 'untuk', 'bisa', 'ada']],
	['zlm', ['yang', 'dan', 'ini', 'itu', 'apa', 'bagaimana', 'saya', 'tidak', 'boleh', 'awak', 'anda', 'untuk']],
	['tgl', ['ang', 'ng', 'mga', 'sa', 'ako', 'ano', 'paano', 'hindi', 'ito', 'mo', 'ka', 'po']],
	['vie', ['là', 'và', 'của', 'có', 'không', 'tôi', 'bạn', 'như', 'thế', 'nào', 'được', 'một']],
	['swh', ['na', 'ya', 'wa', 'kwa', 'ni', 'katika', 'hii', 'habari', 'tafadhali', 'naomba', 'asante', 'gani']],
	['mri', ['kia', 'ora', 'kei', 'koe', 'ahau', 'tēnā', 'ngā', 'whānau', 'aroha', 'pēhea']]
];
const WORD_SETS = WORDS.map(([lang, list]) => [lang, new Set(list)] as const);

// Spelling settles what the shared short words can't. Spanish writes no grave accent, ï, ç, middle-dot
// l·l or elided l'/d', so any of them rules it out; Catalan writes no ñ and no inverted ¿ ¡, so those
// rule it out and count as one Spanish word (ñ as one Galician word too, which writes it as well).
const RULED_OUT_BY: [RegExp, string][] = [
	[/[àèòïç]|l·l|\b[dlmnst]['’][aeiouhàèéíòóú]/iu, 'spa'],
	[/[ñ¿¡]/iu, 'cat']
];
const SPELLED_WORD: [RegExp, string][] = [
	[/[ñ¿¡]/iu, 'spa'],
	[/ñ/iu, 'glg']
];

/** Languages this text's spelling rules out. */
export function ruledOut(text: string): Set<string> {
	return new Set(RULED_OUT_BY.filter(([re]) => re.test(text)).map(([, lang]) => lang));
}

/** Function-word hits per listed language, spelling applied, most first; ties keep list order. */
export function wordScores(text: string): { lang: string; hits: number }[] {
	const words = tokens(text);
	const excluded = ruledOut(text);
	const spelled = new Set(SPELLED_WORD.filter(([re]) => re.test(text)).map(([, lang]) => lang));
	return (
		WORD_SETS.map(([lang, set]) => ({
			lang,
			hits: words.filter((w) => set.has(w)).length + (spelled.has(lang) ? 1 : 0)
		}))
			.filter((s) => s.hits > 0 && !excluded.has(s.lang))
			// Stable sort keeps list order on ties.
			.sort((a, b) => b.hits - a.hits)
	);
}

export function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{M}']+/u)
		.filter(Boolean);
}

/** Script, then function words, then the dialect layer. Synchronous; no libraries. */
export function detectLanguage(text: string): LanguageDecision {
	const t = text.trim();
	const none: LanguageDecision = { value: 'und', confidence: 0, alternatives: [], signal: 'none' };
	if (t.length < 3) return none;

	for (const [re, lang, confidence] of SCRIPTS) {
		if (re.test(t)) {
			return applyDialect(t, { value: lang, confidence, alternatives: [], signal: 'script' });
		}
	}

	if (tokens(t).length === 0) return none;

	const scored = wordScores(t);
	if (scored.length === 0) return { ...none, confidence: 0.1 };

	const [best, second] = scored;
	// Confidence grows with evidence and with the margin over the runner-up.
	const margin = (best.hits - (second?.hits ?? 0)) / best.hits;
	const evidence = Math.min(1, best.hits / 4);
	const decision: LanguageDecision = {
		value: best.lang,
		confidence: round(0.3 + 0.6 * evidence * (0.4 + 0.6 * margin)),
		alternatives: scored.slice(1, 4).map((s) => ({ value: s.lang, confidence: round((0.3 * s.hits) / best.hits) })),
		signal: 'words'
	};
	return applyDialect(t, decision);
}

// ── Difficulty ───────────────────────────────────────────────────────────────────────────────────

// Cue words for "this needs thought" and "this is small talk". English-heavy by construction; the
// structural signals below (length, code, several questions) carry across languages.
const DEEP_CUES = new Set([
	'explain', 'why', 'compare', 'analyse', 'analyze', 'prove', 'derive', 'plan', 'strategy', 'essay',
	'tradeoffs', 'review', 'debug', 'refactor', 'evaluate', 'design', 'argue',
	'explica', 'compara', 'analiza', 'explique', 'analyser', 'erkläre', 'vergleiche', 'spiega', 'confronta',
	'wyjaśnij', 'porównaj', 'jelaskan', 'bandingkan', 'giải', 'thích', 'expliqueu'
]);
const QUICK_CUES = new Set([
	'hi', 'hello', 'hey', 'thanks', 'thank', 'ok', 'yes', 'no', 'hola', 'bonjour', 'hallo', 'ciao',
	'olá', 'oi', 'cześć', 'halo', 'hoi', 'grüezi', 'translate', 'define', 'spell', 'gràcies', 'gracias', 'merci', 'danke'
]);

/** A fenced block, or a line that ends like code. Shapes we generate or that code has, not prose. */
function looksLikeCode(t: string): boolean {
	return t.includes('```') || /\bfunction\b|=>|[;{}]\s*$/m.test(t);
}

/** Word count, with CJK and Thai (no spaces between words) counted roughly by characters. */
function wordCount(t: string): number {
	const spaced = t.split(/\s+/).filter(Boolean).length;
	const dense = (t.match(/[぀-鿿가-힯฀-๿]/g) ?? []).length;
	return Math.max(spaced, Math.round(dense / 2));
}

export function estimateDifficulty(text: string): Decision<Difficulty> {
	const t = text.trim();
	const words = wordCount(t);
	// Hyphens dropped so "trade-offs" meets "tradeoffs".
	const toks = new Set(tokens(t.replace(/-/g, '')));
	const deep = [...toks].filter((w) => DEEP_CUES.has(w)).length;
	const quick = [...toks].some((w) => QUICK_CUES.has(w));
	const questions = (t.match(/[?？]/g) ?? []).length;
	const listItems = (t.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
	const code = looksLikeCode(t);

	let score = 0;
	if (words > 150) score += 3;
	else if (words > 60) score += 2;
	else if (words > 25) score += 1;
	if (code) score += 3;
	if (deep && words > 12) score += 2;
	if (deep > 1) score += 1;
	if (questions >= 3 || listItems >= 3) score += 1;

	if (score >= 3) return { value: 'L', confidence: round(Math.min(0.9, 0.6 + 0.08 * (score - 3))) };
	if ((score === 0 && words <= 6) || (quick && words <= 15 && score <= 1)) {
		return { value: 'S', confidence: quick ? 0.8 : 0.6 };
	}
	return { value: 'M', confidence: score === 0 || score === 1 ? 0.6 : 0.55 };
}

// ── Skills ───────────────────────────────────────────────────────────────────────────────────────

const TRANSLATE_CUES = new Set([
	'translate', 'translation', 'traduce', 'traducir', 'traduis', 'traduire', 'übersetze', 'übersetzen',
	'traduci', 'tradurre', 'tradueix', 'traduza', 'traduzir', 'przetłumacz', 'terjemahkan', 'dịch'
]);

/** Skills and tools the answer will likely want. Reuses the composer's existing search signals. */
export function detectSkills(text: string, difficulty: Decision<Difficulty>): SkillHint[] {
	const t = text.trim();
	const out: SkillHint[] = [];
	if (isExplicitLookupRequest(t)) {
		out.push({ id: 'web-search', confidence: 0.9, reason: 'You asked to look something up' });
	} else if (isRecencyQueryDenoised(t)) {
		out.push({ id: 'web-search', confidence: 0.7, reason: 'Asks about something recent' });
	}
	if (looksLikeCode(t)) out.push({ id: 'code', confidence: 0.85, reason: 'Contains code' });
	// Digits joined by an operator: a calculation, in any language.
	if (/\d\s*[-+*/×÷^=%]\s*\d/.test(t)) out.push({ id: 'math', confidence: 0.7, reason: 'Has a calculation' });
	if (tokens(t).some((w) => TRANSLATE_CUES.has(w))) {
		out.push({ id: 'translation', confidence: 0.8, reason: 'Asks for a translation' });
	}
	if (difficulty.value === 'L') {
		if (classifyQueryIntent(t).signals.has('research')) {
			out.push({ id: 'research', confidence: 0.6, reason: 'Reads like a research question' });
		}
		if (difficulty.confidence >= 0.6) {
			out.push({ id: 'reasoning', confidence: difficulty.confidence, reason: 'A large task goes better step by step' });
		}
	}
	return out;
}

// ── The synchronous heuristic ────────────────────────────────────────────────────────────────────

/** The heuristic classifier. Deterministic and synchronous; confidences are rough. */
export function heuristicClassify(text: string): DraftAnalysis {
	const difficulty = estimateDifficulty(text);
	return {
		language: detectLanguage(text),
		difficulty,
		skills: detectSkills(text, difficulty),
		source: 'heuristic'
	};
}

/** "Catalan", "Swiss German", or "an unclear language". */
export const nameOf = (d: Decision<string>) => languageName(d.value);

export const round = (n: number) => Math.round(n * 100) / 100;
