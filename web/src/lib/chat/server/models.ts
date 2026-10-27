import { building } from "$app/environment";
import { config } from "$lib/chat/server/config";
import { mistralChatLane, ticketBranchAllowlist } from "$lib/chat/server/mistralKey";
import { pickerSpec } from "$lib/chat/server/primaryModel";
import { multimodalConfigured } from "$lib/chat/server/textOnly";
import type { ChatTemplateInput } from "$lib/chat/types/Template";
import { z } from "zod";
import endpoints from "./endpoints/endpoints";
import { endpointOAIParametersSchema } from "./endpoints/openai/endpointOai";
import { endpointAgentParametersSchema } from "./endpoints/agent/endpointAgent";
import {
	configKey,
	endpointApiKey,
	firstSetKeyEnv,
	LOCAL_ENDPOINT_API_KEY,
} from "$lib/chat/server/endpointKey";
import {
	withFailover,
	firstChunkTimings,
	FAILOVER_ON_SILENT_LANE_FLAG,
	HEDGE_ON_FIRST_TOKEN_FLAG,
	laneModelIds,
} from "./endpoints/failover";
import { flagEnabledOr, ensureFlagsPolled } from "$lib/chat/server/flags";
import { firstChunkMsFor, silentGiveUpMsFor } from "$lib/chat/server/harnessProfiles";
import type { Endpoint } from "./endpoints/types";

import JSON5 from "json5";
import { agentServiceUrl } from "$lib/chat/server/agentMode";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";
import {
	offeredModels,
	onRegistryPollLanded,
	resolveRegistryGates,
	type RegistryGates,
} from "$lib/chat/server/modelGates";
import { captureServerException } from "$lib/chat/server/errorTracking";
import {
	checkRoles,
	describeRoles,
	shadowedIds,
	topologyFromRegistry,
	uncheckedProviders,
	type Lane,
} from "$lib/chat/server/inferenceTopology";
import { inferenceEnvironment } from "../../../../config/inference";
import { logger } from "$lib/chat/server/logger";
import { deployEnv, type DeployEnv } from "$lib/chat/server/deployEnv";
import { makeRouterEndpoint } from "$lib/chat/server/router/endpoint";
import { sanitizeJSONEnv } from "$lib/chat/server/envParse";
import {
	applyOverrides,
	mistralChatEndpoint,
	directWire,
	routeDirectModels,
	withOnlyPickedModelLanes,
	hfPinnedLane,
	type DirectEndpoint,
	selectAllowedModels,
	toModelConfigs,
	withDirectModels,
} from "$lib/chat/server/modelsCatalog";
import { firstKey } from "$lib/chat/server/env/firstKey";
import {
	catalogEntrySchema,
	computeModelDrift,
	parseModelsSnapshot,
	type CatalogEntry,
} from "$lib/chat/server/modelsSnapshot";
// Committed boot snapshot of the upstream /models catalog (scripts/gen-models-snapshot.mjs, written at
// build time). The committed default is empty ({baseURL:"", entries:[]}) so this import always resolves;
// parseModelsSnapshot treats an empty/mismatched artifact as absent → live path (§C).
import modelsSnapshotRaw from "$lib/chat/server/data/models-snapshot.json";

// Re-export the shared catalog-entry type from its home in modelsSnapshot.ts (type-only, erased at
// build) so existing importers (modelsCatalog.ts, its spec) keep resolving it from here.
export type { CatalogEntry } from "$lib/chat/server/modelsSnapshot";

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

/**
 * An endpoint as the model registry holds it (CUR-2640): the env var its key lives in
 * (`apiKeyEnv`), never the key. The registry is long-lived and gets serialized, and a key value on it
 * would be exposed through `/chat/api/v2/models` (CUR-2643). `getEndpoint` resolves the value
 * when it builds the lane. The one `apiKey` allowed is a local endpoint's fixed, non-secret
 * placeholder (localModels.ts, CUR-3177).
 */
const registryEndpointSchema = z.discriminatedUnion("type", [
	endpointOAIParametersSchema
		.omit({ apiKey: true })
		.extend({ apiKey: z.literal(LOCAL_ENDPOINT_API_KEY).optional() }),
	endpointAgentParametersSchema.omit({ apiKey: true }),
]);
export type RegistryEndpoint = z.infer<typeof registryEndpointSchema>;

const modelConfig = z.object({
	/** Used as an identifier in DB */
	id: z.string().optional(),
	/** Used to link to the model page, and for inference */
	name: z.string().default(""),
	displayName: z.string().min(1).optional(),
	description: z.string().min(1).optional(),
	logoUrl: z.string().url().optional(),
	websiteUrl: z.string().url().optional(),
	modelUrl: z.string().url().optional(),
	tokenizer: z.never().optional(),
	datasetName: z.string().min(1).optional(),
	datasetUrl: z.string().url().optional(),
	preprompt: z.string().default(""),
	prepromptUrl: z.string().url().optional(),
	chatPromptTemplate: z.never().optional(),
	promptExamples: z
		.array(
			z.object({
				title: z.string().min(1),
				prompt: z.string().min(1),
			})
		)
		.optional(),
	endpoints: z.array(registryEndpointSchema).optional(),
	providers: z.array(z.object({ supports_tools: z.boolean().optional() }).passthrough()).optional(),
	parameters: z
		.object({
			temperature: z.number().min(0).max(2).optional(),
			truncate: z.number().int().positive().optional(),
			max_tokens: z.number().int().positive().optional(),
			stop: z.array(z.string()).optional(),
			top_p: z.number().positive().optional(),
			top_k: z.number().positive().optional(),
			frequency_penalty: z.number().min(-2).max(2).optional(),
			presence_penalty: z.number().min(-2).max(2).optional(),
		})
		.passthrough()
		.optional(),
	multimodal: z.boolean().default(false),
	multimodalAcceptedMimetypes: z.array(z.string()).optional(),
	// Aggregated tool-calling capability across providers (HF router)
	supportsTools: z.boolean().default(false),
	// Reasoning-capable model (accepts `reasoning_effort` parameter)
	supportsReasoning: z.boolean().default(false),
	// Opt-in artifacts: when true, the model is instructed to emit <artifact>
	// blocks rendered in the side panel. Set per model via MODELS overrides.
	supportsArtifacts: z.boolean().default(false),
	unlisted: z.boolean().default(false),
	embeddingModel: z.never().optional(),
	/** Used to enable/disable system prompt usage */
	systemRoleSupported: z.boolean().default(true),
});

export type ModelConfig = z.infer<typeof modelConfig>;

const overrideEntrySchema = modelConfig
	.partial()
	.extend({
		id: z.string().optional(),
		name: z.string().optional(),
	})
	.refine((value) => Boolean((value.id ?? value.name)?.trim()), {
		message: "Model override entry must provide an id or name",
	});

export type ModelOverride = z.infer<typeof overrideEntrySchema>;

const openaiBaseUrl = config.OPENAI_BASE_URL
	? config.OPENAI_BASE_URL.replace(/\/$/, "")
	: undefined;
const isHFRouter = openaiBaseUrl === "https://router.huggingface.co/v1";
// Optional same-model backup lane: when CSCS is primary, HF can serve the same Apertus checkpoint as a
// failover (config presence is the switch — no feature flag). The HF host needs its own token, hence
// the explicit pairing rather than reusing the primary key. Blank/unset → models stay single-lane.
const fallbackBaseURL = (config.HF_BASE_URL || "").trim();
// OPENAI_API_KEY tail is a defensive fallback only, not a real second choice: HF_TOKEN is set in every
// real deployment. If HF_TOKEN were ever unset, this would send
// the CSCS chat key to HF instead of failing loud — acceptable only because it can't happen today.
const fallbackApiKey = firstKey(["HF_TOKEN", "OPENAI_API_KEY"], "modelsFallbackApiKey", {
	allowEmpty: true,
});
// The env var that value came from, same precedence: what a registry endpoint records (CUR-2640).
const fallbackApiKeyEnv = firstSetKeyEnv(["HF_TOKEN", "OPENAI_API_KEY"]);
// The backup lane's spelling of the primary's id, for a backup host that cases it differently. Never
// a different model: withOnlyPickedModelLanes drops any lane that asks for one (CUR-3936). Unset →
// the backup lane requests the primary id unchanged.
const fallbackModelId = ((config.FALLBACK_MODEL_ID as string | undefined) || "").trim();

