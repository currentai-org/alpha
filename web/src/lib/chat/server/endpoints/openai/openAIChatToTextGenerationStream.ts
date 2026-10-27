import type { TextGenerationStreamOutput } from "@huggingface/inference";
import type OpenAI from "openai";
import type { Stream } from "openai/streaming";
import { logger } from "$lib/chat/server/logger";
import { ThinkFilter, UntaggedReasoningHold, dropsReasoning } from "./thinkFilter";
import { type InlineTool, InlineToolReferenceStrip, TOOL_REF_CLOSE, TOOL_REF_OPEN } from "./inlineToolReference";
import { opensReasoningUntagged } from "../../harnessProfiles";

// Appended when the model stops because it hit the token cap (finish_reason "length"), so a long answer
// never just ends mid-thought with no signal. User-facing — reword freely.
//
// It is appended ONCE, at the update() chokepoint in the conversation route, driven by the `truncated`
// flag this transform sets on the final chunk. Appending it here, to the accumulated generated_text or
// the final chunk's token text, does not carry it through output moderation: generate.ts takes its
// `generated_text` branch on that same chunk and `continue`s without ever yielding the token, and
// screenStream.ts rebuilds the answer body from Stream tokens alone, so the client receives the answer
// with no notice (CUR-149).
export const TRUNCATION_NOTICE =
	'\n\n_(Stopped at the length limit. Say "continue" for the rest.)_';

/** True when this is the final chunk because the model hit its token cap (not a natural stop). */
function isLengthTruncated(finishReason: string | null | undefined): boolean {
	return finishReason === "length";
}

/**
 * The one place the notice is written onto an answer. Idempotent, because the conversation route calls
 * it at a chokepoint that several producers reach and a re-emitted final must not stack notices.
 */
export function withTruncationNotice(text: string, truncated: boolean | undefined): string {
	if (!truncated || !text.trim() || text.endsWith(TRUNCATION_NOTICE)) return text;
	return text + TRUNCATION_NOTICE;
}

/**
 * A message's or delta's `content` as text, whatever shape the host sent. OpenAI sends a string; Mistral
 * can send a list of parts, `{type: "text", text}` beside `{type: "thinking", thinking: [...parts]}`.
 * Read as a string, that list crashed the stream on `.trim()` and the answer never finished (CUR-2340,
 * 19 `content.trim is not a function` on one preview's scenario run). Thinking parts come back as
 * reasoning, so the caller's own reasoning handling decides whether the visitor sees them.
 *
 * A `{type: "reference", reference_ids}` part is a citation. Mistral Large 3 sends one in place of the
 * `[n]` our prompt asks for whenever the request declares a tool, keeping our numbering, so it is
 * written back as `[n]`. Dropping it left every grounded Large 3 answer with no inline citations. A
 * reference whose id is a tool's name is a call written into the answer (CUR-2777): it is marked for
 * InlineToolReferenceStrip, which drops it with the arguments that follow.
 */
let loggedListContent = false;
function contentText(value: unknown): { text: string; thinking: string } {
	if (typeof value === "string") return { text: value, thinking: "" };
	if (!Array.isArray(value)) return { text: "", thinking: "" };
	// Once per instance, the part types only: the line that shows this path ran, not just that the
	// crash stopped (CUR-2340).
	if (!loggedListContent) {
		loggedListContent = true;
		const types = value.map((p) => (p && typeof p === "object" ? String((p as { type?: unknown }).type) : typeof p));
		logger.info({ types }, "[stream] content arrived as a list of parts");
	}
	let text = "";
	let thinking = "";
	for (const part of value) {
		if (typeof part === "string") text += part;
		else if (part && typeof part === "object") {
			const p = part as { type?: unknown; text?: unknown; thinking?: unknown; reference_ids?: unknown };
			if (p.type === "thinking") thinking += contentText(p.thinking).text;
			else if (p.type === "reference" && Array.isArray(p.reference_ids)) {
				for (const id of p.reference_ids) {
					if (Number.isInteger(id)) text += `[${id}]`;
					else if (typeof id === "string" && id) text += TOOL_REF_OPEN + id + TOOL_REF_CLOSE;
				}
			}
			else if (typeof p.text === "string") text += p.text;
		}
	}
	return { text, thinking };
}

