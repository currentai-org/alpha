import { describe, it, expect } from "vitest";

import {
	LANGUAGES,
	RUBRIC,
	TASK_SET,
	getLocalization,
	getTask,
	isLanguageOpen,
	questionsFor,
	validateConfig,
	varietiesFor,
	withLanguage,
} from "./config";
import { validateRating, CANT_TELL } from "./validateRating";
import { pickNext, type Candidate } from "./nextItem";
import { assessRating, minimumDurationMs, passesCheck, wordCount } from "./quality";
import { aggregateCell, baselineDelta, disagrees, THRESHOLDS, wilson } from "./aggregate";
import type { RatingRow, ScoreValue } from "./types";

const plainTask = getTask("t05-letter")!;
const safetyTask = getTask("t12-fever")!;

const fullScores = { task: 4, accuracy: 3, language: 5, usable: "small_edits" };

describe("config", () => {
	it("loads and is internally consistent", () => {
		expect(() => validateConfig()).not.toThrow();
	});

	it("covers the 26 launch languages from the A2 epic, plus pt-PT and es-ES as their own entries, with English as the one baseline", () => {
		expect(LANGUAGES).toHaveLength(28);
		expect(LANGUAGES.filter((l) => l.id.includes("-")).map((l) => l.id).sort()).toEqual(["por-PT", "spa-ES"]);
		expect(LANGUAGES.filter((l) => l.baseline).map((l) => l.id)).toEqual(["eng"]);
	});

	it("keeps a draft task set closed: a language opens only once a speaker has checked it", () => {
		expect(isLanguageOpen("spa")).toBe(false);
		expect(isLanguageOpen("spa", true)).toBe(true);
		// A language with no task set file at all stays closed, drafts included.
		expect(isLanguageOpen("xxx", true)).toBe(false);
	});

	it("has a task set, at least a draft, for every launch language, so none is closed in the picker on preview", () => {
		expect(LANGUAGES.filter((l) => !getLocalization(l.id)).map((l) => l.id)).toEqual([]);
	});

	it("leaves the translation task out of English, the source language", () => {
		expect(getLocalization("eng")!.items["t11-translate"].notApplicable).toBe(true);
		expect(getLocalization("fra")!.items["t11-translate"].prompt).toBeTruthy();
	});

	it("asks the safety questions only on safety-sensitive tasks", () => {
		expect(questionsFor(plainTask).map((q) => q.key)).toEqual(["task", "accuracy", "language", "usable"]);
		expect(questionsFor(safetyTask).map((q) => q.key)).toContain("safety");
	});

	it("refuses a localization marked checked with nobody recorded as the checker", () => {
		const bad = { ...getLocalization("fra")!, status: "checked" as const, checkedBy: undefined };
		expect(() => validateConfig(undefined, undefined, undefined, [bad])).toThrow("no checkedBy");
	});

	it("refuses a rubric with no credit to the work it is adapted from", () => {
		const { credit: _credit, ...noCredit } = RUBRIC;
		expect(() => validateConfig(undefined, noCredit as typeof RUBRIC)).toThrow("no credit");
		expect(RUBRIC.credit.text).toContain("Roya Pakzad");
		expect(RUBRIC.credit.links.map((l) => l.url)).toContain(
			"https://github.com/royapakzad/multilingual-ai-safety-evaluation"
		);
	});

	it("refuses a multi-step task: none can be rated yet", () => {
		const multi = { ...TASK_SET, tasks: [{ ...TASK_SET.tasks[0], mode: "multi_step" }] } as unknown as typeof TASK_SET;
		expect(() => validateConfig(undefined, undefined, multi, [])).toThrow("only single_turn");
	});

	it("offers 'Other' after the listed varieties, and asks nothing where none are listed", () => {
		const por = varietiesFor("por-PT").map((v) => v.value);
		expect(por).toEqual(["pt-PT", "pt-AO", "pt-MZ", "other"]);
		expect(varietiesFor("pol")).toEqual([]);
	});

	it("refuses a variety list with a duplicate, or one that claims the reserved 'other'", () => {
		const fra = LANGUAGES.find((l) => l.id === "fra")!;
		const dup = { ...fra, varieties: [...fra.varieties!, fra.varieties![0]] };
		const other = { ...fra, varieties: [{ value: "other", label: "Other" }] };
		const rest = LANGUAGES.filter((l) => l.id !== "fra");
		expect(() => validateConfig([...rest, dup])).toThrow("twice");
		expect(() => validateConfig([...rest, other])).toThrow("invalid variety");
	});

	it("names the language in rubric text", () => {
		expect(withLanguage(RUBRIC.questions[2].label, "Portuguese")).toContain("natural Portuguese");
		expect(TASK_SET.tasks).toHaveLength(12);
	});
});

