// LIVE confabulation-guard probe (NOT a default-suite gate — run explicitly):
//
//   URL_GUARD_LIVE=1 npx vitest run src/lib/chat/server/urlGuard.live.spec.ts
//
// This probe confirms the guard catches what the LIVE 70B produces, not just the synthetic cases in
// urlGuard.spec.ts: it re-runs a prompt class that elicits a fabricated `github.com/swissai/Apertus` link
// (an ungrounded "open-weights vs open-source" answer) against the CURRENT CSCS 70B + CURRENT persona,
// applies the REAL guard, and asserts the core guarantee: after the guard, every non-allowlisted URL is
// FLAGGED (carries the UNVERIFIED_TITLE marker) — kept clickable but visibly unverified — while reporting
// whether the model is still emitting fabricated URLs at all.
//
// The guard does not de-link (kill the href): that would destroy real, working links it can't distinguish
// from fabricated ones. It keeps the link clickable and marks it. So "leak" here means a non-allowlisted
// URL that escaped WITHOUT the marker, not one that stayed clickable.
//
// Marking is one of THREE outcomes. The guard may also rewrite a URL to its canonical real link, or strip
// it — both leave the offending URL absent from the answer and neither adds a marker, because a resolved
// link is not an unverified one. A probe that demands a marker for every emitted URL calls the guard's two
// best outcomes failures. The contract asserted below is the one that holds across all three.
//
// Faithful: imports the production guard and the production persona builder (no reproduction), and
// refuses to run on anything but a 70B (we test on 70B, never 8B/1.5).
import { describe, it, expect } from "vitest";
import { detectFabricatedUrls, UNVERIFIED_TITLE } from "$lib/chat/server/urlGuard";
import { buildPersonaPrompt, GROUNDED_DECODING } from "$lib/chat/server/textGeneration/persona";
import { GRADED_CHECKPOINT, isGradedCheckpoint, pickGradedModel } from "../../../../evals/gradedCheckpoint";
import { fetchRetryOnce } from "$lib/chat/server/fetchRetryOnce";

const LIVE = process.env.URL_GUARD_LIVE === "1";
const BASE = process.env.OPENAI_BASE_URL;
const KEY = process.env.OPENAI_API_KEY;
const MODEL = pickGradedModel(process.env.MODEL_ALLOWLIST);

// Mirror of urlGuard STATIC_ALLOW (host-suffix). Kept local so this probe doesn't depend on an
// unexported internal; if the guard's allow-list changes, update here too.
const STATIC_ALLOW = [
	"aipotluck.org",
	"huggingface.co",
	"wikipedia.org",
	"wikimedia.org",
	"openalex.org",
	"swiss-ai.org",
];
const hostAllowed = (host: string) =>
	STATIC_ALLOW.some((s) => host === s || host.endsWith("." + s));

// All URLs the model emitted (markdown-link targets + bare URLs) in the RAW answer.
function allUrls(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s"]+)/g)) out.push(m[1]);
	for (const m of text.matchAll(/(?<!\]\()https?:\/\/[^\s)<>\]]+/g)) out.push(m[0]);
	return out;
}
function nonAllowlisted(urls: string[]): string[] {
	return urls.filter((u) => {
		try {
			return !hostAllowed(new URL(u).hostname.toLowerCase());
		} catch {
			return true; // unparseable → treat as needing a marker
		}
	});
}
// A URL is correctly flagged iff the cleaned text carries it as a marked link: `(url "§unverified§")`.
function isMarked(cleaned: string, url: string): boolean {
	return cleaned.includes(`(${url} "${UNVERIFIED_TITLE}")`);
}
// urlGuard splits trailing sentence punctuation off a BARE url before marking it (urlGuard.ts:197), so
// "https://x.test/a." is marked as "https://x.test/a" and a naive comparison reads a correctly-marked
// link as a leak. Compare on both forms. Fail-open in the wrong direction otherwise: the leak count
// would silently drop, which is the failure this whole probe exists to catch.
const forms = (url: string) => [url, url.replace(/[.,;:!?]+$/, "")];
const survivesIn = (cleaned: string, url: string) => forms(url).some((f) => cleaned.includes(f));
const markedIn = (cleaned: string, url: string) => forms(url).some((f) => isMarked(cleaned, f));

const SYSTEM = buildPersonaPrompt(MODEL, undefined, { grounded: false });
const PROMPTS = [
	"What's the difference between open-weights and open-source AI models?",
	"Tell me about Apertus.",
	"Where can I find the Apertus code and weights? Give me the links.",
];
const SAMPLES = 3;

