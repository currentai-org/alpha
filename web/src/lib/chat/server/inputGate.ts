// inputGate — the SINGLE pre-model safety gate the route runs, with the verdict source selected by
// the carried per-turn policy. Both branches settle the route's EXISTING
// nested bundle — { verdict, childSafety, contentPolicy, gateMs } + gateSource — so every
// consumer (decideModeration, recordAllowed, the timing stamp) destructures exactly what it always
// has; the guard branch fills it, no translation layer.
//
//   flag OFF (useGuardPrimary=false) — byte-identical to the pre-swap gate: ONE Coop /content submit
//     per turn; child/content owner-points reuse the fetched verdict (no extra Coop I/O).
//   flag ON — getGuardVerdict supplies verdict/childSafety/contentPolicy (ZERO Coop calls on the
//     sync path).
//
// There is no in-app injection classifier alongside either branch (CUR-59): an in-app classifier
// could not separate a benign paraphrase request from a real jailbreak with any threshold (CUR-54),
// so injection defense here is structural, not classification-based. See moderation.ts and
// +server.ts's decideModeration. Don't rebuild a classifier here without a different approach.
//
// Extracted from the route so the one-operation invariants are TESTS, not conventions:
// "flag ON → one guard screening operation and zero Coop /content calls" (and the inverse) run
// against this seam with spies — see inputGate.spec.ts.

import {
	getCoopVerdict,
	checkChildSafety,
	checkContentPolicy,
	isCoopConfigured,
	type ChildSafetyResult,
	type ContentPolicyResult,
} from "$lib/chat/server/moderation";
import { getGuardVerdict, guardPrimaryConfigured, type GuardGateVerdict, type GuardScreenDeps } from "$lib/chat/server/guardGate";
import type { GuardScreenInput, GuardHit, ServedCall } from "$lib/chat/server/guardScreenTypes";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import { recheckViolenceBlock, violenceRecheckEnabled } from "$lib/chat/server/violenceRecheck";

export type GateSource = "coop" | "guard";

export type GateBundle = {
	verdict: { status: "ok" | "unknown"; actions: string[] };
	childSafety: ChildSafetyResult;
	contentPolicy: ContentPolicyResult;
	gateMs: number;
	gateSource: GateSource;
	/** Fired guard rules for the review plane (coop-review-plane Step 1). Set only on the guard branch;
	 *  the Coop branch leaves it undefined (Coop already holds the turn — it ran sync). */
	hits?: GuardHit[];
	/** Text chunks the guard screen read (CUR-3532). Set only on the guard branch; the route charges
	 *  the chunks past the first against the per-minute rate limit. */
	guardChunks?: number;
	/** Where the guard screen ran, from its own response (CUR-3563). Guard branch only. */
	served?: ServedCall;
};

type MinimalLogger = { info: (o: unknown, m: string) => void };

export type InputGateDeps = {
	getCoopVerdict?: typeof getCoopVerdict;
	checkChildSafety?: typeof checkChildSafety;
	checkContentPolicy?: typeof checkContentPolicy;
	getGuardVerdict?: typeof getGuardVerdict;
	/** Passed to the guard verdict; the route sets it only for the `input_screen_unfinished` fault. */
	guardDeps?: GuardScreenDeps;
	/** re-checks a violence-only block. Runs only when `violenceRecheckEnabled` says so, (CUR-1853)
	 *  unless a test passes its own. */
	recheckViolence?: (g: GuardGateVerdict, screen: GuardScreenInput) => Promise<GuardGateVerdict>;
	logger?: MinimalLogger;
	now?: () => number;
};

// Capture wall time for a call without changing its result or error behavior.
async function timeCall<T>(fn: () => Promise<T>, now: () => number): Promise<{ value: T; ms: number }> {
	const start = now();
	const value = await fn();
	return { value, ms: now() - start };
}

/** Run the whole gate for one turn and settle the full bundle, gateMs stamped and the `[moderation]`
 *  timing line emitted at settlement — consumers never re-run a check. Which source screens is decided by the CARRIED policy value, read once in
 *  the pre-stream chain — never re-read here. */
export async function runInputGate(
	input: { input: GuardScreenInput; userId?: string; useGuardPrimary: boolean },
	deps: InputGateDeps = {}
): Promise<GateBundle> {
	const log = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => performance.now());
	const gateStart = now();
	const screen = input.input;

	if (input.useGuardPrimary) {
		const guardFn = deps.getGuardVerdict ?? getGuardVerdict;
		const screened = await (deps.guardDeps ? guardFn(screen, deps.guardDeps) : guardFn(screen));
		const recheck = deps.recheckViolence ?? (violenceRecheckEnabled() ? recheckViolenceBlock : null);
		const g = recheck ? await recheck(screened, screen) : screened;
		const gateMs = Math.round(now() - gateStart);
		log.info(
			{
				gateSource: "guard",
				guardMs: gateMs,
				gateMs,
				guardStatus: g.verdict.status,
				guardChunks: g.guardChunks,
				guardTruncated: g.guardTruncated,
				textLen: screen.corpus.length,
				imageUnits: screen.images.length,
			},
			"[moderation] pre-model screen timing"
		);
		return {
			verdict: g.verdict,
			childSafety: g.childSafety,
			contentPolicy: g.contentPolicy,
			gateMs,
			gateSource: "guard",
			hits: g.hits,
			guardChunks: g.guardChunks,
			...(g.served ? { served: g.served } : {}),
		};
	}

	// Coop branch — ONE /content submit, then the verdict-reusing
	// owner-points (they don't re-fetch when a verdict is passed). Coop screens ONLY the current turn's
	// typed text — file/history/image bytes never reach the vendor.
	const typed = screen.typedTurnText;
	const coopFn = deps.getCoopVerdict ?? getCoopVerdict;
	const childFn = deps.checkChildSafety ?? checkChildSafety;
	const contentFn = deps.checkContentPolicy ?? checkContentPolicy;
	const verdictTimed = await timeCall(() => coopFn(typed, input.userId), now);
	const verdict = verdictTimed.value;
	const childSafety = await childFn(typed, input.userId, verdict);
	const contentPolicy = await contentFn(typed, input.userId, verdict);
	const gateMs = Math.round(now() - gateStart);
	log.info(
		{
			gateSource: "coop",
			coopMs: Math.round(verdictTimed.ms),
			gateMs,
			coopStatus: verdict.status,
			textLen: typed.length,
		},
		"[moderation] pre-model screen timing"
	);
	return { verdict, childSafety, contentPolicy, gateMs, gateSource: "coop" };
}

/** `screened` for the allow-record, derived from the SELECTED source's own configured-check + status,
 *  so a successfully guard-screened turn under guard-primary records as screened whether or not Coop is
 *  configured. */
export function screenedForRecord(source: GateSource, status: "ok" | "unknown"): boolean {
	return source === "guard"
		? guardPrimaryConfigured() && status === "ok"
		: isCoopConfigured() && status === "ok";
}
