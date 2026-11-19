/**
 * The public language leaderboard's reading of the app's language scores. Pure: it takes
 * the scores file, the models Alpha serves and the languages to show, and says, for every model and
 * language, which score is shown, how much evidence is behind it, and whether it can be compared.
 *
 * The rules, in order:
 *   - One run per model and language, never an average. Where several runs measured a pair, the most
 *     recent is shown, the larger sample breaking a tie (the importer replaces an older score the same
 *     way, docs/benchmarks/README.md).
 *   - A score borrowed from another model is never shown as this model's: BORROWED below.
 *   - A score from fewer than MIN_QUESTIONS_TO_COMPARE questions is shown, labelled, and left out of
 *     the comparison: its 95% range is too wide to tell models apart.
 *   - A pair with no score is "not measured", never 0.
 *   - The 95% range is a Wilson interval on the raw accuracy and the number of questions. It covers
 *     sampling error only. Runs on different question sets, through different providers or harnesses,
 *     differ for reasons no interval captures, which the page states in words.
 */
import type { CatalogModel } from './catalog';
import type { LanguageBenchmark, LanguageScores } from './languageScores';
import { fromIso1, languageName } from './languages';
import { endonym } from '../evaluate/endonym';

/** Belebele has 900 questions in every language. A run on fewer is a sample or did not finish. */
export const BELEBELE_FULL_SET = 900;

/**
 * Below this many questions a score is shown but not compared. At 250 questions and 90% accuracy the
 * 95% range is about ±4 points; at 50 it is about ±9. 250 is also the cut the CIP import used.
 */
export const MIN_QUESTIONS_TO_COMPARE = 250;

/**
 * Scores the file gives one model that were measured on another. The provisional CIP entries hold
 * Mistral Large 4's scores, given to Mistral Medium 3.5 for routing until Medium is measured itself
 * (docs/benchmarks/README.md, "Provisional scores"). Routing may borrow; a public table may not.
 */
export const BORROWED: readonly { benchmarkPrefix: string; model: string; measuredModel: string }[] = [
	{ benchmarkPrefix: 'belebele-cip-provisional-2026-10-26-', model: 'mistral-medium', measuredModel: 'mistral-large-4' }
];

type ScoreStatus =
	/** Enough questions to compare with the other models in this language. */
	| 'compared'
	/** Measured, on too few questions to compare. */
	| 'too-few'
	/** No score of the model's own in this language. */
	| 'not-measured';

export interface LeaderboardCell {
	model: CatalogModel;
	language: string;
	status: ScoreStatus;
	/** Raw accuracy, 0–1. Absent when not measured. */
	accuracy?: number;
	/** 95% range on the accuracy, 0–1. */
	low?: number;
	high?: number;
	/** Questions the score rests on. */
	questions?: number;
	benchmarkId?: string;
	benchmark?: LanguageBenchmark;
	/** Fewer questions than the full Belebele set: a sample, or a run that did not finish. */
	partial?: boolean;
	/**
	 * Compared, and its range overlaps the highest compared score's range in this language, so the data
	 * cannot say which is higher. Set on the highest score too, and only when another overlaps it.
	 */
	closeToTop?: boolean;
}

