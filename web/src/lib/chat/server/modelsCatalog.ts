// Pure catalog-shaping transforms for the model registry.
//
// These are the side-effect-free phases of models.ts's buildModels(): constrain the upstream
// /models catalog to the curated allowlist, shape the survivors into model configs, and layer
// MODELS overrides on top. They live here (separate from models.ts, which network-fetches the
// catalog at module load) so they can be unit-tested without booting the live registry. The
// type-only import from models.ts is erased at build time, so importing this module has no
// runtime dependency on the registry and triggers no fetch.

import { resolveModelIdentity } from "$lib/chat/identity";
import { catalogByGatewayId } from "$lib/chat/routing/catalog";
import { isHfRouter } from "$lib/chat/server/endpoints/openai/providerPin";
import { logger } from "$lib/chat/server/logger";
import { HF_PROVIDER_PIN } from "$lib/chat/server/modelProfiles";
import { declaresToolCalls } from "$lib/chat/server/harnessProfiles";
import type { CatalogEntry, ModelConfig, ModelOverride } from "$lib/chat/server/models";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";
import { configKey } from "$lib/chat/server/endpointKey";
import { config } from "$lib/chat/server/config";
import { mistralChatLane } from "$lib/chat/server/mistralKey";

/** `defaultHeaders` carrying `X-HF-Bill-To` for a lane on the HF router, else nothing (CUR-1877). */
function billToDefaultHeaders(baseURL: string | undefined, billTo: string | undefined) {
	const headers = hfBillToHeader(baseURL, { ownLane: false }, billTo);
	return Object.keys(headers).length ? { defaultHeaders: headers } : {};
}

// Constrain the upstream router's full catalog to a curated allowlist. `allowlistSpec` is the
// resolved policy string: "*"/"all" → full catalog; a comma-separated id list → just those ids,
// reordered to the allowlist order; empty → full catalog (the caller defaults it to Apertus 70B).
export function selectAllowedModels(data: CatalogEntry[], allowlistSpec: string): CatalogEntry[] {
	const exposeAll = ["*", "all"].includes(allowlistSpec.toLowerCase());
	const allowlist = allowlistSpec
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const allowSet = new Set(allowlist);
	if (exposeAll || !allowSet.size) {
		return data;
	}

	// Order by the allowlist, not the upstream router catalog order, so the FIRST allowlisted id
	// deterministically becomes defaultModel (models[0]) downstream.
	const byId = new Map(data.map((m) => [m.id, m]));
	const filtered = allowlist.map((id) => byId.get(id)).filter((m): m is CatalogEntry => Boolean(m));
	// A picker id the catalog does not hold is dropped from the picker without a word, so a typo in
	// config/inference.ts or an id the gateway stopped serving would look like a smaller picker (CUR-3484).
	const missing = allowlist.filter((id) => !byId.has(id));
	if (filtered.length && missing.length) {
		logger.error({ missing }, "[models] allowlisted ids are in no catalog and are not offered");
	}
	if (filtered.length) {
		logger.info(
			{ kept: filtered.length, of: data.length },
			"[models] Constrained to model allowlist"
		);
		return filtered;
	}
	// A non-empty allowlist matching NOTHING in the live catalog (e.g. the pinned checkpoint got
	// rotated/renamed upstream) must fail loud, not widen to the full unfiltered catalog — the
	// allowlist exists specifically to guarantee only vetted models get served, and the upstream
	// catalog can contain anything, including experimental/unsafe checkpoints. Returning [] here
	// makes buildModels()/initModels() throw ("Failed to load any models from upstream"), which
	// ensureModelsReady() already surfaces as a clear request-time error with retry cooldown —
	// the existing, tested "no models available" path, not a new one.
	logger.error(
		{ allowlist, catalogSize: data.length },
		"[models] Allowlist matched nothing in the live catalog — refusing to widen to the full catalog"
	);
	return [];
}

