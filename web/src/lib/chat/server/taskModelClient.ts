import type OpenAI from "openai";
import { config } from "$lib/chat/server/config";
import { endpointApiKey } from "$lib/chat/server/endpointKey";

/**
 * A client on TASK_MODEL's own registered lane, with the model id to send. null when TASK_MODEL is
 * unset or names no registered model with a usable endpoint.
 *
 * The forced-tool side calls that must run on that lane (violenceRecheck, groundcheck) open their
 * client here rather than each re-deriving the lane.
 */
async function taskModelClient(
	timeoutMs: number
): Promise<{ client: OpenAI; modelId: string } | null> {
	const modelId = ((Reflect.get(config, "TASK_MODEL") as string | undefined) ?? "").trim();
	if (!modelId) return null;
	// Imported here, not at the top: models.ts reads its whole config at import, and specs of the
	// callers that never reach this path should not pay for it.
	const { models } = await import("$lib/chat/server/models");
	const ep = models.find((m) => m.id === modelId)?.endpoints?.[0] as
		| { baseURL?: string; apiKeyEnv?: string; modelId?: string }
		| undefined;
	const apiKey = endpointApiKey(ep);
	if (!ep?.baseURL || !apiKey) return null;
	const { createOpenAIClient } = await import("$lib/chat/server/openaiClient");
	const client: OpenAI = await createOpenAIClient({
		baseURL: ep.baseURL,
		apiKey,
		timeout: timeoutMs,
		defaultHeaders: { "User-Agent": "aipotluck.org" },
	});
	// The endpoint's `modelId` is the id its host knows the model by: a router can name
	// mistral-small-2603 `mistralai/mistral-small-2603` and answer 400 to ours (CUR-3057, CUR-3055).
	return { client, modelId: ep.modelId || modelId };
}

/**
 * One forced call of `tool` on TASK_MODEL's lane: a system message, a user message, temperature 0.
 * Returns the first tool call for the caller to parse, or null when TASK_MODEL is unset or
 * unregistered. Throws on a transport failure.
 */
export async function forcedTaskModelToolCall(opts: {
	system: string;
	user: string;
	tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
	maxTokens: number;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<unknown> {
	const lane = await taskModelClient(opts.timeoutMs);
	if (!lane) return null;
	const res = await lane.client.chat.completions.create(
		{
			model: lane.modelId,
			messages: [
				{ role: "system", content: opts.system },
				{ role: "user", content: opts.user },
			],
			tools: [opts.tool],
			tool_choice: { type: "function", function: { name: opts.tool.function.name } },
			temperature: 0,
			max_tokens: opts.maxTokens,
		},
		{ signal: opts.signal, timeout: opts.timeoutMs }
	);
	return res.choices?.[0]?.message?.tool_calls?.[0] ?? null;
}
