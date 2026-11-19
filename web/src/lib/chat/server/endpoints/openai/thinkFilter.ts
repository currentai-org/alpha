// GLM reasons before it answers, and on the lanes that serve it that reasoning reaches this client
// in one of two shapes: a separate `reasoning_content` delta (the Hugging Face router's providers) or `<think>…</think>` inline in `content` (a vLLM server with no reasoning
// parser). It restates the prompt it was given ("Let me use the calc block as required"), and an
// Apertus turn has no such block, so a GLM side call's reasoning is removed. The visitor's answer
// keeps it: it goes into the collapsed Working panel, which may quote the prompt.

import { reasoningOffFields, splitWireId } from "../../modelProfiles";
import { hfPinnedProvider, isHfRouter } from "./providerPin";

/** The served model is one whose reasoning is removed from a side call's text. */
export function dropsReasoning(modelId: string | undefined): boolean {
	return !!modelId && /(^|\/)glm-/i.test(modelId.trim());
}

/**
 * The wire model id and fields for a GLM call that must not reason (a title, a classifier, the math
 * ledger). On the HF router an id in modelProfiles.ts's pin table is pinned with a `:provider` suffix,
 * unless it already carries one; endpointOai has usually pinned it before this runs. The fields come
 * from the verified profile row for the model and the provider the id ends up naming
 * (modelProfiles.ts): Scaleway honours `reasoning_effort: "none"` and ignores `thinking`, novita and
 * zai-org the reverse, and Featherless honours neither for GLM-5.2, so its row sends no field;
 * DeepInfra honours `reasoning_effort` for GLM-5.2 and Qwen3.6.
 */
export function reasoningOffRequest(
	modelId: string,
	baseURL: string | undefined,
	gatewayBaseURL?: string
): { model: string; fields: Record<string, unknown> } {
	const pin = hfPinnedProvider(modelId, baseURL);
	const model = pin ? `${modelId}:${pin}` : modelId;
	const { model: base, provider } = splitWireId(model);
	// The unverified fallback (`thinking`) is a guess made for the gateway and the HF router. A host
	// that is neither has no verified row and may validate its body strictly: Mistral's API answers
	// 422 extra_forbidden on `thinking`. Its models get no field at all.
	const norm = (u: string) => u.trim().replace(/\/+$/, "");
	if (
		!provider &&
		baseURL &&
		gatewayBaseURL &&
		norm(baseURL) !== norm(gatewayBaseURL) &&
		!isHfRouter(baseURL)
	)
		return { model, fields: {} };
	return { model, fields: reasoningOffFields(base, provider) };
}

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Characters of reasoning inside `<think>…</think>` blocks in a finished generation, for the
 * `reasoningChars` log field. The stream wraps every kind of reasoning in these tags before
 * it reaches the text: a separate reasoning field (Large 4), an untagged opening held until its bare
 * `</think>` (ALIA), and tags the model writes itself. An unclosed block counts to the end.
 */
export function thinkChars(text: string): number {
	let total = 0;
	let from = 0;
	for (;;) {
		const open = text.indexOf(OPEN, from);
		if (open < 0) return total;
		const start = open + OPEN.length;
		const close = text.indexOf(CLOSE, start);
		if (close < 0) return total + text.length - start;
		total += close - start;
		from = close + CLOSE.length;
	}
}

/**
 * Removes `<think>…</think>` from streamed content that may split a tag across chunks. Feed each
 * content delta to `push` and send what it returns; call `flush` at the end of the stream. Text held
 * back as a possible partial tag is released by the next push or by `flush`. An unclosed block is
 * dropped to the end: the model ran out of tokens while still reasoning, and there is no answer in it.
 */
export class ThinkFilter {
	/** Characters of reasoning removed so far, counted for the log line (never the text). */
	stripped = 0;
	private inside = false;
	private pending = "";

	push(chunk: string): string {
		let text = this.pending + chunk;
		this.pending = "";
		let out = "";
		for (;;) {
			const tag = this.inside ? CLOSE : OPEN;
			const at = text.toLowerCase().indexOf(tag);
			if (at >= 0) {
				if (this.inside) this.stripped += at;
				else out += text.slice(0, at);
				text = text.slice(at + tag.length);
				this.inside = !this.inside;
				continue;
			}
			// Hold back a suffix that could be the start of the tag we are looking for.
			const keep = partialTagSuffix(text, tag);
			const settled = text.slice(0, text.length - keep);
			if (this.inside) this.stripped += settled.length;
			else out += settled;
			this.pending = text.slice(text.length - keep);
			return out;
		}
	}

	flush(): string {
		const rest = this.pending;
		this.pending = "";
		if (this.inside) {
			this.stripped += rest.length;
			return "";
		}
		return rest;
	}
}

