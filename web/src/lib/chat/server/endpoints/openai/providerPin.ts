import { HF_PROVIDER_PIN } from "../../modelProfiles";
import { endpointApiKey } from "$lib/chat/server/endpointKey";

/**
 * Resolve the model id sent to the HF Inference Providers router, applying a default provider pin.
 *
 * The router auto-selects a backend when the model id carries no `:provider` suffix, and can land on a
 * cold one (e.g. featherless) with a long cold-start warmup — a real TTFT cost. Pinning a default
 * provider keeps the request on a known-warm lane. For Apertus on the HF router that lane is
 * "publicai" (Public AI's own endpoint); set it via the `OPENAI_PROVIDER` env var.
 *
 * Precedence: an explicit per-request/per-user override always wins; an explicit "auto" honors the
 * user's choice to let the router decide (no pin); only an *absent* provider falls back to the default.
 */
export function resolveProviderModelId(
	baseModelId: string,
	provider: string | undefined,
	defaultProvider: string | undefined
): string {
	let effective: string | undefined;
	if (provider && provider !== "auto") {
		effective = provider; // explicit override wins
	} else if (provider === undefined) {
		effective = (defaultProvider ?? "").trim() || undefined; // default pin (config.OPENAI_PROVIDER)
	}
	// provider === "auto" → leave unset so the router auto-selects (explicit user choice)
	return effective ? `${baseModelId}:${effective}` : baseModelId;
}

/** The request goes to the Hugging Face Inference Providers router. */
export function isHfRouter(baseURL: string | undefined): boolean {
	try {
		const host = new URL(baseURL ?? "").hostname.toLowerCase().replace(/\.$/, "");
		return host === "huggingface.co" || host.endsWith(".huggingface.co");
	} catch {
		return false;
	}
}

/**
 * The provider `modelId` is always pinned to on the HF router, or undefined when it has none here.
 *
 * Throws for a `zai-org/` id with no pin (CUR-2112). Unpinned, the router sends a GLM call to whichever
 * provider it picks, Z.ai's own endpoint included, so a GLM id reaching the router without a decision
 * about who receives the text fails the call by name instead of going out.
 */
export function hfPinnedProvider(modelId: string, baseURL: string | undefined): string | undefined {
	if (!isHfRouter(baseURL) || modelId.includes(":")) return undefined;
	const key = modelId.trim().toLowerCase();
	const pin = HF_PROVIDER_PIN[key];
	if (!pin && key.startsWith("zai-org/"))
		throw new Error(
			`${modelId} has no HF provider pin; add it to HF_PROVIDER_PIN in modelProfiles.ts before calling it on the router (CUR-2112)`
		);
	return pin;
}

/**
 * The model id put on the wire. A lane modelId goes verbatim, gaining only a table pin. Otherwise an
 * explicit per-request provider wins, then the table pin, then `resolveProviderModelId`'s own rules
 * ("auto" leaves the router to choose, absent falls back to the default pin). The table outranks
 * "auto" and the `OPENAI_PROVIDER` default on purpose: both exist to steer Apertus, and neither is a
 * decision about where GLM traffic goes.
 *
 * An own lane (the endpoint reaches its host on its own key) never takes the default pin: `:publicai`
 * is an HF-router suffix, and a direct host answers `<id>:publicai` with nothing until the timeout
 * (CUR-1875). Every caller passes `ownLane` rather than choosing "auto" itself, so the rule lives here.
 */
export function wireModelId(args: {
	baseModelId: string;
	laneModelId?: string;
	provider: string | undefined;
	defaultProvider: string | undefined;
	baseURL: string | undefined;
	ownLane?: boolean;
}): string {
	const { baseModelId, laneModelId, defaultProvider, baseURL, ownLane } = args;
	if (laneModelId !== undefined) {
		const pin = hfPinnedProvider(laneModelId, baseURL);
		return pin ? `${laneModelId}:${pin}` : laneModelId;
	}
	const provider = args.provider ?? (ownLane ? "auto" : undefined);
	const explicit = provider && provider !== "auto" ? provider : undefined;
	return resolveProviderModelId(
		baseModelId,
		explicit ?? hfPinnedProvider(baseModelId, baseURL) ?? provider,
		defaultProvider
	);
}

/** The shape these resolvers need — structural, so this module never imports models.ts. */
export interface ServingLaneModel {
	id: string;
	endpoints?: ReadonlyArray<{
		type?: string;
		baseURL?: string;
		/** Env var NAME of the lane's key (CUR-2640); the value is read at call time. */
		apiKeyEnv?: string;
		modelId?: string;
	}>;
}