/** Wilson score interval, 95%, for a proportion `p` observed over `n` trials. */
export function wilson95(p: number, n: number): { low: number; high: number } {
	if (!(n > 0)) throw new Error(`wilson95: n must be positive, got ${n}`);
	if (!(p >= 0 && p <= 1)) throw new Error(`wilson95: p must be within 0–1, got ${p}`);
	const z = 1.96;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function isBorrowed(benchmarkId: string, modelId: string): boolean {
	return BORROWED.some((b) => b.model === modelId && benchmarkId.startsWith(b.benchmarkPrefix));
}

/** The one score shown for a model in a language, or a not-measured cell. */
export function cellFor(data: LanguageScores, model: CatalogModel, language: string): LeaderboardCell {
	const runs: { id: string; accuracy: number; bench: LanguageBenchmark }[] = [];
	for (const [id, byModel] of Object.entries(data.scores)) {
		const accuracy = byModel[model.id]?.[language];
		const bench = data.benchmarks[id];
		if (accuracy === undefined || !bench || isBorrowed(id, model.id)) continue;
		runs.push({ id, accuracy, bench });
	}
	if (!runs.length) return { model, language, status: 'not-measured' };
	const shown = runs.reduce((a, b) =>
		b.bench.ran > a.bench.ran || (b.bench.ran === a.bench.ran && b.bench.questions > a.bench.questions) ? b : a
	);
	const n = shown.bench.questions;
	return {
		model,
		language,
		status: n >= MIN_QUESTIONS_TO_COMPARE ? 'compared' : 'too-few',
		accuracy: shown.accuracy,
		...wilson95(shown.accuracy, n),
		questions: n,
		benchmarkId: shown.id,
		benchmark: shown.bench,
		partial: n < BELEBELE_FULL_SET
	};
}

const byName = (a: LeaderboardCell, b: LeaderboardCell) => a.model.name.localeCompare(b.model.name);

/**
 * Every served model in one language. Compared scores first, highest first; then scores on too few
 * questions, highest first; then models not measured, by name. No rank numbers: the order is by score,
 * and `closeToTop` marks the compared scores the data cannot separate from the highest one.
 */
export function languageBoard(data: LanguageScores, models: readonly CatalogModel[], language: string): LeaderboardCell[] {
	const cells = models.map((m) => cellFor(data, m, language));
	const byScore = (a: LeaderboardCell, b: LeaderboardCell) => b.accuracy! - a.accuracy! || byName(a, b);
	const compared = cells.filter((c) => c.status === 'compared').sort(byScore);
	const top = compared[0];
	const close = top ? compared.filter((c) => c.high! >= top.low!) : [];
	if (close.length > 1) for (const c of close) c.closeToTop = true;
	return [
		...compared,
		...cells.filter((c) => c.status === 'too-few').sort(byScore),
		...cells.filter((c) => c.status === 'not-measured').sort(byName)
	];
}

/** One model in every language: measured languages highest first, then the ones not measured. */
export function modelBoard(
	data: LanguageScores,
	model: CatalogModel,
	languages: readonly string[],
	nameOf: (tag: string) => string
): LeaderboardCell[] {
	const cells = languages.map((l) => cellFor(data, model, l));
	const byLanguage = (a: LeaderboardCell, b: LeaderboardCell) => nameOf(a.language).localeCompare(nameOf(b.language));
	const measured = cells.filter((c) => c.status !== 'not-measured');
	return [
		...measured.sort((a, b) => b.accuracy! - a.accuracy! || byLanguage(a, b)),
		...cells.filter((c) => c.status === 'not-measured').sort(byLanguage)
	];
}

/** The date of the most recent run behind any score shown, or undefined when nothing is measured. */
export function latestRun(data: LanguageScores, models: readonly CatalogModel[], languages: readonly string[]): string | undefined {
	let latest: string | undefined;
	for (const m of models) {
		for (const l of languages) {
			const ran = cellFor(data, m, l).benchmark?.ran;
			if (ran && (!latest || ran > latest)) latest = ran;
		}
	}
	return latest;
}

/**
 * The language the page opens on when the link names none: the first of the browser's languages that
 * is a launch language, else Spanish (measured for most served models, and widely read).
 */
export function openingLanguage(acceptLanguage: string | null, languages: readonly string[]): string {
	for (const part of (acceptLanguage ?? '').split(',')) {
		const tag = fromIso1(part.split(';')[0].trim().split('-')[0].toLowerCase());
		if (languages.includes(tag)) return tag;
	}
	return languages.includes('spa') ? 'spa' : languages[0];
}

/**
 * A language's name in its own language and script, shown beside the English name ("Catalan ·
 * català") instead of a flag, since most languages are spoken in more than one country. Undefined
 * when it would only repeat the English name. Tagalog keeps its own name: Intl calls it Filipino,
 * which is a different standard.
 */
export function ownLanguageName(tag: string): string | undefined {
	const own = tag === 'tgl' ? 'Tagalog' : endonym(tag);
	return own && own.toLocaleLowerCase() !== languageName(tag).toLocaleLowerCase() ? own : undefined;
}

/**
 * The language picker's options: "Catalan · català", searchable by the English name, the language's
 * own name and its code (the Combobox's fuzzy filter also forgives typos and missing accents).
 */
export function languagePickerItems(languages: readonly string[]): { value: string; label: string; keywords: string[] }[] {
	return languages.map((tag) => {
		const own = ownLanguageName(tag);
		return {
			value: tag,
			label: own ? `${languageName(tag)} · ${own}` : languageName(tag),
			keywords: [languageName(tag), ...(own ? [own] : []), tag]
		};
	});
}

/** Whole percent, the precision the evidence supports. */
export const percent = (p: number) => `${Math.round(p * 100)}%`;
