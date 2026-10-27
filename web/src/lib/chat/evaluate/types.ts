/**
 * What the human evaluation API returns and accepts, as the evaluation page reads it. Mirrors
 * `NextItem`, `RatingSubmission` and the rubric's question shape in `$lib/chat/server/humanEval/`,
 * with the `unknown[]` fields there spelled out from rubric-r1.json. All four routes answer 404 while
 * the `human-eval` flag is off (humanEval/gate.ts).
 *
 *   GET  /chat/api/eval/languages        → { languages: EvalLanguage[] }
 *   GET  /chat/api/eval/next?language=   → NextItem                            (401 signed out)
 *   POST /chat/api/eval/profile          ← ProfileSubmission → { ok: true }    (404 language not open)
 *   POST /chat/api/eval/ratings          ← RatingSubmission  → { ok: true } | RatingRefusal
 */

export type Direction = 'ltr' | 'rtl';

/** A variety a rater can declare (BCP 47, or "other"), as `/languages` lists it. */
interface EvalVariety {
	value: string;
	label: string;
}

export interface EvalLanguage {
	id: string;
	name: string;
	dir: Direction;
	/** Open languages only, from `/languages`; empty when the language asks for none. */
	varieties?: EvalVariety[];
	/** False when the language is open but has no stored answers to rate yet. Absent means it has some. */
	hasAnswers?: boolean;
}

export type DeclaredLevel = 'native' | 'fluent' | 'working';

export type ScoreValue = number | string;

interface EvalQuestionOption {
	value: ScoreValue;
	label: string;
}

export interface EvalQuestion {
	key: string;
	type: 'scale' | 'choice';
	required: boolean;
	label: string;
	help?: string;
	/** A worked case, e.g. "asks for at most five tips and gets eight: 3 at best". */
	example?: string;
	options: EvalQuestionOption[];
	allowCantTell?: boolean;
	cantTellLabel?: string;
}

export interface EvalFlag {
	key: string;
	label: string;
}

export interface Credit {
	text: string;
	links: { label: string; url: string }[];
}

export interface Consent {
	version: string;
	title: string;
	paragraphs: string[];
	agree: string;
}

export type NextItem =
	| {
			kind: 'calibration';
			language: string;
			dir: Direction;
			prompt: string;
			answer: string;
			questions: EvalQuestion[];
			expected: Record<string, ScoreValue>;
			explanation: string;
			credit: Credit;
	  }
	| {
			kind: 'rate';
			runId: string;
			language: string;
			dir: Direction;
			prompt: string;
			answer: string;
			questions: EvalQuestion[];
			flags: EvalFlag[];
			/** "What a good answer does", in the rater's language. Empty for tasks judged on usefulness. */
			reference: string[];
			credit: Credit;
	  }
	| { kind: 'done'; language: string }
	/** Open, but nothing stored to rate yet: sent before consent, and in place of `done` to someone who rated nothing. */
	| { kind: 'empty'; language: string }
	| { kind: 'needs_profile'; language: string; consent: Consent }
	| { kind: 'closed'; language: string };

export interface ProfileSubmission {
	language: string;
	level: DeclaredLevel;
	variety?: string | null;
	consent: true;
	calibrationDone?: boolean;
}

export interface RatingSubmission {
	modelRunId: string;
	scores: Record<string, ScoreValue>;
	flags: string[];
	comment?: string | null;
	durationMs: number;
}

type RefusalReason =
	| 'incomplete'
	| 'daily_limit'
	| 'already_rated'
	| 'unknown_answer'
	| 'unknown_task'
	| 'needs_profile';

export interface RatingRefusal {
	ok: false;
	reason: RefusalReason;
	/** Required questions left unanswered. */
	missing: string[];
	invalid: string[];
}

export type RatingResult = { ok: true } | RatingRefusal;

/** One model's result in a language (`GET /results`). Shares and means only once `status` is `shown`. */
export interface ModelResult {
	modelId: string;
	name: string;
	/** `none`: nobody has rated it yet. `insufficient`: some ratings, below the thresholds. */
	status: 'none' | 'insufficient' | 'shown';
	nRatings: number;
	nRaters: number;
	nTasks: number;
	/** Share of ratings where the rater would use the answer, with its 95% interval. */
	usable: { share: number; low: number; high: number; n: number } | null;
	means: { task: number | null; accuracy: number | null; language: number | null } | null;
}

export type LanguageResults =
	| {
			kind: 'results';
			language: string;
			thresholds: { minRatings: number; minRaters: number; minTasks: number };
			models: ModelResult[];
	  }
	| { kind: 'closed'; language: string };

/** The answer a scale or choice question accepts besides its options, where allowed. */
export const CANT_TELL = 'cant_tell';

/** The server's cap on ratings per person per 24 hours (humanEval DAILY_RATING_CAP). */
export const DAILY_RATING_CAP = 60;
