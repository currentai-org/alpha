import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { groundcheckAnswer } from "./groundcheck";

// LIVE: groundcheck end to end, the real detector and the real reviser on TASK_MODEL's lane, over three
// sets of answers under evals/data/ (CUR-2692).
//
//   groundcheck-real-answers.jsonl, set "fabrication": 24 real model answers to "list four European
//     open-weight projects with their country", each with the countries no source gives (`cut`).
//     The measure is how many of those countries groundcheck deletes.
//   groundcheck-real-answers.jsonl, set "known-good": 20 real grounded answers on ten everyday
//     questions. Every deletion groundcheck makes in one is printed and looked up in
//     groundcheck-deletion-verdicts.json; a wrong one fails the spec, and so does one nobody has
//     judged yet, which is how a new kind of deletion gets read rather than averaged away.
//   groundcheck-cases.json: one hand-written answer per guard, each the case a ticket was filed on
//     (CUR-2594, CUR-2680, CUR-2682, CUR-2688). Every `keep` sentence and [n] marker must survive.
//
// The reviser runs at temperature 0, so a second pass over the same answer mostly repeats the first:
// breadth comes from more answers. GROUNDCHECK_RUNS (default 1) repeats the whole set for the rare
// case where the detector or the gateway varies.
//
// Gated on GROUNDCHECK_URL, GROUNDCHECK_TOKEN and TASK_MODEL, set from the preview environment:
//   pnpm test:live src/lib/chat/server/groundcheck.live.spec.ts
// GROUNDCHECK_LIVE=0 skips it. live-vendor-tests.yml sets that on its vendor-contract step and runs this
// eval in its own step with its own alert, because a red here is the reviser's behaviour, not a
// vendor changing shape (CUR-2759).

// The test setup stubs $env/dynamic/private, so the app's config reads every key as empty and the
// detector call goes to a bare "/detect". Here config reads the environment Doppler injected, which is
// also what models.ts resolves TASK_MODEL's lane from.
vi.mock("$lib/chat/server/config", () => ({
	config: new Proxy({}, { get: (_t, k) => (typeof k === "string" ? process.env[k] : undefined) }),
}));

type Regression = {
	id: string;
	ticket: string;
	question: string;
	context: string[];
	answer: string;
	keep: string[];
	cut: string[];
	markers: string[];
};
type Real = {
	id: string;
	set: "fabrication" | "known-good";
	model: string;
	question: string;
	context: string[];
	answer: string;
	cut?: string[];
};

const env = (k: string) => (process.env[k] ?? "").trim();
const LIVE = env("GROUNDCHECK_LIVE") !== "0" && !!(env("GROUNDCHECK_URL") && env("GROUNDCHECK_TOKEN") && env("TASK_MODEL"));
const RUNS = Number(env("GROUNDCHECK_RUNS") || 1);
// The share of unsourced countries groundcheck must delete. Recall is traded for precision on purpose
// (groundcheck.ts header); this is the floor below which it no longer earns its latency.
const CUT_FLOOR = 0.5;

const data = (name: string) => fileURLToPath(new URL(`../../../../evals/data/${name}`, import.meta.url));
const regressions = (JSON.parse(readFileSync(data("groundcheck-cases.json"), "utf8")) as { cases: Regression[] })
	.cases;
