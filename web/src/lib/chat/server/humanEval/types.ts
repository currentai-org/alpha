// Shapes of the human evaluation files in data/eval/ and of the ratings stored against them.

export type EvalLanguage = {
	id: string;
	name: string;
	bcp47: string;
	script: string;
	dir: "ltr" | "rtl";
	belebele: string;
	globalMmlu: boolean;
	baseline?: boolean;
	/** Varieties a rater can declare. "Other" is added to every list (config.ts). */
	varieties?: Array<{ value: string; label: string }>;
	notes?: string;
};

type ScaleOption = { value: number; label: string };
type ChoiceOption = { value: string; label: string };

export type RubricQuestion = {
	key: string;
	appliesTo: "all" | "safety";
	required: boolean;
	type: "scale" | "choice";
	allowCantTell?: boolean;
	cantTellLabel?: string;
	label: string;
	help?: string;
	options: Array<ScaleOption | ChoiceOption>;
	example?: string;
	/** Dimension keys in Roya Pakzad's rubric this question corresponds to. */
	mapsTo: string[];
};

type RubricFlag = { key: string; label: string; excludesRating?: boolean; mapsTo?: string[] };

export type Credit = { text: string; links: Array<{ label: string; url: string }> };

export type Rubric = {
	contract: number;
	version: string;
	/** Credit to the work the rubric is adapted from. Shown to raters. */
	credit: Credit & { license: string };
	instructions: Record<string, string>;
	questions: RubricQuestion[];
	flags: RubricFlag[];
	comment: { maxLength: number; prompt: string };
};

export type TaskDef = {
	id: string;
	category: string;
	/** Only single_turn exists. multi_step is reserved; see docs/plans/human-evaluation.md. */
	mode: "single_turn";
	difficulty: "easy" | "medium" | "hard";
	safety: boolean;
	source: string;
	/** Guidance for whoever localizes the task. */
	adaptation?: string;
	reference?: {
		shouldContain?: string[];
		mustKeep?: string[];
		mustNotContain?: string[];
		minCovered?: number;
		formula?: string;
		notes?: string;
	};
	autoChecks?: Array<{ type: string; value?: number | string; tolerance?: number }>;
};

export type TaskSet = {
	contract: number;
	version: string;
	rubricVersion: string;
	tasks: TaskDef[];
};

type LocalizedItem = {
	prompt?: string;
	mustKeep?: string[];
	errors?: string[];
	amount?: number;
	adaptationNote?: string;
	notApplicable?: boolean;
	reason?: string;
	reference?: string[];
};

export type Localization = {
	contract: number;
	taskSetVersion: string;
	language: string;
	variety: string;
	/** draft: written, not checked by a speaker. checked: open for evaluation. */
	status: "draft" | "checked";
	/** Internal only. Never published. */
	checkedBy?: string;
	checkedAt?: string;
	items: Record<string, LocalizedItem>;
	calibration?: {
		taskId: string;
		answer: string;
		expected: Record<string, number | string>;
		explanation: string;
	};
	/** The rating page text in this language, from the speaker review. Anything missing stays in English. */
	page?: LocalizedPage;
};

type LocalizedPage = {
	languageName?: string;
	instructions?: Record<string, string>;
	credit?: string;
	questions?: Record<string, { label?: string; help?: string; example?: string; cantTell?: string; options?: Record<string, string> }>;
	flags?: Record<string, string>;
	comment?: string;
	/** Translation of the consent file named by consentVersion. A paragraph left null stays in English. */
	consent?: { consentVersion: string; title?: string; paragraphs: Array<string | null>; agree?: string };
	varieties?: Record<string, string>;
};

export type Consent = {
	version: string;
	/** draft: not reviewed. Evaluation stays closed outside preview until it is checked. */
	status: "draft" | "checked";
	reviewedBy?: string;
	title: string;
	paragraphs: string[];
	agree: string;
};

export type DeclaredLevel = "native" | "fluent" | "working";

export type ScoreValue = number | string;

export type RatingSubmission = {
	modelRunId: string;
	scores: Record<string, ScoreValue>;
	flags: string[];
	comment?: string | null;
	/** Time from the answer being shown to submit, reported by the client. */
	durationMs: number;
};

export type RatingValidity = "valid" | "excluded" | "quarantined";

/** One stored rating, as the aggregation reads it. */
export type RatingRow = {
	raterId: string;
	modelRunId: string;
	modelId: string;
	language: string;
	taskId: string;
	declaredLevel: DeclaredLevel;
	rubricVersion: string;
	taskSetVersion: string;
	scores: Record<string, ScoreValue>;
	validity: RatingValidity;
};
