// LIVE probe: does the served model actually COMPLY with behaviors whose only other coverage is
// "the instruction text is in the prompt" (persona.spec.ts's toContain checks prove that, not that
// the model complies)? Generates a real answer per behavior against the production persona, then
// grades it with llmJudge + createHfJudgeClient, a judge model (DEFAULT_JUDGE_MODEL, see
// hfJudgeClient.ts) that is never the model under test.
//
// Covers A6/A15/A20 plus the commitment-battery gaps that are not covered elsewhere
// (evals/mini/slice.json's canary) and not blocked on an external prerequisite (M8 needs a
// reasoning-model-architecture decision; S1/S4 need clinical review, so neither is touched here):
//   - S5 (abstains when it lacks a basis). sourceGuard.ts only strips the GROUNDED "fake Sources:
//     list" pattern; nothing else covers ungrounded confabulation on an invented term.
//   - P11/P13 (privacy: what deletion removes, retention period, third parties). Grades the chat's
//     OWN answer against the real GDPR wipe backend (wipeUserData.ts) and the real /privacy-notice
//     Payload page, not an invented policy.
//
//   - E1 (no unprompted next-action). Measures whether sign-off/listicle drift is real, without
//     touching the persona.
//
//   - D1 (no identity/capability disclaimer on a non-identity task, CUR-1437), e.g. a request to
//     improve a thank-you email opening "I don't have feelings or personal opinions" unasked.
//     Distinct from W1 (which bans a willingness/ability opener): this bans an identity/capability
//     opener, a different move the other rubrics don't name.
//
// Infra self-description is not graded here: it is a static string in `servingClause()`
// (persona.ts), pinned by a regression assertion in persona.spec.ts, so no judge is needed.
//
// OPT-IN ONLY — run explicitly with `JUDGE_LIVE=1` (mirrors urlGuard.live's URL_GUARD_LIVE gate and
// endpointAgent.live's AGENT_LIVE gate). It is a *.live.spec.ts, which `server-fast` EXCLUDES and
// only the `server-live` project includes, so the project flag is not optional — without it vitest
// matches no project and exits 1 with "No test files found", which reads like a path typo:
//
//   JUDGE_LIVE=1 VITEST_LIVE=1 npx vitest run --project=server-live \
//     src/routes/chat/admin/tuning/mini-eval/judgeBehaviors.live.spec.ts
//
// JUDGE_BEHAVIOR_LIVE=0 skips the POSITIVE half, the one that grades the model (CUR-2759). Unset, it runs.
// live-vendor-tests.yml sets 0 on its vendor-contract step and runs this half in a step of its own with
// its own alert, so a model that misbehaves and a vendor that changed shape do not read as the same red.
//
// Faithful: imports the production persona builder and the production judge client (no
// reproduction). Refuses to run on anything but the checkpoint a default turn is actually served —
// see evals/gradedCheckpoint.ts for why that is an identity check and not a size check.
import { describe, it, expect } from "vitest";
import { buildPersonaPrompt, resolveDecoding } from "$lib/chat/server/textGeneration/persona";
import { fetchRetryOnce } from "$lib/chat/server/fetchRetryOnce";
import { llmJudge } from "../../../../../../evals/judge/llmJudge";
import { createHfJudgeClient } from "../../../../../../evals/judge/hfJudgeClient";
import { GRADED_CHECKPOINT, isGradedCheckpoint, pickGradedModel } from "../../../../../../evals/gradedCheckpoint";
// The cases and their known-bad fixtures live in behaviors.ts so evals/behavior-repeat.ts grades
// against this exact rubric text rather than a copy of it.
import { BEHAVIORS, KNOWN_BAD } from "./behaviors";

const LIVE = process.env.JUDGE_LIVE === "1";
const BEHAVIOR_LIVE = process.env.JUDGE_BEHAVIOR_LIVE !== "0";
const BASE = process.env.OPENAI_BASE_URL;
const KEY = process.env.OPENAI_API_KEY;
const MODEL = pickGradedModel(process.env.MODEL_ALLOWLIST);

// THE JUDGE NEEDS ITS OWN HOST. createHfJudgeClient({ modelUnderTest }) with no creds falls back to
// OPENAI_BASE_URL, the endpoint serving the model under test. That works on the HF router, where the judge
// model also lives, and fails on a branch pointed at a research cluster: CSCS serves Apertus and nothing
// else, so every judge call returns HTTP 503 "No provider found for the requested service". The error
// names the router, not the misrouting, so it reads like the judge model was deprecated. This uses the
// JUDGE_BASE_URL/JUDGE_API_KEY pair every evals/ harness uses, and falls back to the primary endpoint so
// an HF-router run needs no extra env.
const JUDGE_CREDS = {
	baseURL: process.env.JUDGE_BASE_URL || BASE,
	apiKey: process.env.JUDGE_API_KEY || KEY,
};


