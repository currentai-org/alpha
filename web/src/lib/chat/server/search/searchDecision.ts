import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { APP_USER_AGENT } from "$lib/chat/constants/app";
import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { logger } from "$lib/chat/server/logger";
import { config } from "$lib/chat/server/config";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { defaultModel, taskModel } from "$lib/chat/server/models";
import { flattenForApertus } from "$lib/chat/server/endpoints/openai/flattenForApertus";
import { measuredReasoningOff, rolesNeedFlattening } from "$lib/chat/server/modelProfiles";
import {
	resolveClassifierLane,
	type ClassifierLane,
	type ServingLaneModel,
} from "$lib/chat/server/endpoints/openai/providerPin";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";
import { getTuning } from "$lib/chat/server/tuning";
import { WEB_SEARCH_TOOL } from "./toolSearch";
import {
	ATTACHMENT_RULE,
	IMAGE_RULE,
	CLASSIFIER_PREPROMPT,
	attachmentNote,
	parseClassifierVerdict,
	readClassifierVerdict,
	type AttachmentKind,
	type DeciderImage,
} from "./classifierPrompt";

// Re-export the pure helpers so existing importers (the /tuning page, future call sites) keep
// resolving them from here, while evals/tests import the pure ./classifierPrompt without the $env graph.
export { CLASSIFIER_PREPROMPT, parseClassifierVerdict };

// Model-driven "does this turn need an open-web search?" classifier. Used by the
// "model" / "tool" trigger strategies (see $lib/chat/search/triggerStrategy) to catch
// current-info questions the recency regex misses. A tiny, cheap, deterministic
// call to the task model — NOT mid-stream tool-calling (the served model's is
// unreliable here today; it should sharpen as the served model improves, but
// degrades gracefully now).

// CLASSIFIER_PREPROMPT moved to ./classifierPrompt (pure) and re-exported above.

/** The global-lane key, for models whose endpoint carries none (every ordinary catalog model). */
function classifierGlobalKey(): string {
	return (
		firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "searchDecisionApiKey", { allowEmpty: true }) || "sk-"
	);
}

/**
 * Bill the classifier's Inference-Providers call to the org, mirroring the main generation path
 * (endpointOai.ts). The served token's inference permission is org-scoped, so an unbilled call
 * resolves on the personal-user scope and 403s ("insufficient permissions to call Inference Providers
 * on behalf of user …") on every turn. Prefer the per-turn billing org (respects user overrides),
 * fall back to the HF_BILL_TO env.
 *
 * Sent only to the HF router on the global lane; `hfBillToHeader` holds the rule (CUR-1877).
 */
function classifierBillingHeaders(
	lane: ClassifierLane,
	locals: App.Locals | undefined
): Record<string, string> {
	return hfBillToHeader(
		lane.baseURL,
		lane,
		locals?.billingOrganization ?? (Reflect.get(config, "HF_BILL_TO") as string | undefined)
	);
}

/**
 * Per-request headers. Both are global-lane concepts, and the Authorization one is why this is
 * gated rather than merged blindly: on an own lane it would replace the endpoint's own key with a
 * user's HF token, 401 the call, and take the classifier down to its silent fail-closed path.
 */
function classifierRequestHeaders(
	lane: ClassifierLane,
	locals: App.Locals | undefined
): Record<string, string> {
	if (lane.ownLane) return {};
	return {
		...(config.USE_USER_TOKEN === "true" && locals?.token
			? { Authorization: `Bearer ${locals.token}` }
			: {}),
		...hfBillToHeader(lane.baseURL, lane, locals?.billingOrganization),
	};
}

/** A decider's verdict plus whether it produced one. `ok: false` means the call failed and the
 *  verdict is meaningless; the caller logs that as a fail-open departure (CUR-2108) instead of reading
 *  it as a "no". Every decider in this file and searchIntent.ts returns this shape. */
export type DeciderVerdict = {
	shouldSearch: boolean;
	ok: boolean;
	/** Which model answered and where, as the endpoint reported it (CUR-984). Set only on a real call. */
	served?: { model: string; backend?: string; provider?: string };
};

/** Deadline for the search-need call. Without one it inherits the 15 s side-call default, which a
 *  stalled classifier model would hold a declined-search turn for (decideMs p50 488 ms, p90
 *  1.39 s, p99 6.9 s; the model's own ttfb p99 3.5 s). Past it the call is `ok: false` and the
 *  strategy's fallback decides (CUR-3952). */
const SEARCH_CLASSIFIER_TIMEOUT_MS = 3_000;

/**
 * Ask the model whether this query needs open-web grounding. Never throws, never blocks the turn.
 * A short query is a real "no" (`ok: true`); a failed call is `ok: false`, which the logs
 * tell apart from the model declining (CUR-2108).
 */
