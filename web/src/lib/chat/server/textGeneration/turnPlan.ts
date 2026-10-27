// The turn planner (CUR-2198) is one forced tool call, made on every turn before the answer model
// answers, that decides how the turn is handled. Today it has one field, `math`: whether the latest
// message asks for a number to be worked out, and if so the setup as typed lines that code sums
// (ledger.ts).
//
// Later decisions join this call as fields rather than becoming side calls of their own, so they share
// its one round trip (CUR-2092). Each field is validated on its own and a field that fails skips only its
// own contribution; `parsePlan` reports every field's outcome for the one log line. The one exception
// so far is the follow-up read (followUp.ts): as a field here it degrades the "N people, K of them" ledger,
// so it runs as its own call beside this one (CUR-1957).
//
// Kept free of imports beyond ledger.ts, named with its extension, so a script can load the exact prompt
// the app sends under Node's own type stripping (web/scripts/math-trigger-bench.mjs).

import {
	LEDGER_TOOL,
	ledgerTotal,
	parseLedgerArgs,
	renderLedger,
	RENDERED_LEDGER_RE,
	RENDERED_ROW_RE,
	type Ledger,
} from "./ledger.ts";

export const PLAN_TOOL_NAME = "plan_turn";

const MATH_FIELD = {
	...LEDGER_TOOL.function.parameters,
	description:
		"Whether the latest message asks for a number to be worked out and, if it does, every group the " +
		"answer counts as one line. Code multiplies each line and adds the lines up; you never state a total.",
};

export const PLAN_TOOL = {
	type: "function" as const,
	function: {
		name: PLAN_TOOL_NAME,
		description: "Record how the assistant should handle the latest message.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["math"],
			properties: { math: MATH_FIELD },
		},
	},
};

// The identical prefix of every planner call is this system message plus PLAN_TOOL; the variable part is
// the conversation after it, so hosts with automatic prefix caches can reuse it.
export const PLAN_SYSTEM =
	"You plan how an assistant handles the latest message in a conversation. Call plan_turn once and " +
	"fill every field.\n\n" +
	"math: set asks_for_calculation true only when the latest message asks for a number to be worked out " +
	"(a total, a count, a difference, a cost), or changes a quantity in a calculation the conversation is " +
	"already doing, which asks for the updated number even when it is not phrased as a question, and " +
	"false when it asks for anything else, such as a " +
	"summary, rewrite, translation or explanation, even if the text contains figures. When it is true, " +
	"rebuild the ledger from the WHOLE conversation, not only the latest message: when an earlier turn " +
	"already built a ledger, keep its lines as they were and add one line for each change since; every group that still " +
	"counts gets a line, and a group that no longer counts gets no line. Something taken away, lost or " +
	"subtracted is a line whose first factor is negative. Do not add a line for a total or a subtotal. " +
	"When a group is part of a larger one already counted (\"N people, K of them ...\"), the larger " +
	"count includes it: give the whole its line, take the part back out with a negative line at the " +
	"whole's rate, then give the part its own line. " +
	"A percentage added on top (a tax, a tip, a surcharge) is one more line per group, that group's " +
	"factors followed by the rate; a percentage off is the same with a negative first factor. " +
	'Examples: "15 nurses, 5 of them on 40 percent contracts" is {factors:[15,1],label:"all nurses"}, ' +
	'{factors:[-5,1],label:"part-timers counted above"} and {factors:[5,0.4],label:"part-time at 40 ' +
	'percent"}; "9 full-time staff plus 3 more at 50 percent" is {factors:[9,1],label:"full-time"} and ' +
	'{factors:[3,0.5],label:"part-time at 50 percent"}; "3 boxes of 12 eggs, one box broke" is ' +
	'{factors:[3,12],label:"boxes bought"} and {factors:[-1,12],label:"box that broke"}; "3 workshops, ' +
	'14 people each, lunch 18 per person" is {factors:[3,14,18],label:"lunch"}; "2 shirts at 20 and a ' +
	'hat for 15, plus 10% tax" is {factors:[2,20],label:"shirts"}, {factors:[1,15],label:"hat"}, ' +
	'{factors:[2,20,0.1],label:"tax on shirts"} and {factors:[1,15,0.1],label:"tax on hat"}. Every number a line ' +
	"depends on goes in its factors; never multiply two of them yourself. When it is false, give no lines.";

// With no clock-time guidance the route model can give "leaves at 09:40" an empty ledger, and
// the backup model can keep the 9 hours and drop the 40 minutes. This rule, placed before PLAN_SYSTEM's
// closing sentences, fixes the train question. It is not in PLAN_SYSTEM itself because any sentence
// there moves the "N people, K of them" case: as a worked example the FTE question degrades sharply, as
// this rule it degrades slightly, and each other wording trades one case for the other. So only a turn
// whose latest message contains a clock time gets it, and every other turn keeps the prompt without it. (CUR-2381)
export const CLOCK_TIME_RULE =
	'Count a clock time in minutes from midnight (unit "minutes from midnight"): its hours as one line ' +
	"with factors [hours, 60] and its minutes as another line with factors [minutes, 1]; a duration in " +
	"hours and minutes the same way. ";