// Mistral's La Plateforme, called directly: its models join the catalog so MODEL_ALLOWLIST can name them
// like the gateway's, the first allowlisted id becoming defaultModel wherever it is served (CUR-2272).
// The host is mistralChatLane's: the staging router when it is configured (CUR-2928). Shared with the
// model warm probe, which must reach the same host (CUR-3848).
const mistralEndpoint = mistralChatEndpoint;

// The HF router bills a personal token against an org through this header, and 403s on arrival
// without it. Same var the second-opinion route, the RAG router and the guard shadow read; a lane that
// omits it answers 403 to every failover.
const fallbackBillTo = (firstKey(["HF_BILL_TO"], "modelsFallbackBillTo", { allowEmpty: true }) || "").trim();

// Pinned models on the HF router as picker entries (CUR-1683): an id MODEL_ALLOWLIST names that has a
// row in HF_PROVIDER_PIN is offered from HF_BASE_URL, pinned to that provider. The pin table is the
// route; the second-opinion panels are separate consumers and play no part in what the picker offers.
const hfEndpoint = (allowlistSpec: string): DirectEndpoint | null =>
	hfPinnedLane(fallbackBaseURL, fallbackApiKeyEnv, fallbackBillTo, allowlistSpec);

// The catalog backup lane's own host (CUR-2293). The HF router serves no Apertus 70B, so on
// production the HF pair above answers every failover with a 400. FALLBACK_BASE_URL
// points this lane elsewhere (the gateway's Infomaniak-only Apertus group); unset, it stays on the HF
// pair. The direct models' backup and the catalog list's fallback keep the HF pair either way. Off HF
// there is no HF billing header, and with no FALLBACK_API_KEY the endpoint's default key is used.
const catalogBackupHost = ((config.FALLBACK_BASE_URL as string | undefined) || "").trim();
const catalogBackup = catalogBackupHost
	? {
			baseURL: catalogBackupHost,
			apiKeyEnv: configKey("FALLBACK_API_KEY") ? "FALLBACK_API_KEY" : undefined,
			billTo: "",
		}
	: { baseURL: fallbackBaseURL, apiKeyEnv: fallbackApiKeyEnv, billTo: fallbackBillTo };

// The catalog list envelope. The ENTRY schema (id required; providers/architecture .nullish() +
// passthrough — the null-vs-omitted CSCS/HF-router difference) is the shared catalogEntrySchema, so the
// live fetch and the boot-snapshot re-validation hold entries to the exact same shape (§C).
const listSchema = z
	.object({
		data: z.array(catalogEntrySchema),
	})
	.passthrough();

function getChatPromptRender(_m: ModelConfig): (inputs: ChatTemplateInput) => string {
	// Minimal template for the "completions" flow. It avoids any tokenizer/Jinja usage in this build.
	return ({ messages, preprompt }) => {
		const parts: string[] = [];
		if (preprompt) parts.push(`[SYSTEM]\n${preprompt}`);
		for (const msg of messages) {
			const role = msg.from === "assistant" ? "ASSISTANT" : msg.from.toUpperCase();
			parts.push(`[${role}]\n${msg.content}`);
		}
		parts.push(`[ASSISTANT]`);
		return parts.join("\n\n");
	};
}

// Fetch a remote preprompt with a hard timeout + fail-open. A bare `fetch(prepromptUrl)` with no
// timeout can HANG the first request app-wide (this runs during model processing, before any turn) —
// a cold/unreachable prepromptUrl host would stall model load until the platform kills the invocation.
// Bound it and fall back to the inline `preprompt` so a slow host degrades to the configured default
// instead of taking the whole app down.
const PREPROMPT_FETCH_TIMEOUT_MS = 8000;
const fetchPreprompt = async (url: string): Promise<string | undefined> => {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(PREPROMPT_FETCH_TIMEOUT_MS) });
		if (!r.ok) throw new Error(`preprompt fetch HTTP ${r.status}`);
		return await r.text();
	} catch (err) {
		logger.warn(
			{ err, url },
			"[models] prepromptUrl fetch failed/timed out — falling back to inline preprompt"
		);
		return undefined;
	}
};

// Exported for localModels.ts — the per-user local-inference-endpoint builder reuses these
// two exactly the way maybeAddCompareModels/maybeAddAgentModel below already do, rather than
// duplicating the chatPromptRender/endpoint-lane construction logic.
export const processModel = async (m: ModelConfig) => ({
	...m,
	chatPromptRender: getChatPromptRender(m),
	id: m.id || m.name,
	displayName: m.displayName || m.name,
	// `?? m.preprompt` only on fetch FAILURE (undefined) — a successful empty body ("") is honored.
	preprompt: m.prepromptUrl ? ((await fetchPreprompt(m.prepromptUrl)) ?? m.preprompt) : m.preprompt,
	parameters: { ...m.parameters, stop_sequences: m.parameters?.stop },
	unlisted: m.unlisted ?? false,
});

/** The sooner of two give-ups, where null means "none": a turn's own give-up never lifts a model's. */
export function shorterGiveUp(own: number | null, turn: number | null): number | null {
	if (own === null) return turn;
	if (turn === null) return own;
	return Math.min(own, turn);
}

/**
 * The input `endpoints.agent` is built from for a model's agent lane: the registry endpoint plus the
 * call-time `model` and the key read from `apiKeyEnv` (CUR-2640).
 *
 * @remarks
 * Shared by the turn's lane and Stop's cancel (CUR-4602). The bare registry entry fails the schema on
 * the missing `model` and carries no service token, so a cancel built from it never reaches the task.
 * One builder keeps the two from drifting.
 */
export function agentLaneInput<M, E extends { apiKeyEnv?: string }>(m: M, endpoint: E) {
	return { ...endpoint, apiKey: endpointApiKey(endpoint), model: m };
}

/** The agent model's lane input for a call made outside a turn, such as Stop's cancel; undefined
 *  when this deployment has no agent model or it has no agent endpoint. */
export function agentModelLaneInput() {
	const m = models.find((candidate) => candidate.id === AGENT_MODEL_ID);
	const endpoint = m?.endpoints?.find((e) => e.type === "agent");
	return m && endpoint?.type === "agent" ? agentLaneInput(m, endpoint) : undefined;
}

export const addEndpoint = (m: Awaited<ReturnType<typeof processModel>>) => ({
	...m,
	/** `giveUpMs` shortens this turn's give-up on a silent last lane; it never lengthens the model's own
	 *  (CUR-4384: an Auto turn gives up sooner so Auto can pick again). `recordBusy: false` leaves the
	 *  busy mark to the caller: the warm probe (modelProbe.ts) records its own verdict, once. */
	getEndpoint: async ({
		giveUpMs,
		recordBusy = true,
	}: { giveUpMs?: number | null; recordBusy?: boolean } = {}): Promise<Endpoint> => {
		if (!m.endpoints || m.endpoints.length === 0) {
			throw new Error("No endpoints configured. This build requires OpenAI-compatible endpoints.");
		}
		// OpenAI-compatible models (the catalog default) + the Potluck agent endpoint (Story B:
		// the agent service behind chat-ui's stream — see endpoints/agent/endpointAgent.ts).
		// The key is read from config here, per lane build, and handed to the endpoint; the registry
		// object only names its env var (CUR-2640). No apiKeyEnv → the endpoint's own default key.
		const buildLane = async (
			endpoint: NonNullable<typeof m.endpoints>[number]
		): Promise<Endpoint> => {
			if (endpoint.type === "openai") {
				const apiKey = endpointApiKey(endpoint) ?? endpoint.apiKey;
				return await endpoints.openai({ ...endpoint, apiKey, model: m });
			}
			if (endpoint.type === "agent") {
				return await endpoints.agent(agentLaneInput(m, endpoint));
			}
			// Unreachable per the discriminated union (openai|agent both handled above); runtime-only guard.
			throw new Error(
				`Unsupported endpoint type '${(endpoint as { type: string }).type}' in this build`
			);
		};
		// Build every configured lane and serve them with same-model failover: a model with a single
		// endpoint behaves exactly as before; a model with a backup lane (e.g. CSCS primary + HF) tries
		// them in order, switching only on a failure BEFORE any output (see endpoints/failover.ts).
		const lanes = await Promise.all(m.endpoints.map(buildLane));
		// CUR-1344. getEndpoint runs per request, so this reads live rather than at model-load time —
		// but preview runs no warm cron, so a cold instance has never polled PostHog and would read the
		// code default forever. ensureFlagsPolled is the same precedent guardGate.ts uses.
		await ensureFlagsPolled();
		const hedging = flagEnabledOr(HEDGE_ON_FIRST_TOKEN_FLAG, () => false);
		const silentLaneFailover = flagEnabledOr(FAILOVER_ON_SILENT_LANE_FLAG, () => false);
		return withFailover(lanes, {
			...firstChunkTimings(firstChunkMsFor(m.id), {
				hedging,
				silentLaneFailover,
				giveUpMs: shorterGiveUp(silentGiveUpMsFor(m.id), giveUpMs ?? null),
			}),
			laneModels: laneModelIds(m.id, m.endpoints),
			...(recordBusy ? { busyKey: m.id } : {}),
		});
	},
});

