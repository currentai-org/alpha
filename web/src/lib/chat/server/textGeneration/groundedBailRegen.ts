import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import { textGenerationWithoutTitle } from "./index";
import type { TextGenerationContext } from "./types";

// On a grounded turn whose whole answer bails to a hedge/refusal, a static pointer to whatever was
// retrieved is the wrong answer when the model would have answered correctly without searching (for
// "what model are you and who made you?" with web search on, two irrelevant sources come back, the
// model hedges, and the pointer is to a YouTube link) (CUR-148). Current
// practice for this exact failure (Corrective RAG's relevance-graded fallback; Google Research's
// "sufficient context" finding that topically-related sources can still be insufficient to answer) is
// to re-answer from the model's own knowledge rather than cite sources it already declined to use —
// but only with an honest marker that a search ran and came up empty, never a silent swap. See
// hedgeGuard.ts's buildGroundedHedgeReplacement (the fallback-of-fallback this regen sits in front of)
// and requestTrace.ts's groundedHedgeNotice (the on-screen disclosure).

export const GROUNDED_BAIL_REGEN_FLAG = "grounded-bail-regen";

export function groundedBailRegenEnabled(): boolean {
	return flagEnabledOr(GROUNDED_BAIL_REGEN_FLAG, () => false);
}

// Generous but bounded: this is a rare fallback path (rare, and the count is a floor, per CUR-148), so paying one full extra round-trip's latency is an acceptable
// trade for not shipping a citation pointer to sources the model already declined to use. A SEPARATE,
// short deadline — rather than reusing the turn's own generation watchdog, which was armed for the
// FIRST generation and may already be close to firing — so this fallback never silently inherits a
// near-expired budget.
const REGEN_TIMEOUT_MS = 15_000;

/**
 * Re-answer UNGROUNDED after a grounded turn's whole answer bailed to a hedge/refusal. Clearing
 * searchContext/ragContext is sufficient to produce a genuinely ungrounded generation: textGeneration
 * derives its own internal `grounded` flag purely from those two fields (index.ts), so the model gets
 * no evidence block and no grounded-turn persona instructions. Uses textGenerationWithoutTitle, not the
 * public textGeneration wrapper — the wrapper always fires a second, redundant conversation-title
 * generation merged into the same stream, which this buffered fallback pass must not repeat. Speak
 * mode is forced off: this text is never surfaced as a separate playable clip, only read back as a
 * string.
 *
 * Buffered, not streamed to the client: the caller (honestyStream.ts) only needs the finished text,
 * and a rare fallback path doesn't earn the complexity of a second live token stream layered onto the
 * turn already in flight.
 *
 * Returns undefined on any failure (timeout, abort, no FinalAnswer, thrown error) — the caller decides
 * what "no answer" falls back to (today: the static sources-pointer via buildGroundedHedgeReplacement).
 */
export async function runGroundedBailRegen(
	ctx: TextGenerationContext,
	signal: AbortSignal
): Promise<string | undefined> {
	return runBufferedRegen(
		{ ...ctx, searchContext: undefined, ragContext: null },
		signal,
		REGEN_TIMEOUT_MS,
		"[groundedBailRegen] ungrounded regen failed — falling back to the sources pointer"
	);
}

// A recital regen asks the same turn again, sources and all, so its budget has to cover a whole slow
// answer: the slowest offered model's first token alone is about 21 s at p75 (CUR-3886).
const RECITAL_REGEN_TIMEOUT_MS = 60_000;

/**
 * Ask the same turn again, grounding kept, after its answer opened by reciting the fenced turn's
 * preamble (CUR-3886). Buffered and bounded like the grounded-bail regen; undefined on any failure.
 */
export async function runRecitalRegen(
	ctx: TextGenerationContext,
	signal: AbortSignal
): Promise<string | undefined> {
	return runBufferedRegen(
		// The recital fault's retry answers as canned_reply, so a spec sees a deterministic replacement.
		ctx.faultInjection === "answer_recites_preamble" ? { ...ctx, faultInjection: "canned_reply" } : ctx,
		signal,
		RECITAL_REGEN_TIMEOUT_MS,
		"[recitalRegen] regen failed — falling back to the recital notice"
	);
}

async function runBufferedRegen(
	ctx: TextGenerationContext,
	signal: AbortSignal,
	timeoutMs: number,
	failureLog: string
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const regenController = new AbortController();
	const onAbort = () => regenController.abort();
	signal.addEventListener("abort", onAbort);

	const drain = async (): Promise<string | undefined> => {
		const regenCtx: TextGenerationContext = {
			...ctx,
			speakMode: "off",
			speakAll: false,
			abortController: regenController,
			// A fresh sink, not the original turn's — this is a separate generation and must not blend its
			// phase timings into the turn that triggered it.
			timings: undefined,
		};
		for await (const event of textGenerationWithoutTitle(regenCtx, new AbortController())) {
			if (event.type === MessageUpdateType.FinalAnswer) return event.text;
		}
		return undefined;
	};

	// A genuine RACE, not merely a cooperative abort: signalling regenController is the polite ask, but
	// a generator that never checks its own abort signal (a real network hang, or a test double that
	// doesn't bother) must not be able to hold this fallback path open
	// past the deadline. Whichever settles first wins; the loser is abandoned, not awaited.
	let timeoutHandle: ReturnType<typeof setTimeout>;
	const giveUp = new Promise<undefined>((resolve) => {
		timeoutHandle = setTimeout(() => resolve(undefined), timeoutMs);
		regenController.signal.addEventListener("abort", () => resolve(undefined));
	});

	try {
		return await Promise.race([
			drain().catch((err) => {
				logger.warn({ err }, failureLog);
				return undefined;
			}),
			giveUp,
		]);
	} finally {
		clearTimeout(timeoutHandle!);
		signal.removeEventListener("abort", onAbort);
	}
}
