// GLM reasons before it answers, and on the lanes that serve it that reasoning reaches this client
// in one of two shapes: a separate `reasoning_content` delta (the Hugging Face router's providers) or `<think>…</think>` inline in `content` (a vLLM server with no reasoning
// parser). It restates the prompt it was given ("Let me use the calc block as required"), and an
// Apertus turn has no such block, so a GLM answer is sent with its reasoning removed (CUR-1933).

import { reasoningOffFields, splitWireId } from "../../modelProfiles";
import { hfPinnedProvider, isHfRouter } from "./providerPin";

/** The served model is one whose reasoning is removed from the answer. */
export function dropsReasoning(modelId: string | undefined): boolean {
	return !!modelId && /(^|\/)glm-/i.test(modelId.trim());
}

/**
 * The wire model id and fields for a GLM call that must not reason (a title, a classifier, the math
 * ledger). On the HF router an id in modelProfiles.ts's pin table is pinned with a `:provider` suffix,
 * unless it already carries one; endpointOai has usually pinned it before this runs. The fields come
 * from the verified profile row for the model and the provider the id ends up naming
 * (modelProfiles.ts): Scaleway honours `reasoning_effort: "none"` and ignores `thinking`, novita and
 * zai-org the reverse.
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
	// 422 extra_forbidden on `thinking` (CUR-2282). Its models get no field at all.
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
 * For a model whose reasoning opens with no tag (harnessProfiles.ts `opensReasoningUntagged`, CUR-2470):
 * holds its content until the bare `</think>` arrives, then releases the held part as a closed
 * `<think>…</think>` block, which the client folds away like any other, and streams the rest as the
 * answer. A stream that ends with no `</think>` was an answer with no reasoning, so `flush` releases
 * the held text unchanged rather than hiding it. One cut off at the token cap (`cutOff`) was still
 * reasoning, so it is released as an open `<think>` block, which the client folds and reports as a turn
 * with no answer; a model that runs out mid-reasoning would otherwise show the reasoning as its
 * reply. A reply that does open with `<think>` passes through, less any
 * `<answer>` wrapper.
 *
 * The answer part also loses ALIA's `<answer>…</answer>` wrapper (AnswerTagStrip).
 */
export class UntaggedReasoningHold {
	private held = "";
	private released = false;
	private answer: AnswerTagStrip | undefined;

	/** True while text is held and not yet released as reasoning or answer (CUR-3942). */
	get holding(): boolean {
		return !this.released && this.held.length > 0;
	}

	push(chunk: string): string {
		if (this.released) return this.answer ? this.answer.push(chunk) : chunk;
		this.held += chunk;
		if (this.held.trimStart().toLowerCase().startsWith(OPEN)) return this.release("", this.held);
		const at = this.held.toLowerCase().indexOf(CLOSE);
		if (at < 0) return "";
		return this.release(OPEN + this.held.slice(0, at) + CLOSE, this.held.slice(at + CLOSE.length));
	}

	flush(cutOff = false): string {
		if (this.released) return this.answer ? this.answer.flush() : "";
		if (cutOff) return this.release(OPEN + this.held);
		return this.release("", this.held, true);
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
 * "<answer> Hola! T'esperem dissabte… </answer>" (CUR-2470). Holds back a suffix that could start
 * either tag until the next push or `flush`.
 */
class AnswerTagStrip {
	private pending = "";

	push(chunk: string): string {
		const text = (this.pending + chunk).replace(/<answer>\s*/gi, "").replace(/\s*<\/answer>/gi, "");
		const keep = Math.max(
			partialTagSuffix(text, ANSWER_OPEN),
			partialTagSuffix(text, ANSWER_CLOSE),
			trailingSpaceBeforeClose(text)
		);
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