type InternalProcessedModel = Awaited<ReturnType<typeof addEndpoint>> & {
	isRouter: boolean;
	hasInferenceAPI: boolean;
	/** Only set for a per-user local model (localModels.ts): which kind of endpoint serves it, so the
	 *  UI can describe the route a message actually takes. A managed endpoint reaches the user's
	 *  machine through an encrypted tunnel; a direct one is a plain URL this server dials. Those are
	 *  different privacy stories and the panel must not tell the wrong one (CUR-3037). */
	localEndpointKind?: "direct" | "managed";
};

const inferenceApiIds: string[] = [];

const getModelOverrides = (): ModelOverride[] => {
	const overridesEnv = (Reflect.get(config, "MODELS") as string | undefined) ?? "";

	if (!overridesEnv.trim()) {
		return [];
	}

	try {
		return z.array(overrideEntrySchema).parse(JSON5.parse(sanitizeJSONEnv(overridesEnv, "[]")));
	} catch (error) {
		logger.error(error, "[models] Failed to parse MODELS overrides");
		return [];
	}
};

export type ProcessedModel = InternalProcessedModel;

export const models: ProcessedModel[] = [];
export let defaultModel!: ProcessedModel;
export let taskModel!: ProcessedModel;
export let validModelIdSchema: z.ZodType<string> = z.string();

// The agent is registered in `models[]` so `resolveAgentRoute`'s internal lookup and turn-
// serving logic can find its config, but it is never a directly-selectable model — the AgentMode toggle
// is the only path onto it (resolveAgentRoute.ts). Excluding it here, at the one place this schema is
// built, means every current and future caller that validates a client-supplied model id against it
// rejects the agent id, without each call site needing its own check. (CUR-770)
/**
 * Whether a visitor may pick this model for a conversation or a turn. The agent and every `unlisted`
 * entry (side-call, compare-panel and backup models) are registered so the server can call them, never
 * so a visitor can chat on them: a PATCH naming one is refused (CUR-3388).
 */
export const isSelectableModel = (m: Pick<ProcessedModel, "id" | "unlisted">): boolean =>
	m.id !== AGENT_MODEL_ID && !m.unlisted;

const createValidModelIdSchema = (modelList: ProcessedModel[]): z.ZodType<string> => {
	if (modelList.length === 0) {
		throw new Error("No models available to build validation schema");
	}
	const ids = new Set(modelList.filter(isSelectableModel).map((m) => m.id));
	return z.string().refine((value) => ids.has(value), "Invalid model id");
};

// The task model serves every side call (titles, search decisions, corrections). Falling back
// to modelList[0] when TASK_MODEL is unset or matches nothing would let a typo or a reordered
// allowlist move side calls onto another model, or another provider's key, silently. A
// TASK_MODEL that names no registered model throws, everywhere. An unset one throws on a deployed
// environment, where both preview and prd name theirs; local dev and the hermetic CI tiers declare no
// environment and set no TASK_MODEL, so they keep the first model, with a warning that says so. (CUR-2319)
export const resolveTaskModel = (
	modelList: ProcessedModel[],
	taskModelId: string | undefined = config.TASK_MODEL,
	env: DeployEnv | null = deployEnv()
): ProcessedModel => {
	if (modelList.length === 0) {
		throw new Error("No models available to select task model");
	}

	const wanted = (taskModelId ?? "").trim();
	if (wanted) {
		const preferred = modelList.find((m) => m.name === wanted || m.id === wanted);
		if (preferred) {
			return preferred;
		}
		throw new Error(
			`TASK_MODEL is "${wanted}", which no registered model matches (registered: ${modelList.map((m) => m.id).join(", ")}). Side calls would otherwise run on ${modelList[0].id} without a word (CUR-2319).`
		);
	}

	if (env === "production" || env === "preview") {
		throw new Error(
			`TASK_MODEL is unset on ${env}. Name the side-call model explicitly; the first model in the registry (${modelList[0].id}) moves whenever the allowlist does (CUR-2319).`
		);
	}

	logger.warn(
		{ taskModelFallback: true, servedModel: modelList[0].id, env },
		"[models] TASK_MODEL is unset; side calls use the first registered model"
	);
	return modelList[0];
};

// Resolve the curated allowlist policy string. The `config` Proxy returns "" for unset keys (not
// undefined), so test the trimmed value. Unset/empty → default to Apertus 1.5 70B; "*"/"all" → full
// catalog; otherwise the comma-separated id list (see selectAllowedModels). 70B only for the alpha:
// the answer-quality layer (persona/grounding/identity-lock) is tuned for the 70B and it is the
// default served + tested model. Newer
// Apertus checkpoints may be added here later. The first allowlisted model becomes defaultModel
// (models[0]); with one entry the picker collapses to a single model.
//
// THIS DEFAULT IS THE MODEL EVERY EVAL GRADES (CUR-243): the consumers reading MODEL_ALLOWLIST[0]
// characterise the checkpoint a default turn gets. Keep this string equal to what a default turn
// actually gets.
// On a Vercel deployment the list comes from config/inference.ts (CUR-3484); see pickerSpec.
const resolveAllowlistSpec = (): string => ticketBranchAllowlist(pickerSpec() || "swiss-ai/apertus-v1.5-70b");

// Fetch + validate an upstream OpenAI-compatible /models catalog. Bounded by a timeout and retried a
// few times so a transient network blip or a scale-from-zero cold start doesn't fail the fetch on the
// first attempt (this runs in the top-level await below — an unhandled throw here 500s every route).
// Network/timeout errors and 5xx are retried; a 4xx (auth/allowlist/bad URL) or a malformed body is
// terminal — a retry can't fix those. The auth token is passed in so each lane (primary vs. backup)
// uses its own credential (the CSCS key is not the HF token).
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchModelCatalog = async (baseURL: string, authToken: string): Promise<CatalogEntry[]> => {
	logger.info({ baseURL }, "[models] Fetching model catalog");
	let lastErr: unknown;
	for (let attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt++) {
		try {
			// Use the auth token from the start if available — some APIs rate-limit unauthenticated
			// requests more aggressively.
			const response = await fetch(`${baseURL}/models`, {
				headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
				signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
			});
			logger.info({ status: response.status, attempt }, "[models] Fetch status");
			if (!response.ok) {
				if (response.status === 401 && !authToken) {
					// 401 with no token to try: nothing a retry can do.
					throw new Error(
						`Failed to fetch ${baseURL}/models: ${response.status} ${response.statusText} (no auth token available)`
					);
				}
				// The folkways adapter answers 503 with this header when its flag is off (CUR-1626): the
				// route is there and switched off on purpose, which neither a retry nor a backup lane changes.
				const disabled = response.headers?.get?.("x-folkways-disabled") || undefined;
				throw Object.assign(
					new Error(`Failed to fetch ${baseURL}/models: ${response.status} ${response.statusText}`),
					{ status: response.status, disabled }
				);
			}
			const json = await response.json();
			logger.info({ keys: Object.keys(json || {}) }, "[models] Response keys");

			const parsed = listSchema.parse(json);
			logger.info({ count: parsed.data.length }, "[models] Parsed models count");
			return parsed.data;
		} catch (err) {
			lastErr = err;
			// Terminal: a 4xx HTTP status (auth/allowlist/bad URL) or a malformed body (zod). Only
			// network-layer failures ("fetch failed") and timeouts are worth another attempt.
			const { status, disabled } = (err as { status?: number; disabled?: string } | null) ?? {};
			const terminal =
				(typeof status === "number" && status >= 400 && status < 500) ||
				Boolean(disabled) ||
				err instanceof z.ZodError;
			if (terminal || attempt === CATALOG_ATTEMPTS) {
				throw err;
			}
			logger.warn(
				{ baseURL, attempt, err: err instanceof Error ? err.message : String(err) },
				"[models] Catalog fetch failed; retrying"
			);
			await sleep(250 * attempt);
		}
	}
	// Unreachable: the loop either returns or throws. Present only to satisfy the type checker.
	throw lastErr;
};

