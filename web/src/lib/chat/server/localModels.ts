/**
 * Per-user local (LAN/self-hosted) inference endpoint — built fresh per request from the requesting
 * user's `local_inference_endpoints` DB row, never merged into the shared, boot-once `models` registry
 * (which is process-wide and would leak one user's endpoint to every other request).
 *
 * The endpoint's model LIST is discovered live from the server itself (`GET {baseUrl}/models`, the same
 * OpenAI-compatible catalog shape `models.ts` already parses for the primary gateway) rather than
 * hard-coded — a local Ollama-style server can have any number of models pulled, and that set changes
 * independently of anything this app configures. The discovered list is cached per baseUrl with a short
 * TTL (see `LOCAL_MODELS_CACHE_TTL_MS`) so the common per-request call sites (turn resolution, settings
 * validation) don't each pay a live round trip to the user's own machine — only a cache miss/expiry does,
 * which in practice means "whenever the user opens the settings page or the picker after the TTL has
 * lapsed," per CUR-1194's own ask.
 *
 * `getEffectiveModels`/`getEffectiveValidModelIdSchema` are the two things every call site that reads
 * the global `models` array or the module-level `validModelIdSchema` for a LIVE request should read
 * instead, so a user's local model(s) participate in model selection, settings validation, and
 * conversation resolution the same way a catalog model does.
 */
import { z } from "zod";
import { LOCAL_ENDPOINT_API_KEY } from "$lib/chat/server/endpointKey";
import {
	listLocalEndpointsForUserId,
	getLocalEndpointForUserAndId,
	type LocalInferenceEndpointRow,
	type LocalInferenceHeader,
} from "$lib/chat/server/db/localInferenceEndpoints";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import { catalogEntrySchema } from "$lib/chat/server/modelsSnapshot";
import { DEFAULT_LOCAL_GENERATION_TIMEOUT_MS } from "$lib/chat/utils/deadlineLadder";
import { logger } from "$lib/chat/server/logger";
import { localEndpointFetch, privateLocalAddressesAllowed } from "$lib/chat/server/localEndpointFetch";
import { isPrivateHostname } from "$lib/chat/server/urlSafety";
import {
	models,
	processModel,
	addEndpoint,
	type ModelConfig,
	isSelectableModel,
	type ProcessedModel,
} from "$lib/chat/server/models";

/** The non-secret bearer a local endpoint is built with, in place of endpointOai's env-key default. */

export const LOCAL_MODEL_ID_PREFIX = "local:";

// A user can now have more than one local endpoint (CUR-1262), so the internal model id has to say
// WHICH endpoint a discovered model came from — two servers can both report "llama3.2:latest", and
// without this they'd collide (same picker entry, same {#each} key, ambiguous which server a turn
// actually goes to). `newId()` (db/ids.ts) is a fixed-width 24-hex-char id, so a FIXED offset — not a
// separator search — recovers it even though the served model id itself may contain colons
// ("llama3.2:latest"). Shape: `local:{24-hex endpointId}:{servedModelId}`.
const LOCAL_ENDPOINT_ID_LENGTH = 24;

function buildLocalModelId(endpointId: string, servedModelId: string): string {
	return `${LOCAL_MODEL_ID_PREFIX}${endpointId}:${servedModelId}`;
}

/** Inverse of buildLocalModelId — null for anything that isn't shaped like a local model id at all
 *  (a catalog id, garbage, or a local id from before CUR-1262's endpoint-namespacing). */
function parseLocalModelId(modelId: string): { endpointId: string; servedModelId: string } | null {
	if (!modelId.startsWith(LOCAL_MODEL_ID_PREFIX)) return null;
	const rest = modelId.slice(LOCAL_MODEL_ID_PREFIX.length);
	if (rest.length <= LOCAL_ENDPOINT_ID_LENGTH || rest[LOCAL_ENDPOINT_ID_LENGTH] !== ":") return null;
	const endpointId = rest.slice(0, LOCAL_ENDPOINT_ID_LENGTH);
	const servedModelId = rest.slice(LOCAL_ENDPOINT_ID_LENGTH + 1);
	if (!/^[0-9a-f]{24}$/.test(endpointId) || !servedModelId) return null;
	return { endpointId, servedModelId };
}

