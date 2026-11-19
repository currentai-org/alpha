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
// There is no in-app injection classifier alongside either branch: an in-app classifier
// could not separate a benign paraphrase request from a real jailbreak with any threshold,
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
import {
	getGuardVerdict,
	selfHostWithoutScreen,
	textScreenConfigured,
	type GuardGateVerdict,
	type GuardScreenDeps,
} from "$lib/chat/server/guardGate";
import { guardInputIsEmpty, type GuardScreenInput, type GuardHit, type ServedCall } from "$lib/chat/server/guardScreenTypes";
import { isSupportRule } from "$lib/chat/server/ruleLabel";
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
	/** Text chunks the guard screen read. Set only on the guard branch; the route charges
	 *  the chunks past the first against the per-minute rate limit. */
	guardChunks?: number;
	/** Where the guard screen ran, from its own response. Guard branch only. */
	served?: ServedCall;
	/** false when a self-harm log hit fired on the screened history but not on this turn's
	 *  own message, so the route stamps no support card. Absent when there was nothing to check. */
	supportOnLatest?: boolean;
};

type MinimalLogger = { info: (o: unknown, m: string) => void };

export type InputGateDeps = {
	getCoopVerdict?: typeof getCoopVerdict;
	checkChildSafety?: typeof checkChildSafety;
	checkContentPolicy?: typeof checkContentPolicy;
	getGuardVerdict?: typeof getGuardVerdict;
	/** Passed to the guard verdict; the route sets it only for the `input_screen_unfinished` fault. */
	guardDeps?: GuardScreenDeps;
	/** re-checks a violence-only block. Runs only when `violenceRecheckEnabled` says so,
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
	/** `latest` is this turn's own message as the model receives it: typed text, file text and images. */
	input: { input: GuardScreenInput; userId?: string; useGuardPrimary: boolean; latest?: GuardScreenInput },
	deps: InputGateDeps = {}
): Promise<GateBundle> {
	const log = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => performance.now());
	const gateStart = now();
	const screen = input.input;

	if (input.useGuardPrimary) {
		// A self-host edition with no text classifier answers unscreened by its operator's choice
		// (selfHostWithoutScreen warns once). screenedForRecord then records the turn as unscreened.
		if (selfHostWithoutScreen()) {
			const gateMs = Math.round(now() - gateStart);
			log.info(
				{ gateSource: "guard", gateMs, guardStatus: "unscreened", textLen: screen.corpus.length, imageUnits: screen.images.length },
				"[moderation] pre-model screen timing"
			);
			return {
				verdict: { status: "ok", actions: [] },
				childSafety: { flagged: false },
				contentPolicy: { action: "allow" },
				gateMs,
				gateSource: "guard",
				hits: [],
				guardChunks: 0,
			};
		}
		const guardFn = deps.getGuardVerdict ?? getGuardVerdict;
		const capped = await (deps.guardDeps ? guardFn(screen, deps.guardDeps) : guardFn(screen));
		// The capped screen already counted this turn's distress hits and reported progress.
		const screenWhole = (whole: GuardScreenInput) =>
			deps.guardDeps
				? guardFn(whole, { ...deps.guardDeps, countLogHits: undefined, onProgress: undefined })
				: guardFn(whole);
		const { verdict: screened, screen: read } = await rescreenCappedBlock(capped, screen, screenWhole, log);
		const recheck = deps.recheckViolence ?? (violenceRecheckEnabled() ? recheckViolenceBlock : null);
		const g = recheck ? await recheck(screened, read) : screened;
		const supportOnLatest = await confirmSupportOnLatest(g.hits, read, input.latest, (latest) => {
			// The turn's own screen already counted its distress hits and reported progress; this one does neither.
			return deps.guardDeps
				? guardFn(latest, { ...deps.guardDeps, countLogHits: undefined, onProgress: undefined })
				: guardFn(latest);
		});
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
			...(supportOnLatest !== undefined ? { supportOnLatest } : {}),
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

/** Under `guard-history-cap` the screen reads only the end of the history, so a follow-up such as
 *  "what is the door code in the memo I pasted?" is judged without the paste that makes it ordinary.
 *  Before a content block from that capped read stands, read the whole history once, as the gate
 *  does with the flag off, and let that verdict decide. The cap therefore never declines a turn the
 *  whole history passes, and a passing turn keeps the short read. A child-safety flag stands
 *  as screened, and so does the block when the whole-history read cannot answer. */
async function rescreenCappedBlock(
	capped: GuardGateVerdict,
	screen: GuardScreenInput,
	screenWhole: (whole: GuardScreenInput) => Promise<GuardGateVerdict>,
	log: MinimalLogger
): Promise<{ verdict: GuardGateVerdict; screen: GuardScreenInput }> {
	const kept = { verdict: capped, screen };
	if (screen.historyCorpus === undefined) return kept;
	if (capped.verdict.status !== "ok" || capped.contentPolicy.action !== "block" || capped.childSafety.flagged) return kept;
	const whole: GuardScreenInput = { ...screen, corpus: screen.historyCorpus, historyCorpus: undefined };
	try {
		const verdict = await screenWhole(whole);
		if (verdict.verdict.status !== "ok") return kept;
		log.info(
			{ gateSource: "guard", cappedBlock: capped.contentPolicy.category, wholeAction: verdict.contentPolicy.action },
			"[moderation] capped screen blocked; the whole-history read decided"
		);
		return { verdict, screen: whole };
	} catch {
		return kept;
	}
}

/** the guard screens every user message together, so a self-harm log hit can come from an
 *  earlier message and stamp the support card on an unrelated follow-up. When the screen read more than
 *  this turn's message, ask the same guard about this message alone. A check that cannot answer keeps
 *  the hit, so an outage never takes the card away. */
async function confirmSupportOnLatest(
	hits: GuardHit[] | undefined,
	screen: GuardScreenInput,
	latest: GuardScreenInput | undefined,
	screenLatest: (latest: GuardScreenInput) => Promise<GuardGateVerdict>
): Promise<boolean | undefined> {
	if (latest === undefined) return undefined;
	if (!hits?.some((h) => h.action === "log" && isSupportRule(h.key))) return undefined;
	if (screen.corpus.trim() === latest.corpus.trim() && screen.images.length === latest.images.length) return undefined;
	if (guardInputIsEmpty(latest)) return false;
	try {
		const verdict = await screenLatest(latest);
		if (verdict.verdict.status === "unknown") return true;
		return verdict.hits?.some((h) => isSupportRule(h.key)) ?? false;
	} catch {
		return true;
	}
}

/** `screened` for the allow-record, derived from the SELECTED source's own configured-check + status
 *  (plan codex r4 #1). The guard's check is the text judge's (textScreenConfigured), so a self-host turn
 *  that went unscreened records as unscreened. */
export function screenedForRecord(source: GateSource, status: "ok" | "unknown"): boolean {
	return source === "guard"
		? textScreenConfigured() && status === "ok"
		: isCoopConfigured() && status === "ok";
}
