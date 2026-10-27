/**
 * The one rule for sending `X-HF-Bill-To` on a chat-model call (CUR-1877).
 *
 * The header is an HF Inference-Providers concept: the HF router reads it to bill an org instead of
 * the token's user, and 403s an org-scoped token without it. No other host reads it. The LiteLLM
 * gateway answers the same with or without it, and
 * sending an org name to a direct host such as api.mistral.ai only leaks it.
 *
 * @remarks Callers that build their own fixed-HF client (embeddings, rerank, the injection screen)
 * talk to an HF host by construction and keep their own header; this is for calls whose base URL
 * is configurable.
 */

import { isHfRouter } from "$lib/chat/server/endpoints/openai/providerPin";

/**
 * `{ "X-HF-Bill-To": billTo }` when the call goes to the HF router on the global lane, else `{}`.
 * An own lane (a model with its own key, see `resolveClassifierLane`) never gets it.
 */
export function hfBillToHeader(
	baseURL: string | undefined,
	lane: { ownLane: boolean },
	billTo: string | undefined
): Record<string, string> {
	const org = billTo?.trim();
	if (!org || lane.ownLane || !isHfRouter(baseURL)) return {};
	return { "X-HF-Bill-To": org };
}

/**
 * The org a chat turn bills on the HF router (CUR-3533). A visitor's own `billingOrganization`
 * setting counts only under `USE_USER_TOKEN`, where their own HF token pays; while our server token
 * pays, it bills `HF_BILL_TO` and nothing a visitor typed.
 */
export function requestBillTo(
	userOrg: string | undefined,
	server: { useUserToken: boolean; billTo: string | undefined }
): string | undefined {
	if (server.useUserToken && userOrg?.trim()) return userOrg;
	return server.billTo?.trim() || undefined;
}
