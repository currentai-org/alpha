// The human evaluation configuration: languages, task set, localizations and rubric. These are
// versioned files in data/eval/, so a change to a task or a question goes through a PR. Postgres holds
// what is produced against them (db/schema.ts, "human evaluation"). Nothing here is read on the chat
// turn path.

import languagesFile from "$lib/chat/server/data/eval/languages.json";
import rubricFile from "$lib/chat/server/data/eval/rubric-r1.json";
import consentFile from "$lib/chat/server/data/eval/consent-c1.json";
import tasksFile from "$lib/chat/server/data/eval/taskset-v1/tasks.json";

import type { Consent, Credit, EvalLanguage, Localization, Rubric, RubricQuestion, TaskDef, TaskSet } from "./types";

export const LANGUAGES = languagesFile.languages as EvalLanguage[];
export const RUBRIC = rubricFile as unknown as Rubric;
export const TASK_SET = tasksFile as unknown as TaskSet;
/** What a person agrees to before rating. Its version is stored on their profile. */
export const CONSENT = consentFile as Consent;

// One file per language, named by its id. A language with no file is not open for evaluation. A new
// file is picked up without a code change (scripts/import-language-review.mjs writes them).
const LOCALIZATIONS = Object.values(
	import.meta.glob("$lib/chat/server/data/eval/taskset-v1/localizations/*.json", { eager: true, import: "default" })
) as Localization[];

/** Added to every variety list, for raters whose variety is not listed. */
const OTHER_VARIETY = "other";