export async function classifySearchNeed(
	query: string,
	locals: App.Locals | undefined,
	attachments: readonly AttachmentKind[] = []
): Promise<DeciderVerdict> {
	const q = query.trim();
	if (q.length < 3) {
		return { shouldSearch: false, ok: true };
	}
	try {
		// Live-tunable (admin /tuning panel) with the constant as fallback. The attachment rule is added
		// after either, so a tuned prompt still learns about the files (CUR-3192).
		const note = attachmentNote(attachments);
		const basePrompt = (await getTuning()).searchClassifierPrompt || CLASSIFIER_PREPROMPT;
		const preprompt = note ? `${basePrompt}\n\n${ATTACHMENT_RULE}` : basePrompt;
		// generateFromDefaultEndpoint never throws: a failed call comes back as "", which parses as a
		// "no". Without onFailure that read as the model declining, and the catch below never ran.
		let failed: { kind: "ceiling" | "error"; status?: number } | undefined;
		const served: { model?: string; backend?: string; provider?: string } = {};
		// One user message for a model whose deployments refuse the system role. The main
		// answer's flatten (CUR-1294) and Infomaniak pin (CUR-2092) both skip side calls, so a classifier
		// routed to a deployment that refuses the system role needs the flatten here too. (CUR-2141)
		const user = note ? `User message: "${q}"\n${note}` : `User message: "${q}"`;
		const flat = rolesNeedFlattening(taskModel.id)
			? flattenForApertus([
					{ role: "system", content: preprompt },
					{ role: "user", content: user },
				])[0]?.content
			: undefined;
		const raw = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: typeof flat === "string" ? flat : user }],
				preprompt: typeof flat === "string" ? undefined : preprompt,
				// No modelId: this is a side call, so it runs on TASK_MODEL like every other one (CUR-2092).
				// It does not follow the turn's model, so a 3-token yes/no never lands on a large, rate-limited one.
				generateSettings: { max_tokens: 3, temperature: 0 },
				timeoutMs: SEARCH_CLASSIFIER_TIMEOUT_MS,
				onFailure: (kind, status) => (failed = { kind, status }),
				// Merged: the requested id arrives first, the served model and host near the end.
				onServed: (s) => {
					served.model = s.model || served.model || s.requestedModel;
					served.backend = s.backend || served.backend;
					served.provider = s.provider || served.provider;
				},
				locals,
			})
		);
		if (failed) {
			logger.warn({ ...failed, modelId: taskModel.id }, "search-need classifier call failed");
			return { shouldSearch: false, ok: false };
		}
		const reading = readClassifierVerdict(String(raw ?? ""));
		// A reply that is neither yes nor no still decides "no" here, as it always has; this line only
		// makes it countable, since the decision log reads it exactly like a real no (CUR-2141). The
		// length and model, never the reply: it can echo the user's text.
		if (reading === "malformed") {
			logger.warn(
				{ outcome: "malformed", replyLength: String(raw ?? "").length, modelId: taskModel.id },
				"search-need classifier reply was neither yes nor no"
			);
		}
		return {
			shouldSearch: reading === "yes",
			ok: true,
			...(served.model
				? { served: { model: served.model, backend: served.backend, provider: served.provider } }
				: {}),
		};
	} catch (e) {
		logger.error(e, "search-need classifier failed");
		return { shouldSearch: false, ok: false };
	}
}

// ── Model TOOL-CALLING decision (trigger strategy "tool") ───────────────────
// Instead of a yes/no classifier, advertise the web_search tool and let the model
// decide AND author the query. An Apertus tool-calling checkpoint
// emits clean OpenAI tool_calls with good discrimination. The chat answer is
// still produced by the existing grounded-streaming path (we run openSearch with
// the model's query and inject evidence) — this call only resolves the decision,
// so the streaming loop is untouched. Search is read-only/benign, so a jailbreak
// in the message can at most force/suppress a search (the heuristic net still
// catches recency); no heavy preprompt hardening needed here.

// Neither classifier call below goes through the main-turn deadline ladder (generateFromDefaultEndpoint
// does; these two hit the OpenAI client directly), so a gateway that hangs instead of erroring would bypass the ok:false fallback both functions
// already have. A backend that hangs rather than answering needs its own timeout here.
const CLASSIFIER_HTTP_TIMEOUT_MS = 8_000;

type SearchDecision = { shouldSearch: boolean; query?: string };
export type ToolDeciderVerdict = SearchDecision & { ok: boolean };