// The create API route runs user-entered input through this before it's ever stored or
// fetched from server-side. It turns what the UI's placeholder asks for ("http://localhost:11434", no
// path) into the OpenAI-compatible base this table stores ("http://localhost:11434/v1"), and it refuses
// an address the server must not reach.
// (CUR-1262)
// Outside local development that means every private address (localhost, loopback, RFC1918,
// link-local, ULA and their IPv4-mapped forms). On a hosted deployment a private address names the
// host's own network, never the visitor's machine; a visitor's own server is reached through a managed
// (tunnel) endpoint instead. The cloud-metadata address is refused everywhere. This check reads the
// typed hostname only, so localEndpointFetch repeats it on the resolved address at connect time. (CUR-3387)
const CLOUD_METADATA_HOST = "169.254.169.254";

/** True when `input` parses but names an address this deployment refuses (see above). */
export function isRefusedLocalBaseUrl(input: string): boolean {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return false;
	}
	if (url.hostname === CLOUD_METADATA_HOST) return true;
	return !privateLocalAddressesAllowed() && isPrivateHostname(url.hostname);
}

export function normalizeLocalBaseUrl(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (isRefusedLocalBaseUrl(input)) return null;
	const withoutTrailingSlash = url.toString().replace(/\/+$/, "");
	return withoutTrailingSlash.endsWith("/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`;
}

// Same envelope models.ts's own `listSchema` validates against (`{data: [...]}`), built from the same
// shared per-entry schema — `catalogEntrySchema` only requires `id`, everything else is `.passthrough()`,
// which is exactly Ollama's own `/v1/models` shape (`{id, object, created, owned_by}`).
const localCatalogSchema = z.object({ data: z.array(catalogEntrySchema) }).passthrough();

// Local — the user's own machine/LAN, not a WAN gateway — so a slow/hung response is a misconfiguration
// worth failing fast on rather than something worth the primary catalog's multi-attempt patience.
const LOCAL_MODELS_FETCH_TIMEOUT_MS = 3_000;

// How long a discovered model list is trusted before the next request re-fetches it. Short enough that
// pulling/removing an Ollama model shows up in the picker within one page reload; long enough that a
// message send, a settings PATCH, and a conversation-create moments apart don't each pay their own round
// trip to the user's own local server.
export const LOCAL_MODELS_CACHE_TTL_MS = 30_000;

interface LocalModelsCacheEntry {
	modelIds: string[];
	fetchedAt: number;
}

const localModelsCache = new Map<string, LocalModelsCacheEntry>();
const localModelsInFlight = new Map<string, Promise<string[]>>();

/** Test-only: clears the module-level cache/in-flight state so specs don't leak a fetched model list
 *  (or a pending fetch) from one test into the next. Not called anywhere in production code. */
export function __resetLocalModelsCacheForTests(): void {
	localModelsCache.clear();
	localModelsInFlight.clear();
}

/** `endpoint.headers` (the settings UI's custom-header list) as a plain string→string record for a
 *  raw `fetch()` call or an OpenAI-SDK `defaultHeaders` option — `undefined` when there are none, so
 *  every call site can spread it into request options without adding an empty `headers: {}`/
 *  `defaultHeaders: {}` to a request that has nothing to add. A local server sitting behind auth
 *  (a reverse proxy, a self-hosted gateway) needs these on EVERY request it receives, not just the
 *  generation call — discovery (`fetchLocalModelIds` below) and the Ollama-native prewarm ping
 *  (`prewarmLocalModel`) hit the same server and would 401 without them just as easily. A duplicate
 *  header NAME collapses to its last entry (`Object.fromEntries` semantics) — same limitation every
 *  other `defaultHeaders` caller in this codebase already has (it's a plain string→string record). */
export function headersRecord(headers: LocalInferenceHeader[]): Record<string, string> | undefined {
	return headers.length > 0 ? Object.fromEntries(headers.map((h) => [h.name, h.value])) : undefined;
}

/** `GET {baseUrl}/models`, parsed the same way the primary catalog is. Throws on any failure (network,
 *  non-2xx, malformed body) — callers decide how to degrade (see `getCachedLocalModelIds`). `headers`
 *  are this endpoint's custom headers (see `headersRecord` above) — required on discovery too, since a
 *  server behind auth 401s this call exactly as readily as the generation call it exists to enable. */
async function fetchLocalModelIds(baseUrl: string, headers?: Record<string, string>): Promise<string[]> {
	const response = await localEndpointFetch(`${baseUrl}/models`, {
		headers,
		signal: AbortSignal.timeout(LOCAL_MODELS_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch ${baseUrl}/models: ${response.status} ${response.statusText}`);
	}
	const parsed = localCatalogSchema.parse(await response.json());
	return parsed.data.map((entry) => entry.id);
}

/** Cached, deduped model-id list for a given local endpoint. Cache key is `baseUrl` alone, as before
 *  CUR-1291 — two DIFFERENT rows pointing at the same baseUrl with different headers would share a
 *  cache entry fetched with whichever row's headers won the race; not a new limitation (two rows
 *  sharing a baseUrl was already an unmodeled edge case) and not worth a compound key for.
 *
 *  A cache miss/expiry fetches fresh; a concurrent request for the same baseUrl while a fetch is
 *  already in flight shares that one fetch rather than firing a second. A fetch failure serves the last-known-good list if one exists (fail
 *  soft — a transient blip on the user's own machine shouldn't disappear their whole model list mid-
 *  session) and falls back to `[]` only when there's never been a successful fetch at all (fail open,
 *  same posture as every other optional model source here — an unreachable local server just means no
 *  local models show up, never an error page). */
async function getCachedLocalModelIds(
	baseUrl: string,
	headers?: Record<string, string>
): Promise<string[]> {
	const cached = localModelsCache.get(baseUrl);
	if (cached && Date.now() - cached.fetchedAt < LOCAL_MODELS_CACHE_TTL_MS) {
		return cached.modelIds;
	}

	const inFlight = localModelsInFlight.get(baseUrl);
	if (inFlight) return inFlight;

	const fetchPromise = fetchLocalModelIds(baseUrl, headers)
		.then((modelIds) => {
			localModelsCache.set(baseUrl, { modelIds, fetchedAt: Date.now() });
			return modelIds;
		})
		.catch((err) => {
			logger.warn(
				{ err: err instanceof Error ? err.message : String(err), baseUrl },
				"[localModels] Failed to fetch model list from local endpoint"
			);
			return cached?.modelIds ?? [];
		})
		.finally(() => {
			localModelsInFlight.delete(baseUrl);
		});

	localModelsInFlight.set(baseUrl, fetchPromise);
	return fetchPromise;
}

/** The Settings UI's status-poll health check for a "direct" row, and the secondary
 *  (post-tunnel-open) check for a "managed" one — see the status API route. Deliberately calls
 *  `fetchLocalModelIds` directly rather than `getCachedLocalModelIds`: the cached getter fails SOFT
 *  (serves the last-known-good list, or `[]`), which is right for model *resolution* but would hide
 *  a real "server unresponsive" state from a health check that exists specifically to surface it —
 *  so this throws on failure instead, same as `fetchLocalModelIds`.
 *
 *  A success also updates the SAME shared cache `getCachedLocalModelIds` reads, so a health-check
 *  poll doubles as a free model-list refresh (the Settings UI's ~10s poll interval is shorter than
 *  `LOCAL_MODELS_CACHE_TTL_MS`) rather than the picker paying a second, separate round trip to the (CUR-1267)
 *  user's own server moments later. */
export async function checkLocalEndpointModels(
	baseUrl: string,
	headers?: Record<string, string>
): Promise<string[]> {
	const modelIds = await fetchLocalModelIds(baseUrl, headers);
	localModelsCache.set(baseUrl, { modelIds, fetchedAt: Date.now() });
	return modelIds;
}

/** Hand-builds a single discovered model the same way maybeAddCompareModels/maybeAddAgentModel build a
 *  non-catalog model in models.ts: a minimal ModelConfig cast through the same processModel/addEndpoint
 *  pipeline every catalog model goes through, so streaming/failover/error-handling all come for free.
 *
 *  `endpoints[0].modelId` is the lane-level served-model override endpointOai.ts already supports for
 *  cross-model backup lanes (providerPin.ts) — set here so the WIRE request carries the real model tag
 *  the local server reported (e.g. "llama3.2:latest"), not the internal `local:` id. The id shown to
 *  the user and the id sent on the wire differ whenever more than one model sits behind an endpoint.
 *
 *  `endpoint` (not just its baseUrl) is threaded through so the internal `id` can be namespaced by
 *  endpoint (CUR-1262) — see buildLocalModelId's header comment for why that's load-bearing once a
 *  user can have more than one server. It also lets `name`/`displayName` read `${label}:${modelId}`
 *  (e.g. "nx16g:llama3.2:latest") instead of the bare served tag — the SAME disambiguation problem as
 *  the internal id: two endpoints can report the same wire model tag, and the label is the only thing
 *  that tells them apart in the picker. `routerModel`/`routerProvider` carry that same labeled string
 *  (plus "local") into routerMetadata so the live request log / provenance trace show it too, instead
 *  of falling back to the raw internal id before/without measured metadata — see endpointOai.ts's own
 *  doc comments on those two fields for why a local endpoint needs them at all (no gateway in front of
 *  it to report provenance via response headers).
 *
 *  `endpoint.headers` (the settings UI's "Advanced Options" custom-header list, via
 *  `headersRecord` above) is passed straight through as `defaultHeaders` — an EXISTING endpointOai.ts
 *  field (already used by modelsCatalog.ts's own backup-lane `X-HF-Bill-To`), which the OpenAI SDK
 *  attaches to every generation request it makes through this client. No new plumbing needed for the (CUR-1291)
 *  generation path: this is the one place a local endpoint's config becomes an actual `Endpoint`. */
async function buildLocalProcessedModel(
	endpoint: LocalInferenceEndpointRow,
	modelId: string
): Promise<ProcessedModel> {
	const labeledModelId = `${endpoint.label}:${modelId}`;
	const defaultHeaders = headersRecord(endpoint.headers);
	const raw = {
		id: buildLocalModelId(endpoint.id, modelId),
		name: labeledModelId,
		displayName: labeledModelId,
		preprompt: "",
		// A local/LAN OpenAI-compatible server (Ollama et al.) needs no key, and a server that does takes
		// it as a custom header (e.g. "Authorization: Bearer …"), see defaultHeaders above. The apiKey is
		// set explicitly because endpointOai's zod default is OPENAI_API_KEY, our gateway key, which would
		// otherwise go to the user's URL as the bearer token on every turn (CUR-3177).
		endpoints: [
			{
				type: "openai" as const,
				baseURL: endpoint.baseUrl,
				apiKey: LOCAL_ENDPOINT_API_KEY,
				modelId,
				routerModel: labeledModelId,
				routerProvider: "local",
				...(defaultHeaders ? { defaultHeaders } : {}),
			},
		],
		unlisted: false,
	} as ModelConfig;

	return {
		...addEndpoint(await processModel(raw)),
		isRouter: false as boolean,
		hasInferenceAPI: false,
		// Carried through to the client so the composer can say which route a message took -- a
		// managed endpoint goes through the tunnel, a direct one does not (CUR-3037).
		localEndpointKind: endpoint.kind === "managed" ? ("managed" as const) : ("direct" as const),
	} as ProcessedModel;
}

/**
 * This user's local model(s) across ALL their configured endpoints, or `[]` — no signed-in user on
 * `locals`, no DB rows, the feature flag is off, or every endpoint reported zero models (or is
 * unreachable). Fail-open/additive by design, same posture as every other optional model source in
 * models.ts (maybeAddCompareModels/maybeAddAgentModel): a user with nothing configured (or whose
 * local server is briefly unreachable) just sees the ordinary catalog, never an error — and one
 * endpoint being down never hides another endpoint's models (each is discovered independently).
 */
export async function resolveLocalModelsForUser(locals: App.Locals): Promise<ProcessedModel[]> {
	if (!localInferenceEndpointsEnabled()) return [];

	const userId = locals.user?._id?.toString();
	if (!userId) return [];

	const endpoints = await listLocalEndpointsForUserId(userId);
	if (endpoints.length === 0) return [];

	const perEndpoint = await Promise.all(
		endpoints.map(async (endpoint) => {
			const modelIds = await getCachedLocalModelIds(endpoint.baseUrl, headersRecord(endpoint.headers));
			return Promise.all(modelIds.map((modelId) => buildLocalProcessedModel(endpoint, modelId)));
		})
	);
	return perEndpoint.flat();
}

/** The global catalog registry plus this user's local model(s), if any — what every live-request call
 *  site should use in place of the raw `models` import. */
export async function getEffectiveModels(locals: App.Locals): Promise<ProcessedModel[]> {
	const local = await resolveLocalModelsForUser(locals);
	return local.length ? [...models, ...local] : models;
}

/** Same exclusion as models.ts's createValidModelIdSchema (`isSelectableModel`): neither the agent
 *  nor an `unlisted` side-call or compare model can be chosen. A user's own local models are listed. */
export async function getEffectiveValidModelIdSchema(locals: App.Locals): Promise<z.ZodType<string>> {
	const all = await getEffectiveModels(locals);
	const ids = new Set(all.filter(isSelectableModel).map((m) => m.id));
	return z.string().refine((v) => ids.has(v), "Invalid model id");
}

// CUR-1194 timeout audit: a cold Ollama-style instance pays real, unbounded model-LOAD time before it
// can answer at all — indistinguishable from a hang to the generation watchdog (see
// deadlineLadder.ts's DEFAULT_LOCAL_GENERATION_TIMEOUT_MS). Raising the watchdog's patience (option 1)
// only helps once the load has started; this (option 2) tries to make sure it already has, by the time
// a real turn needs an answer.
//
// This has to be at least as generous as the load times it exists to absorb, or it defeats its own
// purpose: a cold `llama3.2:latest` load on a modest local box takes ~7s, so a 5s timeout would cut
// off the prewarm call before the load finished and Ollama's `/api/ps` would never show the model
// loaded. Matches DEFAULT_LOCAL_GENERATION_TIMEOUT_MS (the same ceiling a
// real turn against a local model now gets) rather than a fresh, unvetted number — this call is
// entirely fire-and-forget (never on a user-facing response's critical path), so there's little cost
// to matching the more patient ceiling.
const OLLAMA_PREWARM_TIMEOUT_MS = DEFAULT_LOCAL_GENERATION_TIMEOUT_MS;

/**
 * Fire-and-forget: ask a local endpoint to load `servedModelId` into memory and keep it there.
 *
 * Ollama's OpenAI-COMPATIBLE surface (`{baseUrl}/chat/completions`, what real turns use) has no
 * `keep_alive` concept at all — that's an Ollama-native-API-only extension. Its NATIVE
 * `/api/generate` does support it, and calling it with `keep_alive: -1` and no `prompt` is Ollama's
 * own documented no-op "preload" trick: the model loads into memory, nothing is generated, and `-1`
 * means "never unload on idle" (vs. Ollama's default ~5-minute unload) — see Ollama's `keep_alive`
 * docs. `{baseUrl}` is the stored, OpenAI-compatible `.../v1` base; the native surface sits one path
 * segment up, hence the strip below.
 *
 * Best-effort ONLY, by construction: nothing here is awaited by a real turn, and any failure (a
 * non-Ollama OpenAI-compatible server with no `/api/generate` at all, a network blip, the same cold
 * instance not yet accepting connections) just logs and gives up — this is a latency optimization for
 * OUR OWN cold-start problem, never a dependency a turn can fail on.
 *
 * `headers` (CUR-1291, see `headersRecord`) hits the SAME server as the generation call this preloads
 * for, so a server behind auth needs them here too — a preload that 401s just means the FIRST real
 * turn pays the cold-start cost this call exists to avoid, not a broken turn.
 */
export function prewarmLocalModel(
	baseUrl: string,
	servedModelId: string,
	headers?: Record<string, string>
): void {
	const nativeBase = baseUrl.replace(/\/v1\/?$/, "");
	localEndpointFetch(`${nativeBase}/api/generate`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ model: servedModelId, keep_alive: -1 }),
		signal: AbortSignal.timeout(OLLAMA_PREWARM_TIMEOUT_MS),
	}).catch((err) => {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err), baseUrl: nativeBase, servedModelId },
			"[localModels] Pre-warm request failed (or the server doesn't support Ollama's native API) — safe to ignore"
		);
	});
}

/**
 * Pre-warm whichever local endpoint `modelId` refers to, for this user — a no-op unless `modelId` is
 * actually shaped like one of THIS user's local models (any other id, including undefined/a catalog
 * id/an endpoint id that isn't this user's own, returns immediately with no network call).
 *
 * Callers fire this and move on (`void prewarmLocalModelForUser(...)`) at the moments a user has just
 * expressed intent to use a specific local model — activating it in settings, starting a new
 * conversation on it, or switching an existing conversation to it — rather than on every request that
 * merely reads the model list (resolveLocalModelsForUser), which would fire on far too many requests
 * for a model the user may not even be about to use.
 */
export async function prewarmLocalModelForUser(
	locals: App.Locals,
	modelId: string | undefined
): Promise<void> {
	if (!modelId) return;
	const parsed = parseLocalModelId(modelId);
	if (!parsed) return;
	if (!localInferenceEndpointsEnabled()) return;

	const userId = locals.user?._id?.toString();
	if (!userId) return;

	// Ownership check, not just existence — a stale/copied model id naming SOMEONE ELSE'S endpoint id
	// must not prewarm that endpoint on this caller's behalf.
	const row = await getLocalEndpointForUserAndId(userId, parsed.endpointId);
	if (!row) return;

	prewarmLocalModel(row.baseUrl, parsed.servedModelId, headersRecord(row.headers));
}
