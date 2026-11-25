// Open WebUI's names for the model endpoint, read so an operator moving from Open WebUI starts Alpha
// with the env file they already have. Names only: nothing here comes from Open WebUI's code.
//
// The first pair becomes OPENAI_BASE_URL with OPENAI_API_KEY, the primary endpoint. Every later pair is
// an extra endpoint whose models join the picker (openWebUiExtraEndpoints). The self-host agent
// gateway reads the same names with its own resolver and serves the first pair only.

type OpenAiEnvSource = "alpha" | "open-webui" | "none";

export type OpenAiEnvResolution = {
	/** Which name set decided the endpoint. "none" means neither was set. */
	source: OpenAiEnvSource;
	/** Set only when source is "open-webui": the values to use for OPENAI_BASE_URL / OPENAI_API_KEY. */
	baseUrl?: string;
	apiKey?: string;
	/** Endpoints in OPENAI_API_BASE_URLS past the first. The web app serves them as extra endpoints;
	 *  the agent gateway, which shares this shape and its test cases, ignores them. */
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
	const owuiSet = Boolean(urlsRaw.trim());

	if (own) {
		return {
			source: "alpha",
			ignoredEndpoints: 0,
			openWebUiShadowed: owuiSet,
		};
	}
	if (!owuiSet) return { source: "none", ignoredEndpoints: 0, openWebUiShadowed: false };

	const { urls, keys, given } = pairs(env);
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

// Keys pair with URLs as Open WebUI 0.12.0 pairs them: OPENAI_API_KEYS falls back to OPENAI_API_KEY, a
// missing key is empty and an extra key is dropped.
function pairs(env: Record<string, string | undefined>) {
	const urls = splitList(env.OPENAI_API_BASE_URLS ?? "");
	const keysRaw = env.OPENAI_API_KEYS ?? "";
	const given = splitList(keysRaw.trim() ? keysRaw : (env.OPENAI_API_KEY ?? ""));
	return { urls, keys: urls.map((_, i) => given[i] ?? ""), given };
}

/** The env names config.ts files the n-th Open WebUI endpoint under (n from 2), so a model's endpoint
 *  names its key by variable, never by value. */
export const extraEndpointEnv = (n: number) => ({
	urlEnv: `OWUI_ENDPOINT_${n}_URL`,
	keyEnv: `OWUI_ENDPOINT_${n}_KEY`,
});

export type ExtraEndpoint = { n: number; baseUrl: string; apiKey: string };

/** The extra endpoints config.ts filed, read back by name, in list order. Key values stay in config. */
export function filedExtraEndpoints(read: (name: string) => string | undefined): { n: number; baseURL: string; apiKeyEnv: string }[] {
	const filed = [];
	// Open WebUI has no limit on its list; 64 entries is far past any real stack.
	for (let n = 2; n <= 64; n++) {
		const { urlEnv, keyEnv } = extraEndpointEnv(n);
		const baseURL = (read(urlEnv) ?? "").trim();
		if (baseURL) filed.push({ n, baseURL, apiKeyEnv: keyEnv });
	}
	return filed;
}

/** Every OPENAI_API_BASE_URLS endpoint past the first, with its key, numbered from 2 in list order.
 *  Empty when Alpha's own OPENAI_BASE_URL is set, since that wins over the Open WebUI names. An empty
 *  URL past the first is skipped, and keeps its number so later keys still pair by position. */
export function openWebUiExtraEndpoints(env: Record<string, string | undefined>): ExtraEndpoint[] {
	if ((env.OPENAI_BASE_URL ?? "").trim()) return [];
	const { urls, keys } = pairs(env);
	return urls
		.map((url, i) => ({ n: i + 1, baseUrl: url.replace(/\/$/, ""), apiKey: keys[i] }))
		.filter((e) => e.n > 1 && e.baseUrl);
}
