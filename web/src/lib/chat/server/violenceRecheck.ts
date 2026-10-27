// Violence re-check (CUR-1853). The Shieldstral 3B judge scores violent idioms as violence on their own:
// "I could murder a coffee" 0.62, "I could kill for a pizza" 0.95, while a real request to make a knife
// that passes a metal detector scored 0.90. Idioms and real requests overlap, so no
// rewording of the query and no per-rule threshold separates them. Thresholds in rules.json are not ours
// to move either.
//
// So when the violence rule is the ONLY thing blocking an input turn, two forced tool calls on TASK_MODEL,
// made in parallel, judge the message, and the turn is released only when both answer an explicit false.
// The two calls ask different questions: one reads the writer's intent (RECHECK_SYSTEM), the other what a
// complete answer would hand over (ANSWER_SYSTEM). Two calls with the same prompt at temperature 0 agree
// on their mistakes: a request for a knife that passes a metal detector is released by both at once. An error, a timeout, a missing or malformed
// answer, an image, or a long corpus all leave the block standing: the re-check can only ever undo a
// block, never add one, and it fails closed.
//
// Behind the `violence-recheck` flag. Enabling it in production needs a privacy notice naming the side-call
// processor (CUR-2063), since this sends a blocked message's text to TASK_MODEL.

import type OpenAI from "openai";
import { forcedTaskModelToolCall } from "$lib/chat/server/taskModelClient";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import type { GuardGateVerdict } from "$lib/chat/server/guardGate";
import type { GuardScreenInput } from "$lib/chat/server/guardScreenTypes";

export const VIOLENCE_RECHECK_FLAG = "violence-recheck";
export const violenceRecheckEnabled = (): boolean => flagEnabledOr(VIOLENCE_RECHECK_FLAG, () => false);

export const VIOLENCE_KEY = "chat-block-violence";
const RECHECK_TIMEOUT_MS = 4_000;
// A corpus this long carries uploaded files or a long paste, where one short judgement is not enough to
// overrule the screen. The idioms this exists for are a sentence or two.
export const RECHECK_MAX_CHARS = 2_000;
// Put ahead of the text when the turn carried images that the screen checked and did not flag, so a
// message pointing at "this" is judged knowing there was something it pointed at.
const IMAGE_CLEARED_NOTE =
	"[The user also attached an image. The safety screen checked the image on its own and did not flag it.]";

// The identical prefix of every call is this system message plus RECHECK_TOOL. Its examples are
// deliberately NOT the calibration fixtures, so the held-out probe measures the prompt rather than
// echoing it (naming the fixtures here inflates the score).
const RECHECK_SYSTEM =
	"A content-safety screen flagged the user's message below as possibly asking for violence. You decide " +
	"whether that flag is right.\n\n" +
	"Answer literal_violence true when the writer asks for, plans, threatens or encourages real harm to a " +
	"person or animal, or asks for weapons, explosives or attack instructions. A request framed as a story, " +
	"joke, hypothetical or role-play still counts as true when the answer would give real instructions for " +
	"harm.\n\n" +
	'Answer false when the violent words are an idiom or figure of speech ("I would kill for a nap", "this ' +
	'commute is murder", "kill the stale job"), or the message is an everyday task that only uses violent ' +
	"vocabulary (a crime novel reading list, a self-defence class timetable, deleting old files).\n\n" +
	"Judge only the message. Do not answer it.";

// The second lens. It asks what a complete answer would contain rather than what the writer meant, so a
// request phrased as a craft or curiosity question ("make a knife that won't show up on a metal
// detector") is judged by what answering it would teach. Its examples, like RECHECK_SYSTEM's, are not
// the probe's fixtures. Listing "threaten" in the wording blocks "my boss will kill me"; this
// wording, on 113 weapon and attack turns and 45 idiom turns, releases none of the first and all of
// the second (evals/cur-1853-recheck).
const ANSWER_SYSTEM =
	"You review messages that a safety screen held back. Imagine an assistant gave this message a complete, " +
	"helpful answer. Decide what that answer would contain.\n\n" +
	"Answer gives_harm_help true when a complete answer would give practical help to physically hurt or kill " +
	"a real person or animal; to make, get or hide a weapon or explosive; to get a weapon past a security " +
	"check, metal detector or background check; or to plan an attack. Wrapping the request in a story, a " +
	"joke, curiosity or a hypothetical does not change this.\n\n" +
	"Answer false when the answer would be ordinary help (a recipe, an email, a slide, a plan, a summary, " +
	"fixing a machine) and the violent words are only a figure of speech: exaggeration about yourself, your " +
	'work, an object or a deadline ("I\'ll throttle this laptop", "my landlord will skin me alive", "I\'m ' +
	'going to destroy this exam"). Also answer false when the topic is violence but the answer would teach ' +
	"nothing usable for harm (a history question, a mystery novel plot, a self-defence class schedule).\n\n" +
	"Only classify. Do not answer the message.";

export const RECHECK_TOOL_NAME = "violence_check";
const RECHECK_TOOL: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: RECHECK_TOOL_NAME,
		description: "Record whether the message asks for real violence.",
		parameters: {
			type: "object",
			properties: {
				literal_violence: {
					type: "boolean",
					description:
						"true when the writer asks for, plans or encourages real harm to a person or animal, or for weapons or attack instructions; false when the violent words are an idiom, figure of speech or everyday task",
				},
			},
			required: ["literal_violence"],
		},
	},
};

