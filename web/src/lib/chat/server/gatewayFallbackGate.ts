// `disable_fallbacks: true` on the answer lane's request body, and how long to honour the 429 that
// comes back (CUR-1729).
//
// The LiteLLM gateway substitutes a different model for the one we asked for whenever our deployment
// is in its cooldown list, and says so only in a response header we have to diff after the fact.
// Against the production gateway, a plain request can return 200 from another provider's group with
// `x-litellm-attempted-fallbacks: 1`, while the same request carrying this flag returns
// `429 … Try again in 5 seconds … cooldown_list=[…]`.
//
// The substituted answers are not usable here: most are very short next to the requested model's.
// Detecting the swap after the fact means retrying and then shedding with nothing to show the user. Asked directly,
// the gateway states the problem in one round trip and names an interval to retry on.
//
// NO POSTHOG FLAG, and that is a decision rather than an omission. A flag here could only be created
// two ways and both are wrong for this change. A preview-only release condition switches it OFF in
// production and ships the defect back, because `flagEnabledOr` falls back only on a key PostHog
// does not define at all (flags.ts) — a key that exists and evaluates false returns false. A
// production group at 100% is a production flag decision, which is not a thing a code change gets to
// make on its own. Meanwhile `check-flag-registry` goes red for any registered key with no live flag,
// correctly. So this runs unconditionally on the answer lane, and rolling it back is a one-line
// revert of `gatewayFallbackOverride`. `flagKeys.ts` carries the same note beside the local-inference
// gate, which is here for the same reason.
//
// Scope is the answer lane. The classifiers and the second-opinion panel are allowed to land
// anywhere, and the panel fans out to models Public AI does not host at all. Telling the gateway to
// refuse rather than substitute earns its keep only where one specific model's identity is the
// point, which is the turn the user reads.

/**
 * The body fields to merge into an outgoing completion request, `{}` when this call is not the one
 * the user reads.
 *
 * Returned as a spreadable object rather than a boolean so the call sites stay a single expression,
 * and merged BEFORE `extraBody` at each of them: an endpoint that names `disable_fallbacks` in its
 * own config is stating something specific about that lane and has to win over a global default.
 */
export function gatewayFallbackOverride(
	servesUserAnswer: boolean | undefined,
	baseURL?: string,
	gatewayBaseURLs?: string | readonly (string | undefined)[]
): Record<string, unknown> {
	if (!servesUserAnswer) return {};
	// `disable_fallbacks` is LiteLLM's field. A host that validates its body strictly rejects it:
	// Mistral's La Plateforme answers 422 `extra_forbidden` (CUR-2280). So a
	// call whose baseURL is none of the gateway's gets nothing; with the URL or every gateway URL
	// unknown, the gateway is assumed, which is what every call was before.
	//
	// More than one URL reaches the gateway. On an event deployment OPENAI_BASE_URL is an adapter,
	// which relays the body unchanged, while the catalog backup lane calls FALLBACK_BASE_URL, the
	// gateway itself. Matching only the first left that backup call free to substitute (CUR-3936).
	const norm = (u: string) => u.trim().replace(/\/+$/, "");
	const gateways = (typeof gatewayBaseURLs === "string" ? [gatewayBaseURLs] : (gatewayBaseURLs ?? []))
		.filter((u): u is string => Boolean(u?.trim()))
		.map(norm);
	if (baseURL && gateways.length > 0 && !gateways.includes(norm(baseURL))) return {};
	return { disable_fallbacks: true };
}

// The staging router's backups by group, from its `/router/settings`: Large 4
// falls back to Bedrock's Large 3, a different model under Large 4's name, so its answer calls
// refuse it (CUR-4551). Large 3's backup is Large 3 on Bedrock, the same model, and it keeps it.
const CROSS_MODEL_ROUTER_BACKUP: ReadonlySet<string> = new Set(["mistralai/mistral-large-2610"]);

/** The router base URL to treat as a gateway for this wire id: set only when its backup is another model. */
export function crossModelRouterURL(
	wireModelId: string,
	routerBaseURL: string | undefined
): string | undefined {
	return CROSS_MODEL_ROUTER_BACKUP.has(wireModelId.trim().toLowerCase()) ? routerBaseURL : undefined;
}

/**
 * How long the gateway asked us to wait, in ms, or null if it did not say.
 *
 * Two sources, in order. `Retry-After` is the standard header and wins when present. The LiteLLM
 * 429 actually observed carried the interval only in its body prose ("No deployments available for
 * selected model, Try again in 5 seconds."), so that is parsed as the fallback.
 *
 * The cap is the whole reason this returns a number instead of obeying the gateway. A turn dies at
 * the 45s watchdog and preview's output-screening phase deadline is 25s, so waiting longer than a
 * few seconds hands the person the same nothing, later. A gateway naming a 60-second cooldown is
 * telling us to give up.
 */
export function gatewayRetryDelayMs(
	retryAfterHeader: string | null,
	body: string | undefined,
	capMs = 6_000
): number | null {
	const fromHeader = retryAfterHeader?.trim();
	if (fromHeader && /^\d+$/.test(fromHeader)) {
		return Math.min(Number(fromHeader) * 1000, capMs);
	}
	const m = body?.match(/try again in (\d+(?:\.\d+)?)\s*second/i);
	if (m) return Math.min(Math.round(Number(m[1]) * 1000), capMs);
	return null;
}