// Process + endpoint-decorate the shaped configs into ProcessedModels (router flag added later).
const processConfigs = async (modelsRaw: ModelConfig[]): Promise<ProcessedModel[]> => {
	const builtModels = await Promise.all(
		modelsRaw.map((e) =>
			processModel(e)
				.then(addEndpoint)
				.then(async (m) => ({
					...m,
					hasInferenceAPI: inferenceApiIds.includes(m.id ?? m.name),
					// router decoration added later
					isRouter: false as boolean,
				}))
		)
	);
	return builtModels as ProcessedModel[];
};

// Prepend the LLM-router alias (Omni) when the `router-alias` flag is on (CUR-257).
//
// The gate used to be `LLM_ROUTER_ROUTES_PATH` being non-empty, which made the routing policy its own
// on/off switch: the policy could not be present with the feature off, and either direction cost a
// redeploy. The path is config now and the flag decides — see routerAliasEnabled in modelGates.ts,
// which is also where "flag on, path missing" becomes a loud misconfiguration rather than a silent off.
//
// The alias lands at models[0], so it takes defaultModel with it. That is why this is a flag and not a
// string: turning it on changes what every new conversation gets by default.
const maybeAddRouterAlias = async (
	decorated: ProcessedModel[],
	baseURL: string,
	enabled: boolean
): Promise<ProcessedModel[]> => {
	if (!enabled) {
		return decorated;
	}

	const routerLabel = (config.PUBLIC_LLM_ROUTER_DISPLAY_NAME || "Omni").trim() || "Omni";
	const routerLogo = (config.PUBLIC_LLM_ROUTER_LOGO_URL || "").trim();
	const routerAliasId = (config.PUBLIC_LLM_ROUTER_ALIAS_ID || "omni").trim() || "omni";
	const routerMultimodalEnabled =
		(config.LLM_ROUTER_ENABLE_MULTIMODAL || "").toLowerCase() === "true";
	const routerToolsEnabled = (config.LLM_ROUTER_ENABLE_TOOLS || "").toLowerCase() === "true";

	// Build a minimal model config for the alias
	const aliasRaw = {
		id: routerAliasId,
		name: routerAliasId,
		displayName: routerLabel,
		description: "Automatically routes your messages to the best model for your request.",
		logoUrl: routerLogo || undefined,
		preprompt: "",
		endpoints: [
			{
				type: "openai" as const,
				baseURL,
			},
		],
		// Keep the alias visible
		unlisted: false,
	} as ModelConfig;

	// The deployment's consent, not the per-account flag: this list is shared by every visitor on the
	// instance, so who may send an image is decided per request (modelTakesImagesNow, CUR-2725).
	if (multimodalConfigured() && routerMultimodalEnabled) {
		aliasRaw.multimodal = true;
		aliasRaw.multimodalAcceptedMimetypes = ["image/*"];
	}

	if (routerToolsEnabled) {
		aliasRaw.supportsTools = true;
	}

	// Apply MODELS overrides to the router alias too, so flags like
	// supportsArtifacts can be set on it like on any other model
	const aliasOverride = getModelOverrides().find(
		(o) => o.id?.trim() === routerAliasId || o.name?.trim() === routerAliasId
	);
	if (aliasOverride) {
		const { id, name, ...rest } = aliasOverride;
		void id;
		void name;
		Object.assign(aliasRaw, rest);
	}

	const aliasBase = await processModel(aliasRaw);
	// Create a self-referential ProcessedModel for the router endpoint
	const aliasModel: ProcessedModel = {
		...aliasBase,
		isRouter: true,
		hasInferenceAPI: false,
		// getEndpoint uses the router wrapper regardless of the endpoints array
		getEndpoint: async (): Promise<Endpoint> => makeRouterEndpoint(aliasModel),
	} as ProcessedModel;

	// Put alias first
	return [aliasModel, ...decorated];
};

// Append the Potluck agent model (Story B) when the agent mode is on. Gated so it appears ONLY
// where configured (off by default → safe for the alpha). The agent endpoint streams the service's
// /run + SSE into chat-ui's token stream (plan/steps as a <think> block, verified result as the
// answer).
//
// The gate is agentModeEnabled() (agentMode.ts): deployEnv() === "preview" | "production" decides
// on/off first, THEN AGENT_MODE_FLAG is read from PostHog (CUR-1451); AGENT_SERVICE_URL is config, and
// a missing URL on an allowed env is a loud config error inside that call, not a silent gate. It is the SAME call
// layoutData.ts makes for `agentEnabled`, so the registry and the UI toggle cannot disagree about
// whether this feature exists. Because the gate returns false unless the URL is present,
// `agentServiceUrl()` below is guaranteed non-empty here. NOTE: this runs during registry build, once
// per instance; flipping deployEnv or the flag re-gates the surface at the next rebuild/poll.
//
// `unlisted: true` (CUR-770): the agent is registered here so `resolveAgentRoute`'s internal lookup and
// turn-serving logic can find its config, but it is never a directly-selectable model — no gallery
// entry, no picker row, rejected by `createValidModelIdSchema` (models.ts, above). The
// composer's AgentMode toggle (stores/agentMode.ts) is the only path onto it, for every user including a
// cleared tester — it's a per-turn setting layered on whatever real chat model the conversation actually
// has, not a peer choice in the model list.
//
// The gate's answer arrives as an argument. Every registry gate needs a `refreshFlags()` ahead of its
// read, so a cold instance doesn't cache "no agent" for its whole life, and one copy per gate is how one
// of them gets dropped, so resolveRegistryGates owns the poll and hands every gate its answer
// (modelGates.ts).
const maybeAddAgentModel = async (
	decorated: ProcessedModel[],
	enabled: boolean
): Promise<ProcessedModel[]> => {
	if (!enabled) {
		return decorated;
	}
	const agentUrl = agentServiceUrl();

	// Neutral provenance: the agent backend is not fixed to any one model (it has been Apertus and is
	// currently a Mistral checkpoint), so DON'T hardcode a model brand here. Leave empty when
	// AGENT_SERVICE_MODEL is unset — the endpoint corrects the badge at runtime from the service's own
	// done.model (identity.ts renders whatever actually served, drift-proof), so the label can't go stale.
	const agentModelName = (
		(Reflect.get(config, "AGENT_SERVICE_MODEL") as string | undefined) ?? ""
	).trim();
	const agentRaw = {
		id: "potluck-agent",
		name: "potluck-agent",
		displayName:
			((Reflect.get(config, "AGENT_SERVICE_DISPLAY_NAME") as string | undefined) ?? "").trim() ||
			"Potluck Agent",
		description:
			"Runs your task as a multi-step agent — sandboxed and metered server-side — and shows its plan and steps as it works.",
		preprompt: "",
		endpoints: [
			{
				type: "agent" as const,
				baseURL: agentUrl,
				// agentServiceToken()'s var; blank → no Authorization header, as before.
				apiKeyEnv: "AGENT_SERVICE_TOKEN",
				provenanceModel: agentModelName,
			},
		],
		unlisted: true,
	} as ModelConfig;
	const agentModel = {
		...addEndpoint(await processModel(agentRaw)),
		isRouter: false as boolean,
		hasInferenceAPI: false,
	} as ProcessedModel;
	logger.info({ baseURL: agentUrl }, "[models] Registered Potluck agent model (potluck-agent)");
	return [...decorated, agentModel];
};

