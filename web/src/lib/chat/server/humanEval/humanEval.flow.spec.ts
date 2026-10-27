// The human evaluation flow against a real Postgres, through the route handlers: stored answers are
// imported with the real script, three people declare a level, go through calibration, rate every
// answer they are served, and the results are read back. Stateful: listed in vite.config.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("$lib/chat/server/humanEval/gate", () => ({
	humanEvalEnabled: () => true,
	// French is a draft localization; preview opens drafts.
	includeDraftLanguages: () => true,
}));

import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { ratingRowsFor } from "$lib/chat/server/db/humanEval";
import { createTestUser, cleanupTestData } from "$lib/chat/server/api/__tests__/testHelpers";
import { TASK_SET, getLocalization } from "./config";
import { aggregateCell } from "./aggregate";
import { submitRating } from "./service";
import { GET as nextGET } from "../../../../routes/chat/api/eval/next/+server";
import { POST as profilePOST } from "../../../../routes/chat/api/eval/profile/+server";
import { POST as ratingsPOST } from "../../../../routes/chat/api/eval/ratings/+server";
import { GET as resultsGET } from "../../../../routes/chat/api/eval/results/+server";

const MODEL = "test/flow-model";
const dir = mkdtempSync(join(tmpdir(), "heval-"));
let generation = 0;

/** Writes one generation of answers for French (every task) plus two check items, and imports it. */
function importGeneration(): string[] {
	generation++;
	const fra = getLocalization("fra")!;
	const rows = TASK_SET.tasks.map((t) => ({
		id: `flow-g${generation}-${t.id}`,
		taskSetVersion: TASK_SET.version,
		taskId: t.id,
		language: "fra",
		modelId: MODEL,
		prompt: fra.items[t.id].prompt,
		response: `Réponse ${generation} à ${t.id}.`,
		current: true,
		isCheck: false,
	}));
	const checks = ["t01-rice", "t02-interview"].map((taskId) => ({
		...rows.find((r) => r.taskId === taskId)!,
		id: `flow-g${generation}-check-${taskId}`,
		response: "My rice always burns. Here are five tips in English.",
		isCheck: true,
		checkSourceLanguage: "eng",
	}));
	const file = join(dir, `g${generation}.jsonl`);
	writeFileSync(file, [...rows, ...checks].map((r) => JSON.stringify(r)).join("\n"));
	execFileSync("node", ["scripts/import-eval-runs.mjs", file], { env: process.env });
	return [...rows, ...checks].map((r) => r.id);
}

const call = (handler: (e: never) => unknown, userId: string, init: { url: string; body?: unknown }) =>
	handler({
		url: new URL(init.url, "http://localhost"),
		locals: { user: { _id: userId } },
		request: new Request(new URL(init.url, "http://localhost"), {
			method: init.body ? "POST" : "GET",
			body: init.body ? JSON.stringify(init.body) : undefined,
		}),
	} as never) as Promise<Response>;

// Scores vary from one rating to the next like a real rater's: five identical ratings in a row are
// quarantined (quality.ts).
let nth = 0;
const ratingFor = (item: { runId: string; questions: Array<{ key: string }> }, language = 5) => ({
	modelRunId: item.runId,
	scores: Object.fromEntries(
		item.questions.map((q) => [
			q.key,
			q.key === "usable" ? "as_is" : q.key === "safety" ? "safe" : q.key === "refusal" ? "no" : q.key === "language" ? language : 3 + (nth++ % 3),
		])
	),
	flags: [],
	durationMs: 120_000,
});

const users: string[] = [];

beforeAll(async () => {
	for (let i = 0; i < 4; i++) users.push((await createTestUser()).user._id.toString());
	importGeneration();
});

afterAll(async () => {
	const db = getDb();
	await db.delete(schema.humanEvalRatings).where(inArray(schema.humanEvalRatings.userId, users));
	await db.delete(schema.humanEvalProfiles).where(inArray(schema.humanEvalProfiles.userId, users));
	await db.delete(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, MODEL));
	await cleanupTestData();
});

