import { mistralLaneFor } from "./modelsCatalog";

/** Where a live spec sends a turn for one model, and the id that host knows it by. */
export interface ModelUnderTestEndpoint {
	baseURL: string;
	apiKey: string;
	/** The id to put in the request body: the host's own name for the model when it differs from ours. */
	wireModel: string;
	/** Whether the turn goes to chat's Mistral lane or to the OpenAI-compatible endpoint. */
	lane: "mistral" | "openai";
}

/**
 * The host, key and wire id a real turn on `modelId` reaches, for a live spec calling the model directly:
 * chat's Mistral lane when it serves the model (`mistralLaneFor`, the lookup the warm probe uses), else
 * `fallback`, the spec's OPENAI_BASE_URL and key. Posting a Mistral id to OPENAI_BASE_URL gets a refusal
 * from a gateway that never serves it, which a live spec would report as the model failing.
 */
export function modelUnderTestEndpoint(
	modelId: string,
	fallback: { baseURL?: string; apiKey?: string }
): ModelUnderTestEndpoint {
	const mistral = mistralLaneFor(modelId);
	if (mistral) {
		return {
			baseURL: mistral.baseURL.replace(/\/+$/, ""),
			apiKey: mistral.apiKey,
			wireModel: mistral.wireId,
			lane: "mistral",
		};
	}
	return {
		baseURL: (fallback.baseURL ?? "").replace(/\/+$/, ""),
		apiKey: fallback.apiKey ?? "",
		wireModel: modelId,
		lane: "openai",
	};
}