/** A model the picker never offers (a compare target or a side call), on one OpenAI-compatible
 * endpoint, plus an optional backup lane that asks the same host for another model. */
async function unlistedModel(
	id: string,
	displayName: string,
	description: string,
	endpoint: { baseURL: string; apiKeyEnv: string; routerProvider?: string },
	backupModelId?: string,
	wire: (id: string) => { modelId?: string; servedAs?: string } = () => ({})
): Promise<ProcessedModel> {
	const raw = {
		id,
		name: id,
		displayName,
		description,
		preprompt: "",
		endpoints: [
			{ type: "openai" as const, ...endpoint, ...wire(id) },
			...(backupModelId
				? [{ type: "openai" as const, ...endpoint, modelId: backupModelId, ...wire(backupModelId) }]
				: []),
		],
		unlisted: true,
	} as ModelConfig;
	return {
		...addEndpoint(await processModel(raw)),
		isRouter: false as boolean,
		hasInferenceAPI: false,
	} as ProcessedModel;
}

// Append the opt-in compare/second-opinion panel when SECOND_OPINION_* is configured. Independent
// open models on a DIFFERENT provider: the sovereign Apertus primary stays on its own base (CSCS);
// these register the ordered "compare with another model" stack — a SECOND opinion (e.g. GLM-5.2)
// and an optional THIRD (e.g. Mistral Large 3) — each as an unlisted per-model endpoint with honest
// provenance, all riding the SAME compare endpoint (same baseURL + key, different model id). Neutral
// triangulation, not "a more capable model" (we don't assert a hierarchy). Off by default → safe for
// the alpha; the third is dormant until THIRD_OPINION_MODEL is set. The side-call models
// (ARITHMETIC_ROUTE_MODEL, TASK_MODEL) register on the same endpoint, except that with the
// `side-call-own-lane` flag on, one listed in MISTRAL_MODELS registers on the Mistral lane (CUR-2262).
const maybeAddCompareModels = async (
	decorated: ProcessedModel[],
	direct: DirectEndpoint | null = null,
	sideCallLane = false
): Promise<ProcessedModel[]> => {
	const soBaseURL = (
		(Reflect.get(config, "SECOND_OPINION_BASE_URL") as string | undefined) ?? ""
	).trim();
	const soApiKey = (
		(Reflect.get(config, "SECOND_OPINION_API_KEY") as string | undefined) ?? ""
	).trim();
	// The panel = COMPARE_PANEL (comma-separated, for the collective fanout) when set, else the
	// sequential [SECOND, THIRD] pair. Plus the AGGREGATOR_MODEL (the verdict writer) if it isn't
	// already a panelist. All ride the same compare endpoint.
	const secondId = (
		(Reflect.get(config, "SECOND_OPINION_MODEL") as string | undefined) ?? ""
	).trim();
	const thirdId = ((Reflect.get(config, "THIRD_OPINION_MODEL") as string | undefined) ?? "").trim();
	const panelRaw = ((Reflect.get(config, "COMPARE_PANEL") as string | undefined) ?? "").trim();
	const aggId = ((Reflect.get(config, "AGGREGATOR_MODEL") as string | undefined) ?? "").trim();
	const panelIds = panelRaw
		? panelRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [secondId, thirdId].filter(Boolean);
	// Display-name hints for the two named singles; panel ids derive a name from the id.
	const nameHints: Record<string, string> = {};
	const secondName = (
		(Reflect.get(config, "SECOND_OPINION_DISPLAY_NAME") as string | undefined) ?? ""
	).trim();
	const thirdName = (
		(Reflect.get(config, "THIRD_OPINION_DISPLAY_NAME") as string | undefined) ?? ""
	).trim();
	if (secondId && secondName) nameHints[secondId] = secondName;
	if (thirdId && thirdName) nameHints[thirdId] = thirdName;
	// Side-call models the app calls on its own (CUR-2261): ARITHMETIC_ROUTE_MODEL (the math-routing
	// turn planner), TASK_MODEL (titles and other side calls) and SECOND_OPINION_MODEL (the RAG
	// entity-scope guard pins to it, CUR-2263). All are looked up by id in the
	// registry, so each is registered here in its own right instead of working only while COMPARE_PANEL
	// happens to list the same id. An id already registered (TASK_MODEL naming an allowlisted chat
	// model, or a panelist) is left as it is.
	const sideCallIds = ["ARITHMETIC_ROUTE_MODEL", "TASK_MODEL", "SECOND_OPINION_MODEL"]
		.map((key) => ((Reflect.get(config, key) as string | undefined) ?? "").trim())
		.filter((id) => id && !decorated.some((m) => m.id === id || m.name === id));
	// A side-call id Mistral serves goes to Mistral: on the compare endpoint it would be sent to a
	// provider that does not have it (CUR-2262).
	const lane = sideCallLane ? direct : null;
	const directSideCallIds = lane
		? [...new Set(sideCallIds.filter((id) => lane.modelIds.includes(id)))]
		: [];
	// A panelist the picker already offers (CUR-1683) is registered once, as the picker entry on the same
	// host, so a lookup by id never finds two models.
	const compareIds = [
		...new Set([...panelIds, ...(aggId ? [aggId] : []), ...sideCallIds]),
	].filter(
		(id) => !directSideCallIds.includes(id) && !decorated.some((m) => m.id === id || m.name === id)
	);
	// Shape-only diagnostic (booleans + counts, never values) — lets an audit tell whether COMPARE_PANEL
	// or the legacy SECOND/THIRD pair is actually driving the panel, and whether the credential pair is
	// present, without ever touching the secret content itself (needed: SECOND_OPINION_API_KEY is a
	// Vercel "Sensitive" var, permanently unreadable by anyone after creation, dashboard included).
	logger.info(
		{
			hasBaseURL: Boolean(soBaseURL),
			hasApiKey: Boolean(soApiKey),
			comparePanelSet: Boolean(panelRaw),
			secondModelSet: Boolean(secondId),
			thirdModelSet: Boolean(thirdId),
			aggregatorSet: Boolean(aggId),
			resolvedPanelSize: panelIds.length,
			sideCallModels: sideCallIds.length,
			directSideCallModels: directSideCallIds.length,
		},
		"[models] compare/second-opinion config shape"
	);

	let result = decorated;
	if (lane) {
		for (const [i, id] of directSideCallIds.entries()) {
			// Each Mistral side-call model is backed by the next one on the lane, so Small and Medium back
			// each other (CUR-2092). Both share the Mistral account, so an account-level
			// failure takes out both lanes; that risk is accepted. A lone side-call model has no partner.
			const partner =
				directSideCallIds.length > 1
					? directSideCallIds[(i + 1) % directSideCallIds.length]
					: undefined;
			const model = await unlistedModel(
				id,
				id,
				"A model the app calls for side work (turn planning, titles, search decisions), never offered in the picker. Served by Mistral.",
				{
					baseURL: lane.baseURL,
					apiKeyEnv: lane.apiKeyEnv,
					...(lane.provider ? { routerProvider: lane.provider } : {}),
				},
				partner,
				(wireId) => directWire(lane, wireId)
			);
			result = [...result, model];
			logger.info(
				{ baseURL: lane.baseURL, model: id, backupModel: partner ?? null },
				"[models] Registered side-call model on its own lane"
			);
		}
	}

	if (!(soBaseURL && soApiKey && compareIds.length)) {
		return result;
	}

	for (const id of compareIds) {
		const model = await unlistedModel(
			id,
			nameHints[id] || id.split("/").pop() || id,
			sideCallIds.includes(id)
				? "An open-weights model the app calls for side work (turn planning, titles, retrieval checks), never offered in the picker. Served on a non-sovereign provider."
				: "An independent open-weights model, offered as an opt-in cross-check (compare with another model / collective second opinion). Open weights, served on a non-sovereign provider — labeled as such.",
			{ baseURL: soBaseURL.replace(/\/$/, ""), apiKeyEnv: "SECOND_OPINION_API_KEY" }
		);
		result = [...result, model];
		logger.info({ baseURL: soBaseURL, model: id }, "[models] Registered compare model");
	}
	return result;
};

