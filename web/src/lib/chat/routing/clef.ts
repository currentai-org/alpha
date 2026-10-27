/**
 * Clef, the hosted draft classifier: the questions Auto asks it, how its answers are read, and how
 * they combine with the local read. Shared by the browser (merging) and the server route that calls
 * it (`routes/chat/api/routing/classify`), so both sides agree on the question set.
 *
 * Clef is a "System One" model in the Jev mould (classifier.ts): it answers typed questions about a
 * piece of text — yes/no as a probability (`noul`), one of several options (`choice`), or a position
 * on a scale (`score`) — each with a calibrated confidence, and never writes text. The Potluck
 * router serves it at `/v1/cloudflare/<model>` (`clef`, 27B; `clef-flash`, 9B).
 *
 * The local classifier answers first and stays the floor (localClassifier.ts). Clef refines what
 * word lists read worst: how big the task is, which skills it needs, and which language it is in
 * (close neighbours such as Catalan and Spanish share their short words). Where the local read has a
 * signal Clef can't express — a script that names its language, the measured low-resource detector,
 * a dialect — the local read stands.
 */
import { SHIPPED_BENCHMARKS, benchmarkedLanguages } from './benchmarks';
import type { Decision, Difficulty, DraftAnalysis, LanguageDecision, SkillHint, SkillId } from './classifier';
import { applyDialect } from './dialects';
import { round } from './heuristic';
import { languageName, parentLanguage } from './languages';

/** Clef's answer when the language isn't one of the listed ones. */
export const OTHER_LANGUAGE = 'other';

/**
 * The languages Clef chooses between: every base language Auto has a benchmark row for. Varieties
 * are left to the dialect markers (dialects.ts), and the languages the low-resource detector covers
 * to that detector, which is measured on held-out sentences.
 */
const LOCAL_ONLY = new Set(['quz', 'yua', 'tzh', 'yor']);
export const CLEF_LANGUAGES: string[] = [
	...new Set(benchmarkedLanguages(SHIPPED_BENCHMARKS).filter((t) => !parentLanguage(t) && !LOCAL_ONLY.has(t)))
];

const SIZES: Difficulty[] = ['S', 'M', 'L'];

/** The skills Clef is asked about, as yes/no questions. */
const SKILL_QUESTIONS: Record<SkillId, string> = {
	'web-search': 'Does a good answer need current information from the web, such as news, prices or recent events?',
	code: 'Is this a programming request, or does it contain code to work on?',
	math: 'Does answering need an exact calculation?',
	translation: 'Is this asking for a translation into another language?',
	research: 'Does a good answer need several sources compared and cited?',
	reasoning: 'Does a good answer need careful step-by-step reasoning?'
};

/** Shown under a skill badge when Clef raised it and the local read didn't. */
const SKILL_REASON: Record<SkillId, string> = {
	'web-search': 'Needs current information',
	code: 'A programming request',
	math: 'Needs an exact calculation',
	translation: 'Asks for a translation',
	research: 'Needs several sources',
	reasoning: 'Needs careful reasoning'
};

/** The `questions` object Clef's API takes, built once. */
export function clefQuestions() {
	return {
		language: {
			type: 'choice',
			instructions: 'Which language is this chat message written in?',
			criteria: Object.fromEntries([
				...CLEF_LANGUAGES.map((t) => [t, languageName(t)]),
				[OTHER_LANGUAGE, 'Another language, or too little text to tell']
			])
		},
		size: {
			type: 'score',
			instructions: 'How much work will a good answer to this chat message take?',
			criteria: ['A greeting or a one-line lookup', 'An everyday request', 'Analysis, code, or long multi-step work']
		},
		...Object.fromEntries(
			(Object.keys(SKILL_QUESTIONS) as SkillId[]).map((id) => [
				`skill_${id.replace('-', '_')}`,
				{ type: 'noul', instructions: SKILL_QUESTIONS[id] }
			])
		)
	};
}

/** What Clef read in a draft, normalised. This is what the server route returns. */
export interface ClefVerdict {
	/** A tag from CLEF_LANGUAGES, or `other`. */
	language: Decision<string>;
	difficulty: Decision<Difficulty>;
	/** Probability that the answer needs each skill. */
	skills: Record<SkillId, number>;
	/** The Clef model that answered (`clef` or `clef-flash`). */
	model: string;
	/** Round trip from the server to Clef. */
	elapsedMs: number;
}

