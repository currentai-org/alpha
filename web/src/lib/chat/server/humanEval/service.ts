// The two operations behind the evaluation flow: give this person their next answer to rate, and
// record their rating. Routes stay thin and call these.

import {
	candidatesFor,
	countRatingsSince,
	languagesWithAnswers,
	ratingRowsFor,
	DAILY_RATING_CAP,
	getProfile,
	getRun,
	incrementFailedChecks,
	insertRating,
	quarantineRatings,
	markCalibrationSeen,
	ratingsByUser,
} from "$lib/chat/server/db/humanEval";
import {
	CONSENT,
	RUBRIC,
	TASK_SET,
	getLanguage,
	getLocalization,
	getTask,
	isLanguageOpen,
	localizedConsent,
	localizedCredit,
	localizedFlags,
	localizedQuestions,
} from "./config";
import { includeDraftLanguages } from "./gate";
import { pickNext } from "./nextItem";
import { aggregateCell, THRESHOLDS, type CellResult } from "./aggregate";
import { assessRating, MAX_FAILED_CHECKS } from "./quality";
import { validateRating } from "./validateRating";
import type { Credit, RatingSubmission } from "./types";

/** Stored on the profile. A new consent file gets a new version. */
export const CONSENT_VERSION = CONSENT.version;

export type NextItem =
	| { kind: "calibration"; language: string; dir: "ltr" | "rtl"; prompt: string; answer: string; questions: unknown[]; expected: Record<string, string | number>; explanation: string; credit: Credit }
	| { kind: "rate"; runId: string; language: string; dir: "ltr" | "rtl"; prompt: string; answer: string; questions: unknown[]; flags: unknown[]; reference: string[]; credit: Credit }
	| { kind: "done"; language: string }
	/** Open, but no stored answers to rate yet. Sent before consent, and in place of "done" to anyone who has rated nothing. */
	| { kind: "empty"; language: string }
	| { kind: "needs_profile"; language: string; consent: { version: string; title: string; paragraphs: string[]; agree: string } }
	| { kind: "closed"; language: string };


/**
 * What a good answer does, in the rater's language: the localization's own reference list, then the
 * values it must keep. English uses the task set's reference. Empty for tasks judged on usefulness.
 */
function referenceFor(taskId: string, language: string): string[] {
	const item = getLocalization(language)?.items[taskId];
	const task = getTask(taskId);
	const lines = [...(item?.reference ?? (language === "eng" ? (task?.reference?.shouldContain ?? []) : []))];
	if (item?.errors?.length) lines.push(...item.errors);
	return lines;
}

export async function nextItemFor(userId: string, language: string): Promise<NextItem> {
	const lang = getLanguage(language);
	if (!lang || !isLanguageOpen(language, includeDraftLanguages())) return { kind: "closed", language };

	// Asked first, so a person is told there is nothing to rate before they consent, not after.
	const candidates = await candidatesFor(language, TASK_SET.version);
	if (!candidates.some((c) => !c.isCheck)) return { kind: "empty", language };

	const profile = await getProfile(userId, language);
	if (!profile) {
		return {
			kind: "needs_profile",
			language,
			consent: localizedConsent(language),
		};
	}

	const loc = getLocalization(language)!;
	if (!profile.calibrationSeenAt && loc.calibration) {
		const task = getTask(loc.calibration.taskId)!;
		return {
			kind: "calibration",
			language,
			dir: lang.dir,
			prompt: loc.items[loc.calibration.taskId].prompt ?? "",
			answer: loc.calibration.answer,
			questions: localizedQuestions(task, language),
			expected: loc.calibration.expected,
			explanation: loc.calibration.explanation,
			credit: localizedCredit(language),
		};
	}

	const mine = await ratingsByUser(userId, language);
	const pick = pickNext({
		candidates,
		ratedRunIds: new Set(mine.map((r) => r.runId)),
		lastTaskId: mine[0]?.taskId ?? null,
		ratingsSoFar: mine.length,
	});
	// "You've rated every answer" is only true of someone who has rated one.
	if (!pick) return mine.length ? { kind: "done", language } : { kind: "empty", language };

	const run = (await getRun(pick.runId))!;
	const task = getTask(run.taskId);
	if (!task) throw new Error(`human_eval_runs ${run.id} names task ${run.taskId}, which is not in task set ${TASK_SET.version}`);
	return {
		kind: "rate",
		runId: run.id,
		language,
		dir: lang.dir,
		prompt: run.prompt,
		answer: run.response,
		questions: localizedQuestions(task, language),
		flags: localizedFlags(language),
		reference: referenceFor(run.taskId, language),
		credit: localizedCredit(language),
	};
}

