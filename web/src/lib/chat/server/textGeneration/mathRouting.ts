// Math routing (CUR-2065, CUR-2198). The arithmetic in an answer never comes from model prose:
//
//   1. plan       one forced `plan_turn` call on ARITHMETIC_ROUTE_MODEL (GLM) on every turn. Its `math`
//                 field says whether the latest message asks for a number to be worked out and, if so,
//                 records the groups as typed lines {factors, label} (turnPlan.ts)
//   2. code       sums the lines and renders the rows and total, which stream to the reader first
//   3. answer     the route model explains in words, told the total and told not to redo it. A model
//                 that restates a different total under the checked one is the failure this guards.
//                 Every turn without a ledger stays on the default model
//
// The planner replaced a regex floor that decided which turns reached the ledger. On the 61-case bench
// it triggered on 165/165 maths questions and 0/63 controls; the floor missed follow-ups like "one of
// them resigned" (CUR-2198). If the call fails or times out, the turn is answered in prose with no
// code-summed total. A rendered ledger shows its rows and total with no label: "checked by code" vouched
// for sums whose setup was wrong (CUR-3663), and `stripForgedStamp` removes that label wherever the
// model copies it from an older answer (CUR-2199).
//
// Behind `math-routing`, off everywhere but preview. Sending visitor text to GLM needs the privacy
// notice to list that processor first (CUR-2063), so production stays off until that lands.

import type OpenAI from "openai";
import { config } from "$lib/chat/server/config";
import { endpointApiKey } from "$lib/chat/server/endpointKey";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";
import { reasoningOffRequest } from "$lib/chat/server/endpoints/openai/thinkFilter";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { extractInlineToolCallArgs, rawToolCallArgs, type ToolCallMessage } from "./forcedToolCallLane";
import {
	compactRenderedLedgers,
	LEDGER_STAMP,
	ledgerAnswerNote,
	ledgerTotal,
	parseLedgerArgs,
	renderLedger,
	type Ledger,
} from "./ledger";
import { parsePlan, PLAN_TOOL, planSystemFor, planTranscript, type TurnPlan } from "./turnPlan";
import { FOLLOW_UP_SYSTEM, FOLLOW_UP_TOOL, followUpNote, followUpTranscript, parseFollowUp, type FollowUpRead } from "./followUp";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";
import { calculatesOnPlannedMath } from "$lib/chat/server/harnessProfiles";

export { followUpNote };
export { compactRenderedLedgers, ledgerAnswerNote, ledgerTotal, parseLedgerArgs, renderLedger, type Ledger };

export const MATH_ROUTING_FLAG = "math-routing";
export const mathRoutingEnabled = (): boolean => flagEnabledOr(MATH_ROUTING_FLAG, () => false);

/**
 * Whether this turn's model gets a plan call at all (CUR-2282). A model that can call tools answers its
 * own arithmetic, through the native `calculate` tool when that is on, so routing its math turns to the
 * route model would hand the answer to a different model for no reason. Only a model that cannot call
 * tools, Apertus today, is planned. The agent model declares no tools either, but it computes in its own
 * sandbox, and a ledger would hand its turn to the route model with no agent run (CUR-3884).
 * A tool-calling model whose row sets `calculateOnPlannedMath` is planned too, see
 * {@link plannedMathForcesCalculate}.
 */
export const plansTurnFor = (model: { id?: string; supportsTools?: boolean }): boolean =>
	model.id !== AGENT_MODEL_ID && (!model.supportsTools || plannedMathForcesCalculate(model));

/**
 * Whether a plan that finds math on this model's turn forces its answer to call `calculate`, rather
 * than handing the turn to the route model with a ledger (CUR-4191). Only for a tool-calling model whose
 * row asks for it: ALIA, left to choose, tends to work a multiplication out by hand.
 */
export const plannedMathForcesCalculate = (model: { id?: string; supportsTools?: boolean }): boolean =>
	!!model.supportsTools && calculatesOnPlannedMath(model.id);

/**
 * Whether the planner can see what the newest question is about. Its transcript is message text only
 * (`planTranscript`), so a file or a paste chip on the newest user message never reaches it, and a plan
 * made without it stamped a count it never saw: "Total: 1 characters (arithmetic checked by code)" for
 * a 100,000-character paste (CUR-3011). Such a turn goes to the answer model alone, which does see it.
 */
