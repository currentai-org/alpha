/**
 * The draft classifier contract. Before a message is sent, a classifier reads the draft and returns a
 * typed `DraftAnalysis`: the language (and dialect) it is written in, how big the task is (S/M/L), and
 * which skills or tools it will likely need, each with a confidence in [0, 1]. The router
 * (`router.ts`) turns that into a model choice and never knows which classifier answered.
 *
 * Any classifier can fill it. What runs today is local and in the browser: the synchronous heuristic
 * (`heuristic.ts`) and the browser classifier built on it (`localClassifier.ts`). A hosted classifier
 * model is the intended upgrade; Jev (typesafe.ai's "System One" models: typed, probabilistic
 * decisions with a calibrated confidence in tens to hundreds of milliseconds) is the recommended one.
 * A hosted classifier lives in its own file implementing `DraftClassifier`, one file per classifier.
 *
 * Wiring a hosted one follows the repo rule that feature flags gate features and env vars
 * are config: a PostHog flag, registered in `server/flagKeys.ts`, decides on/off, and the endpoint
 * URL is only the address. It also sends the draft off the device, so the picker's "worked out on your
 * device" copy and the privacy panel change with it.
 */
import { m } from '$lib/paraglide/messages.js';

/** Task size. S: a lookup or a greeting. M: an everyday request. L: analysis, code, long work. */
export type Difficulty = 'S' | 'M' | 'L';

/** A typed decision with a confidence in [0, 1]. */
export interface Decision<T> {
	value: T;
	confidence: number;
}

/** What produced the language answer — shown in the routing lab. `model`: a hosted classifier (clef.ts). */
export type LanguageSignal = 'script' | 'words' | 'ngram' | 'low-resource' | 'dialect' | 'model' | 'none';

export interface LanguageDecision extends Decision<string> {
	/** Language tag (see `languages.ts`), or `und` when there is too little text to tell. */
	value: string;
	/** Runner-up tags, most likely first. */
	alternatives: Decision<string>[];
	signal: LanguageSignal;
}

export type SkillId = 'web-search' | 'code' | 'math' | 'translation' | 'research' | 'reasoning';

/** A skill or tool the answer will likely want, surfaced to the agent and shown in the picker. */
export interface SkillHint {
	id: SkillId;
	confidence: number;
	/** Plain-language reason, e.g. "Asks about something recent". */
	reason: string;
}

export interface DraftAnalysis {
	language: LanguageDecision;
	difficulty: Decision<Difficulty>;
	skills: SkillHint[];
	/**
	 * Which classifier produced it: `heuristic` (the synchronous stand-in), `local` (the browser
	 * classifier), `remote` (a hosted classifier model such as Jev), or `manual` (set by hand in the
	 * routing lab).
	 */
	source: 'heuristic' | 'local' | 'remote' | 'manual';
	/** The classifier's own name, when it reports one (e.g. a model id). */
	classifier?: string;
	/** Wall time the classifier took, when it measured it. */
	elapsedMs?: number;
}

export type DraftClassifier = (text: string, opts?: { signal?: AbortSignal }) => Promise<DraftAnalysis>;

// Getters, so every read is in the interface language at the moment it is read.
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
	get S() {
		return m.routing_smallTask();
	},
	get M() {
		return m.routing_mediumTask();
	},
	get L() {
		return m.routing_largeTask();
	}
};

export const SKILL_LABEL: Record<SkillId, string> = {
	get 'web-search'() {
		return m.routing_skillWebSearch();
	},
	get code() {
		return m.routing_skillCode();
	},
	get math() {
		return m.routing_skillMath();
	},
	get translation() {
		return m.routing_skillTranslation();
	},
	get research() {
		return m.routing_skillResearch();
	},
	get reasoning() {
		return m.routing_skillReasoning();
	}
};