describe("human evaluation flow", () => {
	it("asks for a profile, then the calibration example, then answers to rate", async () => {
		const uid = users[0];
		const first = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=fra" })).json();
		expect(first).toMatchObject({ kind: "needs_profile", consent: { version: "c1" } });
		// French is checked and carries its own consent translation, with {language} filled in.
		expect(first.consent.paragraphs[0]).toContain("rédigées en français");
		const noConsent = await call(profilePOST, uid, { url: "/p", body: { language: "fra", level: "native" } }).catch((e) => e);
		expect(noConsent.status).toBe(400);

		const badVariety = await call(profilePOST, uid, {
			url: "/p",
			body: { language: "fra", level: "native", variety: "pt-BR", consent: true },
		}).catch((e) => e);
		expect(badVariety.status).toBe(400);
		await call(profilePOST, uid, { url: "/p", body: { language: "fra", level: "native", variety: "other", consent: true } });
		const calibration = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=fra" })).json();
		expect(calibration.kind).toBe("calibration");
		expect(calibration.credit.text).toContain("Roya Pakzad");

		await call(profilePOST, uid, { url: "/p", body: { language: "fra", level: "native", consent: true, calibrationDone: true } });
		const item = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=fra" })).json();
		expect(item.kind).toBe("rate");
		expect(item).not.toHaveProperty("modelId");
		expect(JSON.stringify(item)).not.toContain(MODEL);
	});

	it("refuses an incomplete rating naming the question, and a second rating of the same answer", async () => {
		const uid = users[0];
		const item = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=fra" })).json();
		const partial = ratingFor(item);
		delete (partial.scores as Record<string, unknown>).accuracy;
		const refused = await call(ratingsPOST, uid, { url: "/r", body: partial });
		expect(refused.status).toBe(400);
		expect((await refused.json()).missing).toEqual(["accuracy"]);

		expect((await call(ratingsPOST, uid, { url: "/r", body: ratingFor(item) })).status).toBe(200);
		expect((await call(ratingsPOST, uid, { url: "/r", body: ratingFor(item) })).status).toBe(409);
	});

	it("serves every answer once, a check item tenth, and shows a result once three people have rated", async () => {
		for (const [i, uid] of users.slice(0, 3).entries()) {
			if (i > 0) {
				await call(profilePOST, uid, { url: "/p", body: { language: "fra", level: "fluent", consent: true, calibrationDone: true } });
			}
			for (;;) {
				const item = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=fra" })).json();
				if (item.kind === "done") break;
				expect(item.kind).toBe("rate");
				// Read the check item as a careful rater would: not French.
				const isCheck = item.answer.includes("in English");
				expect((await call(ratingsPOST, uid, { url: "/r", body: ratingFor(item, isCheck ? 1 : 5) })).status).toBe(200);
			}
		}
		for (const uid of users.slice(0, 3)) {
			const mine = (
				await getDb()
					.select({ runId: schema.humanEvalRatings.runId })
					.from(schema.humanEvalRatings)
					.where(eq(schema.humanEvalRatings.userId, uid))
					.orderBy(schema.humanEvalRatings.createdAt)
			).map((r) => r.runId);
			expect(new Set(mine).size).toBe(mine.length);
			expect(mine[9]).toContain("-check-");
			expect(mine.filter((id) => !id.includes("-check-"))).toHaveLength(TASK_SET.tasks.length);
		}

		const cell = aggregateCell(MODEL, "fra", await ratingRowsFor("fra"));
		expect(cell).toMatchObject({ status: "shown", nRatings: 36, nRaters: 3, nTasks: 12 });
		expect(cell.usable).toMatchObject({ share: 1, n: 36 });

		// The evaluation page reads the same result through the results route, signed out.
		const results = await (await resultsGET({ url: new URL("http://localhost/chat/api/eval/results?language=fra") } as never)).json();
		const mine = results.models.find((m: { modelId: string }) => m.modelId === MODEL);
		expect(mine).toMatchObject({ status: "shown", nRatings: 36, nRaters: 3, nTasks: 12, usable: { share: 1, n: 36 } });
		expect(mine.means.language).toBe(5);
	});

	it("quarantines everything a person rated once they fail a second check item", async () => {
		const uid = users[3];
		await call(profilePOST, uid, { url: "/p", body: { language: "fra", level: "native", consent: true, calibrationDone: true } });
		const item = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=fra" })).json();
		await call(ratingsPOST, uid, { url: "/r", body: ratingFor(item) });

		const checks = ["flow-g1-check-t01-rice", "flow-g1-check-t02-interview"];
		for (const runId of checks) {
			const r = await submitRating(uid, { ...ratingFor({ runId, questions: [{ key: "task" }, { key: "accuracy" }, { key: "language" }, { key: "usable" }] }, 5) });
			expect(r).toEqual({ ok: true });
		}
		const rows = await getDb().select().from(schema.humanEvalRatings).where(eq(schema.humanEvalRatings.userId, uid));
		expect(rows.find((r) => r.runId === item.runId)?.validity).toBe("quarantined");
		expect(rows.filter((r) => checks.includes(r.runId)).every((r) => r.validity === "excluded")).toBe(true);
	});

	it("stops counting ratings on answers a new generation replaced", async () => {
		const ids = importGeneration();
		const current = await getDb().select().from(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, MODEL));
		expect(current.filter((r) => r.current).map((r) => r.id).sort()).toEqual([...ids].sort());
		expect(aggregateCell(MODEL, "fra", await ratingRowsFor("fra")).status).toBe("none");
	});
});