// Load the /models catalog with a same-model backup lane: if the primary (e.g. CSCS-direct) is
// unreachable, fetch the list from the configured backup host (e.g. HF router) using its own token.
// Without it, a primary blip at server boot throws out of the top-level await below and 500s every
// route. The shaped configs still carry BOTH lanes for streaming regardless of which host served the
// list, so downstream provenance/failover is unchanged.
//
// It is NOT the streaming failover (withFailover), and the difference is CUR-1249. The streaming lane
// maps the model id onto the backup's spelling (FALLBACK_MODEL_ID); the model list cannot, because the
// allowlist is written in the primary's ids and the HF router spells them differently
// (`swiss-ai/Apertus-v1.5-70B` against `swiss-ai/apertus-v1.5-70b`). So a backup catalogue is accepted
// only when the allowlist finds something in it, and a primary that says it is switched off is not
// failed over at all.
const loadCatalog = async (baseURL: string): Promise<CatalogEntry[]> => {
	// Canonical auth token is OPENAI_API_KEY; keep HF_TOKEN as legacy alias.
	const primaryToken = firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "modelsAuthToken");
	try {
		const catalog = await fetchModelCatalog(baseURL, primaryToken);
		gatewayListed = new Set(catalog.map((e) => e.id));
		return catalog;
	} catch (primaryErr) {
		const disabled = (primaryErr as { disabled?: string } | null)?.disabled;
		if (disabled) {
			logger.error(
				{ primary: baseURL, flag: disabled },
				"[models] Primary catalog is switched off by its flag; not failing over, since that is configuration and not an outage"
			);
			throw primaryErr;
		}
		const fb = fallbackBaseURL.replace(/\/$/, "");
		if (!fb || fb === baseURL) {
			throw primaryErr; // no distinct backup lane configured — nothing to fall back to
		}
		logger.error(
			{
				primary: baseURL,
				backup: fb,
				err: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
			},
			"[models] Primary catalog fetch failed; falling back to the backup lane for the model list"
		);
		void captureServerException(primaryErr);
		const catalog = await fetchModelCatalog(fb, fallbackApiKey);
		const allowlistSpec = resolveAllowlistSpec();
		const withDirect = withDirectModels(
			withDirectModels(catalog, mistralEndpoint()),
			hfEndpoint(allowlistSpec)
		);
		if (selectAllowedModels(withDirect, allowlistSpec).length === 0) {
			logger.error(
				{ backup: fb, allowlist: allowlistSpec, catalogSize: catalog.length },
				"[models] Backup catalog cannot satisfy the allowlist; keeping the primary's failure rather than loading a list that serves nothing"
			);
			throw primaryErr;
		}
		logger.warn(
			{ backup: fb },
			"[models] Model catalog loaded from BACKUP lane (primary was unreachable)"
		);
		return catalog;
	}
};

/** The gates the published registry was built with (CUR-1149, CUR-4194). */
let lastKnownGates: RegistryGates | null = null;

// Shape + process + endpoint-decorate a raw catalog into ProcessedModels. The SAME transform for the
// live fetch and the boot snapshot — only WHERE the raw `catalog` comes from differs (§C): the snapshot
// only replaces the catalog SOURCE, never how it is allowlisted/shaped/overridden/decorated.
const buildModelsFromCatalog = async (
	catalog: CatalogEntry[],
	baseURL: string
): Promise<ProcessedModel[]> => {
	// EVERY flag this build reads is answered here, against one fresh poll, BEFORE anything reads a
	// gate. The registry builds once per instance, so a gate read against a cold-start snapshot would be
	// cached for the instance's whole life and the flag would look broken rather than off. See
	// modelGates.ts — the type is only obtainable from that call, which is what keeps the order.
	const gates: RegistryGates = await resolveRegistryGates();
	// What this registry is built from, so the next gate check compares against what is actually being
	// served. Left null, the first check would only record the polled gates, and a registry built from
	// fallbacks behind a slow poll would keep them until a flag changed again.
	lastKnownGates = gates;

	// Constrain the upstream router's full catalog to a curated allowlist, shape the survivors into
	// model configs, then layer MODELS overrides on top (see $lib/chat/server/modelsCatalog).
	//
	// With the `model-picker` flag off, the allowlist still decides WHICH models are admissible and the
	// flag decides whether more than the first is offered — so a widened MODEL_ALLOWLIST is inert until
	// someone turns the picker on, and defaultModel is the same model either way (CUR-245).
	const direct = mistralEndpoint();
	const allowlistSpec = resolveAllowlistSpec();
	const hfPinned = hfEndpoint(allowlistSpec);
	const allowed = offeredModels(
		selectAllowedModels(withDirectModels(withDirectModels(catalog, direct), hfPinned), allowlistSpec),
		gates.picker
	);
	// The lane guard runs last so a MODELS override can't reintroduce a substitute (CUR-3936).
	const configs = withOnlyPickedModelLanes(
		applyOverrides(
			routeDirectModels(
				routeDirectModels(
					toModelConfigs(allowed, {
						baseURL,
						isHFRouter,
						multimodalEnabled: multimodalConfigured(),
						fallbackBaseURL: catalogBackup.baseURL,
						fallbackApiKeyEnv: catalogBackup.apiKeyEnv,
						fallbackModelId,
						fallbackBillTo: catalogBackup.billTo,
					}),
					direct
				),
				hfPinned
			),
			getModelOverrides()
		)
	);

	let decorated = await processConfigs(configs);
	decorated = await maybeAddRouterAlias(decorated, baseURL, gates.routerAlias);
	decorated = await maybeAddAgentModel(decorated, gates.agent);
	decorated = await maybeAddCompareModels(decorated, direct, gates.sideCallLane);
	return decorated;
};

const buildModels = async (): Promise<ProcessedModel[]> => {
	if (!openaiBaseUrl) {
		logger.error(
			"OPENAI_BASE_URL is required. Set it to an OpenAI-compatible base (e.g., https://router.huggingface.co/v1)."
		);
		throw new Error("OPENAI_BASE_URL not set");
	}
	const baseURL = openaiBaseUrl;

	try {
		const catalog = await loadCatalog(baseURL);
		return await buildModelsFromCatalog(catalog, baseURL);
	} catch (e) {
		logger.error(e, "Failed to load models from OpenAI base URL");
		throw e;
	}
};

// Publish a freshly-built registry into the four live exports ATOMICALLY (§C): `models` is refreshed by
// IN-PLACE mutation (splice) so an importer holding the array object observes it; the other three are
// reassigned (ES live bindings propagate to call-time readers — verified: no importer destructures them
// into a module-scope local). Factored out so BOTH the initializer and the background snapshot-drift
// refresh publish all four together — a drift refresh can never leave `models` updated while
// defaultModel/taskModel/validModelIdSchema still describe the old set. Requires a NON-EMPTY list
// (defaultModel/resolveTaskModel/createValidModelIdSchema all reject empty); callers guard that.
export const publishRegistry = (newModels: ProcessedModel[]): void => {
	// Resolve before mutating anything: resolveTaskModel throws on a misconfigured TASK_MODEL, and a
	// throw after the splice would leave `models` holding the new list while taskModel still names the
	// old one, which is the disagreement this function exists to prevent.
	const nextTaskModel = resolveTaskModel(newModels);
	const nextSchema = createValidModelIdSchema(newModels);
	models.splice(0, models.length, ...newModels);
	defaultModel = models[0];
	taskModel = nextTaskModel;
	validModelIdSchema = nextSchema;
	if (process.env.CI_HERMETIC !== "true") void reportInferenceTopology(models);
};