const real = readFileSync(data("groundcheck-real-answers.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as Real);
const verdicts = (
	JSON.parse(readFileSync(data("groundcheck-deletion-verdicts.json"), "utf8")) as {
		verdicts: Record<string, { verdict: "correct" | "wrong"; why: string }>;
	}
).verdicts;

const wordList = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const words = (s: string) => wordList(s).join(" ");
const survives = (sentence: string, text: string) => ` ${words(text)} `.includes(` ${words(sentence)} `);
const occurrences = (needle: string, text: string) => text.split(needle).length - 1;

/** The runs of words `revised` dropped from `original`, in order; groundcheck only ever deletes. */
function deletions(original: string, revised: string): string[] {
	const o = wordList(original);
	const r = wordList(revised);
	const out: string[] = [];
	let run: string[] = [];
	let i = 0;
	for (const w of r) {
		while (i < o.length && o[i] !== w) run.push(o[i++]);
		if (run.length) out.push(run.join(" "));
		run = [];
		i++;
	}
	if (i < o.length) out.push(o.slice(i).join(" "));
	return out;
}

const GUARDS = ["rejected", "citation", "sourced", "fragment", "unrelated", "unmarked", "restored", "tail"];

async function check(c: { answer: string; context: string[]; question: string }) {
	let logged: Record<string, unknown> = {};
	let warned = "";
	const res = await groundcheckAnswer(
		{ answer: c.answer, context: c.context, question: c.question },
		{
			logger: {
				info: (o) => (logged = o as Record<string, unknown>),
				warn: (o) => (warned = JSON.stringify(o)),
			},
		}
	);
	const guards = GUARDS.filter((g) => Number(logged[g] ?? 0) > 0).map((g) => `${g}×${logged[g]}`);
	return { ...res, guards, warned };
}

describe.skipIf(!LIVE)("groundcheck on real and regression answers (live)", () => {
	it(
		"cuts unsourced countries, deletes nothing judged wrong, and keeps every regression case's true sentences",
		async () => {
			const broken: string[] = [];
			const lost: string[] = [];
			const wrong: string[] = [];
			const unjudged: string[] = [];
			const report: string[] = [`[groundcheck live] TASK_MODEL=${env("TASK_MODEL")} runs=${RUNS}`];
			let cutHit = 0;
			let cutTotal = 0;
			const outcomes: Record<string, Record<string, number>> = {};
			const tally = (set: string, outcome: string) => {
				outcomes[set] ??= {};
				outcomes[set][outcome] = (outcomes[set][outcome] ?? 0) + 1;
			};

			for (let r = 1; r <= RUNS; r++) {
				for (const c of real) {
					const res = await check(c);
					tally(c.set, res.outcome);
					if (res.outcome.endsWith("-failed")) {
						broken.push(`${c.id} run ${r}: ${res.outcome} ${res.warned}`);
						continue;
					}
					if (c.set === "fabrication") {
						const before = (c.cut ?? []).reduce((n, w) => n + occurrences(w, c.answer), 0);
						const after = (c.cut ?? []).reduce((n, w) => n + occurrences(w, res.text), 0);
						cutTotal += before;
						cutHit += before - after;
						report.push(
							`fabrication ${c.id.padEnd(16)} ${res.outcome.padEnd(8)} cut ${before - after}/${before}` +
								(res.guards.length ? `  ${res.guards.join(" ")}` : "") +
								(res.text !== c.answer ? `\n    ${JSON.stringify(res.text)}` : "")
						);
						continue;
					}
					const gone = res.outcome === "emptied" ? [words(c.answer)] : deletions(c.answer, res.text);
					for (const d of gone) {
						const v = verdicts[d];
						const line = `${c.id} run ${r}: "${d}"`;
						if (!v) unjudged.push(line);
						else if (v.verdict === "wrong") wrong.push(`${line} (${v.why})`);
					}
					report.push(
						`known-good  ${c.id.padEnd(40)} ${res.outcome.padEnd(8)} deleted ${gone.length}` +
							(res.guards.length ? `  ${res.guards.join(" ")}` : "")
					);
				}

				for (const c of regressions) {
					const res = await check(c);
					tally("regression", res.outcome);
					if (res.outcome.endsWith("-failed")) {
						broken.push(`${c.id} run ${r}: ${res.outcome} ${res.warned}`);
						continue;
					}
					const missing = [...c.keep, ...c.markers].filter((s) =>
						s.startsWith("[") ? !res.text.includes(s) : !survives(s, res.text)
					);
					for (const m of missing) lost.push(`${c.id} run ${r} (${res.outcome}) lost "${m}" → ${JSON.stringify(res.text)}`);
					const cut = c.cut.filter((p) => !survives(p, res.text)).length;
					cutTotal += c.cut.length;
					cutHit += cut;
					report.push(
						`regression  ${c.id.padEnd(36)} ${c.ticket.padEnd(9)} ${res.outcome.padEnd(8)} kept ${missing.length ? "NO" : "yes"}` +
							(c.cut.length ? `  cut ${cut}/${c.cut.length}` : "") +
							(res.guards.length ? `  ${res.guards.join(" ")}` : "")
					);
				}
			}

			report.push(`outcomes ${JSON.stringify(outcomes)}`);
			report.push(`unsourced claims cut ${cutHit}/${cutTotal}`);
			for (const [label, list] of [
				["LOST", lost],
				["WRONG DELETION", wrong],
				["UNJUDGED DELETION (add a verdict to groundcheck-deletion-verdicts.json)", unjudged],
				["BROKEN", broken],
			] as const)
				for (const l of list) report.push(`${label}: ${l}`);
			// Vitest drops a passing test's console output, so GROUNDCHECK_REPORT also writes it to a file.
			console.log(report.join("\n"));
			if (env("GROUNDCHECK_REPORT")) writeFileSync(env("GROUNDCHECK_REPORT"), report.join("\n") + "\n");

			// A run whose detector or reviser call failed returns the answer untouched, which passes every
			// keep and fails every cut for a reason that is not groundcheck's judgement. Name it first.
			expect(broken, "the detector or reviser call failed, so these runs measured nothing").toEqual([]);
			expect(lost, "a regression case lost a true sentence or [n] marker").toEqual([]);
			expect(wrong, "groundcheck deleted something true from a known-good answer").toEqual([]);
			expect(unjudged, "a deletion nobody has judged yet").toEqual([]);
			expect(cutHit, `unsourced claims cut on ${cutHit} of ${cutTotal}`).toBeGreaterThanOrEqual(
				Math.ceil(cutTotal * CUT_FLOOR)
			);
		},
		120_000 + (real.length + regressions.length) * RUNS * 12_000
	);
});
