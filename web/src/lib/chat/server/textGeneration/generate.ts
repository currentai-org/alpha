import { config } from "$lib/chat/server/config";
import { modelTakesImagesNow } from "$lib/chat/server/textOnly";
import {
	HELD_REASONING_STATUS,
	MessageReasoningUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	phaseMarker,
	SANDBOX_READY_PHASE,
	SANDBOX_WAIT_PHASE,
	type MessageUpdate,
	type UnrunCodeReason,
} from "$lib/chat/types/MessageUpdate";
import { AbortedGenerations } from "../abortedGenerations";
import type { TextGenerationContext } from "./types";
import type { EndpointMessage, NativeToolKit } from "../endpoints/types";
import { generateFromDefaultEndpoint } from "../generateFromDefaultEndpoint";
import { generateSummaryOfReasoning } from "./reasoning";
import { GROUNDED_DECODING, resolveDecoding } from "./persona";
import { DEFAULT_ANSWER_RESERVE } from "../endpoints/openai/endpointOai";
import { evalLayers, markEvalLayerApplied } from "../evalLayers";
import { opensReasoningUntagged } from "../harnessProfiles";
import { stripFenceTags, stripResponseTags } from "./grounding";
import { logger } from "../logger";
import { unreadFilesNotice } from "../chat/unreadFilesNotice";
import { storeChatAttachments } from "../storage/attachmentsToCustodial";

type GenerateContext = Omit<TextGenerationContext, "messages"> & {
	messages: EndpointMessage[];
	unhardenedUserText?: string;
	/** The visitor's own system text (see EndpointParameters.clientInstructions). (CUR-4088) */
	clientInstructions?: string;
	/** Offer the native calculate tool on this turn. Decided once in index.ts, next to the (CUR-2273)
	 *  persona paragraph that tells the model to use it. */
	calculateTool?: boolean;
	/** A native turn's tools, run by the endpoint's tool loop in place of calculate alone. (CUR-2420) */
	nativeTools?: NativeToolKit;
	/** Send no decoding overrides, so the model's own defaults apply. (CUR-2420) */
	modelDecoding?: boolean;
	/** The person's fixed answer language, for the agent endpoint; see EndpointParameters. (CUR-3929) */
	replyLanguage?: string;
};

/** The model `wrong_model_served` makes the first lane's body name, standing in for a lane
 *  that answers under the wrong badge (servedModelPeek.ts). A different maker from every (CUR-1614)
 *  model we offer, so the badge's backup rule (identity.ts servedByBackup) applies whichever is asked. */
const WRONG_MODEL_SUBSTITUTE = "aisingapore/Qwen-SEA-LION-v4-32B-IT";

/** The layer test's max_tokens switch, set last so it holds on native turns too. (CUR-2139) */
// Grounded decoding's cap was sized for an answer. A model that reasons in-band before it
// answers spends that same budget on its reasoning and can run out before `</think>`, so its cap is
// the answer reserve. A tuning-panel max_tokens still wins. (CUR-4241)
function groundedFor(modelId: string, override?: Partial<typeof GROUNDED_DECODING>): typeof GROUNDED_DECODING {
	const decoding = resolveDecoding(override);
	if (override?.max_tokens !== undefined || !opensReasoningUntagged(modelId)) return decoding;
	return { ...decoding, max_tokens: Math.max(decoding.max_tokens, DEFAULT_ANSWER_RESERVE) };
}

function withEvalCap<T extends object>(settings: T): T | (T & { max_tokens: number }) {
	const cap = evalLayers()?.maxTokens;
	if (cap === undefined) return settings;
	markEvalLayerApplied("maxTokens", cap);
	return { ...settings, max_tokens: cap };
}

