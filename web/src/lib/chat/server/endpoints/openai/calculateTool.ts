// The answer model is offered one OpenAI-style function,
// `calculate({expression})`, with tool_choice "auto". When it calls it, code evaluates the expression
// with evaluateArithmetic (mathjs behind an arithmetic-only tree check), the result goes back as a `tool` message, and the same answer continues in a
// second request, so the visitor reads one answer. Each expression and its result also go to the UI,
// so the visitor can check the setup the model wrote down, not just the number that came out of it.
//
// Why a model-native tool and not a side call: a model offered the tool misses arithmetic mainly on
// turns where it skips the tool, so the persona tells it to call `calculate` before stating any number
// (CALCULATE_FIRST_CLAUSE in persona.ts). A hybrid setup that stamps "arithmetic checked by code" on a
// total can be right about the arithmetic and wrong about the setup, so the UI shows the expression
// and never says "checked" or "verified".
//
// Model-agnostic: nothing here names a model. The model's own `supportsTools` decides whether it is
// offered to that model.

import { catalogByGatewayId } from "$lib/chat/routing/catalog";
import type OpenAI from "openai";
import { logger } from "$lib/chat/server/logger";
import { evaluateArithmetic, evaluateExactInteger } from "$lib/chat/server/textGeneration/evaluateArithmetic";
import { rolesNeedFlattening } from "../../modelProfiles";
import {
	createHedgeThrottle,
	isRateLimited,
	statusOf,
	TOOL_ROUND_RETRY,
	upstreamErrorText,
	withRetry,
	type HedgeThrottle,
	type RetryPolicy,
} from "../retryPolicy";
import { framesWhile } from "../toolFrames";
import type {
	NativeToolKit,
	NativeToolResult,
	StreamedToolCall,
	TextGenerationStreamOutputSimplified,
} from "../types";

const warnedWithoutTools = new Set<string>();
const warnedNativeFirst = new Set<string>();

/**
 * Whether the answer request for this model goes out on the native-first path (endpointOai.ts),
 * which hedges with a flattened resend and has no place for a tool round. A model with no measured
 * profile row counts as needing the flatten, so a new tool-capable model lands here until its row exists.
 * A model on this path whose tool the endpoint dropped, while the persona still tells it to call
 * `calculate`, writes "Calling `calculate`" as prose.
 */
export function answersNativeFirst(modelId: string): boolean {
	return rolesNeedFlattening(modelId);
}

/**
 * Whether this turn offers `calculate`. Needs the model's config declaring tool support, because a
 * model that does not do tool calls either ignores the tool or answers with a malformed one. A model
 * that declares no tool support is logged once per model rather than silently skipped.
 */
export function calculateToolOffered(model: { id?: string; name?: string; supportsTools?: boolean }): boolean {
	const id = model.id ?? model.name ?? "unknown";
	if (model.supportsTools) {
		if (!answersNativeFirst(id)) return true;
		if (!warnedNativeFirst.has(id)) {
			warnedNativeFirst.add(id);
			logger.warn(
				{ leg: "calculate-tool", model: id },
				"[calculate] this model's answer goes out native-first, which cannot run the tool loop; the tool and the persona's calculate paragraph are both withheld"
			);
		}
		return false;
	}
	if (!warnedWithoutTools.has(id)) {
		warnedWithoutTools.add(id);
		logger.warn(
			{ leg: "calculate-tool", model: id },
			"[calculate] this model's config does not set supportsTools; the tool is not offered"
		);
	}
	return false;
}

/** Tool rounds before the model has to answer without the tool. Each round is one more request, so the
 *  cap bounds the turn's latency; three leaves room for a multi-step question. */
export const MAX_CALCULATE_ROUNDS = 3;

export const CALCULATE_TOOL_NAME = "calculate";

// Same name, description and parameter as the evaluation harness's tool, except the clock-time
// sentence in the parameter's description.
const CALCULATE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
	type: "function",
	function: {
		name: CALCULATE_TOOL_NAME,
		description: "Evaluate an arithmetic expression exactly and return the result.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["expression"],
			properties: {
				expression: {
					type: "string",
					// Without the clock-time form named here, a model sends minutes since midnight for an
					// arrival time, and the note's "= 1480" matches nothing in the answer. The functions are
					// named with a cap's form so a capped benefit takes one call instead of a round per step.
					description:
						"The arithmetic expression, using numbers, + - * / ^, parentheses and the functions min, max, round, floor, ceil, abs, sqrt and pow. Apply a cap as min(amount, cap) and a floor as max(amount, floor), as in min(1840 * 0.65, 1150) + 2 * 42. To add or subtract clock times or durations, write them as H:MM terms, as in 23:35 + 1:05, and the result comes back as a time.",
				},
			},
		},
	},
};