// What the primary catalog listed when this module last read it (the live fetch or the boot snapshot),
// so the role check reuses it rather than asking the gateway again.
let gatewayListed: Set<string> | null = null;

// Every lane this module can send a request to, for config/inference.ts (CUR-2277). The key VALUES are
// here only so the check can read each lane's /models; the config records the env var names.
const inferenceLanes = (): Lane[] => {
	const env = (key: string) => ((Reflect.get(config, key) as string | undefined) ?? "").trim();
	const direct = mistralEndpoint();
	const gatewayKey = firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "inferenceGatewayKey", { allowEmpty: true });
	// The catalog backup is FALLBACK_BASE_URL when set (CUR-2293), else the HF pair. On its own host
	// with no FALLBACK_API_KEY it rides the gateway's key, which is what endpointOai sends.
	const backupKey = endpointApiKey(catalogBackup);
	const backupKeyEnv = !catalogBackupHost ? "HF_TOKEN" : backupKey ? "FALLBACK_API_KEY" : "OPENAI_API_KEY";
	return [
		...(openaiBaseUrl
			? [{ name: "gateway", baseURL: openaiBaseUrl, keyEnv: "OPENAI_API_KEY", listsModels: true, apiKey: gatewayKey }]
			: []),
		...(catalogBackup.baseURL
			? [{ name: "backup", baseURL: catalogBackup.baseURL, keyEnv: backupKeyEnv, listsModels: true, apiKey: backupKey || gatewayKey || undefined }]
			: []),
		...(fallbackBaseURL
			? [{ name: "hf", baseURL: fallbackBaseURL, keyEnv: "HF_TOKEN", listsModels: true, apiKey: fallbackApiKey || undefined }]
			: []),
		...(direct ? [{ name: "mistral", baseURL: direct.baseURL, keyEnv: mistralChatLane().keyEnv, listsModels: false }] : []),
		...(env("SECOND_OPINION_BASE_URL")
			? [{ name: "compare", baseURL: env("SECOND_OPINION_BASE_URL"), keyEnv: "SECOND_OPINION_API_KEY", listsModels: false }]
			: []),
	];
};

// Builds the inference config from the registry just published, logs it, and checks every role against
// its provider's /models. Phase 1 changes nothing that is served: a misconfigured role is an error log
// and a captured exception at boot, where before it was a visitor-facing failure the first time the
// role was used (CUR-2293). Never throws.
const reportInferenceTopology = async (registry: ProcessedModel[]): Promise<void> => {
	const env = (key: string) => ((Reflect.get(config, key) as string | undefined) ?? "").trim() || undefined;
	const list = (raw: string | undefined) => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const environment = inferenceEnvironment(process.env.VERCEL_ENV);
	const lanes = inferenceLanes();
	const shadowed = shadowedIds(registry);
	if (shadowed.length) {
		logger.warn({ shadowed }, "[inference] a model id is registered more than once; only the first registration is served");
	}
	try {
		const cfg = topologyFromRegistry(
			registry.map((m) => ({ id: m.id, unlisted: m.unlisted, supportsTools: m.supportsTools, endpoints: m.endpoints })),
			lanes,
			{
				defaultChat: registry[0].id,
				task: env("TASK_MODEL"),
				arithmeticRoute: env("ARITHMETIC_ROUTE_MODEL"),
				comparePanel: env("COMPARE_PANEL")
					? list(env("COMPARE_PANEL"))
					: [env("SECOND_OPINION_MODEL"), env("THIRD_OPINION_MODEL")].filter((id): id is string => !!id),
				aggregator: env("AGGREGATOR_MODEL"),
				picker: servableModels(registry).filter((m) => !m.unlisted).map((m) => m.id),
			},
			environment
		);
		const served = servableModels(registry).map((m) => m.id).sort();
		logger.info({ environment, roles: describeRoles(cfg), served }, "[inference] topology");
		const known = gatewayListed ? new Map([["gateway", gatewayListed]]) : new Map<string, Set<string>>();
		const { unserved, fetchErrors } = await checkRoles(cfg, lanes, known);
		for (const r of unserved.filter((u) => u.reason === "absent")) {
			logger.error(r, "[inference] a role names a model its provider does not serve");
		}
		// An unreadable list is expected on a cold start (a slow /models), and the role still serves:
		// one warn per provider, never an error per role (CUR-4057). No failopen field: the fail-open
		// monitor pages at three an hour, and nothing here falls back for a person.
		for (const p of uncheckedProviders(cfg, unserved, fetchErrors)) {
			logger.warn(
				{ reason: p.reason, provider: p.provider, host: p.host, error: p.error, unchecked: p.unchecked },
				p.message
			);
		}
		if (unserved.some((r) => r.reason === "absent")) {
			void captureServerException(new Error(`[inference] unserved roles: ${unserved.map((r) => `${r.role}=${r.upstream}@${r.provider}`).join(", ")}`));
		}
	} catch (e) {
		logger.error(e, "[inference] the registry does not make a valid inference config");
		void captureServerException(e);
	}
};

// Build (or rebuild) the model registry from the LIVE catalog and publish it into the live exports.
// Models a visitor can actually choose and send a message to. NOT the same as the registry's length
// (CUR-1246): buildModelsFromCatalog appends the agent model and the compare panel AFTER the
// allowlisted chat models, all of them `unlisted`, so a build whose allowlist matched NOTHING still
// returns five entries. An emptiness guard that counts those as a healthy registry lets `initModels`
// publish it without throwing, `ensureModelsReady` skip the retry, and `applyLiveRegistry` republish it
// over a working snapshot; the deployment then serves "No models available" for its whole life while
// every route answers 200. A primary catalog 404 that falls back to a catalog where the allowlist
// matches nothing is enough to get there.
const servableModels = (list: ProcessedModel[]): ProcessedModel[] => list.filter(isSelectableModel);

/** Can this instance actually answer a chat turn? The question `/chat/healthcheck` asks, and the one
 *  `models.length` cannot answer — a registry of five unlisted entries is non-empty and serves nobody. */
export const registryCanServe = (): boolean => servableModels(models).length > 0;

const initModels = async (): Promise<void> => {
	const startedAt = Date.now();
	const newModels = await buildModels();
	if (servableModels(newModels).length === 0) {
		throw new Error("Failed to load any models from upstream");
	}

	publishRegistry(newModels);

	logger.info(
		{ total: models.length, durationMs: Date.now() - startedAt },
		"[models] Model cache built"
	);
};

let initInFlight: Promise<void> | null = null;
let lastInitFailureAt = 0;
// After a failed init, fail requests fast for this long instead of re-hitting a struggling upstream
// from every request (each attempt is already 3 tries × 15s per lane inside fetchModelCatalog).
const INIT_RETRY_COOLDOWN_MS = 15_000;

/**
 * Ensure the model registry is built, retrying a failed boot init on demand.
 *
 * Memoizes SUCCESS only: a failed attempt clears the in-flight promise (after a short cooldown) so a
 * later request retries, while concurrent requests share one attempt. This is the anti-zombie seam:
 * a transient upstream failure would reject the top-level await below, and Node's ESM loader
 * CACHES a failed module evaluation — the instance would then serve instant 500s forever while looking
 * "warm" to the load balancer. Requests are gated on this in hooks.handle,
 * so the first request after the upstream recovers heals the instance in place.
 */
export const ensureModelsReady = async (): Promise<void> => {
	// Servable, not total. A registry of only the agent and the compare panel is non-empty and serves
	// nobody, and returning early on it would skip the retry below, so
	// an instance that lost its catalog once would stay dead for its whole life (CUR-1246). The tradeoff is deliberate
	// — a request now errors and triggers a heal instead of rendering a page that says "No models
	// available" forever, which reads as a configuration choice rather than a broken instance.
	if (registryCanServe()) return;
	if (!initInFlight) {
		if (Date.now() - lastInitFailureAt < INIT_RETRY_COOLDOWN_MS) {
			// Every request refused during the cooldown window is logged. `warn`, not
			// `error`/captureServerException: the underlying failure was already reported once below when it
			// happened, and every request hitting this branch during the same 15s window is the same
			// failure, not a new one. (CUR-1154)
			logger.warn(
				{ cooldownRemainingMs: INIT_RETRY_COOLDOWN_MS - (Date.now() - lastInitFailureAt) },
				"[models] Model registry unavailable — retry cooldown active, refusing without a fresh attempt"
			);
			throw new Error("Model registry unavailable (catalog fetch failed; retry cooldown active)");
		}
		initInFlight = initModels().catch((e) => {
			lastInitFailureAt = Date.now();
			initInFlight = null; // memoize success only — a later request retries
			logger.error(e, "[models] Per-request registry init failed; entering retry cooldown");
			void captureServerException(e);
			throw e;
		});
	}
	await initInFlight;
};