/** Throws on the first inconsistency, naming it. Runs at module load and in the spec. */
export function validateConfig(
	languages: EvalLanguage[] = LANGUAGES,
	rubric: Rubric = RUBRIC,
	taskSet: TaskSet = TASK_SET,
	localizations: Localization[] = LOCALIZATIONS
): void {
	const languageIds = new Set(languages.map((l) => l.id));
	if (languageIds.size !== languages.length) throw new Error("languages.json has a duplicate id");
	for (const l of languages) {
		const values = (l.varieties ?? []).map((v) => v.value);
		if (new Set(values).size !== values.length) throw new Error(`${l.id} lists a variety twice`);
		for (const v of values) {
			// The profile column and route accept at most 16 characters.
			if (v === OTHER_VARIETY || v.length > 16) throw new Error(`${l.id} has an invalid variety "${v}"`);
		}
	}
	if (languages.filter((l) => l.baseline).length !== 1) {
		throw new Error("languages.json must mark exactly one baseline language");
	}
	if (taskSet.rubricVersion !== rubric.version) {
		throw new Error(`task set ${taskSet.version} names rubric ${taskSet.rubricVersion}, loaded ${rubric.version}`);
	}
	const taskIds = new Set<string>();
	for (const t of taskSet.tasks) {
		if (taskIds.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
		taskIds.add(t.id);
		if (t.mode !== "single_turn") throw new Error(`task ${t.id} is ${t.mode}: only single_turn tasks can be rated`);
	}
	if (!rubric.credit?.text?.trim() || !rubric.credit.links?.length) {
		throw new Error(`rubric ${rubric.version} has no credit: the work it is adapted from must be credited on the page`);
	}
	const questionKeys = new Set(rubric.questions.map((q) => q.key));
	if (questionKeys.size !== rubric.questions.length) throw new Error("rubric has a duplicate question key");

	const seen = new Set<string>();
	for (const loc of localizations) {
		if (!languageIds.has(loc.language)) throw new Error(`localization for unknown language ${loc.language}`);
		if (seen.has(loc.language)) throw new Error(`two localizations for ${loc.language}`);
		seen.add(loc.language);
		if (loc.taskSetVersion !== taskSet.version) {
			throw new Error(`${loc.language} localization is for task set ${loc.taskSetVersion}`);
		}
		for (const taskId of taskIds) {
			const item = loc.items[taskId];
			if (!item) throw new Error(`${loc.language} has no item for ${taskId}`);
			if (!item.notApplicable && !item.prompt?.trim()) throw new Error(`${loc.language}/${taskId} has no prompt`);
		}
		for (const key of Object.keys(loc.items)) {
			if (!taskIds.has(key)) throw new Error(`${loc.language} has item ${key}, which is not in task set ${taskSet.version}`);
		}
		if (loc.calibration && !taskIds.has(loc.calibration.taskId)) {
			throw new Error(`${loc.language} calibration names unknown task ${loc.calibration.taskId}`);
		}
		validatePage(loc, rubric);
		if (loc.status === "checked" && !loc.checkedBy) {
			throw new Error(`${loc.language} is marked checked with no checkedBy`);
		}
	}
	if (CONSENT.status === "checked" && !CONSENT.reviewedBy) {
		throw new Error(`consent ${CONSENT.version} is marked checked with no reviewedBy`);
	}
}

/** A translated rating page may only name questions, options and flags the rubric has. */
function validatePage(loc: Localization, rubric: Rubric): void {
	const page = loc.page;
	if (!page) return;
	for (const [key, q] of Object.entries(page.questions ?? {})) {
		const question = rubric.questions.find((r) => r.key === key);
		if (!question) throw new Error(`${loc.language} translates question ${key}, which rubric ${rubric.version} does not have`);
		for (const value of Object.keys(q.options ?? {})) {
			if (!question.options.some((o) => String(o.value) === value)) {
				throw new Error(`${loc.language} translates option ${key}.${value}, which rubric ${rubric.version} does not have`);
			}
		}
	}
	for (const key of Object.keys(page.flags ?? {})) {
		if (!rubric.flags.some((f) => f.key === key)) throw new Error(`${loc.language} translates flag ${key}, which rubric ${rubric.version} does not have`);
	}
	if (page.consent && page.consent.consentVersion !== CONSENT.version) {
		throw new Error(`${loc.language} translates consent ${page.consent.consentVersion}, the current consent is ${CONSENT.version}`);
	}
	if (page.consent && page.consent.paragraphs.length !== CONSENT.paragraphs.length) {
		throw new Error(`${loc.language} consent has ${page.consent.paragraphs.length} paragraphs, consent ${CONSENT.version} has ${CONSENT.paragraphs.length}`);
	}
}

validateConfig();

export function getLanguage(id: string): EvalLanguage | undefined {
	return LANGUAGES.find((l) => l.id === id);
}

export function getLocalization(languageId: string): Localization | undefined {
	return LOCALIZATIONS.find((l) => l.language === languageId);
}

/**
 * A language is open once a speaker has checked its task set and the consent text has been reviewed.
 * Drafts of either stay closed. `includeDrafts` opens them on preview, where they are reviewed.
 */
export function isLanguageOpen(languageId: string, includeDrafts = false): boolean {
	const loc = getLocalization(languageId);
	if (!loc) return false;
	if (includeDrafts) return true;
	return loc.status === "checked" && CONSENT.status === "checked";
}

export function openLanguages(includeDrafts = false): EvalLanguage[] {
	return LANGUAGES.filter((l) => isLanguageOpen(l.id, includeDrafts));
}

export function getTask(taskId: string): TaskDef | undefined {
	return TASK_SET.tasks.find((t) => t.id === taskId);
}

/** The varieties a rater can declare for a language, "Other" last. Empty when the language asks for none. */
export function varietiesFor(languageId: string): Array<{ value: string; label: string }> {
	const listed = getLanguage(languageId)?.varieties ?? [];
	return listed.length ? [...listed, { value: OTHER_VARIETY, label: "Other" }] : [];
}

/** The rubric questions shown for a task. Safety questions only on safety-sensitive tasks. */
export function questionsFor(task: TaskDef, rubric: Rubric = RUBRIC): RubricQuestion[] {
	return rubric.questions.filter((q) => q.appliesTo === "all" || (q.appliesTo === "safety" && task.safety));
}

/** Fills `{language}` in rubric text with the language's display name. */
export function withLanguage(text: string, languageName: string): string {
	return text.replaceAll("{language}", languageName);
}

/** The name of the language as its speakers write it, for {language} in the page text. English name otherwise. */
export function displayName(languageId: string): string {
	return getLocalization(languageId)?.page?.languageName || getLanguage(languageId)?.name || languageId;
}

/**
 * The rubric questions for a task in the rater's language. A string the localization does not
 * translate stays in English, so a partly translated page still shows every question and option.
 */
export function localizedQuestions(task: TaskDef, languageId: string, rubric: Rubric = RUBRIC) {
	const page = getLocalization(languageId)?.page;
	const name = displayName(languageId);
	return questionsFor(task, rubric).map((q) => {
		const t = page?.questions?.[q.key];
		return {
			...q,
			label: withLanguage(t?.label ?? q.label, name),
			help: q.help ? withLanguage(t?.help ?? q.help, name) : undefined,
			example: q.example ? withLanguage(t?.example ?? q.example, name) : undefined,
			cantTellLabel: q.allowCantTell ? (t?.cantTell ?? q.cantTellLabel) : undefined,
			options: q.options.map((o) => ({ ...o, label: withLanguage(t?.options?.[String(o.value)] ?? o.label, name) })),
		};
	});
}

export function localizedFlags(languageId: string, rubric: Rubric = RUBRIC) {
	const page = getLocalization(languageId)?.page;
	const name = displayName(languageId);
	return rubric.flags.map((f) => ({ key: f.key, label: withLanguage(page?.flags?.[f.key] ?? f.label, name) }));
}

/** The consent text in the rater's language. The version stays the English file's: it is what was agreed to. */
export function localizedConsent(languageId: string) {
	const t = getLocalization(languageId)?.page?.consent;
	const name = displayName(languageId);
	return {
		version: CONSENT.version,
		title: t?.title ?? CONSENT.title,
		paragraphs: CONSENT.paragraphs.map((p, i) => withLanguage(t?.paragraphs[i] ?? p, name)),
		agree: t?.agree ?? CONSENT.agree,
	};
}

/** The credit to the work the rubric is adapted from, its text in the rater's language. Links are not translated. */
export function localizedCredit(languageId: string, rubric: Rubric = RUBRIC): Credit {
	const text = getLocalization(languageId)?.page?.credit;
	return { text: text ?? rubric.credit.text, links: rubric.credit.links };
}