/**
 * Transform a stream of OpenAI.Chat.ChatCompletion into a stream of TextGenerationStreamOutput
 */
/** How many images a request carries and how many characters of text, read off the
 *  wire messages. A photo turn's prefill runs longer than a text turn's, and the first-chunk allowance (CUR-4003)
 *  cannot be set per shape until the finish line says which shape each turn was. */
export type TurnShape = { imageParts: number; promptChars: number };

export function turnShapeOf(messages: ReadonlyArray<{ content?: unknown }>): TurnShape {
	let imageParts = 0;
	let promptChars = 0;
	for (const { content } of messages) {
		if (typeof content === "string") promptChars += content.length;
		else if (Array.isArray(content))
			for (const part of content as Array<{ type?: string; text?: unknown }>) {
				if (part?.type === "image_url") imageParts++;
				else if (typeof part?.text === "string") promptChars += part.text.length;
			}
	}
	return { imageParts, promptChars };
}

/** A tool call id for a call the model typed as text, in the only shape Mistral accepts: 9 of [a-zA-Z0-9]. */
function inlineCallId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	return Array.from({ length: 9 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export async function* openAIChatToTextGenerationStream(
	completionStream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
	getRouterMetadata?: () => { route?: string; model?: string; provider?: string; backend?: string; lane?: string },
	/** When the request left, so the finish line can say where the time went. Defaults to now. */
	sentAt: number = Date.now(),
	/** The request offered a tool, so assemble its tool_calls deltas and hand them back as one (CUR-2273)
	 *  `toolCalls` output in place of a final answer. Off, tool_calls deltas are ignored as before. */
	collectToolCalls = false,
	/** The model id this request asked for. A provider that reports the same model under its (CUR-1683)
	 *  own short name ("glm-5.2" for "zai-org/GLM-5.2") is recorded under this id instead. */
	requestedModel?: string,
	/** The tools this request declared, so a call typed into the answer as text is dropped. (CUR-2777) */
	toolNames: readonly InlineTool[] = [],
	/** What the request carried, so time to first chunk can be split by photo vs text turn. (CUR-4003) */
	shape?: TurnShape
) {
	let firstChunkAt: number | undefined;
	let generatedText = "";
	let tokenId = 0;
	// Arguments from tool_call deltas with id "" and name null: some providers stream a plain answer
	// that way. They are collected here and yielded as the generated text when the stream stops.
	let nullNameToolArgs = "";
	let metadataYielded = false;
	let thinkOpen = false;
	// A GLM answer goes out without its reasoning (CUR-1933). Decided from the body's own model id or
	// the lane's served-model seed, whichever names GLM first; both are known by the first chunk.
	let dropReasoning = false;
	const thinkFilter = new ThinkFilter();
	// A model whose reasoning opens with no tag has it held until its bare `</think>` (CUR-2470).
	// Decided on the first chunk, from the requested id or the body's own.
	let untaggedHold: UntaggedReasoningHold | undefined;
	let untaggedDecided = false;
	// The first chunk the hold keeps back is flagged once, so the client can show that ALIA
	// is reasoning instead of a blank wait. Only the flag travels: the held text has not been through
	// output screening, which reads content tokens alone. (CUR-3942)
	let heldSignalled = false;
	// Tool calls arrive in pieces keyed by index: id and name on the first delta, the arguments split
	// across the rest (OpenAI), or the whole call in one delta (Mistral). Both assemble the same way.
	const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
	const toolRefStrip = new InlineToolReferenceStrip(toolNames);

	// Header-derived provenance as one output, or undefined when the headers named nothing. Yield it if
	// there is any signal: complete router metadata, provider info, a served-model id (seeded by a
	// cross-model backup lane even when the host sends no provider header), or the LiteLLM backend host.
	// The `backend` case is what lets identity persist on a HEALTHY gateway turn (no X-Router-Model
	// header, body echoes the group): without it the served backend is captured in endpointOai.ts and
	// dropped here, so nothing downstream can assert WHICH lane answered (CUR-114/115).
	// `x-litellm-model-api-base` is the only header that names the real backend.
	//
	// The HF router names only the provider in its headers. The model that served is in the body's own
	// `model` field, so a provider-only report takes it from there; without it a turn on a pinned HF
	// lane persisted a provider and no served model (CUR-1683). Scaleway reports GLM-5.2 as "glm-5.2",
	// so a body id naming the requested model's last path segment is recorded under the requested id;
	// any other body id is a different model and is recorded as reported.
	const lastSegment = (id: string) => id.split("/").at(-1)?.toLowerCase();
	const headerMetadataOutput = (bodyModel?: string) => {
		const headerReport = getRouterMetadata?.();
		const served =
			bodyModel && requestedModel && lastSegment(bodyModel) === lastSegment(requestedModel)
				? requestedModel
				: bodyModel;
		const routerMetadata =
			headerReport?.provider && !headerReport.model && served
				? { ...headerReport, model: served }
				: headerReport;
		if (!(routerMetadata?.provider || routerMetadata?.model || routerMetadata?.backend)) return undefined;
		metadataYielded = true;
		return {
			token: {
				id: tokenId++,
				text: "",
				logprob: 0,
				special: true,
			},
			generated_text: null,
			details: null,
			routerMetadata,
		} as TextGenerationStreamOutput & {
			routerMetadata: { route?: string; model?: string; provider?: string; backend?: string; lane?: string };
		};
	};

	for await (const completion of completionStream) {
		firstChunkAt ??= Date.now();
		const retyped = completion as {
			"x-router-metadata"?: { route: string; model: string; provider?: string };
		};
		// Check if this chunk contains router metadata (first chunk from llm-router)
		if (!metadataYielded && retyped["x-router-metadata"]) {
			const metadata = retyped["x-router-metadata"];
			yield {
				token: {
					id: tokenId++,
					text: "",
					logprob: 0,
					special: true,
				},
				generated_text: null,
				details: null,
				routerMetadata: {
					route: metadata.route,
					model: metadata.model,
					provider: metadata.provider,
				},
			} as TextGenerationStreamOutput & {
				routerMetadata: { route: string; model: string; provider?: string };
			};
			metadataYielded = true;
			// Skip processing this chunk as content since it's just metadata
			if (
				!completion.choices ||
				completion.choices.length === 0 ||
				!completion.choices[0].delta?.content
			) {
				continue;
			}
		}
		// The headers were read before the first chunk (endpointOai.ts), so provenance goes out with it.
		// Held to the end, it was lost whenever the stream was cancelled early: output screening's phase
		// deadline cancels the source mid-answer, and that turn persisted no served model (CUR-2343).
		if (!metadataYielded) {
			const headerMetadata = headerMetadataOutput(completion.model || undefined);
			if (headerMetadata) yield headerMetadata;
		}
		// Usage counts (from stream_options.include_usage), surfaced so the caller can log token cost +
		// the prefix-cache hit ratio. Two wire shapes exist and BOTH must be handled:
		//
		//   trailing — a final chunk with empty choices and populated usage. The convention, and what
		//     this code assumed exclusively.
		//   merged   — usage attached to the SAME chunk that carries finish_reason "stop". The HF router
		//     serving zai-org/GLM-5.2-FP8 does this.
		//
		// The finish_reason chunk is the only one this transform marks `last`, i.e. the only one that
		// ever sets generated_text. Unconditionally `continue`ing past a usage chunk would therefore drop
		// the FINAL TEXT of every merged-shape stream, not merely its accounting: tokens still stream,
		// but consumers waiting on the final get nothing — generateFromDefaultEndpoint returns ""
		// and generate.ts never emits a FinalAnswer. The second-opinion panel's GLM panelist would fail
		// and, because the aggregator is the same model, the verdict would stay the neutral placeholder
		// (CUR-153).
		//
		// Which shape you get is a property of the BACKEND, not the model, so tolerate both here rather
		// than special-casing a model id anywhere upstream. For example, zai-org/GLM-5.2-FP8 has been seen to
		// send the merged shape, and zai-org/GLM-5.2 usually sends a trailing usage chunk but sometimes the
		// merged shape (with a trailing usage chunk as well, so two usage chunks in one stream).
		//
		// Do not reason from "FP8 merges, plain GLM-5.2 doesn't". The HF router fans out across providers, so
		// a model id does not pin a serving backend and the shape can differ between two calls a minute
		// apart. That is why the tolerate-both branch below is needed: FALLBACK_MODEL_ID is zai-org/GLM-5.2,
		// the cross-model backup lane that serves ORDINARY CHAT TURNS when the primary fails, and that lane
		// can hand us the merged shape.
		let mergedUsage: TextGenerationStreamOutput | undefined;
		if (completion.usage) {
			const promptDetails = completion.usage.prompt_tokens_details as
				{ cached_tokens?: number } | undefined;
			const usageEvent = {
				token: { id: tokenId++, text: "", logprob: 0, special: true },
				generated_text: null,
				details: null,
				usage: {
					promptTokens: completion.usage.prompt_tokens,
					completionTokens: completion.usage.completion_tokens,
					totalTokens: completion.usage.total_tokens,
					cachedTokens: promptDetails?.cached_tokens ?? null,
				},
			} as TextGenerationStreamOutput & {
				usage: {
					promptTokens: number;
					completionTokens: number;
					totalTokens: number;
					cachedTokens: number | null;
				};
			};
			const choice = completion.choices?.[0];
			const merged = choice?.delta as
				| { content?: string; reasoning?: string; reasoning_content?: string }
				| undefined;
			const carriesPayload = Boolean(
				choice &&
					(choice.finish_reason || merged?.content || merged?.reasoning || merged?.reasoning_content)
			);
			if (!carriesPayload) {
				yield usageEvent;
				continue;
			}
			// Hold it until the payload below has been emitted, so accounting still follows the final
			// answer on the merged shape exactly as it does on the trailing one.
			mergedUsage = usageEvent;
		}
		const { choices } = completion;
		const delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
			reasoning?: string;
			reasoning_content?: string;
		} = choices?.[0]?.delta ?? {};
		const parts = contentText(delta.content);
		const reasoning: string =
			(typeof delta?.reasoning === "string"
				? (delta.reasoning as string)
				: typeof delta?.reasoning_content === "string"
					? (delta.reasoning_content as string)
					: "") + parts.thinking;
		// Collected before `last` is decided, because the chunk carrying finish_reason can also carry
		// the whole call (Mistral).
		if (collectToolCalls && choices?.[0]?.delta?.tool_calls) {
			for (const [i, call] of choices[0].delta.tool_calls.entries()) {
				const index = typeof call.index === "number" ? call.index : i;
				const acc = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
				if (call.id) acc.id = call.id;
				if (call.function?.name) acc.name = call.function.name;
				if (call.function?.arguments) acc.arguments += call.function.arguments;
				toolCalls.set(index, acc);
			}
		}

		// A request that offered a tool ends in tool calls when calls arrived by the finishing chunk,
		// whatever the host names the reason ("tool_calls", or an ordinary "stop" from some hosts). That
		// chunk is not the answer's last: the tool loop continues it.
		let toolFinish =
			collectToolCalls && Boolean(choices?.[0]?.finish_reason) && toolCalls.size > 0;
		let last =
			!toolFinish &&
			(choices?.[0]?.finish_reason === "stop" || choices?.[0]?.finish_reason === "length");
		const ends = last || toolFinish;
		const content: string = toolRefStrip.push(parts.text) + (ends ? toolRefStrip.flush() : "");

		// On stop, yield the collected null-name tool-call arguments as the generated text.
		if (choices?.[0]?.finish_reason === "stop" && nullNameToolArgs.length > 0) {
			yield {
				token: {
					id: tokenId++,
					special: true,
					logprob: 0,
					text: "",
				},
				generated_text: nullNameToolArgs,
				details: null,
			} as TextGenerationStreamOutput;
			break;
		}

		// The provider quirk above: a single tool_call delta with id "" and name null carries answer text.
		if (!collectToolCalls && choices?.[0]?.delta?.tool_calls) {
			const calls = Array.isArray(choices[0].delta.tool_calls)
				? choices[0].delta.tool_calls
				: [choices[0].delta.tool_calls];

			if (
				calls.length === 1 &&
				calls[0].index === 0 &&
				calls[0].id === "" &&
				calls[0].type === "function" &&
				!!calls[0].function &&
				calls[0].function.name === null
			) {
				nullNameToolArgs += calls[0].function.arguments;
				continue;
			}
		}

		if (!dropReasoning) {
			dropReasoning =
				dropsReasoning(completion.model) || dropsReasoning(getRouterMetadata?.()?.model);
		}

		if (!untaggedDecided) {
			untaggedDecided = true;
			if (opensReasoningUntagged(requestedModel) || opensReasoningUntagged(completion.model)) {
				untaggedHold = new UntaggedReasoningHold();
			}
		}
		const answerText = untaggedHold
			? untaggedHold.push(content) +
				(last ? untaggedHold.flush(isLengthTruncated(choices?.[0]?.finish_reason)) : "")
			: content;
		const reasoningHeld = !heldSignalled && !last && !!untaggedHold?.holding;
		if (reasoningHeld) heldSignalled = true;

		let combined = "";
		if (dropReasoning) {
			thinkFilter.stripped += reasoning.length;
			combined = thinkFilter.push(content) + (last ? thinkFilter.flush() : "");
		} else if (reasoning && reasoning.length > 0) {
			if (!thinkOpen) {
				combined += "<think>" + reasoning;
				thinkOpen = true;
			} else {
				combined += reasoning;
			}
		}

		if (!dropReasoning && answerText && answerText.length > 0) {
			const trimmed = answerText.trim();
			// Allow <think> tags in content to pass through (for models like DeepSeek R1)
			if (thinkOpen && trimmed === "</think>") {
				// close once without duplicating the tag
				combined += "</think>";
				thinkOpen = false;
			} else if (thinkOpen) {
				combined += "</think>" + answerText;
				thinkOpen = false;
			} else {
				combined += answerText;
			}
		}
		// A round that ends in a tool call is not the answer's last chunk, and the next round opens its
		// own stream. Close the reasoning here, or the answer the next round writes lands inside it
		// (CUR-3748: "<think>…Let's call calculate.42").
		if (toolFinish && thinkOpen) {
			combined += "</think>";
			thinkOpen = false;
		}

		// Accumulate the combined token into the full text
		generatedText += combined;
		// On the tool_choice "none" round after the calculate cap, a model can write its call
		// as text and nothing else. The strip drops it, the round ends with no visible text, and the
		// turn reads "couldn't answer". A round whose only output was such a call ends in
		// that call instead, so the tool loop runs it. With any visible text the call stays dropped and
		// unrun: the answer around it has already streamed. (CUR-4495)
		if (
			last &&
			collectToolCalls &&
			toolCalls.size === 0 &&
			toolRefStrip.dropped.length > 0 &&
			generatedText.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim() === ""
		) {
			for (const [i, c] of toolRefStrip.dropped.entries())
				toolCalls.set(i, { id: inlineCallId(), name: c.name, arguments: c.arguments });
			logger.warn(
				{ model: completion.model, tools: toolRefStrip.dropped.map((c) => c.name).join(",") },
				"[generation] round wrote only an inline tool call; running it as a tool call"
			);
			last = false;
			toolFinish = true;
			if (thinkOpen) {
				generatedText += "</think>";
				combined += "</think>";
				thinkOpen = false;
			}
		}
		// The model stopped at its token cap, and there is actual content to annotate (never flag an
		// empty/aborted generation). Travels as a flag on the output — the notice is text, and text on
		// this chunk does not survive to the user; see TRUNCATION_NOTICE above.
		const truncated =
			last && isLengthTruncated(choices?.[0]?.finish_reason) && generatedText.trim().length > 0;
		if (last) {
			// WHY the generation ended, recorded once per turn at the only place that sees it. Nothing
			// downstream carries this: `interrupted` is computed from token.special (always true on the
			// final chunk, so a capped answer reports false), and `[turn] outcome` says `complete` for a
			// natural stop and a hard token cap alike. A user reading an answer that ends mid-word had
			// no counterpart in any log (CUR-149).
			logger.info(
				{
					// The model AS THE BACKEND NAMES IT on the chunk. Without it this line could say a
					// generation was capped but not which of four panelists it was, which is exactly the
					// question a fanout route raises (CUR-149).
					model: completion.model,
					finishReason: choices?.[0]?.finish_reason,
					chars: generatedText.length,
					truncated,
					// Length only: the reasoning restates the prompt, so its text is not logged either.
					...(dropReasoning ? { reasoningStripped: thinkFilter.stripped } : {}),
					// Where the time went and who served it, so "why was this slow" is an Axiom query
					// and not a probe. ttfbMs is the first chunk, not the headers.
					ttfbMs: (firstChunkAt ?? Date.now()) - sentAt,
					totalMs: Date.now() - sentAt,
					provider: getRouterMetadata?.()?.provider,
					...(shape ?? {}),
				},
				"[generation] finish"
			);
		}
		// The headers were read before the first chunk, so provenance is known by now. It goes out ahead
		// of the final token, which is what becomes FinalAnswer: the conversation route persists the turn
		// on FinalAnswer, and metadata that trailed it was missing from that write (CUR-2078).
		// A provider can send its last content delta on the same chunk as finish_reason. generate.ts
		// turns the final chunk into FinalAnswer without streaming its text, and output screening builds
		// the answer from streamed text alone, so that delta would be dropped: "17 × 23 = 391." would
		// leave "17 × 23" (CUR-2081). Stream it as an ordinary token first.
		if (last && combined) {
			yield {
				token: { id: tokenId++, text: combined, logprob: 0, special: false },
				generated_text: null,
				details: null,
			};
			combined = "";
		}
		const output: TextGenerationStreamOutput & { truncated?: boolean; reasoningHeld?: true } = {
			token: {
				id: tokenId++,
				text: combined,
				logprob: 0,
				special: last,
			},
			generated_text: last ? generatedText : null,
			details: null,
			...(truncated ? { truncated: true } : {}),
			...(reasoningHeld ? { reasoningHeld: true as const } : {}),
		};
		yield output;
		if (toolFinish) {
			// Medium 3.5 sometimes sends the name padded ("\t\t web_search"). Kept verbatim, the
			// kit matched no tool and the next round replayed the name, which LiteLLM refuses with a 400
			// that ends the turn. Trimmed here, dispatch and replay both see the declared name. The raw
			// name is logged so the model's side of it stays measurable, and a name that matches no
			// declared tool even after trimming is logged too (the kit answers it "no tool named"). (CUR-4362)
			const declared = new Set(toolNames.map((t) => (typeof t === "string" ? t : t.name)));
			const raw = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
			const calls = raw.map((c) => ({ ...c, name: c.name.trim() }));
			for (const [i, c] of raw.entries()) {
				const name = calls[i].name;
				if (c.name !== name || (declared.size > 0 && !declared.has(name)))
					logger.warn(
						{ model: completion.model, rawName: JSON.stringify(c.name), declared: declared.has(name) },
						"[generation] tool call name normalised"
					);
			}
			logger.info(
				{
					model: completion.model,
					finishReason: choices?.[0]?.finish_reason,
					toolCalls: toolCalls.size,
					chars: generatedText.length,
					ttfbMs: (firstChunkAt ?? Date.now()) - sentAt,
					totalMs: Date.now() - sentAt,
				},
				"[generation] tool calls"
			);
			yield {
				token: { id: tokenId++, text: "", logprob: 0, special: true },
				generated_text: null,
				details: null,
				toolCalls: calls,
			} as TextGenerationStreamOutput & {
				toolCalls: { id: string; name: string; arguments: string }[];
			};
		}
		if (mergedUsage) yield mergedUsage;

		// Tools removed: ignore tool_calls deltas
	}

	// A stream that ended with no finishing chunk still releases whatever it was holding (CUR-2470).
	const held = untaggedHold?.flush();
	if (held) {
		generatedText += held;
		yield { token: { id: tokenId++, text: held, logprob: 0, special: false }, generated_text: null, details: null };
	}

	// A stream that sent no chunk at all still reports what served it.
	if (!metadataYielded) {
		const headerMetadata = headerMetadataOutput();
		if (headerMetadata) yield headerMetadata;
	}
}

/**
 * Transform a non-streaming OpenAI chat completion into a stream of TextGenerationStreamOutput
 */
export async function* openAIChatToTextGenerationSingle(
	completion: OpenAI.Chat.Completions.ChatCompletion,
	getRouterMetadata?: () => { route?: string; model?: string; provider?: string; backend?: string; lane?: string }
) {
	const message: NonNullable<OpenAI.Chat.Completions.ChatCompletion.Choice>["message"] & {
		reasoning?: string;
		reasoning_content?: string;
	} = completion.choices?.[0]?.message ?? {};
	const parts = contentText(message?.content);
	const strip = new InlineToolReferenceStrip();
	let content: string = strip.push(parts.text) + strip.flush();
	// Provider-dependent reasoning shapes (non-streaming)
	const r: string =
		(typeof message?.reasoning === "string"
			? (message.reasoning as string)
			: typeof message?.reasoning_content === "string"
				? (message.reasoning_content as string)
				: "") + parts.thinking;
	if (r && r.length > 0) {
		content = `<think>${r}</think>` + content;
	} else if (opensReasoningUntagged(completion.model)) {
		const hold = new UntaggedReasoningHold();
		content =
			hold.push(content) + hold.flush(isLengthTruncated(completion.choices?.[0]?.finish_reason));
	}
	// Same flag, same reason as the streaming path: one append site, at the update() chokepoint.
	const truncated =
		isLengthTruncated(completion.choices?.[0]?.finish_reason) && content.trim().length > 0;
	const tokenId = 0;

	// Yield the content as a single token
	yield {
		token: {
			id: tokenId,
			text: content,
			logprob: 0,
			special: false,
		},
		generated_text: content,
		details: null,
		...(truncated ? { truncated: true } : {}),
		...(getRouterMetadata
			? (() => {
					const metadata = getRouterMetadata();
					// Same provenance-signal rule as the streaming path: provider info or a served-model id
					// (the latter seeded by a cross-model backup lane).
					return metadata?.provider || metadata?.model ? { routerMetadata: metadata } : {};
				})()
			: {}),
	} as TextGenerationStreamOutput & {
		routerMetadata?: { route?: string; model?: string; provider?: string; backend?: string; lane?: string };
		truncated?: boolean;
	};
}