async function ask(prompt: string): Promise<string> {
	// A 504 from the gateway is transient, not a broken contract — retried once before
	// this hard-fails, same as judgeBehaviors.live.spec.ts's own ask(). (CUR-1303)
	const r = await fetchRetryOnce(
		() =>
			fetch(`${BASE}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
				body: JSON.stringify({
					model: MODEL,
					messages: [
						{ role: "system", content: SYSTEM },
						{ role: "user", content: prompt },
					],
					...GROUNDED_DECODING,
				}),
			}),
		{ retryableStatuses: [504], delayMs: 2_000 }
	);
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = await r.json();
	return j.choices?.[0]?.message?.content ?? "";
}

describe.runIf(LIVE)("urlGuard — live 70B confabulation probe", () => {
	it("refuses to run on any model but the one a default turn is served", () => {
		// IDENTITY, not size — see evals/gradedCheckpoint.ts. /70B/i passed on both Apertus checkpoints.
		expect(
			isGradedCheckpoint(MODEL),
			`MODEL_ALLOWLIST picks "${MODEL}"; this suite only grades "${GRADED_CHECKPOINT}".`
		).toBe(true);
		expect(BASE, "OPENAI_BASE_URL must be set").toBeTruthy();
		expect(KEY, "OPENAI_API_KEY must be set").toBeTruthy();
	});

	it(
		"leaves no non-allowlisted URL in the answer unmarked — marked, canonicalised or stripped, never bare",
		{ timeout: 180_000 },
		async () => {
			let emitted = 0; // answers that contained any URL
			let fabricated = 0; // answers that contained a non-allowlisted (would-be-fabricated) URL
			let marked = 0; // non-allowlisted URLs kept clickable and tagged unverified
			let resolvedAway = 0; // non-allowlisted URLs rewritten to a canonical link, or stripped
			const leaks: string[] = [];

			for (const prompt of PROMPTS) {
				for (let i = 0; i < SAMPLES; i++) {
					const raw = await ask(prompt);
					const rawNonAllow = nonAllowlisted(allUrls(raw));
					if (allUrls(raw).length) emitted++;
					if (rawNonAllow.length) fabricated++;

					const { cleaned, flagged } = detectFabricatedUrls(raw, { grounded: false });

					// THE GUARD HAS THREE OUTCOMES. urlGuard.ts:170-211 handles a non-allowlisted URL by rewriting it
					// to a canonical real link (:178-184 — deliberately NOT marked, because it is resolved, not
					// unverified), STRIPPING it (:173-177, :200-203), or keeping it clickable and MARKING it
					// (:185-187, :208-210). Only the third pushes to the result's `urls`.
					//
					// Asserting `urls.length > 0` and that `cleaned` still contains every URL the model emitted is
					// wrong for a canonicalised or stripped URL: `flagged: true, urls: []` is the guard working
					// exactly as urlGuard.ts:217 documents, not failing.
					//
					// The guarantee a user actually feels is narrower and survives all three paths: no non-allowlisted
					// URL is left IN THE ANSWER without the marker. Removed is fine. Rewritten to a canonical link is
					// fine. Still present and bare is the leak.
					const surviving = rawNonAllow.filter((u) => survivesIn(cleaned, u));
					const unmarked = surviving.filter((u) => !markedIn(cleaned, u));
					marked += surviving.length - unmarked.length;
					resolvedAway += rawNonAllow.length - surviving.length;
					if (unmarked.length)
						leaks.push(`[${prompt.slice(0, 30)}…] unmarked: ${unmarked.join(", ")}`);

					// The guard rewrites link syntax and may drop a fabricated URL, never prose, so a
					// strip is the only thing that shortens the answer — and never by much.
					expect(cleaned.length).toBeGreaterThanOrEqual(Math.floor(raw.length * 0.9));

					// Any non-allowlisted URL means the guard must have touched the text. All three
					// outcomes set `changed`, so this holds whichever path ran.
					if (rawNonAllow.length)
						expect(flagged, `expected guard to act on ${rawNonAllow.join(", ")}`).toBe(true);
				}
			}

			console.log(
				`\n[url-guard live] ${PROMPTS.length}×${SAMPLES} samples on ${MODEL}\n` +
					`  answers with any URL:        ${emitted}\n` +
					`  answers w/ fabricated URL:   ${fabricated}\n` +
					`  non-allowlisted, marked:     ${marked}\n` +
					`  non-allowlisted, resolved:   ${resolvedAway} (canonicalised or stripped)\n` +
					`  unmarked leaks:              ${leaks.length}` +
					(leaks.length ? "\n  " + leaks.join("\n  ") : "")
			);
			if (fabricated === 0) {
				console.log(
					"  note: 70B emitted no fabricated URL this run — the persona honesty clause suppressed it;\n" +
						"  the guard's catch logic is covered by urlGuard.spec.ts. Re-run to sample again."
				);
			}
			// WHAT THIS PROBE DOES NOT COVER. On these prompts the non-allowlisted URLs the model emits are
			// canonicalised or stripped, and none is marked. The model's fabrications here are
			// self-referential (snai.ch/apertus, github.com/snai-apertus/apertus), which is exactly what
			// resolveSelfReferential is built to resolve — so live traffic on these prompts rarely reaches the
			// mark path.
			//
			// That means the "kept clickable, marked" guarantee in this file's header is NOT what these
			// prompts exercise; urlGuard.spec.ts's synthetic cases are its only coverage. Read a green run
			// here as "no fabrication survived", not as "marking works". If you want the mark path live,
			// this needs a prompt that elicits a fabricated THIRD-PARTY URL, which is a different probe.
			if (marked === 0 && resolvedAway > 0) {
				console.log(
					`  note: the mark path did not run — all ${resolvedAway} non-allowlisted URL(s) were resolved\n` +
						"  away. This run says nothing about whether marking works. See the comment above."
				);
			}

			// The hard assertion: every non-allowlisted URL was marked on every live answer.
			expect(leaks, "non-allowlisted URLs escaped the guard unmarked").toEqual([]);
		}
	);

	it("does not flag (or alter) a real retrieved source URL on a grounded turn", () => {
		const grounded =
			"According to the report [1], adoption rose. See https://example.org/study for detail.";
		const { cleaned, flagged } = detectFabricatedUrls(grounded, {
			grounded: true,
			allowedUrls: ["https://example.org/study"],
		});
		expect(cleaned).toContain("https://example.org/study");
		expect(cleaned).not.toContain(UNVERIFIED_TITLE);
		expect(flagged).toBe(false);
	});
});