/** Where a side-call about a turn (search classifier, router) must be sent to reach the SAME model. */
export interface ClassifierLane {
	baseURL: string | undefined;
	/** undefined → caller supplies the global key; ordinary catalog endpoints carry none by design. */
	apiKey: string | undefined;
	/** The id to put on the wire — a lane modelId verbatim, else the pinned global id. */
	modelId: string;
	/**
	 * True when this model reaches its host on its OWN credentials. Callers must then suppress the
	 * global-lane request headers — `X-HF-Bill-To` is an HF-router concept, and the `USE_USER_TOKEN`
	 * Authorization override would replace the lane's key with a user's HF token and 401 the call.
	 */
	ownLane: boolean;
}

/**
 * Resolve the lane a classifier/side call must use so it hits the model actually serving the turn.
 *
 * The search classifier must not read `defaultModel.id` (a module-level binding) or
 * `config.OPENAI_BASE_URL` (the global). Both are the registry default, which stops being the serving
 * model the moment anything substitutes per request (CUR-127): the content can come from one model
 * while the search decision is made by another. Nothing errors, because both globals are stale
 * together and produce a coherent request; it is simply a different model deciding.
 *
 * Ordinary catalog models build `endpoints[0]` from `config.OPENAI_BASE_URL` with NO apiKeyEnv
 * (modelsCatalog.ts:120-122) and no lane modelId, so for them every field here is the registry default.
 *
 * A non-openai `endpoints[0]` (the agent lane) falls back to the global lane: an agent endpoint speaks
 * a different protocol and cannot answer a logprob classifier call.
 */
export function resolveClassifierLane(
	model: ServingLaneModel | undefined,
	globalBaseURL: string | undefined,
	defaultProvider: string | undefined
): ClassifierLane {
	const first = model?.endpoints?.[0];
	const endpoint = first?.type === "openai" ? first : undefined;
	const apiKey = endpointApiKey(endpoint);
	const ownLane = Boolean(apiKey);
	return {
		baseURL: endpoint?.baseURL || globalBaseURL,
		apiKey,
		// The same call endpointOai makes for the turn, so the side call names the model the turn names.
		modelId: wireModelId({
			baseModelId: model?.id ?? "",
			laneModelId: endpoint?.modelId,
			provider: undefined,
			defaultProvider,
			baseURL: endpoint?.baseURL || globalBaseURL,
			ownLane,
		}),
		ownLane,
	};
}

/**
 * What the `[ttft] decomposition` log should say about where a turn was routed and under what id.
 *
 * Both answers live on the SERVING MODEL'S endpoint, not in global config. Reading
 * `config.OPENAI_BASE_URL` for the host is wrong for every model that carries its own endpoint: the
 * Apertus 1.5 transparent swap points at CSCS direct and the compare models at a third host, yet the
 * log would name the LiteLLM gateway — a host those turns never touched. Resolving the wire id from
 * `model.id` is wrong the same way: a lane `modelId` is sent VERBATIM by endpointOai and deliberately
 * bypasses the provider pin, so the 1.5 swap sends "apertus-ai/Apertus-v1.5-70B" while the log would print
 * the internal swap key "apertus-1.5".
 *
 * Ordinary catalog models build `endpoints[0]` from `config.OPENAI_BASE_URL` and set no lane modelId
 * (modelsCatalog.ts), so for them both values are the configured ones.
 *
 * LIMIT: `endpoints[0]` is the lane tried FIRST, not the lane that answered — withFailover can fall
 * through to a backup before any output and this still names the primary. It reports routing, not
 * served identity; provenance on the persisted message reports the latter.
 */
export function describeServingLane(
	model: ServingLaneModel,
	globalBaseURL: string | undefined,
	defaultProvider: string | undefined
): { baseHost: string | null; resolvedModelId: string } {
	const endpoint = model.endpoints?.[0];
	const baseURL = endpoint?.baseURL || globalBaseURL;
	let baseHost: string | null;
	try {
		baseHost = baseURL ? new URL(baseURL).host : null;
	} catch {
		baseHost = null; // a malformed URL is a config bug, not a reason to lose the whole log line
	}
	// Mirrors endpointOai's own `wireModelId` call —
	// `??` and not `||`, deliberately: the point of this function is to report what was SENT, so it has
	// to make the same nullish-vs-falsy call the wire code makes, not a nearby one. Only the openai lane
	// has a modelId; an agent lane names its served model through provenance instead.
	const laneModelId = endpoint?.type === "openai" ? endpoint.modelId : undefined;
	const ownLane = endpoint?.type === "openai" && Boolean(endpointApiKey(endpoint));
	let resolvedModelId: string;
	try {
		resolvedModelId = wireModelId({
			baseModelId: model.id,
			laneModelId,
			provider: undefined,
			defaultProvider,
			baseURL,
			ownLane,
		});
	} catch {
		// An unpinned GLM id: the call itself fails by name, and a log line is no place to throw again.
		resolvedModelId = laneModelId ?? model.id;
	}
	return { baseHost, resolvedModelId };
}