// The languages imported from the speaker review (scripts/import-language-review.mjs): the page text
// a rater sees comes from the reviewed file, and Urdu goes through right to left.
describe("human evaluation flow in the reviewed languages", () => {
	const REVIEWED_MODEL = "test/flow-model-reviewed";
	const raters: Record<string, string> = {};

	beforeAll(async () => {
		const rows = ["ita", "urd", "por"].flatMap((language) =>
			TASK_SET.tasks.map((t) => ({
				id: `flow-rev-${language}-${t.id}`,
				taskSetVersion: TASK_SET.version,
				taskId: t.id,
				language,
				modelId: REVIEWED_MODEL,
				prompt: getLocalization(language)!.items[t.id].prompt,
				response: language === "urd" ? `جواب ${t.id}` : `Risposta ${t.id}.`,
				current: true,
				isCheck: false,
			}))
		);
		const file = join(dir, "reviewed.jsonl");
		writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
		execFileSync("node", ["scripts/import-eval-runs.mjs", file], { env: process.env });
		for (const language of ["ita", "urd", "por"]) {
			raters[language] = (await createTestUser()).user._id.toString();
			users.push(raters[language]);
		}
	});

	afterAll(async () => {
		await getDb().delete(schema.humanEvalRatings).where(eq(schema.humanEvalRatings.modelId, REVIEWED_MODEL));
		await getDb().delete(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, REVIEWED_MODEL));
	});

	it("serves consent, worked example and questions in Italian, as the reviewer corrected them", async () => {
		const uid = raters.ita;
		const first = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=ita" })).json();
		expect(first.consent.version).toBe("c1");
		expect(first.consent.paragraphs[0]).toBe(getLocalization("ita")!.page!.consent!.paragraphs[0]);

		await call(profilePOST, uid, { url: "/p", body: { language: "ita", level: "native", variety: "it-IT", consent: true } });
		const calibration = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=ita" })).json();
		expect(calibration.kind).toBe("calibration");
		expect(calibration.prompt).toBe(getLocalization("ita")!.items["t05-letter"].prompt);
		expect(calibration.explanation).toMatch(/^L'italiano va bene/);
		expect(calibration.questions[0].label).toBe("La risposta soddisfa la richiesta?");
		expect(calibration.credit.text).toContain("Roya Pakzad");

		await call(profilePOST, uid, { url: "/p", body: { language: "ita", level: "native", consent: true, calibrationDone: true } });
		const item = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=ita" })).json();
		expect(item.kind).toBe("rate");
		expect(item.dir).toBe("ltr");
		expect(item.reference).toEqual([
			...(getLocalization("ita")!.items[item.runId.replace("flow-rev-ita-", "")].reference ?? []),
			...(getLocalization("ita")!.items[item.runId.replace("flow-rev-ita-", "")].errors ?? []),
		]);
		expect((await call(ratingsPOST, uid, { url: "/r", body: ratingFor(item) })).status).toBe(200);

		const [stored] = await getDb().select().from(schema.humanEvalRatings).where(eq(schema.humanEvalRatings.userId, uid));
		expect(stored).toMatchObject({ language: "ita", modelId: REVIEWED_MODEL, runId: item.runId, validity: "valid", taskSetVersion: "v1" });
	});

	it("serves Urdu right to left and keeps its text intact through the database", async () => {
		const uid = raters.urd;
		await call(profilePOST, uid, { url: "/p", body: { language: "urd", level: "native", variety: "ur-PK", consent: true, calibrationDone: true } });
		const item = await (await call(nextGET, uid, { url: "/chat/api/eval/next?language=urd" })).json();
		expect(item.kind).toBe("rate");
		expect(item.dir).toBe("rtl");
		const taskId = item.runId.replace("flow-rev-urd-", "");
		expect(item.prompt).toBe(getLocalization("urd")!.items[taskId].prompt);
		expect(item.answer).toBe(`جواب ${taskId}`);
	});

	it("importing the same answers file again changes nothing", async () => {
		const before = await getDb().select().from(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, REVIEWED_MODEL));
		execFileSync("node", ["scripts/import-eval-runs.mjs", join(dir, "reviewed.jsonl")], { env: process.env });
		const after = await getDb().select().from(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, REVIEWED_MODEL));
		expect(after.map((r) => [r.id, r.current]).sort()).toEqual(before.map((r) => [r.id, r.current]).sort());
		expect(after.filter((r) => r.current)).toHaveLength(3 * TASK_SET.tasks.length);
	});

	it("retires a stored answer the file now carries as not current, and sets it back to current when a later file carries it as current", async () => {
		const file = join(dir, "reviewed.jsonl");
		const rows = readFileSync(file, "utf8").split("\n").map((l) => JSON.parse(l));
		// A model that has left the registry for Portuguese: the nightly export keeps its answers, not current.
		const retiredFile = join(dir, "retired.jsonl");
		const retire = (r: { language: string; response: string }) =>
			r.language === "por" ? { ...r, current: false, response: "a different text that must not land" } : r;
		writeFileSync(retiredFile, rows.map((r) => JSON.stringify(retire(r))).join("\n"));
		const out = execFileSync("node", ["scripts/import-eval-runs.mjs", retiredFile], { env: process.env, encoding: "utf8" });
		expect(out).toContain(`${TASK_SET.tasks.length} retired`);
		const stored = await getDb().select().from(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, REVIEWED_MODEL));
		const por = stored.filter((r) => r.language === "por");
		expect(por).toHaveLength(TASK_SET.tasks.length);
		expect(por.every((r) => !r.current && r.response.startsWith("Risposta"))).toBe(true);
		expect(stored.filter((r) => r.current)).toHaveLength(2 * TASK_SET.tasks.length);

		// Twice is the same as once, and the original file, which carries the answers as current, sets them back.
		execFileSync("node", ["scripts/import-eval-runs.mjs", retiredFile], { env: process.env });
		const again = await getDb().select().from(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, REVIEWED_MODEL));
		expect(again.map((r) => [r.id, r.current, r.response]).sort()).toEqual(stored.map((r) => [r.id, r.current, r.response]).sort());
		const back = execFileSync("node", ["scripts/import-eval-runs.mjs", file], { env: process.env, encoding: "utf8" });
		expect(back).toContain(`${TASK_SET.tasks.length} set back to current`);
		const restored = await getDb().select().from(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.modelId, REVIEWED_MODEL));
		expect(restored.filter((r) => r.current)).toHaveLength(3 * TASK_SET.tasks.length);
		expect(restored.filter((r) => r.language === "por").every((r) => r.response.startsWith("Risposta"))).toBe(true);
	});

	it("one rater in a language gives counts, never a shown result", async () => {
		const cell = aggregateCell(REVIEWED_MODEL, "ita", await ratingRowsFor("ita"));
		expect(cell.status).not.toBe("shown");
		expect(cell.nRatings).toBe(1);
	});

	it("the results route gives counts below the thresholds and withholds every share and mean", async () => {
		const results = await (await resultsGET({ url: new URL("http://localhost/chat/api/eval/results?language=ita") } as never)).json();
		const mine = results.models.find((m: { modelId: string }) => m.modelId === REVIEWED_MODEL);
		expect(mine).toEqual({
			modelId: REVIEWED_MODEL,
			name: REVIEWED_MODEL,
			status: "insufficient",
			nRatings: 1,
			nRaters: 1,
			nTasks: 1,
			usable: null,
			means: null,
		});
	});
});
