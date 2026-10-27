// Server-side check of one rating before it is stored. The client disables submit until the form is
// complete, but the server is the one that refuses, and it names every question that is missing so
// the flow can point at it.

import { questionsFor } from "./config";
import type { Rubric, RatingSubmission, ScoreValue, TaskDef } from "./types";

export const CANT_TELL = "cant_tell";

export type RatingCheck =
	| { ok: true; scores: Record<string, ScoreValue>; flags: string[]; comment: string | null; excluded: boolean }
	| { ok: false; missing: string[]; invalid: string[] };

export function validateRating(task: TaskDef, rubric: Rubric, submission: RatingSubmission): RatingCheck {
	const missing: string[] = [];
	const invalid: string[] = [];

	const knownFlags = new Set(rubric.flags.map((f) => f.key));
	const flags = [...new Set(submission.flags ?? [])];
	for (const f of flags) if (!knownFlags.has(f)) invalid.push(`flag:${f}`);

	// "The request is badly written" is a way out of the form, not a rating: the questions become
	// optional and the row is stored as excluded until the translation is reviewed.
	const excluded = flags.some((f) => rubric.flags.find((rf) => rf.key === f)?.excludesRating);

	const questions = questionsFor(task, rubric);
	const allowed = new Set(questions.map((q) => q.key));
	for (const key of Object.keys(submission.scores ?? {})) {
		if (!allowed.has(key)) invalid.push(key);
	}

	const scores: Record<string, ScoreValue> = {};
	for (const q of questions) {
		const v = submission.scores?.[q.key];
		if (v === undefined || v === null || v === "") {
			if (q.required && !excluded) missing.push(q.key);
			continue;
		}
		if (v === CANT_TELL) {
			if (q.allowCantTell) scores[q.key] = v;
			else invalid.push(q.key);
			continue;
		}
		if (!q.options.some((o) => o.value === v)) {
			invalid.push(q.key);
			continue;
		}
		scores[q.key] = v;
	}

	if (typeof submission.durationMs !== "number" || !Number.isFinite(submission.durationMs) || submission.durationMs < 0) {
		invalid.push("durationMs");
	}

	const comment = submission.comment?.trim() || null;
	if (comment && comment.length > rubric.comment.maxLength) invalid.push("comment");

	if (missing.length || invalid.length) return { ok: false, missing, invalid };
	return { ok: true, scores, flags, comment, excluded };
}