// On the native turn, "12 people, 3 at 0.5 FTE, two full-timers drop to 0.5" is easy to write as
// (9 * 1) + (3 * 0.5) + (2 * 0.5), which leaves the two movers in the full-time count. On native
// turns the tool requires each group's size after every change before the expression, for a model
// whose harness row asks for it (`calculateCounts`). Whether it helps depends on the model and on
// whether past calls are replayed in the request (harnessProfiles.ts). The evaluator reads
// `expression` alone.
const CALCULATE_COUNTS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
	type: "function",
	function: {
		...CALCULATE_TOOL.function,
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["counts", "expression"],
			properties: {
				counts: {
					type: "string",
					description:
						"Before the expression: each group the numbers come from and how many are in it once every change in the message has happened, one per line, as label: number. Something that moves from one group to another counts in the new group only.",
				},
				...(CALCULATE_TOOL.function.parameters as { properties: Record<string, unknown> }).properties,
			},
		},
	},
};

/** The calculate definition a native turn offers a model whose row sets `calculateCounts`. */
export const CALCULATE_COUNTS_DEFINITIONS: NativeToolKit["definitions"] = [
	CALCULATE_COUNTS_TOOL as NativeToolKit["definitions"][number],
];

/** One evaluated call, as the UI shows it. Exactly one of `result` and `error` is set. `counts` is the
 *  group list a model offered CALCULATE_COUNTS_TOOL wrote, kept so withPastCalculations can replay it. */
type Calculation = { expression: string; result?: string; error?: string; counts?: string };

/** A group list is a few short lines; past this it is the model writing prose into the field. */
const MAX_COUNTS_CHARS = 500;

/** Readable, exact enough, and the same string the model and the visitor both see. Twelve significant
 *  digits drops float noise (0.1 + 0.2) without losing anything a person would type. An exact integer
 *  carries no float noise, so it is returned whole: rounding 2^43 to twelve digits would give
 *  8796093022210. Past 2^53 a float is no longer exact, so an integer-only expression is worked in
 *  BigInt; as a float, 987654321 * 123456789 comes out as 121932631113000000. A value at or past 10^12
 *  that still has no exact form says it is rounded, so it never reads as an exact whole number. */
function formatResult(value: number, expression: string): string {
	// First, since a safe result can still come from an inexact step: 2^53 + 1 - 2^53 is 0 as floats.
	const exact = evaluateExactInteger(expression);
	if (exact !== null) return exact.toString();
	if (Number.isSafeInteger(value)) return String(value);
	if (Math.abs(value) >= 1e12) return `about ${value.toPrecision(12)} (rounded to 12 significant digits)`;
	return String(Number(value.toPrecision(12)));
}

/**
 * Evaluates one call. Never throws: anything wrong comes back as `error`, which the model reads as the
 * tool's answer and can correct. A malformed call must not end the turn.
 */
export function runCalculate(call: StreamedToolCall): Calculation {
	let expression = "";
	let counts = "";
	try {
		const args = JSON.parse(call.arguments || "{}") as { expression?: unknown; counts?: unknown };
		if (typeof args?.expression === "string") expression = args.expression.trim();
		if (typeof args?.counts === "string") counts = args.counts.trim().slice(0, MAX_COUNTS_CHARS);
	} catch {
		return { expression: call.arguments.slice(0, 200), error: "the arguments were not valid JSON" };
	}
	if (call.name !== CALCULATE_TOOL_NAME) {
		return { expression, error: `there is no tool named "${call.name}"; the only tool is calculate` };
	}
	if (!expression) return { expression, error: "no expression was given" };
	const withCounts = counts ? { counts } : {};
	const clock = addClockTimes(expression);
	if (clock !== null) return { expression, result: clock, ...withCounts };
	const days = daysBetween(expression);
	if (days !== null) return { expression, result: days, ...withCounts };
	const date = expression.match(DATE_TERM)?.[0];
	if (date) return { expression, error: dateError(date), ...withCounts };
	const value = evaluateArithmetic(expression);
	if (value === null) {
		return {
			expression,
			error:
				"could not evaluate this; use only numbers, + - * / ^, parentheses and min, max, round, floor, ceil, abs, sqrt or pow, with no units, words, variables or division by zero. For clock times, add or subtract H:MM terms, as in 23:35 + 1:05",
		};
	}
	return { expression, result: formatResult(value, expression), ...withCounts };
}

/**
 * A calendar date written as digits: 2026-10-28, 2026/10/28, 28/10/2026, 10-28-2026, 28.10.2026. mathjs reads
 * each one as arithmetic, so `2026-10-28 - 2026-10-26` comes back as -74 and `(2026-10-28) - (2026-10-26)` as -2.
 * Such a call is refused with a message saying what to do instead. Spaced subtraction (`2026 - 10 - 28`) is left to the evaluator.
 */