export const plannerSeesTurn = (
	messages: readonly { from: string; content?: string; files?: readonly unknown[] }[]
): boolean =>
	!([...messages].reverse().find((m) => m.from === "user")?.files?.length ?? 0);

export const PLAN_TIMEOUT_MS = 8_000;

// The call's own exits. "ok" means the planner answered with a usable plan; each field then carries its
// own outcome (turnPlan.ts), so a malformed math field never costs a later field its answer.
export type PlanCallOutcome = "ok" | "no-call" | "unparsable" | "failed" | "timeout";

type RouteModel = { id: string; endpoints?: unknown[] };

// `modelId` is the id the host knows the model by: the staging router names mistral-medium-2604
// `mistralai/mistral-medium-3-5` and rejects ours (CUR-3055).
function laneFor(model: RouteModel): { baseURL: string; apiKey: string; modelId: string } | null {
	const ep = model.endpoints?.[0] as { baseURL?: string; apiKeyEnv?: string; modelId?: string } | undefined;
	const apiKey = endpointApiKey(ep);
	if (!ep?.baseURL || !apiKey) return null;
	return { baseURL: ep.baseURL, apiKey, modelId: ep.modelId || model.id };
}

const latestUserText = (messages: readonly { from: string; content?: string }[]): string =>
	[...messages].reverse().find((m) => m.from === "user")?.content ?? "";

type CallDiag = {
	ttfbMs?: number;
	finishReason?: string;
	contentChars: number;
	reasoningChars: number;
	provider?: string;
};

/** One forced tool call on the route model. Never throws: every exit is an outcome code. Records where
 *  the call's time goes, so a slow one is read from the log rather than re-probed: headers (ttfbMs),
 *  reasoning spent before the call (reasoningChars), and which HF provider served it. */
