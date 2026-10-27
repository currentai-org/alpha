import { taskModel, models } from "$lib/chat/server/models";
import { logger } from "$lib/chat/server/logger";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { EndpointMessage } from "./endpoints/types";
import { flattenForApertus } from "./endpoints/openai/flattenForApertus";
import { rolesNeedFlattening } from "./modelProfiles";

/** Ceiling on ANY side-call through this function, applied whether or not the caller passes a signal.
 *
 *  Every call here is a classifier, a title, or a summary — max_tokens 3, 20, 40, 120 — never the
 *  answer the user reads. None of them has a legitimate reason to outlive the turn that asked for it,
 *  and the turn's own watchdog fires at 45s (`GENERATION_TIMEOUT_MS`). So a side-call still running
 *  after this ceiling is, by construction, work whose result nobody can use.
 *
 *  The ceiling exists because bounding the callers one at a time does not hold (CUR-1655 bounded two
 *  of them). A side-call generation can finish well after its turn was declared dead, with the
 *  output-screen summary showing a long screen phase that screened nothing and released nothing:
 *  an abandoned in-flight side-call keeps the upstream async iterator from returning `done`, which
 *  parks screenStream's consumer, and output screening is the first-token gate. The user sees an
 *  empty bubble until the watchdog fires.
 *
 *  Eight of the ten call sites had no bound. A per-caller fix leaves the ninth to the next person. */
const DEFAULT_SIDE_CALL_TIMEOUT_MS = 15_000;

/**
 * A side call to a model some deployment of which refuses non-user roles goes out as ONE user message
 * (CUR-1294). Production's TASK_MODEL is Apertus, pooled across Infomaniak and Featherless, and a
 * system role sent to the Featherless deployment is answered as Qwen SEA-LION, so the side call is
 * shed and comes back empty. The answer lane flattens in endpointOai, gated to the answer marker, so
 * this covers the side calls; the two that flatten themselves (the search classifier and the title)
 * arrive here already in this shape and pass through unchanged.
 *
 * A call carrying files keeps its shape: the flattened message is text, and dropping an attachment is
 * worse than a refused role.
 */
function shapeForModel(
	modelId: string,
	messages: EndpointMessage[],
	preprompt: string | undefined
): { messages: EndpointMessage[]; preprompt: string | undefined } {
	if (!rolesNeedFlattening(modelId) || messages.some((m) => m.files?.length)) {
		return { messages, preprompt };
	}
	const flat = flattenForApertus([
		...(preprompt ? [{ role: "system" as const, content: preprompt }] : []),
		...messages.map((m) => ({ role: m.from, content: m.content })),
	]);
	const only = flat.length === 1 ? flat[0] : undefined;
	if (only?.role !== "user" || typeof only.content !== "string") return { messages, preprompt };
	return { messages: [{ from: "user", content: only.content }], preprompt: undefined };
}

/** Side-call model ids already reported as unregistered, so each warns once per instance (CUR-2264). */
const substitutedSideCallIds = new Set<string>();