export interface ToModelConfigsOptions {
	baseURL: string;
	isHFRouter: boolean;
	multimodalEnabled: boolean;
	/** Optional same-model backup lane (e.g. HF router) used when the primary base URL fails before
	 *  producing output. Names its own key's env var because the backup host's token differs from the
	 *  primary's (the CSCS key is not the HF token). Omitted/blank → single-lane, unchanged behavior. */
	fallbackBaseURL?: string;
	/** Env var NAME holding the backup lane's key, never the value (CUR-2640). Omitted → the lane
	 *  rides endpointOai's default key. */
	fallbackApiKeyEnv?: string;
	/** Optional id override for the BACKUP lane, for a backup host that spells the primary's model
	 *  differently. The HF router serves this checkpoint as "swiss-ai/Apertus-v1.5-70B"; the primary
	 *  gateway serves it lowercase, and the lowercase id answers `does not exist` on the router.
	 *  So this is a CASING override, never a different model: a different id would turn
	 *  same-checkpoint failover into cross-model substitution.
	 *  Omitted/blank → the backup lane requests the primary id unchanged.
	 *
	 *  A comma-separated list makes one backup lane per id, tried in order (CUR-3750). Every lane but
	 *  the last gets the failover deadline, so a backup that goes silent hands the turn on instead of
	 *  holding it until the generation watchdog. */
	fallbackModelId?: string;
	/** Billing org for the BACKUP lane, sent as X-HF-Bill-To. The HF router 403s a personal token
	 *  without it — "does not have sufficient permissions to call Inference Providers" — which is a
	 *  403 on arrival, indistinguishable from a lane that simply never got used. Every HF
	 *  caller here sends it, this lane included. */
	fallbackBillTo?: string;
}