describe("validateRating", () => {
	const base = { modelRunId: "r1", flags: [], durationMs: 30_000 };

	it("accepts a complete rating", () => {
		const r = validateRating(plainTask, RUBRIC, { ...base, scores: fullScores });
		expect(r.ok).toBe(true);
	});

	it("refuses a rating with a question missing and names the question", () => {
		const r = validateRating(plainTask, RUBRIC, { ...base, scores: { task: 4, language: 5, usable: "no" } });
		expect(r).toEqual({ ok: false, missing: ["accuracy"], invalid: [] });
	});

	it("requires the safety questions on a safety task", () => {
		const r = validateRating(safetyTask, RUBRIC, { ...base, scores: fullScores });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.missing).toEqual(["safety", "refusal"]);
	});

	it("refuses safety answers on a task that does not ask them", () => {
		const r = validateRating(plainTask, RUBRIC, { ...base, scores: { ...fullScores, safety: "safe" } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.invalid).toContain("safety");
	});

	it("allows 'can't tell' only where the question offers it", () => {
		expect(validateRating(plainTask, RUBRIC, { ...base, scores: { ...fullScores, accuracy: CANT_TELL } }).ok).toBe(true);
		expect(validateRating(plainTask, RUBRIC, { ...base, scores: { ...fullScores, language: CANT_TELL } }).ok).toBe(false);
	});

	it("refuses values outside the scale", () => {
		expect(validateRating(plainTask, RUBRIC, { ...base, scores: { ...fullScores, task: 6 } }).ok).toBe(false);
	});

	it("lets 'the request is badly written' through with no scores, stored as excluded", () => {
		const r = validateRating(plainTask, RUBRIC, { ...base, scores: {}, flags: ["task_badly_written"] });
		expect(r.ok && r.excluded).toBe(true);
	});
});

describe("pickNext", () => {
	const c = (runId: string, modelId: string, taskId: string, validRatings: number, isCheck = false): Candidate => ({
		runId,
		modelId,
		taskId,
		validRatings,
		isCheck,
	});
	const first = () => 0;

	it("returns the least rated answer the person has not rated", () => {
		const next = pickNext({
			candidates: [c("a", "m1", "t1", 3), c("b", "m2", "t2", 1), c("c", "m3", "t3", 0)],
			ratedRunIds: new Set(["c"]),
			ratingsSoFar: 1,
			random: first,
		});
		expect(next?.runId).toBe("b");
	});

	it("never repeats the last task when another is available", () => {
		const next = pickNext({
			candidates: [c("a", "m1", "t1", 0), c("b", "m2", "t2", 5)],
			ratedRunIds: new Set(),
			lastTaskId: "t1",
			ratingsSoFar: 3,
			random: first,
		});
		expect(next?.runId).toBe("b");
	});

	it("breaks ties towards the model with fewer ratings in the language", () => {
		const next = pickNext({
			candidates: [c("a", "m1", "t1", 0), c("b", "m2", "t1", 0), c("x", "m1", "t2", 9)],
			ratedRunIds: new Set(["x"]),
			ratingsSoFar: 2,
			random: first,
		});
		expect(next?.runId).toBe("b");
	});

	it("serves a check item on every tenth rating, and never counts it as regular", () => {
		const cands = [c("a", "m1", "t1", 0), c("chk", "m1", "t1", 0, true)];
		expect(pickNext({ candidates: cands, ratedRunIds: new Set(), ratingsSoFar: 9, random: first })?.runId).toBe("chk");
		expect(pickNext({ candidates: cands, ratedRunIds: new Set(), ratingsSoFar: 3, random: first })?.runId).toBe("a");
	});

	it("returns null when the person has rated everything", () => {
		expect(pickNext({ candidates: [c("a", "m1", "t1", 0)], ratedRunIds: new Set(["a"]), ratingsSoFar: 1 })).toBeNull();
	});
});

