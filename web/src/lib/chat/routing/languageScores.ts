/**
 * Measured language scores: the app's half of the two-layer benchmark data. Each score is one model
 * in one language on one benchmark, a raw 0–1 accuracy, and points to that benchmark's entry (name,
 * version, run date, questions, link, what it measures and what it doesn't). How each run went
 * (intervals, model revision, prompt condition, per-question results) stays in the run files
 * belebele_gen.py writes, for the leaderboard; `pnpm benchmarks:import` turns finished runs into this
 * file and leaves unfinished ones out.
 *
 * Two rules the router depends on:
 *   - A raw score is rescaled against the benchmark's `chance` floor before it is weighed: Belebele
 *     has four choices, so 0.25 is guessing, and (0.3 − 0.25) / 0.75 ≈ 0.07 is what a 0.3 is worth.
 *     People are shown the raw accuracy, the number the benchmark itself reports.
 *   - A pair nobody measured is unknown, never 0 and never a default: once any model is measured in a
 *     language, an unmeasured one scores the lowest of the measured ones there (`neutralSupport`), so
 *     it is not pushed away for lack of a test and never outranks a model that was tested. A median
 *     would let an untested model outrank tested ones in a language such as Arabic or Amharic (CUR-4035).
 */
import raw from './data/language-scores.json';
import { parentLanguage } from './languages';

export interface LanguageBenchmark {
	/** Shown as the score's source: "Belebele". */
	name: string;
	/** Dataset revision or release the run used. */
	version: string;
	/** YYYY-MM-DD the run finished. */
	ran: string;
	/** Questions per language. */
	questions: number;
	/** Score a model gets by guessing: 0.25 for four-choice questions. */
	chance: number;
	url: string;
	/** Plain words, shown beside the score. */
	measures: string;
	doesNotMeasure: string;
}

export interface LanguageScores {
	version: 1;
	/** Benchmark id → its entry. */
	benchmarks: Record<string, LanguageBenchmark>;
	/** Benchmark id → catalog model id → language tag → raw accuracy, 0–1. */
	scores: Record<string, Record<string, Record<string, number>>>;
}

export interface MeasuredScore {
	/** Raw accuracy on the benchmark, the number people see. */
	raw: number;
	/** Rescaled above chance, 0–1: what routing weighs. Averaged when several benchmarks measured the pair. */
	value: number;
	benchmarkId: string;
	/** The most recent benchmark that measured the pair. */
	benchmark: LanguageBenchmark;
}

/** Raw accuracy → 0–1 above the benchmark's guessing floor. */
export function rescale(rawScore: number, chance: number): number {
	if (chance >= 1) return 0;
	return round(clamp01((rawScore - chance) / (1 - chance)));
}

/** This model's measured score in exactly this language, or undefined when nobody measured it. */
export function measuredScore(data: LanguageScores, modelId: string, tag: string): MeasuredScore | undefined {
	const found: { id: string; raw: number; value: number; bench: LanguageBenchmark }[] = [];
	for (const [id, byModel] of Object.entries(data.scores)) {
		const score = byModel[modelId]?.[tag];
		const bench = data.benchmarks[id];
		if (score === undefined || !bench) continue;
		found.push({ id, raw: score, value: rescale(score, bench.chance), bench });
	}
	if (!found.length) return undefined;
	const latest = found.reduce((a, b) => (b.bench.ran > a.bench.ran ? b : a));
	return {
		raw: latest.raw,
		value: round(found.reduce((sum, f) => sum + f.value, 0) / found.length),
		benchmarkId: latest.id,
		benchmark: latest.bench
	};
}

/**
 * What an unmeasured model scores in a language some models were measured in: the lowest of their
 * rescaled scores (or of its parent language's, for a variety). Undefined when nobody was measured
 * there, so the caller falls back to the hand-set estimates.
 */
export function neutralSupport(data: LanguageScores, tag: string): number | undefined {
	const values = measuredValues(data, tag);
	if (values.length) return Math.min(...values);
	const parent = parentLanguage(tag);
	const parentValues = parent ? measuredValues(data, parent) : [];
	return parentValues.length ? Math.min(...parentValues) : undefined;
}

function measuredValues(data: LanguageScores, tag: string): number[] {
	const models = new Set<string>();
	for (const byModel of Object.values(data.scores)) {
		for (const [model, byTag] of Object.entries(byModel)) if (tag in byTag) models.add(model);
	}
	return [...models].map((m) => measuredScore(data, m, tag)!.value);
}

const TAG = /^[a-z]{3}(-[A-Za-z0-9]{2,8})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Validate a scores file. Throws naming the first bad field; never returns half-valid data. */
export function parseLanguageScores(input: unknown): LanguageScores {
	const fail = (msg: string): never => {
		throw new Error(msg);
	};
	if (!input || typeof input !== 'object') fail('Expected a JSON object.');
	const d = input as Record<string, unknown>;
	if (d.version !== 1) fail('`version` must be 1.');
	const benchmarks: Record<string, LanguageBenchmark> = {};
	for (const [id, value] of Object.entries((d.benchmarks ?? {}) as Record<string, unknown>)) {
		const b = value as Record<string, unknown>;
		const at = `benchmarks.${id}`;
		for (const key of ['name', 'version', 'url', 'measures', 'doesNotMeasure'] as const) {
			if (typeof b?.[key] !== 'string' || !(b[key] as string).trim()) fail(`${at}.${key} is required.`);
		}
		if (typeof b.ran !== 'string' || !DATE.test(b.ran)) fail(`${at}.ran must be a date, YYYY-MM-DD.`);
		if (!Number.isInteger(b.questions) || (b.questions as number) < 1) fail(`${at}.questions must be a positive whole number.`);
		if (!isUnit(b.chance) || b.chance === 1) fail(`${at}.chance must be a number from 0 up to (not including) 1.`);
		benchmarks[id] = b as unknown as LanguageBenchmark;
	}
	const scores: LanguageScores['scores'] = {};
	for (const [id, byModel] of Object.entries((d.scores ?? {}) as Record<string, unknown>)) {
		if (!benchmarks[id]) fail(`scores.${id} has no entry under benchmarks, so its source can't be shown.`);
		scores[id] = {};
		for (const [model, byTag] of Object.entries((byModel ?? {}) as Record<string, unknown>)) {
			scores[id][model] = {};
			for (const [tag, v] of Object.entries((byTag ?? {}) as Record<string, unknown>)) {
				const at = `scores.${id}.${model}.${tag}`;
				if (!TAG.test(tag)) fail(`${at}: not an ISO 639-3 language tag.`);
				if (!isUnit(v)) fail(`${at} must be a raw accuracy from 0 to 1 (leave an unmeasured language out).`);
				scores[id][model][tag] = v as number;
			}
		}
	}
	return { version: 1, benchmarks, scores };
}

/** The scores shipped with the app. Parsed at load, so a malformed file fails loudly in tests. */
export const SHIPPED_LANGUAGE_SCORES: LanguageScores = parseLanguageScores(raw);

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 100) / 100;
