/**
 * Whether a native tool loop can still afford another tool round, judged against the turn's ceiling.
 *
 * Once tools are done, the model still has to write its answer, and on a reasoning model that round
 * is most of the turn: a searched Large 4 answer round wrote 4,800-12,600 tokens at 40-62 tokens/s,
 * 100-200 s on its own. A tool round that starts late leaves that round no room, and the turn
 * ends on the timeout notice mid-answer. So before the loop offers tools again, it asks whether the
 * answer round would still fit before the ceiling, and asks for the answer now when it would not.
 *
 * The estimate is measured, never a per-model constant:
 * - speed: this turn's own rounds so far, completion tokens (the provider's usage count, or the
 *   streamed characters at 4.4 per token when a round reports none) over the time they took to stream;
 * - length: the median completion tokens of the answer rounds this server instance has already
 *   seen for the same model.
 * Until either is measured, the conservative defaults below stand in. Nothing here names a model or
 * a tool, so it holds for every model the native harness serves and every tool kit it offers.
 */

/** Tokens/s assumed before this turn has streamed a round worth timing: the slowest median measured
 *  for a served model's answer round (Large 4, 41 tok/s).
 *  @internal exported for answerRoundBudget.spec */
export const FALLBACK_TOKENS_PER_SECOND = 40;

/** A round shorter than this says little about decode speed (the first chunk's wait dominates it). */
const MIN_TIMED_TOKENS = 64;

/** Answer rounds remembered per model, and how many are needed before their median replaces the
 *  fallback length. */
const ANSWER_HISTORY_SIZE = 20;
/** @internal exported for answerRoundBudget.spec */
export const MIN_ANSWER_SAMPLES = 3;

/** Characters per token when a round reports no usage: the conversion measured on Large 4. */
const CHARS_PER_TOKEN = 4.4;

/** Room kept after the answer round for what follows it inside the turn: output screening's release,
 *  the closing message's first-chunk wait beyond what was measured, and the persist.
 *  @internal exported for answerRoundBudget.spec */
export const ANSWER_ROUND_MARGIN_MS = 10_000;

/** One round as it streamed: how many tokens, how long from its first chunk to its last, and how
 *  long its first chunk took after the request went out. */
export type RoundSample = { completionTokens: number; streamMs: number; firstChunkMs: number };

/** One turn's rounds so far. */
export class TurnPace {
	private readonly rounds: RoundSample[] = [];

	observe(sample: RoundSample): void {
		this.rounds.push(sample);
	}

	/** Completion tokens per second across the rounds long enough to time; undefined before one is. */
	tokensPerSecond(): number | undefined {
		const timed = this.rounds.filter((r) => r.completionTokens >= MIN_TIMED_TOKENS && r.streamMs > 0);
		if (timed.length === 0) return undefined;
		const tokens = timed.reduce((n, r) => n + r.completionTokens, 0);
		const ms = timed.reduce((n, r) => n + r.streamMs, 0);
		return (tokens / ms) * 1000;
	}

	/** The longest first-chunk wait this turn has seen; 0 before any round. */
	firstChunkMs(): number {
		return this.rounds.reduce((n, r) => Math.max(n, r.firstChunkMs), 0);
	}
}

// Per server instance, so it fills as the instance serves turns and starts empty after a cold start.
const answerTokensByModel = new Map<string, number[]>();

/** Record an answer round's completion tokens for `modelId`. */
export function recordAnswerRound(modelId: string, completionTokens: number): void {
	if (!(completionTokens > 0)) return;
	const seen = answerTokensByModel.get(modelId) ?? [];
	seen.push(completionTokens);
	if (seen.length > ANSWER_HISTORY_SIZE) seen.shift();
	answerTokensByModel.set(modelId, seen);
}

/** @internal test seam: forget every recorded answer round. */
export function forgetAnswerRounds(): void {
	answerTokensByModel.clear();
}

/** How long `modelId`'s answer rounds typically are: the median of those recorded, once there are
 *  MIN_ANSWER_SAMPLES of them, else `fallbackTokens`. */
export function typicalAnswerTokens(
	modelId: string,
	fallbackTokens: number
): { tokens: number; source: "measured" | "fallback" } {
	const seen = answerTokensByModel.get(modelId) ?? [];
	if (seen.length < MIN_ANSWER_SAMPLES) return { tokens: fallbackTokens, source: "fallback" };
	const sorted = [...seen].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const tokens = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
	return { tokens, source: "measured" };
}

/** How long the answer round should take: its first chunk's wait plus its tokens at the turn's rate. */
export function expectedAnswerRoundMs(opts: {
	answerTokens: number;
	tokensPerSecond: number | undefined;
	firstChunkMs: number;
}): number {
	const rate = opts.tokensPerSecond && opts.tokensPerSecond > 0 ? opts.tokensPerSecond : FALLBACK_TOKENS_PER_SECOND;
	return opts.firstChunkMs + (opts.answerTokens / rate) * 1000;
}

/** The latest moment another tool round may be offered: the answer round, and the margin after it,
 *  must still end by `ceilingAt`. */
export function lastToolRoundAt(opts: { ceilingAt: number; expectedAnswerMs: number; marginMs?: number }): number {
	return opts.ceilingAt - opts.expectedAnswerMs - (opts.marginMs ?? ANSWER_ROUND_MARGIN_MS);
}

/** Tokens a round wrote: the provider's count when it sent one, else its streamed characters. */
function roundTokens(usageTokens: number | undefined, streamedChars: number): number {
	return usageTokens !== undefined && usageTokens > 0 ? usageTokens : Math.round(streamedChars / CHARS_PER_TOKEN);
}

type ObservedOutput = {
	token?: { text?: string; special?: boolean };
	toolCalls?: unknown;
	usage?: { completionTokens?: number };
};

/**
 * Pass a round's stream through unchanged and, when it ends, report what it wrote and how fast:
 * `onDone` gets the round's sample and whether it ended in tool calls (false: it was an answer). A round
 * cut short by an error or an abort reports nothing, since its speed was not the model's.
 */
export async function* observeRound<T extends ObservedOutput>(
	stream: AsyncGenerator<T, void, void>,
	opts: { sentAt: number; now?: () => number; onDone: (sample: RoundSample, calledTools: boolean) => void }
): AsyncGenerator<T, void, void> {
	const now = opts.now ?? Date.now;
	let firstAt: number | undefined;
	let chars = 0;
	let usageTokens: number | undefined;
	let calledTools = false;
	for await (const out of stream) {
		firstAt ??= now();
		if (out.toolCalls) calledTools = true;
		if (out.usage?.completionTokens !== undefined) usageTokens = out.usage.completionTokens;
		chars += out.token?.text?.length ?? 0;
		yield out;
	}
	const endedAt = now();
	opts.onDone(
		{
			completionTokens: roundTokens(usageTokens, chars),
			streamMs: firstAt === undefined ? 0 : endedAt - firstAt,
			firstChunkMs: (firstAt ?? endedAt) - opts.sentAt,
		},
		calledTools
	);
}
