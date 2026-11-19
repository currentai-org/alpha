// guardScreenTypes — the ONE screen-input contract shared by the primary gate (guardGate), the
// health probe, and the media preparer (prepareTurnMedia). A tiny leaf
// module so prepareTurnMedia and guardGate can both import it without a cycle.
// (Shieldstral swap plan — docs/plans/shieldstral-detection-swap.md, "API change" section.)

// ── shared caps (plan "ONE corpus budget" / "Image set + cap") ────────────────────────────────────
/** The whole-corpus screen cap — Coop /content parity, no widening. Typed text reserves its length
 *  out of this first; clipboard + rendered file segments truncate into the remainder. */
export const GUARD_CORPUS_CAP = 100_000;
/** With `guard-history-cap` on, the most the input screen reads per turn: the newest user message
 *  whole, plus the end of the earlier ones up to this total. An earlier message passed the
 *  screen on its own turn; re-reading a long chat's whole history cost ~15 s a turn. */
export const SCREEN_HISTORY_CAP = 4_000;

/** The screen corpus under the history cap: `texts` are the user messages' finalTexts in prompt
 *  order. The newest is always kept whole; a newest of `cap` chars or more is returned alone. Earlier
 *  texts are joined as the uncapped corpus joins them, and only their end is kept. */
export function capScreenHistory(texts: string[], cap = SCREEN_HISTORY_CAP): string {
	const newest = texts.at(-1) ?? "";
	const room = cap - newest.length - "\n\n".length;
	if (texts.length < 2 || room <= 0) return newest;
	return `${texts.slice(0, -1).join("\n\n").slice(-room)}\n\n${newest}`;
}
/** Newest-first cap on retained image OCCURRENCES per turn — excluded from BOTH the screen and the
 *  model payload beyond it (never screened-less-than-sent). */
export const MAX_TURN_IMAGES = 8;
/** Bounded prefix of the source message's finalText used as an image unit's caption. */
export const IMAGE_CAPTION_CAP = 4_000;

/** One retained image OCCURRENCE — an image as it rides in one specific user message. The endpoint
 *  sends an image inside each message it appears in, with that message's text, so the screen judges
 *  the same (text, image) pairs. */
export type PreparedImage = {
	sha: string;
	mime: string;
	/** The name the person gave the file; the agent's workdir copy is named by it. */
	name?: string;
	/** Hydrated source bytes — what the endpoint's own image processor consumes. */
	source: Buffer;
	/** Bounded screening rendition (sharp fit-inside 1024×1024 JPEG), base64 — what the guard sees. */
	screenB64: string;
	/** The message this occurrence rides in. */
	sourceMessageId: string;
	/** Bounded PREFIX of that message's finalText (clipboard + rendered file segments included), so
	 *  the guard judges the text-image pair the endpoint actually serves. */
	caption: string;
};

/** A media unit the preparer could not produce. Failures must be REPRESENTABLE (plan r3 #1): the
 *  gate merges any failed unit as UNKNOWN — child closes — never as silence that reads as safe. */
export type FailedUnit = {
	kind: "file-hydration" | "text-decode" | "image-encode" | "document-extract";
	sha: string;
};

/** The whole screen input for one turn. `corpus` is the text the gate chunks and screens — the
 *  finalText of every user message in prompt order, containing every file-derived byte the
 *  endpoint will receive. `typedTurnText` is THIS turn's typed text only — the Coop branch's input
 *  (sync and async planes): file/history bytes never go to the vendor (plan r3 #3). */
export type GuardScreenInput = {
	corpus: string;
	/** Set only when `guard-history-cap` cut the history out of `corpus`: the whole history, as the
	 *  uncapped corpus would read. The gate re-screens it before a content block stands, so the cap
	 *  never declines a follow-up the whole history would pass. */
	historyCorpus?: string;
	typedTurnText: string;
	images: PreparedImage[];
	failedUnits: FailedUnit[];
};