export async function* generate(
	ctx: GenerateContext,
	preprompt?: string,
	// Tuning panel: decoding overrides merged over GROUNDED_DECODING; undefined = defaults.
	decodingOverride?: Partial<typeof GROUNDED_DECODING>
): AsyncIterable<MessageUpdate> {
	// Bracket the run so the cross-instance abort poll runs ONLY while a generation is active on this
	// instance (see AbortedGenerations). finally covers normal end, early break, throw, and consumer
	// .return() (the generator is closed when the request stream is torn down).
	const abortTracker = AbortedGenerations.getInstance();
	abortTracker.beginGeneration();
	try {
		yield* generateImpl(ctx, preprompt, decodingOverride);
	} finally {
		abortTracker.endGeneration();
	}
}

async function* generateImpl(
	{
		model,
		endpoint,
		conv,
		messages,
		promptedAt,
		forceMultimodal,
		provider,
		reasoningEffort,
		locals,
		abortController,
		faultInjection,
		turnDeadlineAt,
		unhardenedUserText,
		clientInstructions,
		agentAttach,
		calculateTool,
		calculateFirst,
		nativeTools,
		modelDecoding,
		timings,
		laneRewrites,
		preparedMedia,
		replyLanguage,
	}: GenerateContext,
	preprompt?: string,
	decodingOverride?: Partial<typeof GROUNDED_DECODING>
): AsyncIterable<MessageUpdate> {
	// Reasoning mode support
	let reasoning = false;
	let reasoningBuffer = "";
	let lastReasoningUpdate = new Date();
	let status = "";
	const startTime = new Date();
	const modelReasoning = Reflect.get(model, "reasoning") as
		{ type: string; beginToken?: string; endToken?: string; regex?: string } | undefined;
	if (
		modelReasoning &&
		(modelReasoning.type === "regex" ||
			modelReasoning.type === "summarize" ||
			(modelReasoning.type === "tokens" && modelReasoning.beginToken === ""))
	) {
		// Starts in reasoning mode and we extract the answer from the reasoning
		reasoning = true;
		yield {
			type: MessageUpdateType.Reasoning,
			subtype: MessageReasoningUpdateType.Status,
			// "Computing", not "reasoning" — house non-anthropomorphic stance for user-visible copy.
			// The update TYPE stays MessageReasoningUpdate; only rendered strings change.
			status: "Started computing...",
		};
	}

	if (faultInjection === "lane_rate_limited") {
		// The openai SDK's RateLimitError as it reached the route on develop, status and text. (CUR-2307)
		throw Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
	}
	if (faultInjection === "lane_not_found") {
		// The router's answer for a model entry it cannot serve, text and status as it reaches
		// the route. (CUR-4629)
		throw Object.assign(new Error("404 litellm.NotFoundError: OpenAIException - Not Found"), { status: 404 });
	}
	if (faultInjection === "lane_server_error") {
		// The openai SDK's InternalServerError text and status, which no named copy maps. (CUR-2829)
		throw Object.assign(new Error("500 Internal Server Error"), { status: 500 });
	}
	// Older exchanges the endpoint left out to fit the model's context (CUR-2893), reported once below so
	// the answer can say the model did not read the whole chat. A backup lane refits and reports its own.
	// Older pastes and attachments cut by the corpus budget count too: the model never read them either.
	const mediaCut = preparedMedia?.olderMessagesCut ?? 0;
	// An attached file the turn could not read is named before the answer, which never saw it. (CUR-3291)
	const unreadNotice = preparedMedia?.unreadFiles?.length ? unreadFilesNotice(preparedMedia.unreadFiles) : undefined;
	if (unreadNotice) yield { type: MessageUpdateType.AttachmentNotice, kind: "unread", message: unreadNotice };
	let historyLeftOut = mediaCut;
	let historyNoticeSent = false;
	const stream = await endpoint({
		messages,
		preprompt,
		// The answer-shaping decoding params — low temperature + frequency/presence
		// penalties + a tight token cap. Without an explicit
		// temperature the model runs at its provider default.
		// Merged OVER model.parameters in the endpoint, so they win regardless of env.
		// A model-decoding turn keeps the model's sampling but not an unbounded answer. Without a
		// cap only the repetition cut ends a runaway; the model's own max_tokens wins when it sets one. (CUR-2697)
		generateSettings: withEvalCap(
			modelDecoding
				? model.parameters.max_tokens
					? {}
					: { max_tokens: DEFAULT_ANSWER_RESERVE }
				: groundedFor(model.id, decodingOverride)
		),
		// Allow user-level override to force multimodal. The model's own field is the deployment's
		// answer, so it is ANDed with this request's flag (CUR-2725).
		isMultimodal: (forceMultimodal ?? false) || modelTakesImagesNow(model),
		conversationId: conv._id,
		locals,
		abortSignal: abortController.signal,
		provider,
		reasoningEffort,
		replyLanguage,
		// The ONE call in the app that writes what the user reads. Everything else reaching an endpoint
		// goes through generateFromDefaultEndpoint and leaves this unset — which is what keeps the
		// sovereign-compute assertion off the second-opinion panel's deliberately non-Swiss backends.
		servesUserAnswer: true,
		onHistoryFitted: (leftOut) => {
			historyLeftOut = Math.max(leftOut, mediaCut);
		},
		unhardenedUserText,
		saveAgentFiles: (files) => storeChatAttachments(conv, files.map((file) => ({ file, paste: false }))),
		...(clientInstructions ? { clientInstructions } : {}),
		...(agentAttach ? { agentAttach } : {}),
		...(laneRewrites ? { laneRewrites } : {}),
		...(faultInjection === "primary_lane_down" ? { failPrimaryLane: true } : {}),
		...(faultInjection === "primary_lane_hangs" ? { hangPrimaryLane: true } : {}),
		...(faultInjection === "every_lane_hangs" ? { hangEveryLane: true } : {}),
		...(faultInjection === "primary_lane_rate_limited" ? { rateLimitPrimaryLane: true } : {}),
		...(faultInjection === "every_lane_rate_limited" ? { rateLimitEveryLane: true } : {}),
		...(faultInjection === "tool_round_rate_limited" ? { rateLimitToolRound: true } : {}),
		...(faultInjection === "tool_round_rate_limited_sustained" ? { rateLimitToolRoundSustained: true } : {}),
		...(faultInjection === "wrong_model_served" ? { substituteServedModel: WRONG_MODEL_SUBSTITUTE } : {}),
		...(faultInjection === "model_replay" ? { replayModelCalls: "new_episodes" as const } : {}),
		...(faultInjection === "model_replay_none" ? { replayModelCalls: "none" as const } : {}),
		...(turnDeadlineAt !== undefined ? { turnDeadlineAt } : {}),
		...(calculateTool ? { calculateTool: true } : {}),
		...(calculateTool && calculateFirst ? { calculateFirst: true } : {}),
		...(nativeTools ? { nativeTools } : {}),
	});

	// `stream_truncates_midway` lets this many answer tokens through and then fails the way a
	// lane's socket closing mid-answer does under undici: a TypeError "terminated" out of the stream. (CUR-1614)
	const truncateAfterTokens = faultInjection === "stream_truncates_midway" ? 12 : Infinity;
	let streamedTokens = 0;
	for await (const output of stream) {
		if (historyLeftOut > 0 && !historyNoticeSent) {
			historyNoticeSent = true;
			yield { type: MessageUpdateType.HistoryNotice, leftOut: historyLeftOut };
		}
		// The adapter is holding the model's untagged reasoning back until `</think>`. Say so,
		// without the text, so the client opens its reasoning panel instead of a blank wait. (CUR-3942)
		if ("reasoningHeld" in output && output.reasoningHeld) {
			yield {
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Status,
				status: HELD_REASONING_STATUS,
			};
		}
		// Agent step: the agent endpoint emits one of these per execution step. Forward it as an
		// AgentStep update so the client beats the Hermes node on the live-stack map — then continue (the
		// step's text already streamed inside the <think> block, so this carries no answer tokens).
		if ("agentStep" in output && output.agentStep) {
			const as = output.agentStep as { index: number; tool: string; total?: number };
			yield {
				type: MessageUpdateType.AgentStep,
				index: as.index,
				tool: as.tool,
				total: as.total,
			};
			continue;
		}
		// Write-permission provenance (Story B, CUR-471): the agent endpoint resolved this caller's
		// write access for the task. Forward as a WritePolicy update so the client can explain a
		// silently-missing terminal/code_execution capability — see messageProvenance.writePolicyProvenance
		// for why only a "deny_writes" resolution ever actually renders.
		if ("writePolicy" in output && output.writePolicy) {
			const wp = output.writePolicy as {
				policy: string;
				tier: string;
				tasksDone?: number | null;
				tasksRequired?: number | null;
			};
			yield {
				type: MessageUpdateType.WritePolicy,
				policy: wp.policy as "allow" | "deny_writes",
				tier: wp.tier as "uniform" | "new" | "trusted",
				tasksDone: wp.tasksDone,
				tasksRequired: wp.tasksRequired,
			};
			continue;
		}
		// Agent tool-execution provenance (Story B, CUR-601): the agent endpoint observed at least one
		// real ACP tool run this turn. Forward as an AgentTools update so the client's grounding
		// classifier can tell this apart from "recall" — see messageProvenance.agentToolsProvenance for
		// why only a non-empty toolKinds ever actually renders.
		if ("agentTools" in output && output.agentTools) {
			const at = output.agentTools as { toolKinds: string[]; counts?: Record<string, number> };
			yield {
				type: MessageUpdateType.AgentTools,
				toolKinds: at.toolKinds,
				counts: at.counts,
			};
			continue;
		}
		// The agent-service task this turn submitted. Stored on the message so the run can be
		// found again after the tab that started it is gone. (CUR-993)
		if ("agentRun" in output && output.agentRun) {
			yield {
				type: MessageUpdateType.AgentRun,
				taskId: output.agentRun.taskId,
				machineId: output.agentRun.machineId,
				...(output.agentRun.closed ? { closed: true } : {}),
			};
			continue;
		}
		// A file the agent wrote, now saved with the conversation. The reference rides the
		// message's files, so the reply shows it as a file and a reload still finds it. (CUR-4398)
		if ("agentFile" in output && output.agentFile) {
			yield {
				type: MessageUpdateType.File,
				name: output.agentFile.name,
				sha: output.agentFile.sha,
				mime: output.agentFile.mime,
				agentPath: output.agentFile.agentPath,
			};
			continue;
		}
		// Unrun-code provenance (CUR-1341): the agent endpoint's own unrun check fired, so the answer below
		// is predicted rather than measured. Forwarded as its own update rather than left as the prose
		// prefix it already produces, because the reasoning panel's header has no other way to know — see
		// MessageUnrunCodeUpdate for why the absence of agentTools cannot stand in for it.
		if ("unrunCode" in output && output.unrunCode) {
			const uc = output.unrunCode as { reason: UnrunCodeReason };
			yield {
				type: MessageUpdateType.UnrunCode,
				reason: uc.reason,
			};
			continue;
		}
		// Agent confirmation gate opened (Story B, CUR-218): agent-service paused a tool call and needs a
		// human answer. Forwarded so the client can render a live Allow/Deny prompt WHILE the turn is still
		// streaming — the one update type in this file that a UI acts on mid-turn rather than after.
		if ("agentConfirm" in output && output.agentConfirm) {
			const ac = output.agentConfirm as {
				taskId: string;
				confirmId: string;
				kind: string;
				title: string;
				summary: string;
				deadlineAt?: number;
				channel?: "agent" | "mcp";
				plain?: string;
			};
			yield {
				type: MessageUpdateType.AgentConfirm,
				taskId: ac.taskId,
				confirmId: ac.confirmId,
				kind: ac.kind,
				title: ac.title,
				summary: ac.summary,
				...(ac.plain ? { plain: ac.plain } : {}),
				...(ac.deadlineAt !== undefined ? { deadlineAt: ac.deadlineAt } : {}),
				...(ac.channel ? { channel: ac.channel } : {}),
			};
			continue;
		}
		// Agent confirmation gate resolved (CUR-218): the pause above ended, one way or another.
		if ("agentConfirmResult" in output && output.agentConfirmResult) {
			const acr = output.agentConfirmResult as {
				confirmId: string;
				decision: "allow" | "deny" | "canceled";
				reason: string;
			};
			yield {
				type: MessageUpdateType.AgentConfirmResult,
				confirmId: acr.confirmId,
				decision: acr.decision,
				reason: acr.reason,
			};
			continue;
		}
		// A native tool round is retrieving, so the live line names what is running, as the
		// scaffolded path's search gate does. Literal markers: liveRequestLabels.spec reads them here. (CUR-2275)
		if (output.toolRetrieval) {
			yield {
				type: MessageUpdateType.Status,
				status: MessageUpdateStatus.KeepAlive,
				message:
					output.toolRetrieval === "documents-web"
						? phaseMarker("searching-documents-web")
						: output.toolRetrieval === "documents"
							? phaseMarker("searching-documents")
							: phaseMarker("searching"),
			};
			continue;
		}
		// A code call is waiting for a free sandbox, or has stopped waiting. The live line says so,
		// and the route holds the turn's deadline while it does (streamUpdate.ts). (CUR-4584)
		if (output.sandboxWait) {
			yield {
				type: MessageUpdateType.Status,
				status: MessageUpdateStatus.KeepAlive,
				message: phaseMarker(output.sandboxWait === "waiting" ? SANDBOX_WAIT_PHASE : SANDBOX_READY_PHASE),
			};
			continue;
		}
		// The configured MCP servers' calls in this round, one update each, for the trace. (CUR-3026)
		if (output.mcpCalls) {
			for (const c of output.mcpCalls) {
				yield {
					type: MessageUpdateType.McpCall,
					server: c.server,
					tool: c.tool,
					outcome: c.outcome,
					ms: c.ms,
					...(c.input !== undefined ? { input: c.input } : {}),
					...(c.output !== undefined ? { output: c.output } : {}),
				};
			}
			continue;
		}
		// Code evaluated the model's calculate calls. Each expression and its result go to the
		// UI so the reader can check the setup, not only the number. (CUR-2273)
		if (output.calculations) {
			for (const c of output.calculations) {
				yield {
					type: MessageUpdateType.Calculation,
					expression: c.expression,
					...(c.result !== undefined ? { result: c.result } : {}),
					...(c.error !== undefined ? { error: c.error } : {}),
					...(c.counts !== undefined ? { counts: c.counts } : {}),
				};
			}
			continue;
		}
		// Sources a native tool call (web_search, search_catalog) retrieved. Each result carries
		// the turn's set so far, so the update replaces what the message holds rather than adding to it. (CUR-2420)
		if (output.toolSources) {
			const { webSearch, rag, searchFailed } = output.toolSources;
			if (searchFailed)
				yield { type: MessageUpdateType.SearchAttempt, grounded: false, searched: false, failed: searchFailed };
			if (rag)
				yield {
					type: MessageUpdateType.Rag,
					query: rag.query,
					sources: rag.sources,
					asOf: rag.asOf,
					...(rag.vaultSynthesis ? { vaultSynthesis: rag.vaultSynthesis } : {}),
				};
			if (webSearch)
				yield {
					type: MessageUpdateType.WebSearch,
					query: webSearch.query,
					sources: webSearch.sources,
					asOf: webSearch.asOf,
				};
			continue;
		}
		// What the tool round cost, summed into the turn's persisted timings. (CUR-2273)
		if (output.calculateToolMs !== undefined) {
			if (timings) {
				timings.calculateToolMs = (timings.calculateToolMs ?? 0) + output.calculateToolMs;
				timings.calculateToolRounds = (timings.calculateToolRounds ?? 0) + 1;
				if (output.toolRunMs !== undefined) timings.toolRunMs = (timings.toolRunMs ?? 0) + output.toolRunMs;
			}
			continue;
		}
		// The backup lane's announcement. Not `continue`d: the same chunk carries the backup's
		// routerMetadata, handled just below. (CUR-2239)
		if (output.failover) {
			yield {
				type: MessageUpdateType.Failover,
				from: output.failover.from,
				to: output.failover.to,
				reason: output.failover.reason,
				...(output.failover.cause ? { cause: output.failover.cause } : {}),
			};
		}
		// Check if this output contains router metadata. Emit if any of:
		// 1) route+model are present (router models),
		// 2) provider-only is present (non-router models exposing x-inference-provider), or
		// 3) a served-model id is present (cross-model backup lanes seed it so provenance can name the
		//    model that actually answered even when the host sends no provider header)
		if ("routerMetadata" in output && output.routerMetadata) {
			const hasRouteModel = Boolean(output.routerMetadata.route && output.routerMetadata.model);
			const hasProviderOnly = Boolean(output.routerMetadata.provider);
			const hasServedModel = Boolean(output.routerMetadata.model);
			// 4) the LiteLLM backend host is present — the only signal on a HEALTHY gateway turn, and the
			//    one that lets the served lane be asserted downstream (CUR-114/115).
			const hasBackend = Boolean(output.routerMetadata.backend);
			// 5) verify_method is present (CUR-756) — presence, not truthiness: "" is a real "checked,
			//    unverified" signal and must still trigger the yield, unlike the other fields above where
			//    empty genuinely means "this frame says nothing about it".
			const hasVerifyMethod = "verifyMethod" in output.routerMetadata;
			if (hasRouteModel || hasProviderOnly || hasServedModel || hasBackend || hasVerifyMethod) {
				// `provenance_header_stripped` drops the report, so the turn reaches the visitor
				// with nothing saying which model served it, as on a lane that sends no provenance. (CUR-1614)
				if (faultInjection === "provenance_header_stripped") continue;
				yield {
					type: MessageUpdateType.RouterMetadata,
					route: output.routerMetadata.route || "",
					model: output.routerMetadata.model || "",
					provider:
						(output.routerMetadata
							.provider as unknown as import("@huggingface/inference").InferenceProvider) ||
						undefined,
					backend: output.routerMetadata.backend || undefined,
					lane: output.routerMetadata.lane || undefined,
					// Where this app server ran, for X-ray's hop list. Set by Vercel at runtime. (CUR-4580)
					appRegion: process.env.VERCEL_REGION || undefined,
					...(hasVerifyMethod ? { verifyMethod: output.routerMetadata.verifyMethod } : {}),
				};
				continue;
			}
		}
		// Per-turn token accounting (from stream_options.include_usage). Log prompt/completion/total
		// plus the vLLM prefix-cache hit ratio (cached_tokens / prompt_tokens) — the number that tells
		// us whether prompt-prefix instability is re-prefilling the whole conversation each turn. Arrives
		// after FinalAnswer, so it never gates the answer.
		if ("usage" in output && output.usage) {
			const u = output.usage as {
				promptTokens?: number;
				completionTokens?: number;
				totalTokens?: number;
				cachedTokens?: number | null;
			};
			const cacheHitPct =
				u.promptTokens && u.cachedTokens != null
					? Math.round((u.cachedTokens / u.promptTokens) * 100)
					: null;
			logger.info(
				{
					conversationId: conv._id?.toString(),
					promptTokens: u.promptTokens,
					completionTokens: u.completionTokens,
					totalTokens: u.totalTokens,
					cachedTokens: u.cachedTokens,
					cacheHitPct,
				},
				"[usage] token accounting"
			);
			continue;
		}
		// text generation completed
		if (output.generated_text) {
			// If an abort happened just before final output, stop here and let
			// the caller emit an interrupted final answer with partial text.
			const abortTime = AbortedGenerations.getInstance().getAbortTime(conv._id.toString());
			if (abortController.signal.aborted || (abortTime && abortTime > promptedAt)) {
				if (!abortController.signal.aborted) {
					abortController.abort();
				}
				break;
			}

			let interrupted =
				!output.token.special && !model.parameters.stop?.includes(output.token.text);

			let text = output.generated_text.trimEnd();
			for (const stopToken of model.parameters.stop ?? []) {
				if (!text.endsWith(stopToken)) continue;

				interrupted = false;
				text = text.slice(0, text.length - stopToken.length);
			}
			// An agent run handed off to the page is still going, so its answer is stored interrupted: that is
			// what a later visit, and the page that sent it, re-attach to (generationState.ts agentRunToReattach).
			if (output.agentHandoff) interrupted = true;

			let finalAnswer = text;
			if (modelReasoning && modelReasoning.type === "regex" && modelReasoning.regex) {
				const regex = new RegExp(modelReasoning.regex);
				finalAnswer = regex.exec(reasoningBuffer)?.[1] ?? text;
			} else if (modelReasoning && modelReasoning.type === "summarize") {
				yield {
					type: MessageUpdateType.Reasoning,
					subtype: MessageReasoningUpdateType.Status,
					status: "Summarizing...",
				};
				try {
					const summary = yield* generateFromDefaultEndpoint({
						messages: [
							{
								from: "user",
								content: `Question: ${messages[messages.length - 1].content}\n\nReasoning: ${reasoningBuffer}`,
							},
						],
						preprompt: `Your task is to summarize concisely all your reasoning steps and then give the final answer. Keep it short, one short paragraph at most. If the reasoning steps explicitly include a code solution, make sure to include it in your answer.`,
						modelId: Reflect.get(model, "id") as string | undefined,
						locals,
					});
					finalAnswer = summary;
					yield {
						type: MessageUpdateType.Reasoning,
						subtype: MessageReasoningUpdateType.Status,
						status: `Done in ${Math.round((new Date().getTime() - startTime.getTime()) / 1000)}s.`,
					};
				} catch (e) {
					finalAnswer = text;
					logger.error(e, "Error generating summary of reasoning");
				}
			} else if (modelReasoning && modelReasoning.type === "tokens") {
				// Remove the reasoning segment from final answer to avoid duplication
				const beginIndex = modelReasoning.beginToken
					? reasoningBuffer.indexOf(modelReasoning.beginToken)
					: 0;
				const endIndex = modelReasoning.endToken
					? reasoningBuffer.lastIndexOf(modelReasoning.endToken)
					: -1;

				if (beginIndex !== -1 && endIndex !== -1 && modelReasoning.endToken) {
					finalAnswer =
						text.slice(0, beginIndex) + text.slice(endIndex + modelReasoning.endToken.length);
				}
			}

			// Safety net for the per-turn injection fence: strip any leaked <Q_xxxx> delimiter the
			// model echoed (a model can under-weight the guard instruction, so don't rely on it alone).
			finalAnswer = stripFenceTags(finalAnswer);
			// Same for the <response>…</response> wrapper Apertus emits when grounding on an injected
			// tool/MCP result — strip the wrapper so the answer renders as plain prose, not tagged XML.
			finalAnswer = stripResponseTags(finalAnswer);

			// `truncated` is set by the endpoint transform on a finish_reason of "length". It rides the
			// update rather than the text because this branch is exactly where a capped answer's last
			// token is discarded — we `continue` without yielding it as a Stream token, so anything the
			// transform appended to `token.text` never reaches the screening rebuild (CUR-149).
			const truncated = Boolean(Reflect.get(output, "truncated"));
			yield {
				type: MessageUpdateType.FinalAnswer,
				text: finalAnswer,
				interrupted,
				...(truncated ? { truncated: true } : {}),
			};
			continue;
		}

		if (modelReasoning && modelReasoning.type === "tokens") {
			if (output.token.text === modelReasoning.beginToken) {
				reasoning = true;
				reasoningBuffer += output.token.text;
				continue;
			} else if (modelReasoning.endToken && output.token.text === modelReasoning.endToken) {
				reasoning = false;
				reasoningBuffer += output.token.text;
				yield {
					type: MessageUpdateType.Reasoning,
					subtype: MessageReasoningUpdateType.Status,
					status: `Done in ${Math.round((new Date().getTime() - startTime.getTime()) / 1000)}s.`,
				};
				continue;
			}
		}

		// ignore special tokens
		if (output.token.special) continue;

		// pass down normal token
		if (reasoning) {
			reasoningBuffer += output.token.text;

			if (modelReasoning && modelReasoning.type === "tokens" && modelReasoning.endToken) {
				if (reasoningBuffer.lastIndexOf(modelReasoning.endToken) !== -1) {
					const endTokenIndex = reasoningBuffer.lastIndexOf(modelReasoning.endToken);
					const textBuffer = reasoningBuffer.slice(endTokenIndex + modelReasoning.endToken.length);
					reasoningBuffer = reasoningBuffer.slice(
						0,
						endTokenIndex + modelReasoning.endToken.length + 1
					);

					yield {
						type: MessageUpdateType.Reasoning,
						subtype: MessageReasoningUpdateType.Stream,
						token: output.token.text,
					};
					yield { type: MessageUpdateType.Stream, token: textBuffer };
					yield {
						type: MessageUpdateType.Reasoning,
						subtype: MessageReasoningUpdateType.Status,
						status: `Done in ${Math.round((new Date().getTime() - startTime.getTime()) / 1000)}s.`,
					};
					reasoning = false;
					continue;
				}
			}

			// yield status update if it has changed
			if (status !== "") {
				yield {
					type: MessageUpdateType.Reasoning,
					subtype: MessageReasoningUpdateType.Status,
					status,
				};
				status = "";
			}

			// create a new status every ~4s (optional)
			if (
				Reflect.get(config, "REASONING_SUMMARY") === "true" &&
				new Date().getTime() - lastReasoningUpdate.getTime() > 4000
			) {
				lastReasoningUpdate = new Date();
				// Deliberately NOT awaited: this runs inside the token loop on a ~4s tick, and awaiting
				// would stall the stream on every summary. A try/catch around it could never fire: a rejected
				// promise does not throw inside the synchronous block. `.catch` is the handler a
				// fire-and-forget call actually reaches; `void` marks the drop as intended.
				void generateSummaryOfReasoning(reasoningBuffer, locals)
					.then((summary) => {
						status = summary;
					})
					.catch((e) => {
						logger.error(e, "Error generating summary of reasoning");
					});
			}

			yield {
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Stream,
				token: output.token.text,
			};
		} else {
			yield { type: MessageUpdateType.Stream, token: output.token.text };
			if (++streamedTokens >= truncateAfterTokens) {
				throw Object.assign(new TypeError("terminated"), { cause: new Error("other side closed") });
			}
		}

		// abort check
		const date = AbortedGenerations.getInstance().getAbortTime(conv._id.toString());

		if (date && date > promptedAt) {
			logger.info(`Aborting generation for conversation ${conv._id}`);
			if (!abortController.signal.aborted) {
				abortController.abort();
			}
			break;
		}

		// no output check
		if (!output) break;
	}
}