/** Which of these languages have stored answers to rate, so the page can say so before anyone starts. */
export async function answersToRate(languages: string[]): Promise<Record<string, boolean>> {
	const stored = await languagesWithAnswers(TASK_SET.version);
	return Object.fromEntries(languages.map((l) => [l, stored.has(l)]));
}

/** One model's result in a language, as the evaluation page shows it. The model is named here. */
export type ModelResult = Pick<CellResult, "modelId" | "status" | "nRatings" | "nRaters" | "nTasks" | "usable"> & {
	name: string;
	/** Mean of each 1 to 5 question, "can't tell" left out. Null until the result is shown. */
	means: { task: number | null; accuracy: number | null; language: number | null } | null;
};

export type LanguageResults =
	| { kind: "results"; language: string; thresholds: typeof THRESHOLDS; models: ModelResult[] }
	| { kind: "closed"; language: string };

/**
 * How each model does in a language: every model with an answer raters are shown there, or a rating
 * on one, with its result from aggregate.ts. Below the thresholds only the counts go out, never a
 * share or a mean. Sorted by name, not by score: 12 answers per model separate a model that fails most
 * tasks from one that passes most, and do not rank two close ones.
 */
export async function resultsFor(language: string): Promise<LanguageResults> {
	if (!getLanguage(language) || !isLanguageOpen(language, includeDraftLanguages())) return { kind: "closed", language };

	const [candidates, rows, { models: registry }] = await Promise.all([
		candidatesFor(language, TASK_SET.version),
		ratingRowsFor(language),
		import("$lib/chat/server/models"),
	]);
	const ids = new Set([...candidates.filter((c) => !c.isCheck).map((c) => c.modelId), ...rows.map((r) => r.modelId)]);
	const nameOf = (id: string) => {
		const m = registry.find((r) => r.id === id);
		return m?.displayName || m?.name || id;
	};

	const models = [...ids].map((modelId): ModelResult => {
		const cell = aggregateCell(modelId, language, rows);
		const shown = cell.status === "shown";
		return {
			modelId,
			name: nameOf(modelId),
			status: cell.status,
			nRatings: cell.nRatings,
			nRaters: cell.nRaters,
			nTasks: cell.nTasks,
			usable: shown ? cell.usable : null,
			means: shown
				? { task: cell.scales.task.mean, accuracy: cell.scales.accuracy.mean, language: cell.scales.language.mean }
				: null,
		};
	});
	models.sort((a, b) => a.name.localeCompare(b.name));
	return { kind: "results", language, thresholds: THRESHOLDS, models };
}

export async function completeCalibration(userId: string, language: string): Promise<void> {
	const profile = await getProfile(userId, language);
	if (profile) await markCalibrationSeen(profile.id);
}

export type SubmitResult =
	| { ok: true }
	| { ok: false; status: 400 | 403 | 404 | 409 | 429; reason: string; missing?: string[]; invalid?: string[] };

export async function submitRating(userId: string, body: RatingSubmission): Promise<SubmitResult> {
	const run = await getRun(body.modelRunId);
	if (!run || !run.current) return { ok: false, status: 404, reason: "unknown_answer" };

	const profile = await getProfile(userId, run.language);
	if (!profile) return { ok: false, status: 403, reason: "needs_profile" };

	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	if ((await countRatingsSince(userId, since)) >= DAILY_RATING_CAP) {
		return { ok: false, status: 429, reason: "daily_limit" };
	}

	const task = getTask(run.taskId);
	if (!task) return { ok: false, status: 404, reason: "unknown_task" };

	const check = validateRating(task, RUBRIC, body);
	if (!check.ok) return { ok: false, status: 400, reason: "incomplete", missing: check.missing, invalid: check.invalid };

	const previous = await ratingsByUser(userId, run.language);
	const quality = assessRating(
		{
			prompt: run.prompt,
			answer: run.response,
			durationMs: body.durationMs,
			scores: check.scores,
			excluded: check.excluded,
			isCheck: run.isCheck,
			previous,
			failedChecks: profile.failedChecks,
		},
		check.flags
	);

	const id = await insertRating({
		userId,
		runId: run.id,
		language: run.language,
		taskId: run.taskId,
		modelId: run.modelId,
		declaredLevel: profile.level,
		rubricVersion: RUBRIC.version,
		taskSetVersion: run.taskSetVersion,
		scores: check.scores,
		flags: check.flags,
		comment: check.comment,
		durationMs: Math.round(body.durationMs),
		validity: quality.validity,
		reasons: quality.reasons,
	});
	if (!id) return { ok: false, status: 409, reason: "already_rated" };
	if (quality.failedCheck) {
		await incrementFailedChecks(profile.id);
		if (profile.failedChecks + 1 > MAX_FAILED_CHECKS) {
			await quarantineRatings(userId, run.language, "failed_checks");
		}
	}

	// The response is the same whether the rating counts or not, so the checks cannot be learned.
	return { ok: true };
}
