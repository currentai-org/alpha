import { localEndpointFetch } from "$lib/chat/server/localEndpointFetch";
import { z } from "zod";
import { APP_USER_AGENT } from "$lib/chat/constants/app";
import { modelTakesImagesNow } from "$lib/chat/server/textOnly";
import { openAICompletionToTextGenerationStream } from "./openAICompletionToTextGenerationStream";
import {
	openAIChatToTextGenerationSingle,
	openAIChatToTextGenerationStream,
	turnShapeOf,
} from "./openAIChatToTextGenerationStream";
import type { CompletionCreateParamsStreaming } from "openai/resources/completions";
import type {
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { buildPrompt } from "$lib/chat/buildPrompt";
import { config } from "$lib/chat/server/config";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";
import { PLATFORM_MAX_DURATION_MS } from "$lib/chat/utils/deadlineLadder";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { logger } from "$lib/chat/server/logger";
import { backendIsSwiss, sovereignCopyFalsifiedBy, throughOpenRouter } from "$lib/chat/servingProvenance";
import { wireModelId } from "./providerPin";
import { endpointApiKey } from "$lib/chat/server/endpointKey";
import { peekServedModel, sameModelId, withServedModel } from "./servedModelPeek";
import { isSameMistralModel, routerUpstreamFor } from "$lib/chat/server/mistralVersions";
import { replayOrRecord, type ReplayMode } from "./modelReplay";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { isDirectLane } from "./directLane";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";
import { dropsReasoning, reasoningOffRequest } from "./thinkFilter";
import { contextTokensFor, takesStrictLane } from "../../harnessProfiles";
import { fitHistory, MessageTooLongError } from "./fitHistory";

import { acceptedEffort, rolesNeedFlattening } from "../../modelProfiles";
import type { Endpoint, EndpointParameters } from "../types";
import type OpenAI from "openai";
import { createImageProcessorOptionsValidator, makeImageProcessor } from "../images";
import { prepareMessagesWithFiles, withoutEmptyAnswers } from "$lib/chat/server/textGeneration/utils/prepareFiles";
import { ensureFlagsPolled, flagEnabledOr, flagsDebugState } from "$lib/chat/server/flags";
import { flattenForApertus } from "./flattenForApertus";
import { withNativeFirst } from "./nativeRolesFirst";
import {
	carriesNonUserRole,
	roleCapableDeployment,
	servedGroupFor,
} from "./apertusStrictLane";
import {
	crossModelRouterURL,
	gatewayFallbackOverride,
	gatewayRetryDelayMs,
} from "$lib/chat/server/gatewayFallbackGate";
import {
	answersNativeFirst,
	CALCULATE_KIT,
	CALCULATE_TOOL_NAME,
	TOOL_ROUND_HEDGE_AFTER_MS,
	withPastCalculations,
	withToolLoop,
	type ToolChoice,
} from "./calculateTool";
import type { InlineToolParameters } from "./inlineToolReference";
import { HEDGE_TOOL_ROUNDS_FLAG } from "../failover";
import { upstreamFetch } from "../../upstreamFetch";

/** Kept free for the answer when the model sets no max_tokens (CUR-2893), and the cap a model-decoding
 *  turn sends (generate.ts), so the room the history leaves and the answer's ceiling agree. */
export const DEFAULT_ANSWER_RESERVE = 4_096;

// uuid import removed (no tool call ids)

/**
 * Per-request marker telling `customFetch` whether the response it is inspecting served the user's
 * answer. It rides on the REQUEST rather than a closure variable because `customFetch` is built once
 * per endpoint instance and shared by every concurrent call through it — a factory-scoped `let` would
 * be read by whichever response happened to land next, not by the call that set it. (`routerMetadata`
 * below is factory-scoped and has exactly that race; this deliberately does not add a second one.)
 *
 * Read back locally and nothing upstream depends on it; gateways ignore headers they don't know.
 */
const SERVES_USER_ANSWER_HEADER = "ChatUI-Serves-User-Answer";

/**
 * Per-request carrier for the `wrong_model_served` fault, on the request for the same reason as the
 * marker above. customFetch strips it before the request leaves, so no host ever sees it.
 */
const FAULT_SUBSTITUTE_HEADER = "ChatUI-Fault-Substitute-Model";

/** Per-request carrier for the `model_replay` faults' mode (SOL-92, SOL-148), stripped the same way. */
const FAULT_REPLAY_HEADER = "ChatUI-Fault-Model-Replay";

/**
 * CUR-1291 macro expansion: `{{name}}` inside a LOCAL endpoint's custom header VALUE (defaultHeaders,
 * see localModels.ts's headersRecord()) expands to a per-request fact — a user wiring their own
 * inference server up to correlate requests with `{{conversationId}}` doesn't need a real templating
 * engine for it. An unknown/absent `{{name}}` expands to "" rather than throwing (this is a header
 * value, not code); `undefined` headers pass through unchanged. Adding a new variable is a one-line
 * addition to a caller's `vars` object below — this function itself never changes.
 */
function expandHeaderMacros(
	headers: Record<string, string> | undefined,
	vars: Record<string, string>
): Record<string, string> | undefined {
	if (!headers) return headers;
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? ""),
		])
	);
}