// Mirrors $lib/chat/server/endpoints/openai/endpointOai.ts's X-HF-Bill-To handling: an org-scoped token
// is attributed to the token owner's PERSONAL namespace unless this header routes it to the org
// instead (the org namespace is where the Inference Providers permission is actually granted).
const BILL_TO = process.env.HF_BILL_TO;

async function ask(system: string, prompt: string): Promise<string> {
	// A 504 from the gateway is transient, not a broken contract — retried once before
	// this hard-fails, same as urlGuard.live.spec.ts's own ask(). (CUR-1303)
	const r = await fetchRetryOnce(
		() =>
			fetch(`${BASE}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${KEY}`,
					...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
				},
				body: JSON.stringify({
					model: MODEL,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: prompt },
					],
					// NOT temperature: 0. Must send exactly what production sends (resolveDecoding(), temp 0.1).
					// A pinned temperature (evals/checkpoint-compare's 0.7 is pinned for cross-model comparability,
					// see this file's header note) would grade a cell nobody ships. The decoding sweep was run at
					// the production temperature (see persona.ts's GROUNDED_DECODING comment) (CUR-702).
					...resolveDecoding(),
				}),
			}),
		{ retryableStatuses: [504], delayMs: 2_000 }
	);
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = await r.json();
	return j.choices?.[0]?.message?.content ?? "";
}


/**
 * A thrown judge call is NOT a behavioural failure, and must not be reported as one.
 *
 * `llmJudge` throws on an HTTP error from the router or on hfJudgeClient's own abort at
 * JUDGE_TIMEOUT_MS (45s). Judge latency over 8 cache-busted samples each: p90 6,984ms on A6, with a
 * 24,416ms tail on S5, about half the budget.
 *
 * Why a marker: the nightly alert prints the assertion TITLE and nothing else (live-vendor-tests.yml),
 * and the title names the behaviour. A grader that never answered would otherwise arrive as "the model
 * invented training specifics", a sentence about the model asserted on no evidence about the model.
 * The prefix goes at the FRONT because the workflow reads the first line of the message.
 *
 * WHAT THE MARKER DOES NOT LET YOU CONCLUDE. Determinism at temperature 0 is a property of one
 * checkpoint, not of this suite: evals/behavior-repeat.ts reports the number of distinct answers per
 * behavior for a checkpoint, and it differs across checkpoints.
 * A local harness loads .env.local over any injected MODEL_ALLOWLIST, so a laptop and
 * CI can grade different checkpoints without saying so (CUR-243).
 *
 * A flipping verdict has three candidates: the judge disagreeing with itself, the judge not answering,
 * and the model. The marker separates out only the second. Quote no pass rate off this suite without
 * the distinct-answer count that behavior-repeat prints beside it (at N=3 a real pass and a lucky draw
 * look the same), and read the harness's own `model` header line on every local run.
 */
const JUDGE_ERROR = "JUDGE ERROR (no verdict returned — NOT a behavioural failure)";