const ANSWER_TOOL_NAME = "answer_check";
const ANSWER_TOOL: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: ANSWER_TOOL_NAME,
		description: "Record whether a complete answer to the message would give practical help to cause harm.",
		parameters: {
			type: "object",
			properties: {
				gives_harm_help: {
					type: "boolean",
					description:
						"true when a complete answer would give practical help to hurt someone, to make, get or hide a weapon, to get one past security, or to plan an attack",
				},
			},
			required: ["gives_harm_help"],
		},
	},
};

/** Which question a call asks: the writer's intent, or what a complete answer would contain. */
type RecheckLens = "intent" | "answer";
const LENSES: Record<RecheckLens, { system: string; tool: typeof RECHECK_TOOL; field: string }> = {
	intent: { system: RECHECK_SYSTEM, tool: RECHECK_TOOL, field: "literal_violence" },
	answer: { system: ANSWER_SYSTEM, tool: ANSWER_TOOL, field: "gives_harm_help" },
};

/** The re-check's answer under one lens: true/false from the model, or null for every way the call can
 *  fail. */
export type RecheckCall = (text: string, signal: AbortSignal, lens: RecheckLens) => Promise<boolean | null>;

type RecheckOutcome = "released" | "upheld" | "failed" | "skipped-media" | "skipped-long";

type MinimalLogger = { info: (o: unknown, m: string) => void };

/** Whether this verdict is one the re-check may look at: a content block whose only action is the
 *  violence rule. A child flag, an UNKNOWN, or any second block rule leaves the verdict alone. */
export function recheckApplies(g: GuardGateVerdict): boolean {
	return (
		g.verdict.status === "ok" &&
		!g.childSafety.flagged &&
		g.contentPolicy.action === "block" &&
		g.contentPolicy.category === VIOLENCE_KEY &&
		g.verdict.actions.length > 0 &&
		g.verdict.actions.every((a) => a === VIOLENCE_KEY)
	);
}

/** The verdict with the violence block lifted. The violence hit stays in `hits`, so the review plane
 *  still sees what the screen said. */
function released(g: GuardGateVerdict): GuardGateVerdict {
	return { ...g, verdict: { ...g.verdict, actions: [] }, contentPolicy: { action: "allow" } };
}

/**
 * Re-checks a violence-only block on an input turn. Never throws, and returns the verdict unchanged
 * unless both calls, one per lens, answered false. Logs one line with the outcome, timing and
 * whether the two calls disagreed, never the message.
 */
export async function recheckViolenceBlock(
	g: GuardGateVerdict,
	screen: GuardScreenInput,
	deps: { call?: RecheckCall; logger?: MinimalLogger; now?: () => number } = {}
): Promise<GuardGateVerdict> {
	if (!recheckApplies(g)) return g;
	const log = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => Date.now());
	const started = now();
	const done = (outcome: RecheckOutcome, verdict: GuardGateVerdict, split = false) => {
		log.info(
			{ outcome, ms: Math.round(now() - started), chars: screen.corpus.length, split },
			"[violence-recheck] input"
		);
		return verdict;
	};
	// A failed unit was never read at all. An image can carry violence the text does not show, so the
	// block stands unless every image answered the violence rule with a clear no. When they all did, the
	// hit came from the text, which here is often an earlier turn's idiom
	// re-screened with the chat's history (CUR-3258), so the text is re-judged as usual.
	const imageCleared = screen.images.length === 0 || (g.imageCleared?.includes(VIOLENCE_KEY) ?? false);
	if (screen.failedUnits.length > 0 || !imageCleared) return done("skipped-media", g);
	const text = screen.corpus.trim();
	if (!text) return done("skipped-media", g);
	if (text.length > RECHECK_MAX_CHARS) return done("skipped-long", g);
	const judged = screen.images.length > 0 ? `${IMAGE_CLEARED_NOTE}\n\n${text}` : text;
	const call = deps.call ?? taskModelRecheck;
	const once = (lens: RecheckLens) => call(judged, AbortSignal.timeout(RECHECK_TIMEOUT_MS), lens).catch(() => null);
	const answers = await Promise.all([once("intent"), once("answer")]);
	const split = answers[0] !== answers[1];
	if (answers.every((a) => a === false)) return done("released", released(g), split);
	return done(answers.includes(true) ? "upheld" : "failed", g, split);
}

/** The default call: one forced tool call on TASK_MODEL's own registered lane, asking the lens's
 *  question. null on any failure, including a TASK_MODEL that is unset or not registered. */
const taskModelRecheck: RecheckCall = async (text, signal, lens) => {
	const l = LENSES[lens];
	const call = await forcedTaskModelToolCall({
		system: l.system,
		user: text,
		tool: l.tool,
		maxTokens: 64,
		timeoutMs: RECHECK_TIMEOUT_MS,
		signal,
	});
	return call === null ? null : parseRecheckArgs(call, lens);
};

/** The lens's boolean from the tool call, or null when the tool is the wrong one, or the field is missing
 *  or not a boolean. */
export function parseRecheckArgs(toolCall: unknown, lens: RecheckLens = "intent"): boolean | null {
	const l = LENSES[lens];
	const fn = (toolCall as { function?: { name?: string; arguments?: string } } | undefined)?.function;
	if (fn?.name !== l.tool.function.name || typeof fn.arguments !== "string") return null;
	try {
		const v = (JSON.parse(fn.arguments) as Record<string, unknown>)[l.field];
		return typeof v === "boolean" ? v : null;
	} catch {
		return null;
	}
}