export const endpointOAIParametersSchema = z.object({
	weight: z.number().int().positive().default(1),
	model: z.any(),
	// Per-lane served-model override (cross-model backup lanes, e.g. GLM on the HF router standing in
	// for an Apertus primary). Used VERBATIM as the request model id — the OPENAI_PROVIDER pin targets
	// the primary checkpoint's warm lane and would corrupt a different model's id (":publicai" on a
	// GLM id 400s). Also seeded into routerMetadata.model UNLESS routerModel (below) is given.
	modelId: z.string().optional(),
	// Our id for `modelId` when the host names the model differently. The staging router
	// serves Mistral Large as `mistralai/mistral-large-2512` and reports that id back. The answer is
	// recorded under this id only after its version checks out against Mistral's alias list (`ours`). (CUR-2928)
	servedAs: z.string().optional(),
	// A per-user local (LAN/self-hosted) endpoint has no gateway in front of it to report
	// provenance via response headers (no X-Router-Model, no x-litellm-*) — it's a single, known,
	// deterministic destination, so the caller (localModels.ts) already knows exactly what should be
	// shown and passes it here rather than leaving routerMetadata to sniff headers that will never
	// arrive. Decoupled from `modelId` on purpose: `modelId` is also the literal WIRE request id (must
	// stay e.g. "llama3.2:latest" or Ollama 404s), while this is display-only — the endpoint's own
	// label prefixed on, e.g. "nx16g:llama3.2:latest" — and must never reach the request body. Wins
	// over modelId for routerMetadata.model when present; every other (non-local) caller leaves this
	// unset and gets the existing modelId-seeds-routerMetadata behavior unchanged. (CUR-1194)
	routerModel: z.string().optional(),
	// Companion to routerModel: what providerDisplay() (identity.ts) shows for this turn's serving
	// venue. Absent → the turn's own provider header, or no "served via" at all (CUR-3562); set to
	// "local" for a local endpoint so the provenance badge names the LAN server.
	routerProvider: z.string().optional(),
	type: z.literal("openai"),
	baseURL: z.string().url().default("https://api.openai.com/v1"),
	// The env var this lane's key lives in (CUR-2640). The registry stores only this name; the caller
	// resolves it into `apiKey` at call time (endpointKey.ts), so the value never sits on a model object.
	apiKeyEnv: z.string().optional(),
	// Canonical auth token is OPENAI_API_KEY; keep HF_TOKEN as legacy alias. Call-time only: a registry
	// endpoint never carries this (models.ts's registryEndpointSchema).
	apiKey: z
		.string()
		.default(
			firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "endpointOaiApiKey", { allowEmpty: true }) || "sk-"
		),
	completion: z
		.union([z.literal("completions"), z.literal("chat_completions")])
		.default("chat_completions"),
	defaultHeaders: z.record(z.string(), z.string()).optional(),
	defaultQuery: z.record(z.string(), z.string()).optional(),
	extraBody: z.record(z.string(), z.any()).optional(),
	multimodal: z
		.object({
			image: createImageProcessorOptionsValidator({
				supportedMimeTypes: [
					// Restrict to the most widely-supported formats
					"image/png",
					"image/jpeg",
				],
				preferredMimeType: "image/jpeg",
				maxSizeInMB: 1,
				maxWidth: 1024,
				maxHeight: 1024,
			}),
		})
		.prefault({}),
	/* enable use of max_completion_tokens in place of max_tokens */
	useCompletionTokens: z.boolean().default(false),
	streamingSupported: z.boolean().default(true),
});

/** The `model` of a JSON request body, for the log; undefined for anything else. */
function wireModelOf(body: unknown): string | undefined {
	if (typeof body !== "string") return undefined;
	try {
		const model = (JSON.parse(body) as { model?: unknown }).model;
		return typeof model === "string" ? model : undefined;
	} catch {
		return undefined;
	}
}