/**
 * For a model whose reasoning opens with no tag (harnessProfiles.ts `opensReasoningUntagged`): opens a
 * `<think>` block at the first character and streams the content live inside it until the bare
 * `</think>` arrives, then streams the rest as the answer. The client folds the block away like any
 * other.
 *
 * A stream that ends with no `</think>` was an answer with no reasoning: `flush` closes the block and
 * sends the same text again as the answer, so it is shown, at the cost of a copy in the folded panel.
 * Everything goes out in order, as content, so output screening reads all of it. One cut off at the
 * token cap (`cutOff`) was still reasoning, so its block is left open, which the client folds and
 * reports as a turn with no answer rather than showing the reasoning as the reply. A reply that opens
 * with `<think>` passes through, and one that opens with `<answer>` is the answer from its first
 * character; both lose the `<answer>` wrapper (AnswerTagStrip).
 */
export class UntaggedReasoningHold {
	private held = "";
	private released = false;
	private opened = false;
	/** Characters of `held` already sent inside the opened block. */
	private sent = 0;
	private answer: AnswerTagStrip | undefined;
	/**
	 * Characters `flush` copied into the block from a reply that never closed it, which were the answer
	 * and not reasoning; `reasoningChars` subtracts them.
	 */
	copiedChars = 0;

	/** True while the first characters are held to tell `<think>` or `<answer>` from reasoning. */
	get holding(): boolean {
		return !this.released && !this.opened && this.held.length > 0;
	}

	push(chunk: string): string {
		if (this.released) return this.answer ? this.answer.push(chunk) : chunk;
		this.held += chunk;
		if (!this.opened) {
			const start = this.held.trimStart().toLowerCase();
			if (start.startsWith(OPEN) || start.startsWith(ANSWER_OPEN)) return this.release("", this.held);
			if (OPEN.startsWith(start) || ANSWER_OPEN.startsWith(start)) return "";
			this.opened = true;
		}
		const head = this.sent === 0 ? OPEN : "";
		const at = this.held.toLowerCase().indexOf(CLOSE);
		if (at >= 0)
			return this.release(head + this.held.slice(this.sent, at) + CLOSE, this.held.slice(at + CLOSE.length));
		const upTo = this.held.length - partialTagSuffix(this.held, CLOSE);
		if (upTo <= this.sent) return "";
		const out = head + this.held.slice(this.sent, upTo);
		this.sent = upTo;
		return out;
	}

	flush(cutOff = false): string {
		if (this.released) return this.answer ? this.answer.flush() : "";
		if (!this.opened) return cutOff ? this.release(OPEN + this.held) : this.release("", this.held, true);
		const rest = (this.sent === 0 ? OPEN : "") + this.held.slice(this.sent);
		if (cutOff) return this.release(rest);
		this.copiedChars = this.held.length;
		return this.release(rest + CLOSE, this.held, true);
	}

	/**
	 * `head` goes out as is; `answer`, when given, is the start of the answer, stripped from here on.
	 * `last` flushes the strip too, for a release made by `flush`, after which nothing flushes it.
	 */
	private release(head: string, answer?: string, last = false): string {
		this.released = true;
		this.held = "";
		if (answer === undefined) return head;
		this.answer = new AnswerTagStrip();
		return head + this.answer.push(answer) + (last ? this.answer.flush() : "");
	}
}

const ANSWER_OPEN = "<answer>";
const ANSWER_CLOSE = "</answer>";

/**
 * Drops the literal `<answer>` and `</answer>` ALIA wraps its reply in, with the whitespace just inside
 * them. Catalan drafting turns can come back as
 * "<answer> Hola! T'esperem dissabte… </answer>". Holds back a suffix that could start
 * either tag until the next push or `flush`.
 */
class AnswerTagStrip {
	private pending = "";

	push(chunk: string): string {
		const text = (this.pending + chunk).replace(/<answer>\s*/gi, "").replace(/\s*<\/answer>/gi, "");
		const tag = Math.max(partialTagSuffix(text, ANSWER_OPEN), partialTagSuffix(text, ANSWER_CLOSE));
		// The space before a partial `</answer>` is held with it, so the strip can drop both.
		const keep = Math.max(tag ? tag + trailingSpaceBeforeClose(text.slice(0, text.length - tag)) : 0, trailingSpaceBeforeClose(text));
		this.pending = text.slice(text.length - keep);
		return text.slice(0, text.length - keep);
	}

	flush(): string {
		const rest = this.pending;
		this.pending = "";
		return rest;
	}
}

/** Whitespace at the end of `text` that a `</answer>` in the next chunk would take with it. */
function trailingSpaceBeforeClose(text: string): number {
	return text.length - text.trimEnd().length;
}

function partialTagSuffix(text: string, tag: string): number {
	const lower = text.toLowerCase();
	for (let n = Math.min(tag.length - 1, lower.length); n > 0; n--) {
		if (tag.startsWith(lower.slice(lower.length - n))) return n;
	}
	return 0;
}