async function forcedToolCall(
	model: RouteModel,
	body: { system: string; transcript: unknown[]; tool: { function: { name: string } }; maxTokens: number },
	signal?: AbortSignal
): Promise<{ raw: string | undefined; outcome: Exclude<PlanCallOutcome, "unparsable">; diag: CallDiag; ms: number }> {
	const started = Date.now();
	const diag: CallDiag = { contentChars: 0, reasoningChars: 0 };
	const exit = (raw: string | undefined, outcome: Exclude<PlanCallOutcome, "unparsable">) => ({
		raw,
		outcome,
		diag,
		ms: Date.now() - started,
	});
	const lane = laneFor(model);
	if (!lane) return exit(undefined, "failed");
	const name = body.tool.function.name;
	const billTo = ((Reflect.get(config, "HF_BILL_TO") as string | undefined) ?? "").trim();
	// GLM reasons before a tool call unless told not to, and these calls need none. Which field turns
	// reasoning off depends on the provider (thinkFilter.ts): zai-org reads `thinking`
	// (CUR-2090), while Scaleway reads `reasoning_effort: "none"` (CUR-2104). Built inside the try: a GLM id with no
	// provider pin throws here (CUR-2112), which fails the plan rather than the turn.
	try {
		const reasoningOff = reasoningOffRequest(lane.modelId, lane.baseURL, config.OPENAI_BASE_URL);
		const client: OpenAI = await createOpenAIClient({
			baseURL: lane.baseURL,
			apiKey: lane.apiKey,
			timeout: PLAN_TIMEOUT_MS,
			defaultHeaders: {
				"User-Agent": "aipotluck.org",
				...hfBillToHeader(lane.baseURL, { ownLane: false }, billTo),
			},
		});
		const sentAt = Date.now();
		const response = await client.chat.completions
			.create(
				{
					model: reasoningOff.model,
					messages: [
						{ role: "system", content: body.system },
						...(body.transcript as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
					],
					tools: [body.tool as OpenAI.Chat.Completions.ChatCompletionTool],
					tool_choice: { type: "function", function: { name } },
					temperature: 0,
					max_tokens: body.maxTokens,
					...(reasoningOff.fields as Record<string, unknown>),
				},
				{ signal, timeout: PLAN_TIMEOUT_MS }
			)
			.asResponse();
		diag.ttfbMs = Date.now() - sentAt;
		diag.provider = response.headers.get("x-inference-provider") ?? undefined;
		if (!response.ok) throw new Error(`${name} call answered ${response.status}`);
		const res = (await response.json()) as OpenAI.Chat.Completions.ChatCompletion;
		const message = res.choices?.[0]?.message as ToolCallMessage | undefined;
		const reasoning = (message as { reasoning_content?: string; reasoning?: string } | undefined) ?? {};
		diag.reasoningChars = (reasoning.reasoning_content ?? reasoning.reasoning ?? "").length;
		diag.finishReason = res.choices?.[0]?.finish_reason ?? undefined;
		diag.contentChars = (message?.content ?? "").length;
		const raw =
			rawToolCallArgs(message, name) ??
			// Fallback for a host that answers a forced call in content instead of tool_calls.
			extractInlineToolCallArgs((message as { content?: string | null } | undefined)?.content, name);
		return exit(raw ?? undefined, raw ? "ok" : "no-call");
	} catch (err) {
		const aborted = signal?.aborted || (err as { name?: string })?.name === "APIConnectionTimeoutError";
		if (!aborted) logger.warn({ err: (err as Error)?.message, model: model.id, tool: name }, "[turn-plan] call failed");
		return exit(undefined, aborted ? "timeout" : "failed");
	}
}

// The follow-up call's own exit when it was not made or did not answer; a parsed answer reports the
// read's outcome instead (followUp.ts).
export type FollowUpCallResult = FollowUpRead | { outcome: "skipped" | "no-call" | "failed" | "timeout"; standalone: null };

/** The turn planner's forced plan_turn call and, when the conversation has an earlier turn, the
 *  follow-up read beside it, both on the route model and in parallel. Never throws: every exit is an
 *  outcome code, a null plan means the turn goes ahead with no math field applied, and a follow-up
 *  without a resolved reading adds no note. Logs one line with both, codes and counts only, never the
 *  visitor's text. */
export async function planTurn(
	messages: readonly { from: string; content?: string; mathLedger?: Ledger }[],
	model: RouteModel,
	signal?: AbortSignal
): Promise<{
	plan: TurnPlan | null;
	followUp: FollowUpCallResult;
	outcome: PlanCallOutcome;
	ms: number;
	provider?: string;
}> {
	const started = Date.now();
	const followUpMessages = followUpTranscript(messages);
	const [mathCall, followUpCall] = await Promise.all([
		forcedToolCall(
			model,
			{
				system: planSystemFor(latestUserText(messages)),
				transcript: planTranscript(messages),
				tool: PLAN_TOOL,
				maxTokens: 1024,
			},
			signal
		),
		followUpMessages
			? forcedToolCall(
					model,
					{ system: FOLLOW_UP_SYSTEM, transcript: followUpMessages, tool: FOLLOW_UP_TOOL, maxTokens: 256 },
					signal
				)
			: null,
	]);
	const plan = mathCall.outcome === "ok" ? parsePlan(mathCall.raw) : null;
	const outcome: PlanCallOutcome = mathCall.outcome === "ok" && !plan ? "unparsable" : mathCall.outcome;
	const followUp: FollowUpCallResult = !followUpCall
		? { outcome: "skipped", standalone: null }
		: followUpCall.outcome === "ok"
			? parseFollowUp(followUpCall.raw, latestUserText(messages))
			: { outcome: followUpCall.outcome, standalone: null };
	const ms = Date.now() - started;
	logger.info(
		{
			outcome,
			ms,
			ttfbMs: mathCall.diag.ttfbMs,
			math: plan?.math.outcome,
			mathLines: plan?.math.ledger?.lines.length ?? 0,
			finishReason: mathCall.diag.finishReason,
			contentChars: mathCall.diag.contentChars,
			reasoningChars: mathCall.diag.reasoningChars,
			provider: mathCall.diag.provider,
			followUp: followUp.outcome,
			followUpMs: followUpCall?.ms,
			followUpTtfbMs: followUpCall?.diag.ttfbMs,
		},
		"[turn-plan] plan"
	);
	const provider = mathCall.diag.provider;
	return { plan, followUp, outcome, ms, ...(provider ? { provider } : {}) };
}

// The stamp as the answer model copies it from an earlier rendered ledger, with or without the markdown
// underscores. It is a string this module generates, never a phrase of natural language.
const STAMP_FORMS = [LEDGER_STAMP, LEDGER_STAMP.replace(/^_|_$/g, "")].map((f) => f.toLowerCase());
const STAMP_RE = /[ \t]*_?\(arithmetic checked by code\)_?/gi;

/** Length of the longest tail of `text` that could still become a stamp once more tokens arrive, with
 *  any whitespace in front of it. That tail is held back rather than streamed. */
function stampTailLength(text: string): number {
	const lower = text.toLowerCase();
	for (let start = Math.max(0, lower.length - LEDGER_STAMP.length - 8); start < lower.length; start++) {
		const body = lower.slice(start).trimStart();
		if (STAMP_FORMS.some((form) => form.startsWith(body))) return lower.length - start;
	}
	return 0;
}

/** Removes the "checked by code" stamp from the answer model's own text, streamed and final. The model
 *  copies it from rendered ledgers earlier in the conversation and put it on its own totals on 36 of 45
 *  follow-ups, 9 of them wrong (CUR-2199). Only `ledgerPrefixStream`, which wraps this, adds a real one. */
export async function* stripForgedStamp(source: AsyncIterable<MessageUpdate>): AsyncGenerator<MessageUpdate> {
	let pending = "";
	let stripped = 0;
	const strip = (text: string): string => {
		const out = text.replace(STAMP_RE, "");
		if (out !== text) stripped++;
		return out;
	};
	const flush = function* (): Generator<MessageUpdate> {
		const out = strip(pending);
		pending = "";
		if (out) yield { type: MessageUpdateType.Stream, token: out };
	};
	for await (const event of source) {
		if (event.type === MessageUpdateType.Stream) {
			// Hold any tail that could still grow into a stamp, a complete one included, since its closing
			// underscore may be the next token; strip only what is released.
			const text = pending + event.token;
			const cut = text.length - stampTailLength(text);
			pending = text.slice(cut);
			const out = strip(text.slice(0, cut));
			if (out) yield { ...event, token: out };
			continue;
		}
		if (event.type === MessageUpdateType.FinalAnswer) {
			yield* flush();
			const text = event.text.replace(STAMP_RE, "");
			if (stripped || text !== event.text) logger.info({ streamed: stripped, final: text !== event.text }, "[math-routing] forged stamp removed");
			yield { ...event, text };
			continue;
		}
		// A keepAlive or routerMetadata can land in the middle of a stamp. Flushing here would release its
		// two halves separately, each unmatched, and with output screening on the persisted answer is built
		// from those tokens (screenStream.ts), never from the FinalAnswer text stripped below. A held tail of
		// bare spaces is no half of a stamp, though, and output screening releases a sentence only at the
		// space after it: holding that space through a pause keeps the whole sentence off screen (CUR-2697).
		if (/^[ \t]+$/.test(pending)) yield* flush();
		yield event;
	}
	yield* flush();
}

/** Names the route model as the served model on a ledger turn. The HF router reports only the provider
 *  that served, so the turn would persist `model: ""` and the badge would fall back to the conversation's
 *  model, crediting Apertus with words GLM wrote (CUR-2198). The id is the one requested, provider-pinned. */
export async function* namedServedModel(
	source: AsyncIterable<MessageUpdate>,
	modelId: string
): AsyncGenerator<MessageUpdate> {
	for await (const event of source) {
		yield event.type === MessageUpdateType.RouterMetadata && !event.model ? { ...event, model: modelId } : event;
	}
}

/** The same two steps for an answer that replaces the stream's whole text after the fact, the
 *  grounded-bail regen (groundedBailRegen.ts), which generates outside `stripForgedStamp` and
 *  `ledgerPrefixStream`: the model's own stamps removed, the code-rendered ledger back in front. */
export function settleReplacedAnswer(text: string, ledger: Ledger | null): string {
	const answer = text.replace(STAMP_RE, "");
	if (answer !== text) logger.info({ regen: true }, "[math-routing] forged stamp removed");
	return ledger ? `${renderLedger(ledger)}\n\n${answer}` : answer;
}

/** Puts the code-rendered ledger in front of the answer: first as a stream token, so the reader sees
 *  the checked rows before the prose starts, then in the final text that is persisted. */
export async function* ledgerPrefixStream(
	source: AsyncIterable<MessageUpdate>,
	ledger: Ledger
): AsyncGenerator<MessageUpdate> {
	const prefix = `${renderLedger(ledger)}\n\n`;
	yield { type: MessageUpdateType.Stream, token: prefix };
	for await (const event of source) {
		if (event.type === MessageUpdateType.FinalAnswer) {
			yield { ...event, text: prefix + event.text };
			continue;
		}
		yield event;
	}
}
