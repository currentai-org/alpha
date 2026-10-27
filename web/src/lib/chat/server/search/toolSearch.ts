// The web_search tool schema. searchDecision.decideSearchViaTool advertises it for the "tool" trigger
// strategy, where the model decides whether to search and writes the query; nativeTools.ts offers it
// on the native tool path.

/**
 * The function/tool schema advertised to the model. Shape matches OpenAI's tools[] entry. Kept here
 * (not inlined at the call site) so the search contract — open-knowledge only, single query string —
 * is explicit.
 */
// On the native path the model is the search decider, so the tool description names the
// kinds of question that need search, such as rules and rights in a named country, which a model
// can otherwise answer from memory with only the first two sentences. (CUR-2423)
export const WEB_SEARCH_TOOL = {
	type: "function",
	function: {
		name: "web_search",
		description:
			"Search open knowledge bases (Wikipedia + Firecrawl + OpenAlex) for current or external information beyond your training data. Use only when the answer needs recent facts, live data, or anything you cannot reliably know. A question about someone's rights, or the rules, fees or deadlines that apply to them, in a named country or region counts: laws there change after your training, so search for its official sources. Returns numbered sources to cite.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "A focused search query capturing what to look up.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} as const;
