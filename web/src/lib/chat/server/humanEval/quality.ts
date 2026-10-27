// Whether a stored rating counts. Every rating is stored; these checks only set its validity.
//
// The time check reads durationMs as the client reports it. It catches someone clicking through the
// page, not a script that sends a large number. A server-side check needs the time each item was
// served, which is not stored yet.

import type { RatingValidity, ScoreValue } from "./types";

/**
 * Fastest plausible reading, in milliseconds per word of prompt plus answer. 80 ms per word is
 * about 750 words a minute, three times ordinary reading speed, so this only catches someone who did
 * not read. Scripts without spaces are counted in characters at half the rate.
 */
const MIN_MS_PER_WORD = 80;
const MIN_MS_FLOOR = 8_000;

export function wordCount(text: string): number {
	// Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar: no spaces between words.
	const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;
	const unspaced = (text.match(UNSPACED) ?? []).length;
	const spaced = text.replace(UNSPACED, " ").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
	return spaced + Math.ceil(unspaced / 2);
}

export function minimumDurationMs(prompt: string, answer: string): number {
	return Math.max(MIN_MS_FLOOR, (wordCount(prompt) + wordCount(answer)) * MIN_MS_PER_WORD);
}

export type QualityInput = {
	prompt: string;
	answer: string;
	durationMs: number;
	scores: Record<string, ScoreValue>;
	excluded: boolean;
	isCheck: boolean;
	/** This person's previous ratings in this language, newest first. */
	previous: Array<{ scores: Record<string, ScoreValue> }>;
	/** Check items this person has failed so far in this language. */
	failedChecks: number;
};

export type QualityResult = {
	validity: RatingValidity;
	reasons: string[];
	/** True when this rating was a check item and the person rated the bad answer as good. */
	failedCheck: boolean;
};

const STRAIGHT_LINE_RUN = 5;
export const MAX_FAILED_CHECKS = 1;

/**
 * A check item is an answer in another language than the one being evaluated (the answer to the
 * same task from a different language's run). Anyone reading it rates language 1 or 2, or ticks
 * "not in language". Rating it 4 or 5 on language means the answer was not read.
 */
export function passesCheck(scores: Record<string, ScoreValue>, flags: string[]): boolean {
	if (flags.includes("not_in_language")) return true;
	const lang = scores.language;
	return typeof lang === "number" && lang <= 2;
}

function sameScores(a: Record<string, ScoreValue>, b: Record<string, ScoreValue>): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) if (a[k] !== b[k]) return false;
	return true;
}

export function assessRating(input: QualityInput, flags: string[] = []): QualityResult {
	const reasons: string[] = [];
	const failedCheck = input.isCheck && !passesCheck(input.scores, flags);

	if (input.excluded) return { validity: "excluded", reasons: ["task_badly_written"], failedCheck: false };

	if (input.durationMs < minimumDurationMs(input.prompt, input.answer)) reasons.push("too_fast");

	const run = [input, ...input.previous].slice(0, STRAIGHT_LINE_RUN);
	if (run.length === STRAIGHT_LINE_RUN && run.every((r) => sameScores(r.scores, input.scores))) {
		reasons.push("identical_run");
	}

	if (input.failedChecks + (failedCheck ? 1 : 0) > MAX_FAILED_CHECKS) reasons.push("failed_checks");

	// A check item is never a result, whatever the person answered.
	if (input.isCheck) return { validity: "excluded", reasons: ["check_item", ...reasons], failedCheck };
	return { validity: reasons.length ? "quarantined" : "valid", reasons, failedCheck };
}