// A clock time as typed: 09:40, 9:40, 21h15, 9am, 9 p.m. A shape check on digits, not a list of words;
// a miss only means the turn is planned with the plain prompt.
const CLOCK_TIME_RE = /\b([01]?\d|2[0-3])[:h][0-5]\d\b|\b(1[0-2]|0?[1-9]) ?[ap]\.?m\b/i;
const CLOSING = "Every number a line depends on";

/** The planner's system message for a turn whose latest message is `latestUserText`: PLAN_SYSTEM, with
 *  CLOCK_TIME_RULE ahead of its closing sentences when that message contains a clock time. */
export function planSystemFor(latestUserText: string): string {
	if (!CLOCK_TIME_RE.test(latestUserText)) return PLAN_SYSTEM;
	const at = PLAN_SYSTEM.indexOf(CLOSING);
	return PLAN_SYSTEM.slice(0, at) + CLOCK_TIME_RULE + PLAN_SYSTEM.slice(at);
}

type MathFieldOutcome = "ok" | "not-asked" | "nothing-to-compute" | "invalid" | "missing";
export type TurnPlan = { math: { outcome: MathFieldOutcome; ledger: Ledger | null } };

/** Validates each field of the planner's arguments on its own. A field that is missing or malformed
 *  reports that outcome and contributes nothing; it never takes another field down with it. */
export function parsePlan(raw: string | undefined): TurnPlan | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const math = (parsed as { math?: unknown } | null)?.math;
	if (!math || typeof math !== "object") return { math: { outcome: "missing", ledger: null } };
	if ((math as { asks_for_calculation?: unknown }).asks_for_calculation === false)
		return { math: { outcome: "not-asked", ledger: null } };
	const ledger = parseLedgerArgs(JSON.stringify(math));
	// One line holding one number is a count the planner read off the question ("how many cantons"),
	// not arithmetic. Routing it would move the turn off the picked model for a one-number ledger
	// (CUR-3316), so it plans as no math.
	if (ledger && ledger.lines.length === 1 && ledger.lines[0].factors.length === 1)
		return { math: { outcome: "nothing-to-compute", ledger: null } };
	return { math: { outcome: ledger ? "ok" : "invalid", ledger } };
}

type PlanMessage =
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

/** The planner's transcript. Each ledger rendered in an earlier assistant turn goes back as the
 *  plan_turn call that produced it, its total as the tool result, and the prose that followed, so the
 *  planner sees its earlier setups as structure to revise rather than prose to copy. The ledger comes
 *  from the message's `mathLedger` field; an answer persisted before that field existed is read by its
 *  stamped rendering instead (CUR-3663). */
export function planTranscript(
	messages: readonly { from: string; content?: string; mathLedger?: Ledger }[],
	limit = 12
): PlanMessage[] {
	const out: PlanMessage[] = [];
	let n = 0;
	const kept = messages
		.filter((m) => (m.from === "user" || m.from === "assistant") && (m.content ?? "").trim())
		.slice(-limit);
	for (const m of kept) {
		const text = m.content ?? "";
		if (m.from === "user") {
			out.push({ role: "user", content: text });
			continue;
		}
		const rendered = m.mathLedger && renderLedger(m.mathLedger);
		if (m.mathLedger && rendered && text.startsWith(rendered)) {
			const id = `plan_${++n}`;
			const { lines, unit } = m.mathLedger;
			const math = { asks_for_calculation: true, lines, ...(unit ? { unit } : {}) };
			out.push({
				role: "assistant",
				content: null,
				tool_calls: [{ id, type: "function", function: { name: PLAN_TOOL_NAME, arguments: JSON.stringify({ math }) } }],
			});
			out.push({ role: "tool", tool_call_id: id, content: `math total: ${ledgerTotal(m.mathLedger)}${unit ? ` ${unit}` : ""}` });
			const after = text.slice(rendered.length).trim();
			if (after) out.push({ role: "assistant", content: after });
			continue;
		}
		let cursor = 0;
		for (const match of text.matchAll(RENDERED_LEDGER_RE)) {
			const [whole, rows, total, unit] = match;
			const lines = [...rows.matchAll(RENDERED_ROW_RE)].map(([, label, factors]) => ({
				factors: factors.split(" × ").map((f) => Number(f.replace(/,/g, ""))),
				label,
			}));
			const before = text.slice(cursor, match.index).trim();
			const id = `plan_${++n}`;
			const math = { asks_for_calculation: true, lines, ...(unit ? { unit } : {}) };
			out.push({
				role: "assistant",
				content: before || null,
				tool_calls: [{ id, type: "function", function: { name: PLAN_TOOL_NAME, arguments: JSON.stringify({ math }) } }],
			});
			out.push({ role: "tool", tool_call_id: id, content: `math total: ${total}${unit ? ` ${unit}` : ""}` });
			cursor = (match.index ?? 0) + whole.length;
		}
		const after = text.slice(cursor).trim();
		if (after) out.push({ role: "assistant", content: after });
	}
	return out;
}