// Kill switch for the boot snapshot (§C). Default ON: when a valid snapshot exists the registry boots
// from it with NO upstream round-trip in the top-level await, then refreshes live in the background.
// "off" forces the live fetch path — byte-identical to before §C (including failover + retry).
const snapshotBootEnabled =
	((Reflect.get(config, "MODELS_BOOT_SNAPSHOT") as string | undefined) ?? "").toLowerCase() !== "off";

// Republish the LIVE registry over a snapshot-booted one ONLY when the model-id set DRIFTED (a model
// added/removed upstream since the snapshot was committed). No drift ⇒ the snapshot registry already
// serves the same ids shaped with runtime endpoint config, so it stands. An empty live build (a fetch
// that produced nothing) keeps the snapshot. Returns whether it republished (for callers/tests).
export const applyLiveRegistry = (
	snapshotModels: ProcessedModel[],
	liveModels: ProcessedModel[]
): boolean => {
	// Servable, not total — see servableModels above. A live build carrying only the agent and the
	// compare panel has nothing a visitor can send a message to, and replacing a working snapshot with
	// it is strictly worse than keeping what already serves.
	if (servableModels(liveModels).length === 0) return false;
	const { drifted, snapshotIds, liveIds } = computeModelDrift(
		snapshotModels.map((m) => m.id),
		liveModels.map((m) => m.id)
	);
	if (!drifted) return false;
	publishRegistry(liveModels);
	logger.info(
		{ snapshotIds, liveIds },
		"[models] snapshot drift — republished the live catalog over the boot snapshot"
	);
	return true;
};

// Background live catalog fetch AFTER a snapshot boot: republish over the snapshot only on drift, and on
// a fetch failure keep the snapshot (log). Fire-and-forget — never blocks or fails boot.
const refreshFromLive = async (snapshotModels: ProcessedModel[]): Promise<void> => {
	try {
		applyLiveRegistry(snapshotModels, await buildModels());
	} catch (e) {
		logger.warn(e, "[models] Background live catalog refresh failed; keeping the boot snapshot registry");
	}
};

// The last gate answer this process has seen, so the warm-cron caller below can tell "unchanged" from
// "just flipped" without rebuilding on every tick. `null` means "never checked yet".

const gatesEqual = (a: RegistryGates, b: RegistryGates): boolean =>
	a.picker === b.picker &&
	a.routerAlias === b.routerAlias &&
	a.agent === b.agent &&
	a.sideCallLane === b.sideCallLane;

/**
 * Re-derive the three registry gates against a fresh flag poll, and rebuild + republish the registry
 * ONLY when a gate's value actually changed since the last check (CUR-1149).
 *
 * `ensureModelsReady` builds the registry exactly ONCE per process — that's deliberate (see its own
 * comment), but it means nothing re-reads the gates again for the rest of that process's life, and a
 * process's life can span more than one deploy on warm compute (CUR-1122). Called from the warm cron
 * (already running every ~60s to keep the flag SNAPSHOT fresh, per refreshFlags's own header) so a stale
 * registry self-corrects on the same cadence without a forced cold start.
 *
 * Cheap in the common (unchanged) case — one flag poll, no catalog fetch. A full `buildModels()` only
 * runs on a real flip, and a failed rebuild leaves the previous registry serving rather than clearing it.
 */
export const refreshRegistryGatesIfChanged = async (): Promise<{
	changed: boolean;
	gates: RegistryGates;
}> => {
	const gates = await resolveRegistryGates();
	const changed = lastKnownGates !== null && !gatesEqual(lastKnownGates, gates);
	if (!changed || models.length === 0) {
		if (lastKnownGates === null) lastKnownGates = gates;
		return { changed: false, gates };
	}
	try {
		const rebuilt = await buildModels();
		// Servable, not total — the warm cron calls this every ~60s, so this is the path by which a
		// single failed catalog fetch could replace a working production registry with one nobody can
		// use (CUR-1246).
		if (servableModels(rebuilt).length > 0) publishRegistry(rebuilt);
		logger.info({ gates, rebuiltCount: rebuilt.length }, "[models] registry gates changed — republished");
		return { changed: true, gates };
	} catch (e) {
		logger.warn(e, "[models] gate change detected but rebuild failed; keeping the previous registry");
		return { changed: false, gates };
	}
};

// A cold instance whose registry was built past the boot poll's cap rebuilds itself when that poll
// lands, rather than waiting for the warm cron, which previews don't get (CUR-4194).
onRegistryPollLanded(() =>
	refreshRegistryGatesIfChanged().catch((e) => logger.warn(e, "[models] late-poll gate refresh failed"))
);

// Boot the registry: prefer the committed snapshot (instant, no upstream round-trip), falling back to
// today's live fetch when there's no usable snapshot (absent/invalid/mismatched base/flag off). §C.
// Exported ONLY for the boot loader spec (models.boot.spec.ts) to exercise the snapshot-vs-live paths
// deterministically; the sole call site remains the module-eval boot below.
export const bootModels = async (): Promise<void> => {
	const snapshot = snapshotBootEnabled ? parseModelsSnapshot(modelsSnapshotRaw, openaiBaseUrl) : null;
	if (snapshot) {
		try {
			// openaiBaseUrl is defined here — parseModelsSnapshot only returns non-null when the snapshot's
			// baseURL equals the (truthy) configured base.
			gatewayListed = new Set(snapshot.entries.map((e) => e.id));
			const snapshotModels = await buildModelsFromCatalog(snapshot.entries, openaiBaseUrl as string);
			// Servable, not total — the last of the four publish paths. A snapshot whose entries no longer
			// match the allowlist would otherwise boot an instance into the same unusable state.
			if (servableModels(snapshotModels).length > 0) {
				publishRegistry(snapshotModels);
				logger.info(
					{ total: snapshotModels.length, fetchedAt: snapshot.fetchedAt },
					"[models] Booted from the committed snapshot (no upstream catalog fetch)"
				);
				void refreshFromLive(snapshotModels); // background drift refresh; never blocks boot
				return;
			}
		} catch (e) {
			logger.warn(e, "[models] Snapshot boot failed; falling back to the live catalog fetch");
		}
	}
	// No usable snapshot — today's live path, byte-identical (via the per-request-shared init gate).
	await ensureModelsReady();
};

// Skip the initial fetch during `vite build`: SvelteKit's analyse phase imports this
// module, and hitting the live router from CI builds fails on rate limits (429).
// Also skip under CI_HERMETIC — hermetic unit tests must not pay production catalog boot
// (models.boot.spec.ts drives bootModels() explicitly). The model list is built once at
// server startup; new models appear on redeploy.
if (!building && process.env.CI_HERMETIC !== "true") {
	// Warm path: build at module eval so the first request doesn't pay the fetch — snapshot-first, live
	// fallback — but NEVER let a failure escape module evaluation (see ensureModelsReady above). On
	// failure the registry stays empty and the per-request gate retries.
	await bootModels().catch((e) => {
		logger.error(e, "[models] Startup model init failed; will retry per-request");
		void captureServerException(e);
	});
}

// if `TASK_MODEL` is string & name of a model in `MODELS`, then we use `MODELS[TASK_MODEL]`, else we try to parse `TASK_MODEL` as a model config itself

export type BackendModel = Optional<
	typeof defaultModel,
	"preprompt" | "parameters" | "multimodal" | "unlisted" | "hasInferenceAPI"
>;