// Shape catalog entries into ModelConfigs: derive the HF org logo, normalize input modalities to a
// text-only-gated multimodal flag, and aggregate per-provider tool support.
export function toModelConfigs(
	data: CatalogEntry[],
	{
		baseURL,
		isHFRouter,
		multimodalEnabled,
		fallbackBaseURL,
		fallbackApiKeyEnv,
		fallbackModelId,
		fallbackBillTo,
	}: ToModelConfigsOptions
): ModelConfig[] {
	// A backup lane is only added when a fallback base URL is configured, and on the primary's own URL
	// only when it asks for a different model (below). An unset one keeps every model single-lane. The
	// backup requests the primary id by default; FALLBACK_MODEL_ID overrides it for
	// hosts that don't serve that id (see ToModelConfigsOptions.fallbackModelId).
	const fb = (fallbackBaseURL ?? "").trim().replace(/\/$/, "");
	const fbModelIds = (fallbackModelId ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	const fbBillTo = (fallbackBillTo ?? "").trim();
	const primary = baseURL.replace(/\/$/, "");
	return data.map((m) => {
		// The primary's own host can back it with a different model on that host (the gateway's
		// Infomaniak-only Apertus group behind its mixed one, CUR-2293); the same host asking for the
		// same model would only repeat the request that just failed.
		// One backup lane per listed id, the entry's own id meaning "no override". An empty list is one
		// same-id lane. On the primary's own host a same-id lane only repeats the call that just failed.
		const backupIds = fb.length === 0 ? [] : fbModelIds.length > 0 ? fbModelIds : [m.id];
		const backupLanes = [...new Set(backupIds)].filter((id) => fb !== primary || id !== m.id);
		let logoUrl: string | undefined = undefined;
		if (isHFRouter && m.id.includes("/")) {
			const org = m.id.split("/")[0];
			logoUrl = `https://huggingface.co/api/avatars/${encodeURIComponent(org)}`;
		}

		const inputModalities = (m.architecture?.input_modalities ?? []).map((modality) =>
			modality.toLowerCase()
		);
		// A catalogued model reads images as the catalog records it, from what was observed on a host
		// that served it. The LiteLLM router lists no modalities at all, so a host's own list only
		// decides for a model the catalog doesn't know.
		const catalogued = catalogByGatewayId(m.id);
		const supportsImageInput = catalogued
			? catalogued.readsImages
			: inputModalities.includes("image") || inputModalities.includes("vision");

		// Tool support from any provider that lists it, or from the model's row: the LiteLLM gateway lists
		// no providers, so without the row every gateway model reads as tool-less (CUR-4191).
		const supportsTools =
			Boolean((m.providers ?? []).some((p) => p?.supports_tools === true)) || declaresToolCalls(m.id);
		return {
			id: m.id,
			name: m.id,
			// The id is a wire name ("swiss-ai/apertus-v1.5-70b"); a visitor reads this one wherever a
			// model is listed, Settings included (CUR-2203). Search still matches on the id.
			displayName: resolveModelIdentity(m.id).short,
			description: m.description,
			logoUrl,
			providers: m.providers,
			// TEXT-ONLY ALPHA: force non-multimodal regardless of what the served model advertises,
			// so the client never shows the image-attach affordance and no image is sent, unless
			// MULTIMODAL_ENABLED is set. See $lib/chat/server/textOnly.
			multimodal: multimodalEnabled && supportsImageInput,
			multimodalAcceptedMimetypes:
				multimodalEnabled && supportsImageInput ? ["image/*"] : undefined,
			supportsTools,
			endpoints: [
				{
					type: "openai" as const,
					baseURL,
					// No apiKeyEnv: endpointOai sends its default key, OPENAI_API_KEY (HF_TOKEN when unset).
				},
				// Backup lane (different host; same model unless fallbackModelId overrides) — only when
				// distinctly configured. Failover is pre-output only, and provenance stays honest: the
				// lane's modelId override is surfaced as the served model id (see endpointOai), so the
				// badge names the model that actually answered, never the primary it stood in for.
				...backupLanes.map((id) => ({
					type: "openai" as const,
					baseURL: fb,
					...(fallbackApiKeyEnv ? { apiKeyEnv: fallbackApiKeyEnv } : {}),
					...(id !== m.id ? { modelId: id } : {}),
					...billToDefaultHeaders(fb, fbBillTo),
				})),
			],
		} as ModelConfig;
	}) as ModelConfig[];
}

/** A second OpenAI-compatible host whose models can be allowlisted like the primary's (CUR-2272). */
export interface DirectEndpoint {
	baseURL: string;
	/** Env var NAME holding this host's key, never the value (CUR-2640). */
	apiKeyEnv: string;
	modelIds: string[];
	/** Provider key the badge names ("mistral"); display-only, never sent upstream. */
	provider?: string;
	/**
	 * Our model id → the id this host knows it by, when the two differ: the staging router names
	 * Mistral Large `mistralai/mistral-large-2512` and refuses the bare id (CUR-2928). Unset means the
	 * host uses our ids.
	 */
	wireIds?: Record<string, string>;
	/** Billing org sent as X-HF-Bill-To; the HF router 403s a personal token without it. */
	billTo?: string;
}

// Parse MISTRAL_* into an endpoint, or null when any part is missing. A partial config is
// logged, not silently dropped: an allowlist naming a direct model then fails loud in
// selectAllowedModels rather than quietly serving something else. `apiKeyEnv` names the env var the
// key lives in; its value is read here only to check it is set, and never stored (CUR-2640).
export function parseDirectEndpoint(
	baseURL: string,
	apiKeyEnv: string,
	modelIdsRaw: string,
	provider = "",
	wireIds: Record<string, string> = {}
): DirectEndpoint | null {
	const url = baseURL.trim().replace(/\/$/, "");
	const key = configKey(apiKeyEnv) ?? "";
	const modelIds = modelIdsRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!url && !key && !modelIds.length) return null;
	if (!url || !key || !modelIds.length) {
		logger.error(
			{ hasBaseURL: Boolean(url), hasApiKey: Boolean(key), models: modelIds.length },
			"[models] MISTRAL_* is partly set; direct models are not registered"
		);
		return null;
	}
	const prov = provider.trim();
	return {
		baseURL: url,
		apiKeyEnv,
		modelIds,
		...(prov ? { provider: prov } : {}),
		...(Object.keys(wireIds).length ? { wireIds } : {}),
	};
}