const unit = (n: unknown): number => {
	if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('Clef answer is not a number');
	return Math.min(1, Math.max(0, n));
};

/**
 * Read Clef's `answers` into a verdict. Throws on a missing or malformed answer rather than filling
 * in a default, so a changed API surfaces as an error and the local read stands.
 */
export function parseClefAnswers(answers: unknown, model: string, elapsedMs: number): ClefVerdict {
	const a = (answers ?? {}) as Record<string, Record<string, unknown> | undefined>;
	const lang = a.language;
	if (!lang || typeof lang.choice !== 'string') throw new Error('Clef answered no language');
	if (lang.choice !== OTHER_LANGUAGE && !CLEF_LANGUAGES.includes(lang.choice)) {
		throw new Error(`Clef chose an unlisted language: ${lang.choice}`);
	}
	const size = a.size;
	if (!size || typeof size.score !== 'number') throw new Error('Clef answered no task size');
	// The most likely size; `score` (the expected position on the 0–2 scale) when no probabilities.
	const probs = (size.probabilities ?? {}) as Record<string, number>;
	const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]);
	const sizeIndex = Math.min(2, Math.max(0, ranked.length ? Number(ranked[0][0]) : Math.round(size.score)));
	const skills = {} as Record<SkillId, number>;
	for (const id of Object.keys(SKILL_QUESTIONS) as SkillId[]) {
		skills[id] = round(unit(a[`skill_${id.replace('-', '_')}`]?.noul));
	}
	return {
		language: { value: lang.choice, confidence: round(unit(lang.confidence)) },
		difficulty: { value: SIZES[sizeIndex], confidence: round(unit(size.confidence)) },
		skills,
		model,
		elapsedMs
	};
}

/** A skill is kept when Clef thinks it likely, or the local read was already sure of it. */
const SKILL_THRESHOLD = 0.5;
const LOCAL_SURE = 0.85;
/**
 * Clef's language stands over the word lists and franc from this confidence up. Their confidences are
 * rough formulas, not probabilities, and run higher than Clef's for a wrong answer as readily as a
 * right one, so the two are not weighed against each other; below this, Clef is unsure and they stand.
 */
const CLEF_LANGUAGE_FLOOR = 0.4;

function mergeLanguage(text: string, local: LanguageDecision, clef: Decision<string>): LanguageDecision {
	// Signals Clef can't express: a script that names its language, the measured low-resource
	// detector, a dialect marker. And `other` means Clef doesn't recognise it as a listed language.
	if (local.signal === 'low-resource' || local.signal === 'dialect') return local;
	if (local.signal === 'script' && local.confidence >= 0.85) return local;
	if (clef.value === OTHER_LANGUAGE) return local;
	if (clef.value === local.value) {
		return { ...local, confidence: round(Math.min(0.97, Math.max(local.confidence, clef.confidence) + 0.05)) };
	}
	if (local.value !== 'und' && clef.confidence < CLEF_LANGUAGE_FLOOR) return local;
	return applyDialect(text, {
		value: clef.value,
		confidence: clef.confidence,
		alternatives: local.value !== 'und' ? [{ value: local.value, confidence: local.confidence }, ...local.alternatives].slice(0, 4) : [],
		signal: 'model'
	});
}

/**
 * Combine the local read of `text` with Clef's. Clef decides task size and skills, and the language
 * unless the local read has a signal Clef lacks or Clef is unsure (see mergeLanguage). The result is
 * a remote analysis named after the Clef model.
 */
export function mergeClef(text: string, local: DraftAnalysis, clef: ClefVerdict): DraftAnalysis {
	const localSkills = new Map(local.skills.map((s) => [s.id, s]));
	const skills: SkillHint[] = [];
	for (const [id, p] of Object.entries(clef.skills) as [SkillId, number][]) {
		const had = localSkills.get(id);
		if (p >= SKILL_THRESHOLD) skills.push({ id, confidence: p, reason: had?.reason ?? SKILL_REASON[id] });
		else if (had && had.confidence >= LOCAL_SURE) skills.push(had);
	}
	skills.sort((a, b) => b.confidence - a.confidence);
	return {
		language: mergeLanguage(text, local.language, clef.language),
		difficulty: clef.difficulty,
		skills,
		source: 'remote',
		classifier: clef.model,
		elapsedMs: clef.elapsedMs
	};
}