export async function endpointOai(
	input: z.input<typeof endpointOAIParametersSchema>
): Promise<Endpoint> {
	const {
		baseURL,
		apiKey,
		completion,
		model,
		modelId: laneModelId,
		servedAs,
		routerModel,
		routerProvider,
		defaultHeaders,
		defaultQuery,
		multimodal,
		extraBody,
		useCompletionTokens,
		streamingSupported,
	} = endpointOAIParametersSchema.parse(input);

	// Store router metadata if captured. A lane-level model override is seeded up front so an answer
	// served by a cross-model backup lane is attributed to the model that actually wrote it — the
	// provenance badge resolves identity from this served id, never from the primary it stood in for.
	// `routerModel`/`routerProvider` (local endpoints only, see their own doc comments above) win over
	// the modelId-derived seed when present, since they're already the exact display-worthy values —
	// every other caller leaves them unset and this is unchanged from before they existed.
	// The host this request was sent to. `backend` cannot tell the lanes apart: a router turn
	// reports its upstream (api.mistral.ai) and a direct turn its own base, which is the same host. (CUR-3193)
	const lane = new URL(baseURL).host;
	let routerMetadata: { route?: string; model?: string; provider?: string; backend?: string; lane?: string } = {
		lane,
		...(routerModel ? { model: routerModel } : laneModelId ? { model: laneModelId } : {}),
		...(routerProvider ? { provider: routerProvider } : {}),
	};

	// litellm's own per-request routing can land an answer on a different MODEL than requested (one
	// provider's own checkpoint answering under another model's id), and a fresh routing decision on
	// retry can land back on the requested model, since the gateway's lane weights decide this, not
	// anything this request controls (CUR-1313). Bounded at 2 total attempts: this sits on live TTFT,
	// so it is one retry, not a failover chain; the same shape as agent-service/api/proxy.py, narrower.
	//
	// The retry keys on model substitution, never on which backend served: a correct answer from any
	// accepted lane must not pay a retry, and the substitution worth catching is a different model
	// answering under the requested id.
	const SAME_BACKEND_RETRY_ATTEMPTS = 2;
	const jitteredRetryDelayMs = () => 100 + Math.random() * 200;
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	// The model this call actually asked for. Never carries a `:provider` wire suffix by construction —
	// endpointOAIParametersSchema's `modelId` is sent verbatim (endpointOai.ts:42-46) and a suffixed one
	// would 400 on the wire, so there's nothing to strip here. litellm's own x-litellm-model-group
	// report is the bare alias on a healthy turn too, and on a substituted turn alike, so this is the correct thing to diff it
	// against, not the suffixed wire id resolveProviderModelId builds per call.
	const requestedModel = laneModelId ?? model.id ?? model.name;
	// A lane that names its own key reaches its host directly, so it never takes the default pin.
	const ownLane = Boolean(endpointApiKey({ apiKeyEnv: input.apiKeyEnv }));
	// The host's report of the model we asked for, recorded under our own id only once the version is
	// checked (CUR-2928). `upstream` (x-litellm-model-name) is the name the router asked Mistral for. A
	// dated name settles it on sight; a `*-latest` one is looked up in Mistral's own alias list, which
	// needs a La Plateforme key. A version that doesn't check out, or couldn't be checked, is recorded
	// as the name the router asked for, with no version claimed. Any other id is a different model and
	// is recorded as the host named it. A direct host (`direct`) that answers as exactly the name we
	// sent it is our model under that host's name: La Plateforme serves Large 4 (preview) as
	// `mistral-large-4-0` for our `mistral-large-2610` (CUR-3027).
	const ours = async (id: string, upstream?: string, direct = false) => {
		if (!servedAs || !sameModelId(id, requestedModel)) return id;
		if (direct) return servedAs;
		if (!upstream) return id;
		const tail = upstream.split("/").pop() ?? "";
		if (sameModelId(tail, servedAs)) return servedAs;
		const routerName = routerUpstreamFor(servedAs);
		if (routerName && sameModelId(tail, routerName)) return servedAs;
		const same = await isSameMistralModel(upstream, servedAs);
		return same ? servedAs : upstream.replace(/^openai\//, "");
	};

	// A user's own local endpoint goes through the private-address guard; every other lane is ours and
	// reaches its configured host directly (CUR-3387), keeping its connection to the router open
	// between calls (upstreamFetch.ts).
	const baseFetch = routerProvider === "local" ? localEndpointFetch : upstreamFetch;

	// Custom fetch wrapper to capture response headers for router metadata.
	//
	// The first parameter is `string | URL | Request`, not `RequestInfo`. openai v7's `Fetch` type may
	// hand us a `URL`, which `RequestInfo` (= string | Request) does not include — so annotating this
	// as RequestInfo makes the wrapper unassignable to the SDK's option and fails the build. Widened
	// rather than cast: global fetch accepts all three, so nothing here narrows.
	const customFetch = async (
		url: string | URL | Request,
		init?: RequestInit
	): Promise<Response> => {
		// The retry loop lives entirely inside this one customFetch call — never a factory-scoped
		// counter. customFetch is built once per endpoint and shared by every concurrent request
		// through it (see SERVES_USER_ANSWER_HEADER's own comment above for the identical race); a
		// shared retry counter would let one request's attempt count leak into another's.
		// With `disable_fallbacks` on the answer lane, a cooling-down deployment answers 429 instead of
		// silently substituting (CUR-1729). That answer is recoverable in a way the substitution is not:
		// the gateway names an interval, and the lane flaps rather than being down (a substitution and a
		// healthy answer can follow each other minutes apart). Retried once, then the 429 goes through as
		// the honest failure it is.
		//
		// It shares the loop's attempt budget with the substitution retry below, which costs nothing:
		// the two causes are mutually exclusive on any given lane. With the flag on, the gateway
		// refuses and cannot substitute; with it off, it substitutes and never sends this 429.
		let gatewayCooldownRetried = false;
		const outgoing = new Headers(init?.headers);
		const substitute = outgoing.get(FAULT_SUBSTITUTE_HEADER) ?? undefined;
		const replayHeader = outgoing.get(FAULT_REPLAY_HEADER);
		// The answer call names its mode in a header; a side call through this endpoint (title,
		// search decision, reasoning summary) inherits the request's mode from its context instead. (SOL-148)
		const replay: ReplayMode | null =
			replayHeader === "none" ? "none" : replayHeader ? "new_episodes" : (getRequestContext()?.replayMode ?? null);
		if (substitute || replay) {
			outgoing.delete(FAULT_SUBSTITUTE_HEADER);
			outgoing.delete(FAULT_REPLAY_HEADER);
			init = { ...init, headers: outgoing };
		}
		for (let attempt = 1; attempt <= SAME_BACKEND_RETRY_ATTEMPTS; attempt++) {
			const sentAt = Date.now();
			const sent = init;
			let response = replay
				? await replayOrRecord(url, sent, (i) => baseFetch(url, i), { requestedModel, attempt }, replay, {
						// Keyed on our id, not the wire id MISTRAL_CHAT_MODEL_MAP resolves it to, so an env
						// pin change does not miss every recording (modelReplay.ts keyedBody).
						appModelId: servedAs ?? requestedModel,
					})
				: await baseFetch(url, init);
			if (substitute) response = await withServedModel(response, substitute);

			// A 429 here reports a deployment cooldown at the gateway, rather than any rate limit
			// applied to this deployment's key. The interval lives in the
			// body prose of the LiteLLM 429 actually observed ("Try again in 5 seconds"), so the body
			// has to be consumed to read it — hence the rebuilt Response on the paths that keep it,
			// which would otherwise hand the SDK a stream already drained.
			if (response.status === 429) {
				const text = await response.text().catch(() => undefined);
				const waitMs = gatewayCooldownRetried
					? null
					: gatewayRetryDelayMs(response.headers.get("retry-after"), text);
				if (waitMs !== null) {
					gatewayCooldownRetried = true;
					logger.info(
						{ waitMs, attempt, requestedModel, body: text?.slice(0, 200) },
						"[gateway] cooldown 429 — retrying once on the interval it named"
					);
					await sleep(waitMs);
					continue;
				}
				return new Response(text ?? null, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			// Capture router headers if present (fallback for non-streaming)
			const routeHeader = response.headers.get("X-Router-Route");
			const modelHeader = response.headers.get("X-Router-Model");
			const providerHeader = response.headers.get("x-inference-provider");

			if (routeHeader && modelHeader) {
				// Router headers win for model — the router's report of what actually served beats our
				// requested id. Merge so a seeded lane override survives header-less fields.
				routerMetadata = {
					...routerMetadata,
					route: routeHeader,
					model: modelHeader,
					provider: providerHeader || undefined,
				};
			} else if (providerHeader) {
				// Even without router metadata, capture provider info (keep any seeded served-model id)
				routerMetadata = {
					...routerMetadata,
					provider: providerHeader,
				};
			}
			if (providerHeader) {
				// The HF router names the provider that served. Logged beside the id we sent, so a pin
				// (providerPin.ts's table) can be checked against where the text actually went (CUR-2112).
				logger.info(
					{
						requestedModel,
						wireModel: wireModelOf(init?.body),
						provider: providerHeader,
						status: response.status,
						ttfbMs: Date.now() - sentAt,
					},
					"[serving] hf provider"
				);
			}

			// LiteLLM (the publicai gateway) reports the ACTUAL backend that served on every response. The
			// swiss-ai/apertus-70b-instruct routing GROUP rotates across CSCS / Infomaniak / Singapore, and
			// this header is the only place the real deployment shows through — the pre-turn provenance
			// resolve derives from the gateway host and cannot see it (CUR-75).
			//
			// The warn is the point, not the info. Every surface — greeting, welcome modal, map, system
			// prompt — tells the user this runs on sovereign public compute IN SWITZERLAND, and that
			// sentence is the deployment's assertion, made before the turn, about a backend chosen during
			// it. A non-Swiss backend on the ANSWER is the condition under which the copy misstates provenance
			// to a user, and nothing anywhere could go red for it: the copy said
			// the same thing whichever backend answered. SWISS_BACKEND_HOSTS is committed in the catalog (routing/catalog.ts)
			// so this warns the moment routing moves somewhere the copy hasn't followed.
			//
			// `servesUserAnswer` is what keeps that warn TRUE when it fires. This client carries the
			// side-calls too, and the second-opinion panel fans out to EuroLLM and Olmo precisely because
			// Public AI doesn't host them — they land off the allowlist and falsify nothing. See
			// `sovereignCopyFalsifiedBy`, which carries the measurement and the reasoning.
			const litellmBackend = response.headers.get("x-litellm-model-api-base");
			if (litellmBackend) {
				routerMetadata = { ...routerMetadata, backend: litellmBackend };
				const servesUserAnswer =
					new Headers(
						init?.headers ?? (typeof Request !== "undefined" && url instanceof Request
							? url.headers
							: undefined)
					).get(SERVES_USER_ANSWER_HEADER) === "1";
				const swissBackend = backendIsSwiss(litellmBackend);
				// x-litellm-model-group is litellm's own report of which model actually answered — on a
				// healthy turn it's the requested alias (a harmless no-op below); on a fallback turn it's the
				// backup lane's id (e.g. aisingapore/Qwen-SEA-LION-v4-32B-IT). It's the only served-identity
				// signal this gateway sends (no X-Router-Model header here), so it overrides what laneModelId
				// seeded routerMetadata.model with, and a substituted turn does not keep the requested model's
				// badge (CUR-874). servedModelId/ChatMessage's backup-lane detection handles a populated
				// .model.
				// servedGroupFor: a request pinned to one deployment (apertusStrictLane.ts) is answered
				// under the deployment's id in both places; map it back to the group it belongs to.
				const litellmGroup = servedGroupFor(
					response.headers.get("x-litellm-model-group") || undefined
				);
				if (litellmGroup) {
					routerMetadata = {
						...routerMetadata,
						model: await ours(
							litellmGroup,
							response.headers.get("x-litellm-model-name") || undefined
						),
					};
				}

				// The group header names the deployment group, and a deployment inside the right group can
				// still answer as another model: the headers can name the requested model while every chunk
				// names aisingapore/Qwen-SEA-LION-v4-32B-IT. The body's own model is the
				// served model, so it is recorded as such and checked alongside the group.
				const peeked = await peekServedModel(response);
				response = peeked.response;
				const bodyModel = servedGroupFor(peeked.model);
				const bodySubstituted = !!bodyModel && !sameModelId(bodyModel, requestedModel);
				if (bodySubstituted) {
					routerMetadata = { ...routerMetadata, model: bodyModel };
				}
				// An OpenRouter backend names no compute; the provider in its body does (servingProvenance.ts).
				const openRouter = throughOpenRouter(litellmBackend, peeked.provider);
				if (openRouter) routerMetadata = { ...routerMetadata, ...openRouter };

				// The retry now fires on a genuine model substitution, not on backend location —
				// a served-vs-requested mismatch is wrong regardless of which call this is (side-call or
				// answer), so it is NOT gated on servesUserAnswer the way the Swiss-host check below is.
				// Compared through sameModelId, not `!==`: a caller asking for the Hugging Face spelling
				// `swiss-ai/Apertus-v1.5-70B` gets the group header `swiss-ai/apertus-v1.5-70b` back, and a
				// strict compare would shed that real Apertus answer as a substitution (CUR-1960). (CUR-1313)
				const isSubstitution =
					(!!litellmGroup && !sameModelId(litellmGroup, requestedModel)) || bodySubstituted;
				const isLastAttempt = attempt === SAME_BACKEND_RETRY_ATTEMPTS;
				if (isSubstitution && !isLastAttempt) {
					// Not yet accepted — release this response's body and let the gateway pick again.
					await response.body?.cancel().catch(() => {});
					await sleep(jitteredRetryDelayMs());
					continue;
				}

				// The Swiss-host fact is a claim about user-facing sovereignty copy, not about whether
				// serving is correct (CUR-1313) — a non-Swiss host such as Featherless is an accepted Apertus
				// lane, so this warns without retrying or blocking anything, purely so any gap between the
				// copy and routing stays visible in the logs.
				const nonSwissAnswer = sovereignCopyFalsifiedBy({ backend: litellmBackend, servesUserAnswer });

				// Logged exactly once, on the attempt we're keeping — never per attempt, so a retried
				// turn that recovers reports one clean "info", and a turn that never recovers reports
				// one clean "warn" naming the FINAL backend, not a duplicate per retry.
				const fields = {
					backend: litellmBackend,
					swissBackend,
					servesUserAnswer,
					group: litellmGroup,
					served: bodyModel,
					bodyProvider: peeked.provider,
					// What the gateway asked its upstream for. The staging router asks Mistral for `*-latest`, so this
					// is where a move of "latest" would show (CUR-2928).
					upstream: response.headers.get("x-litellm-model-name") || undefined,
					requestedModel,
					substituted: isSubstitution,
					retried: attempt > 1,
					fallbacks: response.headers.get("x-litellm-attempted-fallbacks") || undefined,
					cost: response.headers.get("x-litellm-response-cost") || undefined,
				};

				if (isSubstitution) {
					// Retries exhausted and the gateway is still substituting a different model. Not
					// shed to avoid a dishonest label — the body-model check above already stamps
					// routerMetadata.model with the real served id, so a served substitute is honestly
					// labeled. It sheds because the person asked for a specific model and a substitute's
					// answer is not that model's. A 503 after two retries is faster and more truthful than a
					// 45s wait ending in nothing, or a very short reply from a different model under a
					// request for Apertus.
					//
					// HAZARD, narrowed but not gone: isSubstitution compares x-litellm-model-group against
					// requestedModel through sameModelId (servedModelPeek.ts), which forgives case,
					// surrounding whitespace and a leading `openai/` (CUR-1960). A model whose litellm group
					// alias differs from its registry id in any other way (a renamed alias, a suffix) would
					// still shed 100% of its own traffic on deploy, indistinguishable from this real
					// substitution case. Check that match before onboarding a new model onto this gateway.
					logger.error(
						fields,
						"[serving] litellm substituted the served model and retries were exhausted — shedding rather than serving the substitute"
					);
					await response.body?.cancel().catch(() => {});
					return new Response(
						JSON.stringify({
							error: { message: "model substitution exhausted retries", type: "server_error" },
						}),
						{ status: 503, headers: { "content-type": "application/json" } }
					);
				} else if (nonSwissAnswer) {
					logger.warn(
						fields,
						"[serving] litellm route left the Swiss backend allowlist — the sovereign-compute copy is false for this turn"
					);
				} else {
					logger.info(fields, "[serving] litellm route");
				}
			} else if (response.ok && !routerModel && isDirectLane(baseURL, config.OPENAI_BASE_URL)) {
				// A direct host sends no provenance header, so without this a Large 3 turn persisted no
				// served model and its badge could never show a measured marker (CUR-2283). The body's own
				// model id is the host's report of what answered, the same evidence the gateway branch
				// above reads; the backend is the host this request actually reached. A local endpoint
				// (routerModel set, CUR-1194) keeps the label its caller chose.
				const peeked = await peekServedModel(response);
				response = peeked.response;
				if (peeked.model) {
					routerMetadata = { ...routerMetadata, model: await ours(peeked.model, undefined, true), backend: baseURL };
				}
				logger.info(
					{ backend: baseURL, served: peeked.model, requestedModel, ttfbMs: Date.now() - sentAt },
					"[serving] direct lane"
				);
			}

			return response;
		}
		// Unreachable — the loop above always returns by its last iteration — but TS can't see that a
		// for-loop bounded by a `const` always runs at least once and always returns inside.
		return baseFetch(url, init);
	};

	const openai = await createOpenAIClient({
		apiKey: apiKey || "sk-",
		baseURL,
		// The turn's own watchdog (conversation/[id]/+server.ts) is the real deadline for a generation,
		// at 45s; this is the backstop under it for the case where that watchdog is not in the path at
		// all — a warm probe, a side-call built on this endpoint. Set to the platform's own function
		// ceiling because anything longer is unreachable: Vercel kills the invocation first, and the
		// SDK's ten-minute default was therefore never a timeout on this lane, only the appearance of one.
		timeout: PLATFORM_MAX_DURATION_MS,
		defaultHeaders: {
			// The HF Inference Providers router's WAF returns 403 ("Your request was blocked") for the
			// OpenAI Node SDK's default User-Agent ("OpenAI/JS x.y.z"). Always override it with our own
			// Identifies this deployment to upstream providers. See constants/app.ts.
			"User-Agent": APP_USER_AGENT,
			...defaultHeaders,
		},
		defaultQuery,
		fetch: customFetch,
	});

	const imageProcessor = makeImageProcessor(multimodal.image);

	/** The `every_lane_rate_limited` fault (CUR-4042): the SDK's 429 as a host with a spent budget sends
	 *  it, thrown before any request leaves, so no model is called and every lane refuses alike. */
	const everyLaneRateLimited = () =>
		Object.assign(new Error("429 every_lane_rate_limited fault: the host refused the call"), { status: 429 });

	/** The headers every gateway request carries, shared by the completions and chat paths. */
	const requestHeaders = (
		{
			conversationId,
			locals,
			servesUserAnswer,
			substituteServedModel: substitute,
			replayModelCalls,
		}: Pick<
			EndpointParameters,
			"conversationId" | "locals" | "servesUserAnswer" | "substituteServedModel" | "replayModelCalls"
		>,
		modelId: string
	) => ({
		"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
		[SERVES_USER_ANSWER_HEADER]: servesUserAnswer ? "1" : "0",
		...(substitute ? { [FAULT_SUBSTITUTE_HEADER]: substitute } : {}),
		...(replayModelCalls ? { [FAULT_REPLAY_HEADER]: replayModelCalls } : {}),
		"X-use-cache": "false",
		...(config.USE_USER_TOKEN === "true" && locals?.token
			? { Authorization: `Bearer ${locals.token}` }
			: {}),
		// Only the HF router reads it; the gateway and direct hosts get no org name (CUR-1877). A backup
		// lane's own bill-to rides in its defaultHeaders (modelsCatalog.ts), which this still overrides.
		...hfBillToHeader(baseURL, { ownLane: false }, locals?.billingOrganization),
		// A local endpoint's own custom headers, `{{conversationId}}`/etc. expanded — spread
		// LAST so a user-named header wins over one of ours on a name collision, since it's their own
		// server they're configuring. (CUR-1291)
		...expandHeaderMacros(defaultHeaders, {
			conversationId: conversationId?.toString() ?? "",
			userId: locals?.user?._id?.toString() ?? "",
			modelId,
		}),
	});

	if (completion === "completions") {
		return async ({
			messages,
			preprompt,
			generateSettings,
			conversationId,
			locals,
			abortSignal,
			provider,
			servesUserAnswer,
			substituteServedModel,
			replayModelCalls,
			rateLimitEveryLane,
		}) => {
			if (rateLimitEveryLane) throw everyLaneRateLimited();
			const prompt = await buildPrompt({
				messages,
				preprompt,
				model,
			});

			// Lane override is verbatim (a different model — the primary's provider pin doesn't apply);
			// otherwise build the model ID with the optional provider suffix (explicit override, then the
			// HF_PROVIDER_PIN table, then the OPENAI_PROVIDER default pin; see providerPin.ts).
			const modelId = wireModelId({
				baseModelId: model.id ?? model.name,
				laneModelId,
				provider,
				defaultProvider: config.OPENAI_PROVIDER,
				baseURL,
				ownLane,
			});

			const parameters = { ...model.parameters, ...generateSettings };
			const body: CompletionCreateParamsStreaming = {
				model: modelId,
				prompt,
				stream: true,
				max_tokens: parameters?.max_tokens,
				stop: parameters?.stop,
				temperature: parameters?.temperature,
				top_p: parameters?.top_p,
				frequency_penalty: parameters?.frequency_penalty,
				presence_penalty: parameters?.presence_penalty,
			};

			const openAICompletion = await openai.completions.create(body, {
				body: { ...body, ...gatewayFallbackOverride(servesUserAnswer, baseURL, [config.OPENAI_BASE_URL, config.FALLBACK_BASE_URL]), ...extraBody },
				headers: requestHeaders({ conversationId, locals, servesUserAnswer, substituteServedModel, replayModelCalls }, modelId),
				signal: abortSignal,
			});

			return openAICompletionToTextGenerationStream(openAICompletion);
		};
	} else if (completion === "chat_completions") {
		return async ({
			messages,
			preprompt,
			generateSettings,
			conversationId,
			isMultimodal,
			locals,
			abortSignal,
			provider,
			reasoningEffort,
			disableThinking,
			servesUserAnswer,
			onHistoryFitted,
			calculateTool,
			calculateFirst,
			nativeTools,
			turnDeadlineAt,
			rateLimitToolRound,
			rateLimitToolRoundSustained,
			toolTranscript,
			substituteServedModel,
			replayModelCalls,
			rateLimitEveryLane,
		}) => {
			if (rateLimitEveryLane) throw everyLaneRateLimited();
			// Format messages for the chat API, handling multimodal content if supported
			let messagesOpenAI: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
				await prepareMessagesWithFiles(
					messages,
					imageProcessor,
					isMultimodal ?? modelTakesImagesNow(model)
				);
			// A turn that offers calculate also sees the calls earlier answers made, so a follow-up
			// works from those groups and not from the prose total. Only on the tool loop's own path: the
			// native-first resend flattens roles, and a request without the tool has nothing to pair them with. (CUR-1202)
			const offersCalculate = (nativeTools ?? (calculateTool ? CALCULATE_KIT : undefined))?.definitions.some(
				(d) => d.function?.name === CALCULATE_TOOL_NAME
			);
			if (offersCalculate && servesUserAnswer && streamingSupported) {
				await ensureFlagsPolled();
				if (!answersNativeFirst(requestedModel)) messagesOpenAI = withPastCalculations(messages, messagesOpenAI);
			}
			messagesOpenAI = withoutEmptyAnswers(messagesOpenAI);

			// Normalize preprompt and handle empty values
			const normalizedPreprompt = typeof preprompt === "string" ? preprompt.trim() : "";

			// Check if a system message already exists as the first message
			const hasSystemMessage = messagesOpenAI.length > 0 && messagesOpenAI[0]?.role === "system";

			if (hasSystemMessage) {
				// Prepend normalized preprompt to existing system content when non-empty
				if (normalizedPreprompt) {
					const userSystemPrompt =
						(typeof messagesOpenAI[0].content === "string"
							? (messagesOpenAI[0].content as string)
							: "") || "";
					messagesOpenAI[0].content =
						normalizedPreprompt + (userSystemPrompt ? "\n\n" + userSystemPrompt : "");
				}
			} else {
				// Insert a system message only if the preprompt is non-empty
				if (normalizedPreprompt) {
					messagesOpenAI = [{ role: "system", content: normalizedPreprompt }, ...messagesOpenAI];
				}
			}

			// Fit the history to the context this lane accepts. Here because `messagesOpenAI` is
			// whole and still role-shaped (the flatten below would merge the exchanges it cuts along), and
			// because it is rebuilt per invocation, so a backup lane is fitted to its own context. A chat
			// that fits goes out as the same array. (CUR-2893)
			{
				const reserveTokens =
					{ ...model.parameters, ...generateSettings }.max_tokens ?? DEFAULT_ANSWER_RESERVE;
				const contextTokens = contextTokensFor(requestedModel);
				const fit = fitHistory(messagesOpenAI, { contextTokens, reserveTokens });
				if (fit.kind === "overflow") {
					logger.warn(
						{ leg: "fit-history", requestedModel, contextTokens, reserveTokens, ...fit },
						"[fit-history] newest message alone is over the context; refused before the call"
					);
					throw new MessageTooLongError(fit.requiredTokens, fit.budgetTokens);
				}
				if (fit.leftOut > 0) {
					logger.info(
						{ leg: "fit-history", requestedModel, contextTokens, reserveTokens, leftOut: fit.leftOut },
						"[fit-history] older exchanges left out to fit the context"
					);
				}
				messagesOpenAI = fit.messages;
				// Zero too, so a backup lane that fits the whole chat clears a count the primary reported.
				onHistoryFitted?.(fit.leftOut);
			}

			// The Apertus deployments do not take a non-user role and the gateway then serves
			// SEA-LION instead, so the user's answer goes out as ONE user message when this flag is on. See
			// flattenForApertus.ts for the measurement and for why it is a workaround with a delete date.
			//
			// HERE and not in generate.ts, for two reasons. `messagesOpenAI` is final at this point — the
			// preprompt merge above is the last thing that touches it — and it is rebuilt from `messages` on
			// every invocation, so withFailover re-invoking a second lane re-derives rather than
			// double-flattens. Moving this up to the endpoint() call site would lose both properties.
			//
			// `servesUserAnswer` keeps this to the main generation. Side calls that need it flatten their
			// own request: the search classifier (searchDecision.ts) and the title (title.ts, CUR-2175).
			// ensureFlagsPolled because this is a per-request read and preview runs no warm cron, so a cold
			// instance would otherwise read every flag as its OFF fallback (same guard as guardGate.ts).
			// (CUR-1294)
			// With native-first on, the flatten is deferred to the resend inside withNativeFirst
			// below, because the flattened transcript is what makes later answers copy earlier ones. (CUR-1886)
			// Only for a model some lane refuses roles on, so a model that takes roles (GLM on the
			// preview backup lane, or under math routing) gets neither the flatten nor a hedged duplicate
			// request. (CUR-2145)
			let nativeFirst = false;
			if (servesUserAnswer) {
				await ensureFlagsPolled();
				const needsFlattening = rolesNeedFlattening(requestedModel);
				const flatten = needsFlattening;
				// One predicate with calculateToolOffered, so the turn that offers `calculate` is never the
				// turn this path drops it on (CUR-2273).
				nativeFirst = answersNativeFirst(requestedModel);
				// LOGGED, not inferred. Whether this branch ran is otherwise invisible: a turn that shipped
				// the old shape and one that shipped the flattened shape look identical in every existing
				// line, and the only downstream tell — which model answered — is absent on exactly the
				// turns that fail, because a hung request never returns a model at all. Without this,
				// "did the flag apply" can only be argued from timing.
				const roles = messagesOpenAI.map((m) => m.role);
				if (flatten && !nativeFirst) messagesOpenAI = flattenForApertus(messagesOpenAI);
				logger.info(
					{
						leg: "flatten",
						flatten,
						nativeFirst,
						needsFlattening,
						requestedModel,
						polled: flagsDebugState().polledOk,
						rolesIn: roles.join(","),
						rolesOut: messagesOpenAI.map((m) => m.role).join(","),
					},
					"[flatten] outgoing message roles"
				);
			}

			// Combine model defaults with request-specific parameters
			const parameters = { ...model.parameters, ...generateSettings };

			// Lane override is verbatim (a different model — the primary's provider pin doesn't apply);
			// otherwise build the model ID with the optional provider suffix (explicit override, then the
			// HF_PROVIDER_PIN table, then the OPENAI_PROVIDER default pin; see providerPin.ts).
			const modelId = wireModelId({
				baseModelId: model.id ?? model.name,
				laneModelId,
				provider,
				defaultProvider: config.OPENAI_PROVIDER,
				baseURL,
				ownLane,
			});

			// Every call to an Apertus group refuses substitution, and the answer lane's role-shaped
			// attempt goes to a deployment that accepts roles (apertusStrictLane.ts, CUR-2092); the
			// model's harness row says whether it takes the lane (harnessProfiles.ts). Side calls are not
			// pinned: pinned to one deployment, the arithmetic pre-checks hit their 8s timeout (CUR-2082).
			const strictLane = takesStrictLane(modelId);
			const fallbackOverride = gatewayFallbackOverride(
				servesUserAnswer || strictLane,
				baseURL,
				[
					config.OPENAI_BASE_URL,
					config.FALLBACK_BASE_URL,
					crossModelRouterURL(modelId, Reflect.get(config, "MISTRAL_CHAT_BASE_URL") as string | undefined),
				]
			);
			// A GLM side call (title, classifier) gets reasoning off as well. Reached through the backup
			// lane, GLM can spend a title's whole token budget reasoning and return nothing (CUR-1933). The answer keeps its reasoning, which the stream strips. On
			// the HF router the call is also pinned to a provider that honours the field (CUR-2090).
			const reasoningOff =
				disableThinking || (!servesUserAnswer && dropsReasoning(modelId))
					? reasoningOffRequest(modelId, baseURL, config.OPENAI_BASE_URL)
					: undefined;
			const modelFor = async (msgs: typeof messagesOpenAI): Promise<string> => {
				if (!strictLane || !servesUserAnswer || !carriesNonUserRole(msgs))
					return reasoningOff?.model ?? modelId;
				return (await roleCapableDeployment(modelId, baseURL, apiKey)) ?? modelId;
			};

			const body = {
				model: modelId,
				messages: messagesOpenAI,
				stream: streamingSupported,
				// Support two different ways of specifying token limits depending on the model
				...(useCompletionTokens
					? { max_completion_tokens: parameters?.max_tokens }
					: { max_tokens: parameters?.max_tokens }),
				stop: parameters?.stop,
				temperature: parameters?.temperature,
				top_p: parameters?.top_p,
				frequency_penalty: parameters?.frequency_penalty,
				presence_penalty: parameters?.presence_penalty,
				// Ask for a trailing usage-only chunk (prompt/completion/total + cached_tokens) so we can
				// log per-turn token cost AND the vLLM prefix-cache hit ratio (prompt_tokens_details.
				// cached_tokens). Streaming only — the non-streaming path already carries usage on the response.
				...(streamingSupported ? { stream_options: { include_usage: true } } : {}),
			};

			const requestOptions = (wire: Record<string, unknown>) => ({
				body: {
					...wire,
					...fallbackOverride,
					...extraBody,
				},
				headers: requestHeaders({ conversationId, locals, servesUserAnswer, substituteServedModel, replayModelCalls }, modelId),
			});

			// Handle both streaming and non-streaming responses with appropriate processors. Each resolves
			// when the response headers arrive, which is the moment withNativeFirst's hedge races on.
			// `toolChoice` set means this request offers the turn's tools: calculate alone (CUR-2273), or the
			// native harness's kit (CUR-2420).
			// A planned math turn on a `calculateOnPlannedMath` model forces calculate on round one. (CUR-4191)
			const kit =
				nativeTools ??
				(calculateTool
					? calculateFirst
						? { ...CALCULATE_KIT, firstRoundTool: CALCULATE_TOOL_NAME }
						: CALCULATE_KIT
					: undefined);
			const send = async (
				msgs: typeof messagesOpenAI,
				attemptSignal: AbortSignal | undefined,
				toolChoice?: ToolChoice
			) => {
				const wireModel = await modelFor(msgs);
				// The effort and the reasoning-off fields follow the pair that will serve the call, which is
				// only known once the wire id is (modelProfiles.ts). A "none" sent to gpt-oss is a 400.
				const effort = acceptedEffort(wireModel, baseURL, reasoningEffort);
				if (effort !== reasoningEffort)
					logger.info(
						{ model: wireModel, wanted: reasoningEffort, sent: effort },
						"[profile] reasoning_effort replaced by one the model accepts"
					);
				const wire = {
					...body,
					...(effort ? { reasoning_effort: effort } : {}),
					...(reasoningOff ? reasoningOff.fields : {}),
					model: wireModel,
					messages: msgs,
					...(toolChoice && kit ? { tools: kit.definitions, tool_choice: toolChoice } : {}),
				};
				const sentAt = Date.now();
				if (streamingSupported) {
					const openChatAICompletion = await openai.chat.completions.create(
						wire as ChatCompletionCreateParamsStreaming,
						{ ...requestOptions(wire), signal: attemptSignal }
					);
					return openAIChatToTextGenerationStream(
						openChatAICompletion,
						() => routerMetadata,
						sentAt,
						Boolean(toolChoice),
						requestedModel,
						toolChoice && kit
							? kit.definitions.map((d) => {
									const fn = (d as { function?: { name?: string; parameters?: InlineToolParameters } }).function;
									return { name: fn?.name ?? "", parameters: fn?.parameters };
								})
							: [],
						turnShapeOf(msgs)
					);
				}
				const openChatAICompletion = await openai.chat.completions.create(
					wire as ChatCompletionCreateParamsNonStreaming,
					{ ...requestOptions(wire), signal: attemptSignal }
				);
				return openAIChatToTextGenerationSingle(openChatAICompletion, () => routerMetadata);
			};

			// The answer offers `calculate` and runs the tool loop. Streaming only, because the
			// loop reads tool calls off the stream; and not on the Apertus native-first path, whose hedged
			// resend has no place for a second round (Apertus is not offered tools anyway). (CUR-2273)
			if (kit && servesUserAnswer) {
				if (streamingSupported && !nativeFirst) {
					// The `tool_round_rate_limited` fault: the first request after round 1 is refused as over-cap.
					// `tool_round_rate_limited_sustained` refuses every one, so the retries run out (CUR-2307).
					let sends = 0;
					let faultArmed = rateLimitToolRound === true;
					return withToolLoop({
						// A backup lane continuing the loop the lane before it could not finish (CUR-2307).
						messages: toolTranscript?.messages ?? messagesOpenAI,
						resumeRound: toolTranscript?.round,
						attempt: (msgs, toolChoice, signal) => {
							if (sends++ > 0 && (faultArmed || rateLimitToolRoundSustained === true)) {
								faultArmed = false;
								return Promise.reject(
									Object.assign(new Error("429 Rate limit exceeded"), { status: 429 })
								);
							}
							return send(msgs, signal ?? abortSignal, toolChoice);
						},
						kit,
						...(kit.maxRounds ? { maxRounds: kit.maxRounds } : {}),
						retry: {
							deadlineAt: turnDeadlineAt,
							signal: abortSignal,
							// A later round hedges after its own delay, under its own flag. (CUR-4372)
							hedgeAfterMs: flagEnabledOr(HEDGE_TOOL_ROUNDS_FLAG, () => false)
								? TOOL_ROUND_HEDGE_AFTER_MS
								: null,
							log: { model: requestedModel, lane },
						},
					});
				}
				logger.warn(
					{ leg: `${kit.label}-tool`, requestedModel, streamingSupported, nativeFirst },
					"[calculate] tool requested on a request shape that cannot run the loop; answering without it"
				);
			}

			if (!nativeFirst) return send(messagesOpenAI, abortSignal);

			const t0 = Date.now();
			const outcome = await withNativeFirst({
				native: messagesOpenAI,
				flat: () => flattenForApertus(messagesOpenAI),
				attempt: send,
				signal: abortSignal,
			});
			// Which shape served this turn. The copying defect only exists on `flat-retry`, so this is the
			// line that says how often the old behavior still reaches users.
			logger.info(
				{ leg: "native-first", shape: outcome.shape, reason: outcome.reason, ms: Date.now() - t0 },
				"[native-first] served shape"
			);
			return outcome.result;
		};
	} else {
		throw new Error("Invalid completion type");
	}
}