// Deliberately structural rather than the SDK's own type, so parseToolDecision can be unit-tested
// against hand-written response shapes without constructing a full SDK object.
//
// `type` is here for a reason and must not be tidied away as unused. openai v7 made
// ChatCompletionMessageToolCall a UNION — ChatCompletionMessageFunctionToolCall (which has
// `function`) or ChatCompletionMessageCustomToolCall (which does not). Without a field the two
// variants share, TypeScript's weak-type check rejects the whole union with "no properties in common"
// and the SDK's tool_calls cannot be passed in at all.
//
// A custom tool call reaching here reads as "no web_search call" and returns shouldSearch: false.
// That is deliberate and matches the documented fail-closed contract below: we never DEFINE a custom
// tool, so the model cannot legitimately emit one, and guessing that an unrecognised tool kind meant
// "search" would be worse than declining.
type ToolCallLike = {
	type?: string;
	function?: { name?: string; arguments?: string } | null;
} | null;

/**
 * Extract the search decision from a completion's tool_calls. Pure + exported for
 * unit testing against the real response shape. A web_search call → search (with
 * the model's query when parseable); no call → no search. If the model called the
 * tool but the args are malformed, honor the call (search) and let the caller fall
 * back to the raw user text for the query.
 */
export function parseToolDecision(toolCalls: ToolCallLike[] | null | undefined): SearchDecision {
	const call = (toolCalls ?? []).find((c) => c?.function?.name === "web_search");
	if (!call) {
		return { shouldSearch: false };
	}
	try {
		const args = JSON.parse(call.function?.arguments || "{}");
		const q = typeof args.query === "string" ? args.query.trim() : "";
		return q ? { shouldSearch: true, query: q } : { shouldSearch: true };
	} catch {
		return { shouldSearch: true };
	}
}

/**
 * Ask the model — via real OpenAI tool-calling — whether this turn needs an
 * open-web search, and let it author the query. Never throws, never blocks the turn: a short
 * query is a real "no" (`ok: true`), a failed call is `ok: false`. Uses the default (chat) model so the decision matches the answerer's
 * tool-calling capability; requires a tools-capable checkpoint.
 */
export async function decideSearchViaTool(
	query: string,
	locals: App.Locals | undefined,
	servingModel?: ServingLaneModel,
	attachments: readonly AttachmentKind[] = [],
	// The conversation's photos, for a serving model that reads images. Seeing one, the model decides from
	// the photo and the question together and writes the query from what is in it (CUR-3192).
	images: readonly DeciderImage[] = []
): Promise<ToolDeciderVerdict> {
	const q = query.trim();
	if (q.length < 3 && images.length === 0) {
		return { shouldSearch: false, ok: true };
	}
	const note = attachmentNote(attachments);
	const text = images.length
		? `${q}\n\n(${IMAGE_RULE})`
		: note
			? `${q}\n\n(${note} ${ATTACHMENT_RULE})`
			: q;
	try {
		const lane = resolveClassifierLane(
			servingModel ?? defaultModel,
			config.OPENAI_BASE_URL,
			config.OPENAI_PROVIDER
		);
		const client = await createOpenAIClient({
			apiKey: lane.apiKey ?? classifierGlobalKey(),
			baseURL: lane.baseURL,
			// Also at construction, not only per-request below: CUR-1345 made the factory require it, so
			// the cap CUR-1069 added holds even if a future call here forgets the per-request option.
			timeout: CLASSIFIER_HTTP_TIMEOUT_MS,
			defaultHeaders: {
				"User-Agent": APP_USER_AGENT,
				...classifierBillingHeaders(lane, locals),
			},
		});
		const res = await client.chat.completions.create(
			{
				model: lane.modelId,
				// The files ride as context, so a question about them doesn't read as a lookup. One
				// user message, since some deployments refuse the system role (CUR-2141). (CUR-3192)
				messages: [
					{
						role: "user",
						content: images.length
							? [
									{ type: "text", text },
									...images.map((im) => ({
										type: "image_url" as const,
										image_url: { url: `data:${im.mime};base64,${im.b64}` },
									})),
								]
							: text,
					},
				],
				tools: [WEB_SEARCH_TOOL],
				tool_choice: "auto",
				stream: false,
				max_tokens: 80,
				temperature: 0,
				// The serving model answers this, unstreamed: a model that reasons by default needs its
				// known off switch here, or it waits out the timeout (CUR-4281).
				...measuredReasoningOff(lane.modelId, lane.baseURL),
			},
			{
				timeout: CLASSIFIER_HTTP_TIMEOUT_MS,
				headers: { "X-use-cache": "false", ...classifierRequestHeaders(lane, locals) }
			}
		);
		return { ...parseToolDecision(res.choices?.[0]?.message?.tool_calls), ok: true };
	} catch (e) {
		logger.error(e, "search-need tool decision failed");
		return { shouldSearch: false, ok: false };
	}
}
