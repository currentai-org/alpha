/**
 * One Anthropic Messages call whose answer is a tool call, shared by the persona driver and the cold-walk
 * driver. The decoder is held to the tool's schema, so there is no reply text to parse; the callers still
 * validate the input, because a schema cannot say whether a ref names something on the current page.
 */
export type ToolChoice = { type: 'tool'; name: string } | { type: 'any' } | { type: 'auto' };

export async function anthropicToolCall(opts: {
	apiKey: string;
	model: string;
	system: string;
	user: string;
	/** Base64 PNGs shown before the text, such as a screenshot of the page the text describes. */
	images?: string[];
	tools: object[];
	choice: ToolChoice;
	maxTokens: number;
	/** Mark the system block for the prompt cache. Worth it only when the system prompt alone is long
	 *  enough to be cached and is resent within the TTL. */
	cacheSystem: boolean;
	/** Prefix of the per-call usage line on stderr, so a run's log shows whether the cache writes and reads. */
	logTag: string;
}): Promise<{ name: string; input: unknown } | null> {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': opts.apiKey,
			'anthropic-version': '2023-06-01'
		},
		body: JSON.stringify({
			model: opts.model,
			max_tokens: opts.maxTokens,
			system: opts.cacheSystem
				? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
				: opts.system,
			messages: [
				{
					role: 'user',
					content: opts.images?.length
						? [
								...opts.images.map((data) => ({
									type: 'image',
									source: { type: 'base64', media_type: 'image/png', data }
								})),
								{ type: 'text', text: opts.user }
							]
						: opts.user
				}
			],
			tools: opts.tools,
			tool_choice: opts.choice
		})
	});
	if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
	const data = (await res.json()) as {
		content?: { type: string; name?: string; input?: unknown }[];
		usage?: Record<string, number>;
	};
	const u = data.usage ?? {};
	console.error(
		`[${opts.logTag}] input=${u.input_tokens ?? '?'} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens ?? '?'}`
	);
	const block = data.content?.find((b) => b.type === 'tool_use');
	return block ? { name: block.name ?? '', input: block.input } : null;
}
