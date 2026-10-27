import { CANT_TELL, type EvalQuestion, type ScoreValue } from './types';

/**
 * Flags that take the answer out of the results ("the request is badly written"): ticking one
 * makes every question optional. rubric-r1.json marks them `excludesRating`; the API doesn't send
 * that, so the page keeps the list.
 */
export const EXCLUDING_FLAGS = new Set(['task_badly_written']);

/**
 * The rating form's own check, the same rule the server applies (validateRating.ts): every required
 * question needs an answer unless a flag that excludes the rating (the request is badly written) is
 * ticked. Run before submitting, so the person learns which
 * question is missing without a round trip; the server's refusal names the same keys.
 */
export function missingQuestions(
	questions: EvalQuestion[],
	answers: Record<string, string | undefined>,
	excluded: boolean
): string[] {
	if (excluded) return [];
	return questions.filter((q) => q.required && !answers[q.key]).map((q) => q.key);
}

/**
 * The form keeps every answer as a string (radio values are strings); the API wants the option's
 * own value back, a number for scale questions. Unanswered questions are left out.
 */
export function toScores(questions: EvalQuestion[], answers: Record<string, string | undefined>): Record<string, ScoreValue> {
	const scores: Record<string, ScoreValue> = {};
	for (const q of questions) {
		const raw = answers[q.key];
		if (!raw) continue;
		if (raw === CANT_TELL) {
			scores[q.key] = CANT_TELL;
			continue;
		}
		const option = q.options.find((o) => String(o.value) === raw);
		if (option) scores[q.key] = option.value;
	}
	return scores;
}

/** The labels of the given question keys, to name the missing ones. */
export function questionNames(questions: EvalQuestion[], keys: string[]): string[] {
	return keys.map((k) => questions.find((q) => q.key === k)?.label ?? k);
}
