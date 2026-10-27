// Fits a chat's history to the context the serving lane accepts, before the call (CUR-2893).
//
// Sending the whole history fails once a chat grows past the lane's limit: the gateway answers 400
// ("maximum context length is 32000 tokens") and Retry resends the same history, so it fails the same
// way every time. This keeps what the answer cannot do without (the system prompt and
// the newest user turn, which carries the retrieval context) and fills the rest with older exchanges,
// newest first. When the required part alone is over, the turn is refused before any call.
//
// Two estimates, because the two mistakes cost different things. Two served models counted a
// 100,000-byte English document as 20,548 and 20,232 prompt tokens, about 4.9 bytes a token. Trimming
// uses 4, so it leaves out an exchange a little early rather than overflow; text that tokenizes
// denser (code, CJK) can still overflow and gets the generic error. Refusing uses 5, just above the
// measured rate, so a message is only refused when it could not have fit: refusing on the trimming
// count would turn away a document that fits.

import type OpenAI from "openai";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Bytes per token when deciding what history fits: below the measured ~4.9, so it over-counts. */
const TRIM_BYTES_PER_TOKEN = 4;
/** Bytes per token when deciding to refuse: just above what was measured, so it under-counts. */
const REFUSE_BYTES_PER_TOKEN = 5;
/** Role markers and separators the chat template adds around each message. */
const PER_MESSAGE_TOKENS = 8;
/** A flat charge per image; vision encoders here spend from a few hundred to ~1,600 tokens on one. */
const IMAGE_TOKENS = 1600;

const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

function contentTokens(content: Msg["content"], perToken: number): number {
	if (content == null) return 0;
	if (typeof content === "string") return Math.ceil(bytes(content) / perToken);
	let total = 0;
	for (const part of content) {
		if (part.type === "text") total += Math.ceil(bytes(part.text) / perToken);
		else if (part.type === "image_url") total += IMAGE_TOKENS;
		else total += Math.ceil(bytes(JSON.stringify(part)) / perToken);
	}
	return total;
}

/** The token count of one message, tool calls included, at `perToken` bytes a token. */
export function estimateMessageTokens(message: Msg, perToken = TRIM_BYTES_PER_TOKEN): number {
	let total = PER_MESSAGE_TOKENS + contentTokens(message.content, perToken);
	if (message.role === "assistant" && message.tool_calls) {
		total += Math.ceil(bytes(JSON.stringify(message.tool_calls)) / perToken);
	}
	return total;
}

export type FitResult =
	| { kind: "fits"; messages: Msg[]; leftOut: number }
	| { kind: "overflow"; requiredTokens: number; budgetTokens: number };

/**
 * The history that fits `contextTokens` with `reserveTokens` kept for the answer.
 *
 * Refused (`overflow`) only when the required part is over budget even at the refusing count.
 *
 * Kept always: leading system messages and everything from the last user message on. The rest is cut
 * into exchanges, each a user message and the assistant and tool messages after it, and whole exchanges
 * are added back newest first while they fit. An exchange is never split, so a tool result never
 * arrives without the call that asked for it.
 *
 * A history that already fits comes back as the same array, untouched. `leftOut` counts the exchanges
 * dropped.
 */
export function fitHistory(
	messages: Msg[],
	{ contextTokens, reserveTokens }: { contextTokens: number; reserveTokens: number }
): FitResult {
	const budgetTokens = contextTokens - reserveTokens;
	const costs = messages.map((m) => estimateMessageTokens(m));
	const total = costs.reduce((a, b) => a + b, 0);
	if (total <= budgetTokens) return { kind: "fits", messages, leftOut: 0 };

	let head = 0;
	while (head < messages.length && messages[head].role === "system") head++;
	let tail = messages.length;
	for (let i = messages.length - 1; i >= head; i--) {
		if (messages[i].role === "user") {
			tail = i;
			break;
		}
	}
	// No user message after the system prompt: nothing to cut, so the whole thing is required.
	if (tail === messages.length) tail = head;

	const sum = (from: number, to: number) => costs.slice(from, to).reduce((a, b) => a + b, 0);
	const required = [...messages.slice(0, head), ...messages.slice(tail)];
	const lowest = required.reduce((a, m) => a + estimateMessageTokens(m, REFUSE_BYTES_PER_TOKEN), 0);
	if (lowest > budgetTokens) return { kind: "overflow", requiredTokens: lowest, budgetTokens };
	// Over by the trimming count but not the refusing one: send the required part alone and let the
	// lane decide, since a refusal here would be a guess.
	const requiredTokens = Math.min(sum(0, head) + sum(tail, messages.length), budgetTokens);

	const exchanges: Array<[number, number]> = [];
	let end = tail;
	for (let i = tail - 1; i >= head; i--) {
		if (messages[i].role === "user" || i === head) {
			exchanges.push([i, end]);
			end = i;
		}
	}

	let room = budgetTokens - requiredTokens;
	let keepFrom = tail;
	for (const [from, to] of exchanges) {
		const cost = sum(from, to);
		if (cost > room) break;
		room -= cost;
		keepFrom = from;
	}

	return {
		kind: "fits",
		messages: [...messages.slice(0, head), ...messages.slice(keepFrom)],
		leftOut: exchanges.filter(([from]) => from < keepFrom).length,
	};
}

/**
 * The refusal for a newest message that is over the context on its own, decided before the input
 * screen runs, or null. A 100k CJK paste is 126 guard calls; screening it only to refuse it would keep the
 * person waiting.
 *
 * A lower bound on fitHistory's own refusal: it counts the message alone, at the refusing rate, against
 * the whole context with nothing kept for the answer or the system prompt. Every message it refuses,
 * the endpoint would have refused; a message near the line still goes through the screen.
 */
export function overContextBeforeScreen(
	text: string,
	imageCount: number,
	contextTokens: number
): MessageTooLongError | null {
	const tokens = estimateMessageTokens({ role: "user", content: text }, REFUSE_BYTES_PER_TOKEN) + imageCount * IMAGE_TOKENS;
	return tokens > contextTokens ? new MessageTooLongError(tokens, contextTokens) : null;
}

/**
 * Thrown before any call when the system prompt and the newest message alone are over the lane's
 * context. A new chat has the same two parts, so the only fix is a shorter message; the conversation
 * route turns this into copy that says so (textGeneration/chatTooLong.ts).
 */
export class MessageTooLongError extends Error {
	constructor(
		readonly requiredTokens: number,
		readonly budgetTokens: number
	) {
		super(`message too long for the lane: needs ~${requiredTokens} tokens, budget ${budgetTokens}`);
		this.name = "MessageTooLongError";
	}
}
