// Open WebUI's names for the model endpoint, read so an operator moving from Open WebUI starts Alpha
// with the env file they already have. Names only: nothing here comes from Open WebUI's code.
//
// The model layer serves ONE OpenAI-compatible endpoint (OPENAI_BASE_URL with OPENAI_API_KEY), so a
// list of several takes the first pair and reports how many it dropped.

type OpenAiEnvSource = "alpha" | "open-webui" | "none";

export type OpenAiEnvResolution = {
	/** Which name set decided the endpoint. "none" means neither was set. */
	source: OpenAiEnvSource;
	/** Set only when source is "open-webui": the values to use for OPENAI_BASE_URL / OPENAI_API_KEY. */
	baseUrl?: string;
	apiKey?: string;
	/** Endpoints in OPENAI_API_BASE_URLS past the first, which the model layer cannot serve. */
	ignoredEndpoints: number;
	/** Set when OPENAI_API_KEYS held a different number of keys than there are URLs: how many it held.
	 *  Open WebUI pads missing keys with empty ones and drops extras, and so does this. */
	keysGiven?: number;
	/** True when Alpha's own OPENAI_BASE_URL won while the Open WebUI names were also set. */
	openWebUiShadowed: boolean;
};

// "a;b;" is a common spelling of a two-item list, so one trailing empty item is dropped.
const splitList = (raw: string): string[] => {
	if (!raw.trim()) return [];
	const parts = raw.split(";").map((p) => p.trim());
	if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
	return parts;
};

/** Decide which name set supplies the model endpoint. Keys pair with URLs the way Open WebUI 0.12.0 pairs
 *  them: OPENAI_API_KEYS falls back to OPENAI_API_KEY, a missing key is empty (a keyless endpoint) and an
 *  extra key is dropped. Throws only when the first URL is empty. */
export function resolveOpenAiEnv(env: Record<string, string | undefined>): OpenAiEnvResolution {
	const own = (env.OPENAI_BASE_URL ?? "").trim();
	const urlsRaw = env.OPENAI_API_BASE_URLS ?? "";
	const keysRaw = env.OPENAI_API_KEYS ?? "";
	const owuiSet = Boolean(urlsRaw.trim());

	if (own) {
		return {
			source: "alpha",
			ignoredEndpoints: 0,
			openWebUiShadowed: owuiSet,
		};
	}
	if (!owuiSet) return { source: "none", ignoredEndpoints: 0, openWebUiShadowed: false };

	const urls = splitList(urlsRaw);
	const given = splitList(keysRaw.trim() ? keysRaw : (env.OPENAI_API_KEY ?? ""));
	const keys = urls.map((_, i) => given[i] ?? "");
	if (!urls[0]) {
		throw new Error("OPENAI_API_BASE_URLS starts with an empty URL; the first entry must be a base URL.");
	}
	return {
		source: "open-webui",
		baseUrl: urls[0],
		apiKey: keys[0],
		ignoredEndpoints: urls.length - 1,
		...(given.length !== urls.length ? { keysGiven: given.length } : {}),
		openWebUiShadowed: false,
	};
}