export async function* generateFromDefaultEndpoint({
	messages,
	preprompt,
	generateSettings,
	modelId,
	provider,
	reasoningEffort,
	disableThinking,
	isMultimodal,
	signal,
	timeoutMs = DEFAULT_SIDE_CALL_TIMEOUT_MS,
	onFailure,
	onServed,
	locals,
}: {
	messages: EndpointMessage[];
	preprompt?: string;
	generateSettings?: Record<string, unknown>;
	/** Optional: use this model instead of the default task model */
	modelId?: string;
	/** Optional router-provider preference forwarded to the endpoint. Left undefined, the endpoint
	 *  applies the OPENAI_PROVIDER default pin (keeps the task model on its known-warm lane). Pass
	 *  "auto" to OPT OUT of that pin — required when fanning out to models the pinned provider doesn't
	 *  host (e.g. the second-opinion panel), so the HF router can auto-select a backend that does. */
	provider?: string;
	/** Forwarded to the endpoint as `reasoning_effort`. NOT expressible through generateSettings — that
	 *  object is read key-by-key in endpointOai and reasoning_effort is not one of the keys it copies.
	 *  Callers fanning out to reasoning models need this: on a substantive question a reasoning model
	 *  spends its entire token budget thinking and returns no answer at all (CUR-149). */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
	/** Forwarded as `thinking: {type: "disabled"}` — see EndpointParameters.disableThinking. */
	disableThinking?: boolean;
	/** Send the user messages' image files as image parts. Left undefined, the model's own registration
	 *  decides (`modelTakesImagesNow`). The second-opinion panel sets it per panelist, since its models
	 *  are registered without a catalog read (CUR-4670). */
	isMultimodal?: boolean;
	/** Cancels the underlying HTTP request. Every endpoint already accepts one — `abortSignal` on
	 *  EndpointParameters (endpoints/types.ts:25), threaded into each fetch by endpointOai — and this
	 *  function passes it through, so a side-call here can be cancelled.
	 *
	 *  That is load-bearing, not tidiness. Racing this call against a timer and walking away leaves the
	 *  generation in flight: getReturnFromGenerator loops `await generator.next()` with no abort, so the
	 *  upstream async iterator never returns `done`, and screenStream's producer then never finishes —
	 *  its consumer parks forever and the turn dies at the watchdog having shown the user nothing
	 *  (CUR-1655, CUR-1657).
	 *
	 *  A `gen.return()` from the caller is NOT a substitute — it queues behind the in-flight next() and
	 *  cannot interrupt a pull that never settles. This is the handle that can. */
	signal?: AbortSignal;
	/** Overrides the ceiling above for a caller whose own deadline is legitimately longer — the
	 *  second-opinion panel, whose panelists are capped at 30s and aggregator at 20s by its own
	 *  constants. A caller passing BOTH this and `signal` gets whichever fires first. */
	timeoutMs?: number;
	/** Told when the call failed and the "" it returns is a stand-in, not a reply: "ceiling" when the
	 *  deadline cut it, "error" for anything else. For a caller that must tell a failed call from a model
	 *  that answered with nothing — the title's source says which (CUR-2031). `status` is the HTTP
	 *  status when the provider refused the request (the SDK's APIError carries it), so a 400 for a model
	 *  the lane cannot serve reads as a refusal rather than as a model that said nothing (CUR-2107). */
	onFailure?: (kind: "ceiling" | "error", status?: number) => void;
	/** Told which lane the call went to: `requestedModel` as soon as the model resolves, so a call that
	 *  never returns still names it, then whatever provenance the gateway's headers carried (`backend`
	 *  on the LiteLLM gateway). The endpoint yields that near the end of the stream and this function
	 *  otherwise drops it, so a caller timing its own side-call could not say which lane was slow
	 *  (CUR-2140). Called more than once; merge the fields. */
	onServed?: (served: {
		requestedModel?: string;
		backend?: string;
		model?: string;
		provider?: string;
	}) => void;
	locals: App.Locals | undefined;
}): AsyncGenerator<MessageUpdate, string, undefined> {
	// Whichever fires first wins: a caller's own (usually tighter) signal, or the ceiling. Built before
	// the try so the timer is armed for the endpoint resolution too — `getEndpoint()` reaches the
	// network on a cold model and is no more exempt from hanging than the generation is.
	const deadline = AbortSignal.timeout(timeoutMs);
	const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		// Choose endpoint based on provided modelId, else fall back to taskModel. A modelId the registry
		// doesn't hold is a misconfiguration (a side-call env var naming an unregistered model), and the
		// task model still serves it, because a side call is best-effort and must not fail the turn. It
		// logs both ids at warn so the swap can be found in Axiom (CUR-2319, CUR-2264). Once per id per
		// instance: the misconfiguration is the same on every call, and a title per turn would bury the
		// line it exists to surface.
		const found = modelId ? models.find((m) => m.id === modelId) : undefined;
		if (modelId && !found && !substitutedSideCallIds.has(modelId)) {
			substitutedSideCallIds.add(modelId);
			logger.warn(
				{ sideCallSubstituted: true, requestedModel: modelId, servedModel: taskModel.id },
				"[side-call] requested model is not registered; the task model serves it instead"
			);
		}
		const resolved = found ?? taskModel;
		// This function is EVERY side-call (title, search-decision, reasoning-summary — never the
		// answer the user reads; see the answer-marker field on EndpointParameters). A caller that
		// passes the turn's serving model through (e.g. searchDecision's `servingModel?.id`) can resolve here to
		// the agent model on an agent-routed turn. endpointAgent has no notion of a side-call: it
		// always submits a full, independent /run task and ignores preprompt/generateSettings (CUR-542)
		// — so a 3-token yes/no classifier or a 24-token title would instead get a second, unrelated
		// agent run as its "answer". Redirect to taskModel instead of ever handing the agent model a
		// call it can't serve as a side-call.
		const model = resolved.id === AGENT_MODEL_ID ? taskModel : resolved;
		onServed?.({ requestedModel: model.id });
		const shaped = shapeForModel(model.id, messages, preprompt);
		const endpoint = await model.getEndpoint();
		const tokenStream = await endpoint({
			messages: shaped.messages,
			preprompt: shaped.preprompt,
			generateSettings,
			provider,
			reasoningEffort,
			disableThinking,
			...(isMultimodal !== undefined ? { isMultimodal } : {}),
			abortSignal,
			locals,
		});

		for await (const output of tokenStream) {
			if (onServed && "routerMetadata" in output && output.routerMetadata) {
				const { backend, model: served, provider: servedProvider } = output.routerMetadata;
				onServed({ backend, model: served, provider: servedProvider });
			}
			// if not generated_text is here it means the generation is not done
			if (output.generated_text) {
				let generated_text = output.generated_text;
				for (const stop of [...(model.parameters?.stop ?? []), "<|endoftext|>"]) {
					if (generated_text.endsWith(stop)) {
						generated_text = generated_text.slice(0, -stop.length).trimEnd();
					}
				}
				return generated_text;
			}
			yield {
				type: MessageUpdateType.Stream,
				token: output.token.text,
			};
		}
	} catch (error) {
		// A task-model failure is logged rather than swallowed (CUR-219). Callers still get ""
		// because every one of them treats an empty result as "no summary/title available", which is the
		// right behaviour; the failure still leaves a trace.
		// Name the ceiling explicitly, so a hung side-call leaves one greppable line behind.
		if (deadline.aborted) {
			logger.warn(
				{ timeoutMs, modelId },
				"[task-model] side-call exceeded its ceiling and was cut; returning empty"
			);
		} else {
			logger.warn({ err: error }, "[task-model] default-endpoint generation failed; returning empty");
		}
		const status = (error as { status?: unknown } | null)?.status;
		onFailure?.(
			deadline.aborted ? "ceiling" : "error",
			typeof status === "number" ? status : undefined
		);
		return "";
	}

	return "";
}
