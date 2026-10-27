import { isHfRouter } from "./providerPin";

const norm = (u: string) => u.trim().replace(/\/+$/, "");

/**
 * The lane talks straight to a model's own host (Mistral's La Plateforme, CUR-2272): neither the
 * LiteLLM gateway nor the Hugging Face router sits in front of it.
 *
 * @remarks
 * Those two report what answered in response headers (`x-litellm-model-api-base`,
 * `x-inference-provider`). A direct host sends neither, so the only record of the served model is
 * the model id in its own response body, and the backend is the host we connected to (CUR-2283).
 */
export function isDirectLane(baseURL: string | undefined, gatewayBaseURL: string | undefined): boolean {
	if (!baseURL || !gatewayBaseURL) return false;
	if (norm(baseURL) === norm(gatewayBaseURL)) return false;
	return !isHfRouter(baseURL);
}