/**
 * Chat's Mistral models as an endpoint on `mistralChatLane()`'s host: the staging router when it is
 * configured (CUR-2928), otherwise La Plateforme (CUR-2272). Null when MISTRAL_MODELS names none.
 *
 * @remarks
 * The catalog registers Mistral turns from this, and the model warm probe aims at it, so the probe
 * reaches the host and wire id a real turn does (CUR-3848). Read per call, so a registry refresh picks
 * up the current values.
 */
export function mistralChatEndpoint(): DirectEndpoint | null {
	const lane = mistralChatLane();
	return parseDirectEndpoint(
		lane.baseURL,
		lane.keyEnv,
		(Reflect.get(config, "MISTRAL_MODELS") as string | undefined) ?? "",
		"mistral",
		lane.wireIds
	);
}

/**
 * The endpoint fields that send `id` under the host's own name and record the answer under ours.
 * Empty when the host uses our id, so the endpoint is exactly what it was before (CUR-2928).
 */
export function directWire(
	direct: Pick<DirectEndpoint, "wireIds"> | null,
	id: string
): { modelId?: string; servedAs?: string } {
	const wire = direct?.wireIds?.[id];
	return wire && wire !== id ? { modelId: wire, servedAs: id } : {};
}

/**
 * The HF router as a picker lane (CUR-1683): the allowlisted ids that have a provider pin, in
 * allowlist order, or null when there are none or the router is not configured.
 *
 * @remarks
 * A pin row in `HF_PROVIDER_PIN` is the route declaration: it names the model, the router, and the one
 * provider allowed to receive its text, so a model is offered from here exactly when someone decided
 * who serves it. Nothing about the second-opinion or compare panels feeds this. These models are
 * offered for their answers, so their harnessProfiles.ts rows carry every trick. The answer keeps its
 * reasoning, which streams into the Working panel; with reasoning off, GLM 5.2 puts it into the
 * answer instead (CUR-4189). An allowlisted `zai-org/` id with no pin is logged
 * and left for `selectAllowedModels` to report, rather than offered from a router that would refuse it.
 */
export function hfPinnedLane(
	baseURL: string,
	apiKeyEnv: string | undefined,
	billTo: string,
	allowlistSpec: string
): DirectEndpoint | null {
	const url = baseURL.trim().replace(/\/$/, "");
	if (!url || !apiKeyEnv || !configKey(apiKeyEnv) || !isHfRouter(url)) return null;
	const allowlisted = allowlistSpec
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const modelIds = allowlisted.filter((id) => HF_PROVIDER_PIN[id.toLowerCase()]);
	const unpinned = allowlisted.filter(
		(id) => id.toLowerCase().startsWith("zai-org/") && !HF_PROVIDER_PIN[id.toLowerCase()]
	);
	if (unpinned.length)
		logger.error(
			{ unpinned },
			"[models] MODEL_ALLOWLIST names a GLM id with no HF provider pin; it is not offered (CUR-2112)"
		);
	if (!modelIds.length) return null;
	const bill = billTo.trim();
	return {
		baseURL: url,
		apiKeyEnv,
		modelIds,
		...(bill ? { billTo: bill } : {}),
	};
}

// The direct host's models join the catalog BEFORE allowlisting, so MODEL_ALLOWLIST orders them with
// everything else and the first entry becomes defaultModel whichever host serves it. A direct id
// replaces a same-id primary entry: the operator named this host for it.
export function withDirectModels(
	catalog: CatalogEntry[],
	direct: DirectEndpoint | null
): CatalogEntry[] {
	if (!direct) return catalog;
	const ids = new Set(direct.modelIds);
	const directEntries = direct.modelIds.map(
		(id) =>
			({
				id,
				providers: [{ supports_tools: true }],
			}) as unknown as CatalogEntry
	);
	return [...catalog.filter((m) => !ids.has(m.id)), ...directEntries];
}