async function verdictOrJudgeError(
	judgeClient: ReturnType<typeof createHfJudgeClient>,
	answer: string,
	rubric: (typeof BEHAVIORS)[number]["judge"]
) {
	try {
		return await llmJudge(judgeClient, answer, rubric);
	} catch (e) {
		throw new Error(`${JUDGE_ERROR}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
}

describe.runIf(LIVE)("LLM-judge — live behavior probe", () => {
	it("refuses to run on any model but the one a default turn is served", () => {
		// IDENTITY, not size. /70B/i is satisfied by both Apertus checkpoints, so a size check stays green while
		// this suite grades a model nobody is on (CUR-243).
		expect(
			isGradedCheckpoint(MODEL),
			`MODEL_ALLOWLIST picks "${MODEL}"; this suite only grades "${GRADED_CHECKPOINT}". A verdict on any other checkpoint is a claim about a model no user is served.`
		).toBe(true);
		expect(BASE, "OPENAI_BASE_URL must be set").toBeTruthy();
		expect(KEY, "OPENAI_API_KEY must be set").toBeTruthy();
	});

	// KNOWN-RED, AND NOT THIS SUITE'S TO FIX. A nightly that goes red on the same known gap every
	// night trains people to ignore the channel, which is the exact failure live-vendor-tests.yml's
	// header exists to prevent. Skipping is the honest move here in a way loosening the rubric would not
	// be: the rubric is right, the behaviour genuinely does not hold, and whether we still want it is a
	// decision that already lives on a ticket.
	//
	// W1 asserts, against the RAW model answer + persona, a property the persona cannot deliver: it
	// already says "Lead with the answer in the first sentence" and that does not fire, and a worked
	// demonstration in the persona's by-example style did not move W1 beyond noise.
	// `ask()` here hits the model directly, so no runtime guard applies to this verdict, and W1 cannot
	// become green while it grades this layer.
	//
	// Nothing enforces it at runtime either (CUR-170). The lead-in the served model does write ("Here's
	// a concise, professional thank-you note you can adapt:") announces delivery rather than
	// willingness, so it is not obviously filler. The case stays skipped rather than deleted because W1
	// also grades the admin mini-eval (behaviors.ts). Do not un-skip by relaxing the rubric.
	//
	// No other case is skipped. A case that fails only because MODEL_ALLOWLIST names a checkpoint users
	// are not served is a harness bug, not a known-red: fix the allowlist rather than adding a per-case
	// skip. The first test asserts the checkpoint's identity, not its size, for that reason
	// (evals/gradedCheckpoint.ts).
	const KNOWN_RED: Record<string, string> = {
		"W1 — no filler opener before the answer":
			"the persona was measured unable to enforce this (a5228455), and CUR-170 removed the runtime guard",
	};

	// SELF-CONSISTENCY, NOT ONE SAMPLE (CUR-100). Temperature 0 is not deterministic under batched serving
	// (see JUDGE_ERROR's note above), so a single (generation, judge) pair is a coin flip dressed as a
	// verdict, and a nightly alert on it fires on a different behavior most nights with no underlying
	// regression. Sample N independently and require a MAJORITY fail before reddening the run.
	const N_SAMPLES = 3;

	for (const b of BEHAVIORS) {
		const knownRed = KNOWN_RED[b.id];
		// The POSITIVE half only. The negative half below grades the JUDGE against a fixture and is
		// unaffected by the model's behaviour, so it keeps running — that is the half that would tell us
		// the rubric had stopped detecting the violation.
		(knownRed ? it.skip : it.skipIf(!BEHAVIOR_LIVE))(
			knownRed ? `${b.id} — SKIPPED: ${knownRed}` : b.id,
			{ timeout: 120_000 },
			async () => {
				// Only constructed when this test body actually runs (describe.runIf(LIVE) skips the
				// callback entirely otherwise), so LIVE is guaranteed true here.
				const persona = buildPersonaPrompt(MODEL);
				const judgeClient = createHfJudgeClient({ modelUnderTest: MODEL, ...JUDGE_CREDS });

				// Independent samples, not a retry loop: each gets its own generation AND its own judge
				// call, run concurrently so N=3 costs wall-clock roughly what N=1 did. allSettled, not
				// all — a single JUDGE_ERROR (HTTP failure, 45s abort) says nothing about the model and
				// must not drag two real verdicts down with it.
				const samples = b.samples ?? N_SAMPLES;
				const settled = await Promise.allSettled(
					Array.from({ length: samples }, async (_, i) => {
						const answer = await ask(persona, b.prompt);
						const verdict = await verdictOrJudgeError(judgeClient, answer, b.judge);
						console.log(
							`\n[judge live] ${b.id} (sample ${i + 1}/${samples})\n  verdict: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.detail}\n` +
								`  answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}${answer.length > 300 ? "…" : ""}\n`
						);
						return verdict;
					})
				);

				const verdicts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
				if (verdicts.length === 0) {
					// Every sample errored, so there is no behavioral evidence. Rethrow rather than asserting a behavioral
					// fail against zero evidence.
					throw (settled[0] as PromiseRejectedResult).reason;
				}

				const passCount = verdicts.filter((v) => v.pass).length;
				const majorityPass = passCount * 2 > verdicts.length;
				const dissent = verdicts.find((v) => v.pass !== majorityPass);
				const detail =
					`${passCount}/${verdicts.length} samples passed` +
					(dissent ? ` — e.g. ${dissent.detail}` : "");
				expect(majorityPass, detail).toBe(true);
			}
		);

		// THE NEGATIVE HALF. Same rubric, an answer that plainly violates it, no model call — the bad
		// answer is a fixture, so this measures the JUDGE rather than the model and costs one judge
		// call instead of a generation plus a judge call.
		//
		// If this goes red, do not "fix" it by loosening the assertion: it means the judge cannot
		// detect this violation, and every green verdict above is therefore uninformative for this
		// behavior. That is a finding about the grader, not a flaky test.
		it(`${b.id} — judge FAILS a known-bad answer`, { timeout: 90_000 }, async () => {
			const judgeClient = createHfJudgeClient({ modelUnderTest: MODEL, ...JUDGE_CREDS });
			const bad = KNOWN_BAD[b.id];
			expect(bad, `no known-bad fixture for "${b.id}" — add one`).toBeTruthy();
			const verdict = await verdictOrJudgeError(judgeClient, bad, b.judge);
			console.log(
				`\n[judge live · negative] ${b.id}\n  verdict: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.detail}\n`
			);
			expect(
				verdict.pass,
				`judge PASSED a known-bad answer — it cannot detect this violation, so the positive ` +
					`assertion above proves nothing for this behavior. ${verdict.detail}`
			).toBe(false);
		});
	}
});
