// Results for one model in one language, derived from stored ratings and never stored themselves.
// There is no overall score: each question keeps its own distribution, and the headline is the share
// of ratings where the rater would use the answer. Only human ratings go in. Belebele results are a
// separate record and never pass through here.

import { RUBRIC, TASK_SET } from "./config";
import type { DeclaredLevel, RatingRow, ScoreValue } from "./types";

export const THRESHOLDS = {
	/** Valid ratings needed before any number is shown for a model in a language. */
	minRatings: 24,
	/** Distinct raters needed, so one person cannot make a result alone. */
	minRaters: 3,
	/** Distinct shared tasks covered, so one easy task cannot make a result alone. */
	minTasks: 8,
} as const;

const COUNTED_LEVELS: DeclaredLevel[] = ["native", "fluent"];

const SCALE_KEYS = ["task", "accuracy", "language"] as const;
const USABLE_YES = new Set(["as_is", "small_edits"]);

type ScaleSummary = {
	/** Counts for 1 to 5, plus "cant_tell" where the question allows it. */
	distribution: Record<string, number>;
	/** Mean of the numeric answers, "can't tell" left out. Null with no numeric answers. */
	mean: number | null;
	n: number;
};

type CellStatus = "none" | "insufficient" | "shown";

export type CellResult = {
	modelId: string;
	language: string;
	status: CellStatus;
	nRatings: number;
	nRaters: number;
	nTasks: number;
	nAnswers: number;
	usable: { share: number; low: number; high: number; n: number } | null;
	scales: Record<(typeof SCALE_KEYS)[number], ScaleSummary>;
	/** Share of answers with two or more ratings where raters disagree (see `disagrees`). */
	disagreement: { share: number; nAnswersWithTwoOrMore: number } | null;
};

/** Wilson score interval, 95%. Honest at small n where the normal approximation is not. */
export function wilson(successes: number, n: number, z = 1.96): { share: number; low: number; high: number } {
	if (n === 0) return { share: 0, low: 0, high: 1 };
	const p = successes / n;
	const denom = 1 + (z * z) / n;
	const centre = (p + (z * z) / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
	return { share: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function summarise(values: ScoreValue[]): ScaleSummary {
	const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
	let sum = 0;
	let numeric = 0;
	for (const v of values) {
		distribution[String(v)] = (distribution[String(v)] ?? 0) + 1;
		if (typeof v === "number") {
			sum += v;
			numeric++;
		}
	}
	return { distribution, mean: numeric ? sum / numeric : null, n: values.length };
}

/**
 * Two raters disagree on an answer when one would use it and another would not, or when their
 * numbers on any scale question are three or more points apart (a 2 and a 5, not a 3 and a 4).
 */
export function disagrees(ratings: Array<Record<string, ScoreValue>>): boolean {
	const usable = ratings.map((r) => r.usable).filter((v) => typeof v === "string");
	if (usable.some((v) => USABLE_YES.has(v as string)) && usable.includes("no")) return true;
	for (const key of SCALE_KEYS) {
		const nums = ratings.map((r) => r[key]).filter((v): v is number => typeof v === "number");
		if (nums.length >= 2 && Math.max(...nums) - Math.min(...nums) >= 3) return true;
	}
	return false;
}

/**
 * Ratings that count: valid, from native or fluent speakers, against the current rubric and task set.
 * Ratings under an older rubric or task set asked different questions and are never mixed in.
 */
function counted(rows: RatingRow[]): RatingRow[] {
	return rows.filter(
		(r) =>
			r.validity === "valid" &&
			COUNTED_LEVELS.includes(r.declaredLevel) &&
			r.rubricVersion === RUBRIC.version &&
			r.taskSetVersion === TASK_SET.version
	);
}

export function aggregateCell(modelId: string, language: string, rows: RatingRow[]): CellResult {
	const mine = counted(rows).filter((r) => r.modelId === modelId && r.language === language);
	const raters = new Set(mine.map((r) => r.raterId));
	const tasks = new Set(mine.map((r) => r.taskId));
	const answers = new Map<string, Array<Record<string, ScoreValue>>>();
	for (const r of mine) answers.set(r.modelRunId, [...(answers.get(r.modelRunId) ?? []), r.scores]);

	const scales = Object.fromEntries(
		SCALE_KEYS.map((k) => [k, summarise(mine.map((r) => r.scores[k]).filter((v) => v !== undefined))])
	) as CellResult["scales"];

	const usableVotes = mine.map((r) => r.scores.usable).filter((v) => typeof v === "string") as string[];
	const yes = usableVotes.filter((v) => USABLE_YES.has(v)).length;

	const multi = [...answers.values()].filter((a) => a.length >= 2);
	const status: CellStatus =
		mine.length === 0
			? "none"
			: mine.length >= THRESHOLDS.minRatings && raters.size >= THRESHOLDS.minRaters && tasks.size >= THRESHOLDS.minTasks
				? "shown"
				: "insufficient";

	return {
		modelId,
		language,
		status,
		nRatings: mine.length,
		nRaters: raters.size,
		nTasks: tasks.size,
		nAnswers: answers.size,
		usable: usableVotes.length ? { ...wilson(yes, usableVotes.length), n: usableVotes.length } : null,
		scales,
		disagreement: multi.length
			? { share: multi.filter(disagrees).length / multi.length, nAnswersWithTwoOrMore: multi.length }
			: null,
	};
}

export type BaselineDelta = {
	modelId: string;
	language: string;
	/** Shared tasks present in both cells. The delta is computed on these only. */
	tasks: string[];
	usableShareDelta: number | null;
	meanDelta: Record<(typeof SCALE_KEYS)[number], number | null>;
};

/**
 * The same model in a language minus in English, on the tasks both have counted ratings for. Null
 * unless both cells are shown. Different people rated different answers, so this is indicative only.
 */
export function baselineDelta(
	modelId: string,
	language: string,
	baseline: string,
	rows: RatingRow[]
): BaselineDelta | null {
	const target = aggregateCell(modelId, language, rows);
	const base = aggregateCell(modelId, baseline, rows);
	if (target.status !== "shown" || base.status !== "shown") return null;

	const pool = counted(rows).filter((r) => r.modelId === modelId);
	const targetTasks = new Set(pool.filter((r) => r.language === language).map((r) => r.taskId));
	const baseTasks = new Set(pool.filter((r) => r.language === baseline).map((r) => r.taskId));
	const shared = [...targetTasks].filter((t) => baseTasks.has(t)).sort();
	const onShared = rows.filter((r) => shared.includes(r.taskId));
	const t = aggregateCell(modelId, language, onShared);
	const b = aggregateCell(modelId, baseline, onShared);

	return {
		modelId,
		language,
		tasks: shared,
		usableShareDelta: t.usable && b.usable ? t.usable.share - b.usable.share : null,
		meanDelta: Object.fromEntries(
			SCALE_KEYS.map((k) => {
				const tm = t.scales[k].mean;
				const bm = b.scales[k].mean;
				return [k, tm === null || bm === null ? null : tm - bm];
			})
		) as BaselineDelta["meanDelta"],
	};
}
