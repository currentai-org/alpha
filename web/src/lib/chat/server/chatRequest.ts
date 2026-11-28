// The one place a chat-completion body picks up its (model, provider) quirks before it is sent.
// modelProfiles.ts says what each pair accepts; before this module, each caller asked it for the
// quirks it knew about and skipped the rest, so a side call could go out with a system role to a
// deployment that refuses it, or with `reasoning_effort: "none"` to gpt-oss, which answers 400.
//
// The main chat path (endpointOai.ts) applies the profile itself, around its native-first and
// strict-lane logic, and is the one caller that does not come through here. eslint.config.js refuses a
// direct `.chat.completions` call or a hand-built `/chat/completions` URL anywhere else.

import type OpenAI from "openai";
import type { APIPromise } from "openai";
import { acceptedEffort, rolesNeedFlattening, type Effort } from "./modelProfiles";
import { reasoningOffRequest } from "./endpoints/openai/thinkFilter";
import { flattenForApertus } from "./endpoints/openai/flattenForApertus";

type ChatBody = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatRequestOptions = Parameters<OpenAI["chat"]["completions"]["create"]>[1];

export interface ChatQuirks {
	/** The host the call goes to. It picks the gateway's profile row and the reasoning-off fields. */
	baseURL: string | undefined;
	/**
	 * "off" sends the fields that turn reasoning off for the pair, and pins the HF provider that honours
	 * them (thinkFilter.ts). An effort is sent as `reasoning_effort`, replaced by the nearest one the
	 * pair accepts. Omitted, neither is sent.
	 */
	reasoning?: "off" | Effort;
	/**
	 * The gateway's base URL, for "off": a host that is neither the gateway nor the HF router gets no
	 * reasoning field at all, since Mistral's API answers 422 to `thinking`.
	 */
	gatewayBaseURL?: string;
	/**
	 * "profile" (the default) sends the messages as one user message when some measured lane for the
	 * model refuses other roles (`rolesNeedFlattening`). "keep" sends them as written, for a caller whose
	 * transcript cannot survive flattening (tool calls and their results) or that must match another
	 * request's shape; the caller says which next to it.
	 */
	roles?: "profile" | "keep";
}

/**
 * The body to send: `body` with its model, messages and reasoning fields made to fit the pair that will
 * serve it. Every other field passes through in its own position, and a quirk that does not apply
 * leaves the body as it was, so a caller that needs none of them sends exactly what it built.
 */
export function buildChatRequest<B extends ChatBody>(body: B, quirks: ChatQuirks): B {
	let model = body.model;
	let fields: Record<string, unknown> = {};
	if (quirks.reasoning === "off") {
		const off = reasoningOffRequest(body.model, quirks.baseURL, quirks.gatewayBaseURL);
		model = off.model;
		fields = off.fields;
	} else if (quirks.reasoning) {
		const effort = acceptedEffort(body.model, quirks.baseURL, quirks.reasoning);
		if (effort) fields = { reasoning_effort: effort };
	}
	const flatten = (quirks.roles ?? "profile") === "profile" && rolesNeedFlattening(model);
	const messages = flatten ? flattenForApertus(body.messages) : body.messages;
	return { ...body, model, messages, ...fields } as B;
}

/** One non-streaming completion on `client`, with the body built by `buildChatRequest`. */
export function createChatCompletion(
	client: OpenAI,
	body: ChatBody,
	quirks: ChatQuirks,
	options?: ChatRequestOptions
): APIPromise<OpenAI.Chat.Completions.ChatCompletion> {
	return client.chat.completions.create(buildChatRequest(body, quirks), options);
}

/**
 * The same request as a bare `fetch` to `${baseURL}/chat/completions`, for a caller that reads the raw
 * response (status, headers) rather than the SDK's parsed one. Resolves on any HTTP status, as fetch does.
 */
export function postChatCompletion(
	baseURL: string,
	body: ChatBody,
	quirks: Omit<ChatQuirks, "baseURL">,
	init: { headers: Record<string, string>; signal?: AbortSignal }
): Promise<Response> {
	return fetch(`${baseURL}/chat/completions`, {
		method: "POST",
		headers: init.headers,
		body: JSON.stringify(buildChatRequest(body, { ...quirks, baseURL })),
		signal: init.signal,
	});
}