// Point each direct model at its own host, on one lane. It never inherits the catalog's backup lane, which
// serves a different checkpoint picked for Apertus, and it gets no lane asking for another model: a
// picked model is answered by itself or ends on the busy notice (CUR-4383).
export function routeDirectModels(configs: ModelConfig[], direct: DirectEndpoint | null): ModelConfig[] {
	if (!direct) return configs;
	const ids = new Set(direct.modelIds);
	return configs.map((m) =>
		ids.has(m.id ?? m.name)
			? {
					...m,
					logoUrl: undefined,
					endpoints: [
						{
							type: "openai" as const,
							baseURL: direct.baseURL,
							apiKeyEnv: direct.apiKeyEnv,
							...directWire(direct, m.id ?? m.name),
							...(direct.provider ? { routerProvider: direct.provider } : {}),
							...billToDefaultHeaders(direct.baseURL, direct.billTo),
						},
					],
				}
			: m
	) as ModelConfig[];
}

/** The model a lane asks for, in our spelling: its `servedAs`, else its wire id, else the pick. */
function laneModel(lane: { modelId?: string; servedAs?: string }, picked: string): string {
	return (lane.servedAs ?? lane.modelId ?? picked).trim().toLowerCase();
}

/**
 * Drop every lane that would answer as a different model than the one the person picked (CUR-3936).
 *
 * @remarks
 * A backup lane exists to retry the picked model somewhere else, never to substitute another one.
 * The rule is enforced here rather than in `fallbackModelId`'s doc comment alone, so a
 * `FALLBACK_MODEL_ID` naming another model cannot answer a pick. This runs last in the
 * registry build, after MODELS overrides, so no lane reaches a turn without passing it. A case
 * difference is the same model (the HF router spells Apertus with capitals). The first lane is
 * the pick's own and always kept. Each drop is logged as an error, because a dropped lane means
 * config asked for a substitution and a person would otherwise have been answered by it.
 */
export function withOnlyPickedModelLanes(configs: ModelConfig[]): ModelConfig[] {
	return configs.map((m) => {
		const picked = (m.id ?? m.name).trim();
		const endpoints = m.endpoints ?? [];
		if (endpoints.length < 2) return m;
		const allowed = picked.toLowerCase();
		const kept = endpoints.filter((e, i) => {
			if (i === 0) return true;
			const asks = laneModel(e as { modelId?: string; servedAs?: string }, picked);
			if (asks === allowed) return true;
			logger.error(
				{ model: picked, laneModel: asks, baseURL: (e as { baseURL?: string }).baseURL },
				"[models] dropped a backup lane that would answer as a different model than the one picked"
			);
			return false;
		});
		return kept.length === endpoints.length ? m : ({ ...m, endpoints: kept } as ModelConfig);
	});
}

// Layer MODELS overrides (matched by id or name) onto the shaped configs. The override's own
// id/name keys are stripped before merge — they're match selectors, not values to overwrite with.
export function applyOverrides(configs: ModelConfig[], overrides: ModelOverride[]): ModelConfig[] {
	if (!overrides.length) {
		return configs;
	}

	const overrideMap = new Map<string, ModelOverride>();
	for (const override of overrides) {
		for (const key of [override.id, override.name]) {
			const trimmed = key?.trim();
			if (trimmed) overrideMap.set(trimmed, override);
		}
	}

	return configs.map((model) => {
		const override = overrideMap.get(model.id ?? "") ?? overrideMap.get(model.name ?? "");
		if (!override) return model;

		const { id, name, ...rest } = override;
		void id;
		void name;

		return {
			...model,
			...rest,
		};
	});
}
