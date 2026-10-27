import { config } from "$lib/chat/server/config";
import { firstKey } from "$lib/chat/server/env/firstKey";

export function getApiToken(locals: App.Locals | undefined) {
	if (config.USE_USER_TOKEN === "true") {
		if (!locals?.token) {
			throw new Error("User token not found");
		}
		return locals.token;
	}
	// OPENAI_API_KEY-first assumes the caller's baseURL is CSCS. True only while OPENAI_BASE_URL is set
	// in every real deployment — endpoint.ts defaults to the Hugging Face router when it is unset,
	// which would send this CSCS key there instead. Check both envs before touching either side.
	return firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "apiToken");
}