const DATE_TERM = /(?<![\d.])(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})(?![\d.])/;

/**
 * One year-first date minus another, `2026-12-21 - 2026-11-14`, each optionally in parentheses, counted
 * exactly as whole days. A model asked how many days are left sends this shape, and refusing it would
 * leave the person with a "could not be worked out" note under an answer the model counted by hand. Only
 * year-first dates qualify: 10/11/2026 is October or November depending on who wrote it, so day-first and
 * month-first dates, and any other arithmetic on a date, are still refused below.
 */
const DATE_DIFFERENCE =
	/^\(?\s*(\d{4})([-/.])(\d{1,2})\2(\d{1,2})\s*\)?\s*-\s*\(?\s*(\d{4})([-/.])(\d{1,2})\6(\d{1,2})\s*\)?$/;

function utcDay(y: string, m: string, d: string): number | null {
	const [year, month, day] = [Number(y), Number(m), Number(d)];
	const t = Date.UTC(year, month - 1, day);
	const back = new Date(t);
	// 2026-02-30 rolls over to March in Date.UTC; a date that does not exist is refused, not counted.
	if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
	return t / 86_400_000;
}

function daysBetween(expression: string): string | null {
	const m = expression.match(DATE_DIFFERENCE);
	if (!m) return null;
	const later = utcDay(m[1], m[3], m[4]);
	const earlier = utcDay(m[5], m[7], m[8]);
	if (later === null || earlier === null) return null;
	const n = later - earlier;
	return `${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
}

function dateError(date: string): string {
	return `"${date}" is a date, and calculate reads it as arithmetic (${date.replace(/[-/.]/g, (c) => ` ${c} `)}), not as a day, so any result would be wrong. To count the days between two dates, send one year-first date minus the other, as in 2026-12-21 - 2026-11-14, and calculate counts the days exactly; send no other arithmetic on a date. Otherwise use a code-running tool if this turn has one, or work it out in whole numbers: within one month subtract the days of the month (28 Oct minus 26 Oct is 28 - 26); across months add the days left in the first month to the day in the last, plus the length of any month between.`;
}

const CLOCK_TERM = /^\d{1,2}:[0-5]\d$/;
const MINUTES_PER_DAY = 24 * 60;

const hm = (minutes: number, pad: boolean): string =>
	`${String(Math.floor(minutes / 60)).padStart(pad ? 2 : 1, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * H:MM terms joined by + and -, as a model writes an arrival time ("23:35 + 1:05").
 * evaluateArithmetic refuses that form, and the retry comes back in minutes since midnight (1480),
 * which no reader can match to "12:40 AM". The result is the total as H:MM, and when it leaves
 * the day, the time of day it lands on, so a sum of durations and a clock time plus a duration both read
 * right. Anything else, a bare number among the terms included, is left to evaluateArithmetic.
 */
function addClockTimes(expression: string): string | null {
	const parts = expression.replace(/\s+/g, "").split(/([+-])/);
	if (parts.length < 3) return null;
	let total = 0;
	for (let i = 0; i < parts.length; i += 2) {
		const term = parts[i];
		if (!CLOCK_TERM.test(term)) return null;
		const [h, m] = term.split(":").map(Number);
		total += (i > 0 && parts[i - 1] === "-" ? -1 : 1) * (h * 60 + m);
	}
	const sign = total < 0 ? "-" : "";
	const sum = `${sign}${hm(Math.abs(total), false)}`;
	if (total >= 0 && total < MINUTES_PER_DAY) return sum;
	const days = Math.floor(total / MINUTES_PER_DAY);
	const timeOfDay = hm(total - days * MINUTES_PER_DAY, true);
	const when =
		days === 1 ? "the next day" : days === -1 ? "the day before" : days > 0 ? `${days} days later` : `${-days} days before`;
	return `${sum}, which is ${timeOfDay} ${when}`;
}

/** The answer a turn ends on when the model never wrote one: each evaluated expression and its result,
 *  or nothing when no call evaluated, which leaves the turn's own "couldn't answer". */
function answerFromCalculations(calculations: readonly Calculation[]): string {
	const answered = calculations.filter((c) => c.result !== undefined);
	return answered.map((c) => `${c.expression} = ${c.result}`).join("\n\n");
}

/** What the model reads back for one call. */
function toolMessageContent(c: Calculation): string {
	return c.error !== undefined ? `error: ${c.error}` : (c.result as string);
}

type Output = TextGenerationStreamOutputSimplified;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * A later round stayed over the host's rate cap through its same-lane retries before the answer had
 * written a word. Nothing the reader saw would be spliced, so withFailover may hand the
 * transcript, tool results included, to the next lane, which continues the loop instead of rerunning
 * the tools. `cause` is the 429 itself, rethrown where there is no next lane.
 */
export class ToolRoundHandoff extends Error {
	constructor(
		readonly cause: unknown,
		readonly messages: ChatMessage[],
		readonly round: number
	) {
		super("tool round rate-limited before any answer text; handing the transcript to the next lane");
	}

	/** The 429's own status, so a lane with no next lane to catch this (a single-lane model reaches the
	 *  route unwrapped) still ends on the busy copy every other over-cap turn gets. */
	get status(): unknown {
		return (this.cause as { status?: unknown } | null)?.status;
	}
}

/**
 * Earlier answers' calculate calls, back in the history as the calls and results they were.
 * Without them a follow-up sees only the prose total and rebuilds the groups: on "one more full-time
 * student joins", the 7 full-time equivalents can be counted as 7 full-timers. `messages` and `mapped` line up one to one, as prepareMessagesWithFiles
 * returns them. Only failed calls are left out, since their error taught the earlier turn nothing the
 * next one needs. A call's `counts` goes back with it: when the first turn wrote "8 + (2 * 0.5)",
 * the expression alone does not say which student switched groups, and the group list does.
 */
export function withPastCalculations(
	messages: readonly { from: string; calculations?: Calculation[] }[],
	mapped: ChatMessage[]
): ChatMessage[] {
	return mapped.flatMap((m, i): ChatMessage[] => {
		const source = messages[i];
		const calcs =
			source?.from === "assistant"
				? (source.calculations ?? []).filter((c) => c.result !== undefined)
				: [];
		if (!calcs.length) return [m];
		// Mistral takes only 9-character [a-zA-Z0-9] ids.
		const ids = calcs.map((_, j) => `p${String(i % 1e5).padStart(5, "0")}${String(j % 1e3).padStart(3, "0")}`);
		return [
			{
				role: "assistant",
				content: null,
				tool_calls: calcs.map((c, j) => ({
					id: ids[j],
					type: "function" as const,
					function: {
						name: CALCULATE_TOOL_NAME,
						arguments: JSON.stringify(c.counts ? { counts: c.counts, expression: c.expression } : { expression: c.expression }),
					},
				})),
			},
			...calcs.map((c, j) => ({ role: "tool" as const, tool_call_id: ids[j], content: c.result as string })),
			m,
		];
	});
}

/** "auto", "none" and "required" as the API spells them, or one named tool the round must call. */
export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

/** The choice sent for `gatewayId`: a named tool becomes "required" for a model that ignores one. */
export function wireToolChoice(choice: ToolChoice, gatewayId: string | undefined): ToolChoice {
	return typeof choice === "object" && catalogByGatewayId(gatewayId)?.namedToolChoice === false ? "required" : choice;
}

/** The scaffolded harness's one tool: calculate, evaluated by code. */
export const CALCULATE_KIT: NativeToolKit = {
	label: "calculate",
	definitions: [CALCULATE_TOOL as NativeToolKit["definitions"][number]],
	run: async (call) => {
		const calculation = runCalculate(call);
		return { content: toolMessageContent(calculation), calculation };
	},
};

/**
 * Runs the answer as a tool loop over a kit (the native harness offers web search, catalog
 * search and calculate; the scaffolded harness offers calculate alone). `attempt` sends one request with
 * the tools offered and returns its transformed stream; `toolChoice` is "auto" for the first MAX rounds
 * and "none" after, so the last request has to answer in words. The tools stay in the request on that
 * round because some hosts reject a transcript carrying tool calls when no tools are declared.
 *
 * The first request goes out before this returns, so a lane that fails to connect throws from the
 * endpoint call exactly as it does without tools, and withFailover sees the same error. Calls in one round run concurrently, or in order for a `sequential` kit; each round's sources reach the UI before
 * the next request goes out, so the source cards are on screen while the model writes from them.
 *
 * Later rounds go out after the lane has committed, so withFailover never sees their errors. They retry
 * here instead, on the same lane under TOOL_ROUND_RETRY and inside `retry.deadlineAt`; moving
 * to another model mid-answer would splice two models' text into one reply. Nor does withFailover's hedge
 * see them, so a later round hedges here, on the same lane, when `retry.hedgeAfterMs` is set.
 */
export async function withToolLoop(opts: {
	messages: ChatMessage[];
	/** `signal`, when given, is this request's own: a hedged round cuts the loser without cutting the turn. */
	attempt: (
		messages: ChatMessage[],
		toolChoice: ToolChoice,
		signal?: AbortSignal
	) => Promise<AsyncGenerator<Output, void, void>>;
	kit: NativeToolKit;
	maxRounds?: number;
	now?: () => number;
	/** How a later round retries: the turn's deadline and cancel signal, plus test seams. */
	retry?: ToolRoundRetry;
	/** The round `messages` already reached, when this lane continues another lane's loop. */
	resumeRound?: number;
}): Promise<AsyncGenerator<Output, void, void>> {
	const maxRounds = opts.maxRounds ?? MAX_CALCULATE_ROUNDS;
	const now = opts.now ?? Date.now;
	const startRound = opts.resumeRound ?? 0;
	// A resumed loop already ran its first round's tool, so it is never forced to call one again.
	const firstChoice: ToolChoice =
		startRound >= maxRounds
			? "none"
			: opts.kit.firstRoundTool && startRound === 0
				? { type: "function", function: { name: opts.kit.firstRoundTool } }
				: "auto";
	// Calls the server runs before round 1 stand in for a round the model already made, so the
	// first request is the loop's second and goes out on "auto" once their results are in the transcript.
	const first =
		opts.kit.firstRoundCalls?.length && startRound === 0 && typeof firstChoice === "string" && firstChoice === "auto"
			? serverRound(opts.kit.firstRoundCalls)
			: await opts.attempt(closingRound(opts.messages, firstChoice), firstChoice);
	return loop(
		first,
		opts.messages,
		opts.attempt,
		opts.kit,
		maxRounds,
		now,
		opts.retry ?? {},
		startRound,
		typeof firstChoice === "object"
	);
}

/** A round the server made for the model: it calls these tools and writes nothing. */
async function* serverRound(calls: StreamedToolCall[]): AsyncGenerator<Output, void, void> {
	yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null, details: null, toolCalls: calls };
}

// A round forced to call a tool can still write first: Mistral Large 4 can write a whole answer and
// then call web_search, so the reader would get that answer and then the searched one. The forced
// round's text is held, and dropped when the round ends in its call. It is released to stream once
// it passes either bound, so a runaway round still reaches the loop-cut. The time bound stays well
// under the page's 8 s silence watchdog (+page.svelte FIRST_TOKEN_TIMEOUT_MS), which nothing re-arms
// during the hold.
const FORCED_ROUND_HOLD_MS = 4_000;
const FORCED_ROUND_HOLD_CHARS = 1_500;

type ToolRoundRetry = {
	deadlineAt?: number;
	/** When the loop stops offering tools: the next round is the closing one. Omitted: no
	 *  time limit, only `maxRounds`. */
	answerBy?: number;
	signal?: AbortSignal;
	policy?: RetryPolicy;
	/** How long a later round's request may go without response headers before a second one goes out
	 *  alongside it, on the same lane. Null or omitted: no hedge, the one request waits for the turn's cap. */
	hedgeAfterMs?: number | null;
	/** Defaults to the module-wide bucket. Tests pass their own so one case cannot drain another's. */
	throttle?: HedgeThrottle;
	/** What the round lines name besides the round: the model and the host the request went to. */
	log?: { model?: string; lane?: string };
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
};

// `tool_choice: "none"` alone does not end the searching: given three rounds of results that
// do not answer the question, a model can keep searching in its text, writing `⟦web_search⟧{query=…}`
// until max_tokens. A closing message last in the request makes it answer from the results and say what
// they did not cover. It goes as a user turn because some chat templates refuse a system message
// anywhere but first, and it is added to the request only, never to the history a later round builds on.
const CLOSING_ROUND_MESSAGE =
	"Tool use is finished for this turn. Answer the question now from the tool results above, in prose, in the language the question was asked in. Do not call or mention a tool. If the results do not cover something, say so.";

/** The messages to send for a round: a round that may not call a tool ends on the closing message. */
function closingRound(messages: ChatMessage[], choice: ToolChoice): ChatMessage[] {
	return choice === "none" ? [...messages, { role: "user", content: CLOSING_ROUND_MESSAGE }] : messages;
}

const ROUND_BREAK = "\n\n";

/** A later round that has not reached response headers after 12 s gets a second request. A round
 *  that never reaches them would end the turn on the 45 s cap; a second request sent at 12 s still
 *  has time to answer inside it. */
export const TOOL_ROUND_HEDGE_AFTER_MS = 12_000;

/** How long a tool loop may keep calling tools before the next round must answer. The ceiling a
 *  still-working turn can stretch to is ~155 s; this leaves an answer round room inside it. */
export const TOOL_LOOP_ANSWER_BY_MS = 90_000;

// Per-instance, as failover.ts keeps its own: a broad outage stops tool-round hedges without touching round one's.
const roundHedgeThrottle = createHedgeThrottle();

/**
 * Sends one round's request; with `hedgeAfterMs` set and no headers by then, sends a second alongside
 * it on the same lane, keeps whichever reaches headers first and cuts the other (failover.ts
 * attemptLane does the same for round one). A rejection while the other is still in flight
 * is waited out; when both fail, the last error goes to withRetry, which decides as before.
 */
async function sendRound<T extends AsyncGenerator<Output, void, void>>(
	send: (signal?: AbortSignal) => Promise<T>,
	opts: { hedgeAfterMs: number | null; turnSignal?: AbortSignal; throttle: HedgeThrottle; onHedge: () => void }
): Promise<T> {
	if (opts.hedgeAfterMs === null) return send();
	type Settled = { id: number; ok: true; value: T } | { id: number; ok: false; error: unknown };
	const controllers = new Map<number, AbortController>();
	const live = new Map<number, Promise<Settled>>();
	let started = 0;
	let lastError: unknown;
	const start = () => {
		const id = started++;
		const controller = new AbortController();
		// A listener attached after the abort never fires, so an already-cancelled turn cuts the attempt here.
		if (opts.turnSignal?.aborted) controller.abort();
		else opts.turnSignal?.addEventListener("abort", () => controller.abort(), { once: true });
		controllers.set(id, controller);
		live.set(
			id,
			send(controller.signal).then(
				(value): Settled => ({ id, ok: true, value }),
				(error): Settled => ({ id, ok: false, error })
			)
		);
	};
	start();
	while (live.size > 0) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick =
			started < 2 && opts.throttle.allows()
				? new Promise<"hedge">((resolve) => {
						timer = setTimeout(() => resolve("hedge"), opts.hedgeAfterMs ?? 0);
					})
				: null;
		let raced: Settled | "hedge";
		try {
			raced = await Promise.race<Settled | "hedge">([...live.values(), ...(tick ? [tick] : [])]);
		} finally {
			clearTimeout(timer);
		}
		if (raced === "hedge") {
			opts.onHedge();
			start();
			continue;
		}
		live.delete(raced.id);
		if (raced.ok) {
			opts.throttle.record(true);
			for (const [id, controller] of controllers) if (id !== raced.id) controller.abort();
			// A loser that reaches its headers after the cut is closed, never read.
			for (const pending of live.values())
				void pending.then((loser) => {
					if (loser.ok) void loser.value.return(undefined).catch(() => {});
				});
			return raced.value;
		}
		opts.throttle.record(false);
		lastError = raced.error;
	}
	throw lastError;
}

async function* loop(
	first: AsyncGenerator<Output, void, void>,
	initial: ChatMessage[],
	attempt: (m: ChatMessage[], c: ToolChoice, signal?: AbortSignal) => Promise<AsyncGenerator<Output, void, void>>,
	kit: NativeToolKit,
	maxRounds: number,
	now: () => number,
	retry: ToolRoundRetry,
	startRound = 0,
	holdFirstRound = false
): AsyncGenerator<Output, void, void> {
	let messages = initial;
	let stream = first;
	let round = startRound;
	// Text streamed by rounds that ended in a tool call. It already reached the reader, so the final
	// generated_text carries it too, or the persisted answer would drop what was on screen.
	let before = "";
	// The round after the cap may run its calls once more when nothing has been written yet,
	// and the last results evaluated are what an answer can still be built from.
	let rescued = false;
	// Whether the round being read was asked to answer without tools: past the round cap, or past
	// `retry.answerBy`.
	let closing = round >= maxRounds;
	// Cleared when a forced first round fails and is asked again unforced.
	let holding = holdFirstRound;
	let lastCalculations: Calculation[] = [];
	for (;;) {
		let roundText = "";
		let calls: StreamedToolCall[] | undefined;
		// Without a break, a round that ends on "mudança." and calls a tool runs straight into the next
		// round's "Confirmação", on screen and in the stored answer. The break goes in only where neither
		// side already has whitespace, judged on the visible text: reasoning is not what the reader sees.
		const shown = before.replace(/<think>[\s\S]*?<\/think>/g, "");
		let joinPending = shown !== "" && !/\s$/.test(shown);
		// The forced round's output, held until it calls its tool or passes a bound.
		let held: Output[] | null = holding && round === startRound ? [] : null;
		let heldChars = 0;
		const holdStarted = now();
		try {
		for await (const out of stream) {
			if (out.toolCalls) {
				calls = out.toolCalls;
				continue;
			}
			if (held) {
				const final = out.generated_text !== null && out.generated_text !== undefined;
				if (!final) {
					held.push(out);
					if (!out.token.special) {
						roundText += out.token.text;
						heldChars += out.token.text.length;
					}
				}
				if (!final && heldChars <= FORCED_ROUND_HOLD_CHARS && now() - holdStarted <= FORCED_ROUND_HOLD_MS) continue;
				yield* held;
				held = null;
				if (!final) continue;
			}
			if (out.generated_text !== null && out.generated_text !== undefined) {
				yield { ...out, generated_text: before + out.generated_text };
				continue;
			}
			if (!out.token.special && out.token.text !== "") {
				if (joinPending && !/^\s/.test(out.token.text)) {
					before += ROUND_BREAK;
					yield { ...out, token: { ...out.token, text: ROUND_BREAK } };
				}
				joinPending = false;
			}
			if (!out.token.special) roundText += out.token.text;
			yield out;
		}
		} catch (error) {
			// Mistral Medium 3.5, forced to web_search, can loop on its own answer instead of calling the
			// tool and end the stream on finish_reason "error". Nothing of the forced round reached the
			// reader while it was held, so the round is asked once more with the choice left to the model,
			// which answers the same question cleanly. The turn's own cancel and a 429 keep their paths.
			if (held === null || retry.signal?.aborted || isRateLimited(error)) throw error;
			logger.warn(
				{ leg: `${kit.label}-tool`, round, chars: heldChars, ms: now() - holdStarted, status: statusOf(error), ...retry.log },
				"[native] forced round failed before any text reached the reader; asking again without forcing the tool"
			);
			holding = false;
			stream = await attempt(messages, "auto");
			continue;
		}
		if (!calls) {
			if (held) yield* held;
			return;
		}
		if (held) {
			// Never shown, so it stays out of the answer; the transcript below still carries it.
			if (heldChars > 0)
				logger.info(
					{ leg: `${kit.label}-tool`, round, chars: heldChars, ms: now() - holdStarted },
					"[native] forced round's text held back: the round called its tool"
				);
		} else before += roundText;
		const written = before.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim() !== "";
		if (closing && (written || rescued)) {
			// Asked to answer without the tool and called it anyway. End the turn on what streamed rather
			// than loop: a further request is latency the reader pays for nothing.
			logger.warn(
				{ leg: `${kit.label}-tool`, round, calls: calls.length },
				"[calculate] tool called after the round cap; ending the turn on the text so far"
			);
			// With nothing written, ending on the text so far is "couldn't answer". The results
			// code already evaluated are the answer the model kept trying to reach, so they are stated.
			const fallback = written ? "" : answerFromCalculations(lastCalculations);
			if (fallback) {
				before += fallback;
				yield { token: { id: -1, text: fallback, logprob: 0, special: false }, generated_text: null, details: null };
			}
			yield {
				token: { id: -1, text: "", logprob: 0, special: true },
				generated_text: before,
				details: null,
			};
			return;
		}
		if (closing) {
			// Calls made after the cap with nothing written: run the calls once more and ask
			// again for the answer, rather than end the turn empty.
			rescued = true;
			logger.warn(
				{ leg: `${kit.label}-tool`, round, calls: calls.length },
				"[calculate] tool called after the round cap with nothing written; running it once more"
			);
		}
		round++;
		const started = now();
		// Before the tools run, since a search is the slow part of the round and the reader waits on it.
		const toolRetrieval = kit.retrievalOf?.(calls);
		if (toolRetrieval)
			yield {
				token: { id: -1, text: "", logprob: 0, special: true },
				generated_text: null,
				details: null,
				toolRetrieval,
			};
		// A tool that may change something waits here for the person's yes, before any call runs.
		if (kit.beforeRun) {
			for await (const frame of kit.beforeRun(calls)) {
				yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null, details: null, ...frame };
			}
		}
		// A kit whose tools share state runs them in order, so a read sees the write the model put before it.
		const searchStarted = now();
		const running = kit.sequential
			? (async () => {
					const out: NativeToolResult[] = [];
					for (const c of calls) out.push(await kit.run(c));
					return out;
				})()
			: Promise.all(calls.map((c) => kit.run(c)));
		// What a call shows while it runs (a sandbox waiting for a slot) reaches the live line now.
		if (kit.frames) {
			for await (const frame of framesWhile(running, kit.frames)) {
				yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null, details: null, ...frame };
			}
		}
		const results = await running;
		// The tools' own run, apart from the second request below: ms is the sum of the two.
		const searchMs = now() - searchStarted;
		const mcpCalls = results.flatMap((r) => (r.mcpCall ? [r.mcpCall] : []));
		if (mcpCalls.length > 0)
			yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null, details: null, mcpCalls };
		const calculations = results.flatMap((r) => (r.calculation ? [r.calculation] : []));
		if (calculations.length > 0) lastCalculations = calculations;
		messages = [
			...messages,
			{
				role: "assistant",
				// What the round said, without its reasoning: the model thought that, it did not say it.
				content: roundText.replace(/<think>[\s\S]*?<\/think>/g, ""),
				tool_calls: calls.map((c) => ({
					id: c.id,
					type: "function" as const,
					function: { name: c.name, arguments: c.arguments },
				})),
			},
			...calls.map(
				(c, i): ChatMessage => ({
					role: "tool",
					tool_call_id: c.id,
					content: results[i].content,
				})
			),
		];
		// Shown before the next request goes out, so the expression is on screen while the model writes.
		if (calculations.length > 0)
			yield {
				token: { id: -1, text: "", logprob: 0, special: true },
				generated_text: null,
				details: null,
				calculations,
			};
		// Each result carries the turn's sources so far, so the last one that has any is the whole set.
		const webSearch = results.findLast((r) => r.webSearch)?.webSearch;
		const rag = results.findLast((r) => r.rag)?.rag;
		// A search in this round that did not finish, unless the turn has web sources anyway.
		const searchFailed = webSearch ? undefined : results.find((r) => r.searchFailed)?.searchFailed;
		// A search in this round that finished and found nothing, unless the turn has web sources anyway or
		// another search of the round did not finish (the unfinished note is the stronger claim).
		const searchEmpty = webSearch || searchFailed ? undefined : results.some((r) => r.searchEmpty) || undefined;
		if (webSearch || rag || searchFailed || searchEmpty)
			yield {
				token: { id: -1, text: "", logprob: 0, special: true },
				generated_text: null,
				details: null,
				toolSources: {
					...(webSearch ? { webSearch } : {}),
					...(rag ? { rag } : {}),
					...(searchFailed ? { searchFailed } : {}),
					...(searchEmpty ? { searchEmpty } : {}),
				},
			};
		// A model can keep searching until the turn runs into its ceiling with no answer. Past
		// `answerBy`, the next round answers from what it has.
		const outOfTime = retry.answerBy !== undefined && now() >= retry.answerBy;
		if (outOfTime && round < maxRounds)
			logger.info(
				{ leg: `${kit.label}-tool`, round, ...retry.log },
				`[${kit.label}] tool loop out of time; asking for the answer now`
			);
		const choice: ToolChoice = round < maxRounds && !outOfTime ? "auto" : "none";
		closing = choice === "none";
		let retries = 0;
		let hedged = 0;
		const nextStarted = now();
		// Logged before the request, so a round that never answers still says where it waited.
		logger.info(
			{ leg: `${kit.label}-tool`, round, searchMs, ...retry.log },
			`[${kit.label}] round request sent`
		);
		try {
			const hedgeAfterMs = retry.hedgeAfterMs ?? null;
			stream = await withRetry(
				() =>
					sendRound((signal) => attempt(closingRound(messages, choice), choice, signal), {
						hedgeAfterMs,
						turnSignal: retry.signal,
						throttle: retry.throttle ?? roundHedgeThrottle,
						onHedge: () => {
							hedged++;
							logger.info(
								{ leg: `${kit.label}-tool`, round, hedgeAfterMs, elapsedMs: now() - nextStarted, ...retry.log },
								`[${kit.label}] round request has no headers yet; sending a second alongside it on the same lane`
							);
						},
					}),
				{
				policy: retry.policy ?? TOOL_ROUND_RETRY,
				deadlineAt: retry.deadlineAt,
				signal: retry.signal,
				now,
				sleep: retry.sleep,
				random: retry.random,
				onRetry: ({ delayMs, hostAsked, status }) => {
					retries++;
					logger.warn(
						{ leg: `${kit.label}-tool`, round, retry: retries, status, delayMs, hostAsked },
						`[${kit.label}] round request failed; retrying on the same lane`
					);
				},
			});
		} catch (error) {
			// Logged for a round that fails or stalls. `aborted` is the turn's own cancel or cap.
			logger.warn(
				{
					leg: `${kit.label}-tool`,
					round,
					elapsedMs: now() - nextStarted,
					searchMs,
					retries,
					hedged,
					status: statusOf(error),
					// The host's error text, so a 402's reason is in the log and not only its status.
					upstream: upstreamErrorText(error),
					aborted: retry.signal?.aborted === true,
					...retry.log,
				},
				`[${kit.label}] round request failed`
			);
			// Still over the cap after the retries. With no answer text on screen yet, the next
			// lane can pick the transcript up; with some, it would splice two models' answers, so it ends here.
			if (isRateLimited(error) && before.trim() === "") {
				logger.warn(
					{ leg: `${kit.label}-tool`, round, retries },
					`[${kit.label}] round still rate-limited after retries, before any answer text; handing off`
				);
				throw new ToolRoundHandoff(error, messages, round);
			}
			throw error;
		}
		// Evaluation is microseconds; the cost of a round is the second request reaching its headers.
		const nextRequestMs = now() - nextStarted;
		const ms = now() - started;
		logger.info(
			{
				leg: `${kit.label}-tool`,
				round,
				ms,
				searchMs,
				nextRequestMs,
				calls: calls.length,
				retries,
				hedged,
				...retry.log,
				tools: calls.map((c) => c.name).join(","),
				errors: calculations.filter((c) => c.error !== undefined).length,
			},
			`[${kit.label}] round`
		);
		yield {
			token: { id: -1, text: "", logprob: 0, special: true },
			generated_text: null,
			details: null,
			calculateToolMs: ms,
			toolRunMs: searchMs,
		};
	}
}