/** Empty-input rule: the gate's fast path may fire ONLY when all three are empty —
 *  an image-only turn or a failed-media turn must run the screen. */
export function guardInputIsEmpty(input: GuardScreenInput): boolean {
	return !input.corpus.trim() && input.images.length === 0 && input.failedUnits.length === 0;
}

/** Text-only convenience for callers that have no media (probe fixtures, agent turns, tests). */
export function textOnlyGuardInput(text: string, typedTurnText = text): GuardScreenInput {
	return { corpus: text, typedTurnText, images: [], failedUnits: [] };
}

/** One fired guard rule as carried to the REVIEW PLANE (Coop /api/v1/report) — the curated rule KEY
 *  plus its action and tier, never the model's raw output, the query text, or the user's bytes. The
 *  union of a screen's block and log hits; the deriver carries it on EVERY status (an UNKNOWN screen
 *  can still have real log hits). A reviewer sees every rule that fired and the action taken.
 *  (coop-review-plane Step 1a — leaf type so guardGate, inputGate, moderation, and the agent adapter
 *  share it without a cycle.) */
export type GuardHit = { key: string; action: "block" | "log"; tier: "child" | "content" };

// ── the detector seam (coop-review-plane Step 5) ──────────────────────────────────────────────────
// The gate (guardGate.ts) owns chunking, fan-out, the deadline, the merge, the deriver, and the probe;
// the DETECTOR is one swappable JudgeFn behind a single seam (runGuardScreen takes deps.judge ??
// shieldstralJudge). These leaf types live here so the detector adapter (detectors/shieldstral.ts) and
// the gate share them without a cycle. A future detector = a new file implementing JudgeFn; no registry.

/** The tiny logger surface the gate and detector share (a pino subset — never the full logger). */
export type MinimalLogger = {
	info: (o: unknown, m: string) => void;
	warn: (o: unknown, m: string) => void;
	error: (o: unknown, m: string) => void;
};

/** One judge target: a text document, or an image occurrence with its caption. */
export type JudgeTarget = { kind: "text"; text: string } | { kind: "image"; image: PreparedImage };

/** A detector's answer for one (target, query) pair. `unknown` is an outage/garble, never a clean pass. */
export type ShieldAnswer =
	| { kind: "score"; score: number; yes: boolean }
	| { kind: "token"; yes: boolean }
	| { kind: "unknown" };

/** One judge call's outcome: the answer plus the transport/identity signals the probe asserts on. */
/** Where one judge call ran, read from its own response: the model the body reports, the URL the
 *  request ended at, and the HF router's provider header when it went through the router. */
export type ServedCall = { model: string; backend?: string; provider?: string };

export type JudgeOutcome = {
	answer: ShieldAnswer;
	httpOk: boolean;
	servedModel?: string;
	/** The response's final URL (after redirects), never the configured endpoint. */
	servedBackend?: string;
	/** `x-inference-provider`, set only by the HF router. */
	servedProvider?: string;
};

/** The per-call context the gate hands a JudgeFn — the SCREENING knobs only, never adapter config
 *  (endpoint/token/bill-to/model live on the adapter factory, off the gate's deps). */
export type JudgeCtx = { instruct: string; opSignal: AbortSignal; timeoutMs: number; log: MinimalLogger };

/** The detector adapter contract: ONE yes/no judge call for a (target, query) pair, returning a
 *  threshold-applied answer. NEVER rejects — a failure or garble is a `{ kind: "unknown" }` answer, and a
 *  call whose turn comes after ctx.opSignal aborts resolves UNKNOWN WITHOUT starting a request. Swap the
 *  whole detector by passing a different JudgeFn as deps.judge. */
export type JudgeFn = (
	target: JudgeTarget,
	query: string,
	threshold: number,
	ctx: JudgeCtx
) => Promise<JudgeOutcome>;