describe("quality", () => {
	const prompt = "word ".repeat(40);
	const answer = "word ".repeat(160);
	const input = {
		prompt,
		answer,
		durationMs: 60_000,
		scores: fullScores as Record<string, ScoreValue>,
		excluded: false,
		isCheck: false,
		previous: [],
		failedChecks: 0,
	};

	it("counts characters in scripts without spaces", () => {
		expect(wordCount("我的米饭总是粘锅")).toBe(4);
	});

	it("keeps a normally paced rating", () => {
		expect(assessRating(input).validity).toBe("valid");
	});

	it("quarantines a rating submitted faster than the answer can be read", () => {
		expect(minimumDurationMs(prompt, answer)).toBe(16_000);
		expect(assessRating({ ...input, durationMs: 5_000 })).toMatchObject({ validity: "quarantined", reasons: ["too_fast"] });
	});

	it("quarantines the fifth identical rating in a row", () => {
		const previous = Array.from({ length: 4 }, () => ({ scores: fullScores as Record<string, ScoreValue> }));
		expect(assessRating({ ...input, previous }).reasons).toContain("identical_run");
	});

	it("reads a check item as passed only when the wrong-language answer is rated low on language", () => {
		expect(passesCheck({ language: 1 }, [])).toBe(true);
		expect(passesCheck({ language: 5 }, ["not_in_language"])).toBe(true);
		expect(passesCheck({ language: 5 }, [])).toBe(false);
	});

	it("never counts a check item, and quarantines after a second failed check", () => {
		const r = assessRating({ ...input, isCheck: true, scores: { ...fullScores, language: 5 } });
		expect(r).toMatchObject({ validity: "excluded", failedCheck: true });
		expect(assessRating({ ...input, failedChecks: 2 }).reasons).toContain("failed_checks");
	});
});

describe("aggregate", () => {
	let n = 0;
	const row = (over: Partial<RatingRow>): RatingRow => ({
		raterId: "u1",
		modelRunId: `run${n++}`,
		modelId: "m1",
		language: "por",
		taskId: "t01-rice",
		declaredLevel: "native",
		rubricVersion: "r1",
		taskSetVersion: "v1",
		scores: fullScores,
		validity: "valid",
		...over,
	});
	const tasks = TASK_SET.tasks.map((t) => t.id);
	const fullCell = (language: string, usable: string) =>
		Array.from({ length: 30 }, (_, i) =>
			row({
				language,
				raterId: `u${i % 3}`,
				taskId: tasks[i % 10],
				modelRunId: `${language}-${tasks[i % 10]}`,
				scores: { ...fullScores, usable },
			})
		);

	it("Wilson interval is honest at small n", () => {
		const w = wilson(3, 3);
		expect(w.share).toBe(1);
		expect(w.low).toBeLessThan(0.5);
	});

	it("reads 'none' with no ratings, never a zero", () => {
		expect(aggregateCell("m1", "por", []).status).toBe("none");
	});

	it("stays 'insufficient' below the thresholds, however good the ratings", () => {
		const rows = Array.from({ length: THRESHOLDS.minRatings }, () => row({}));
		expect(aggregateCell("m1", "por", rows).status).toBe("insufficient");
	});

	it("shows a result with enough ratings, raters and tasks", () => {
		const cell = aggregateCell("m1", "por", fullCell("por", "as_is"));
		expect(cell.status).toBe("shown");
		expect(cell.usable?.share).toBe(1);
	});

	it("leaves out quarantined, excluded and working-knowledge ratings", () => {
		const rows = [row({ validity: "quarantined" }), row({ validity: "excluded" }), row({ declaredLevel: "working" })];
		expect(aggregateCell("m1", "por", rows).nRatings).toBe(0);
	});

	it("never mixes in ratings made under another rubric or task set version", () => {
		const rows = [row({ rubricVersion: "r0" }), row({ taskSetVersion: "v0" }), row({})];
		expect(aggregateCell("m1", "por", rows).nRatings).toBe(1);
	});

	it("keeps 'can't tell' out of the accuracy mean but in the count", () => {
		const rows = [row({ scores: { ...fullScores, accuracy: 4 } }), row({ scores: { ...fullScores, accuracy: CANT_TELL } })];
		const acc = aggregateCell("m1", "por", rows).scales.accuracy;
		expect(acc.mean).toBe(4);
		expect(acc.n).toBe(2);
		expect(acc.distribution[CANT_TELL]).toBe(1);
	});

	it("counts one answer rated by two people once in nAnswers and twice in nRatings", () => {
		const rows = [row({ modelRunId: "same", raterId: "a" }), row({ modelRunId: "same", raterId: "b" })];
		const cell = aggregateCell("m1", "por", rows);
		expect([cell.nAnswers, cell.nRatings, cell.nRaters]).toEqual([1, 2, 2]);
	});

	it("flags disagreement when one rater would use an answer and another would not", () => {
		expect(disagrees([{ usable: "as_is" }, { usable: "no" }])).toBe(true);
		expect(disagrees([{ task: 3 }, { task: 4 }])).toBe(false);
		expect(disagrees([{ task: 2 }, { task: 5 }])).toBe(true);
	});

	it("computes the English delta only when both cells are shown", () => {
		const rows = [...fullCell("por", "no"), ...fullCell("eng", "as_is")];
		expect(baselineDelta("m1", "por", "eng", rows)?.usableShareDelta).toBe(-1);
		expect(baselineDelta("m1", "por", "eng", fullCell("por", "no"))).toBeNull();
	});
});
