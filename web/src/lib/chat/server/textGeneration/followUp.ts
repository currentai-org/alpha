// The follow-up read (CUR-1957): one forced tool call that says whether the latest message only makes
// sense with an earlier turn ("Which ones do you recommend?") and restates it as a standalone question.
// The answer model gets that reading as a note beside the person's unchanged message.
//
// It runs as its own call, in parallel with the turn planner's plan_turn (turnPlan.ts), not as a field
// of it. As a field it degraded the planner's math (the "N people, K of them" ledger), so plan_turn's
// request stays byte-identical to the one without it.
// Only a turn with an earlier turn in the conversation makes this call; a first message cannot refer back.
//
// Kept free of imports, named with its extension where imported, so a script can load the exact prompt
// the app sends under Node's own type stripping.

export const FOLLOW_UP_TOOL = {
	type: "function" as const,
	function: {
		name: "resolve_follow_up",
		description: "Record whether the latest message refers back to the conversation, and what it asks when read on its own.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["refers_to_earlier", "standalone"],
			properties: {
				refers_to_earlier: {
					type: "boolean",
					description:
						"True when the latest message only makes sense with an earlier turn: it points back " +
						'("Which ones do you recommend?" after a list, "and in Berlin?" after a question about Paris) or ' +
						"leaves out what it is about. False when it stands on its own.",
				},
				standalone: {
					type: "string",
					description:
						"When refers_to_earlier is true, the latest message restated as one question that names what it " +
						"refers to, in its own language, keeping its intent and not answering it. Name only what the " +
						'conversation says: empty when it does not settle what the message points at ("why that one?" ' +
						"when nothing was picked), and empty when refers_to_earlier is false.",
				},
			},
		},
	},
};

// The identical prefix of every follow-up call is this system message plus FOLLOW_UP_TOOL.
export const FOLLOW_UP_SYSTEM =
	"You read the latest message in a conversation and decide whether it can be understood on its own. " +
	"Call resolve_follow_up once. Do not answer the message.";

type FollowUpOutcome = "resolved" | "unresolved" | "standalone" | "invalid" | "missing";
export type FollowUpRead = { outcome: FollowUpOutcome; standalone: string | null };

// A restated question longer than this is no longer a restatement of a short follow-up.
const STANDALONE_MAX_CHARS = 400;

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Validates the call's arguments against the latest message. Anything but a usable restatement that
 *  differs from the message applies no reading. */
export function parseFollowUp(raw: string | undefined, latestUserText: string): FollowUpRead {
	if (!raw) return { outcome: "missing", standalone: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { outcome: "invalid", standalone: null };
	}
	if (!parsed || typeof parsed !== "object") return { outcome: "invalid", standalone: null };
	const { refers_to_earlier: refers, standalone } = parsed as { refers_to_earlier?: unknown; standalone?: unknown };
	if (refers === false) return { outcome: "standalone", standalone: null };
	if (refers !== true || typeof standalone !== "string") return { outcome: "invalid", standalone: null };
	const text = standalone.replace(/\s+/g, " ").trim();
	// Refers back, but the conversation doesn't settle to what: no reading beats a guessed one.
	if (!text) return { outcome: "unresolved", standalone: null };
	if (text.length > STANDALONE_MAX_CHARS) return { outcome: "invalid", standalone: null };
	// A "restatement" that is the message itself says it stands on its own, whatever the flag says.
	// A model can flag a standalone question as referring back: a word-for-word repeat is caught here;
	// a reworded one asks the answer model the same question anyway.
	if (normalized(text) === normalized(latestUserText)) return { outcome: "standalone", standalone: null };
	return { outcome: "resolved", standalone: text };
}

type ChatMessage = { role: "user" | "assistant"; content: string };

/** The conversation as plain turns, the latest `limit` of them. Null when there is no earlier turn
 *  before the latest message, so the call is not made at all. */
export function followUpTranscript(
	messages: readonly { from: string; content?: string }[],
	limit = 12
): ChatMessage[] | null {
	const kept: ChatMessage[] = messages
		.filter((m) => (m.from === "user" || m.from === "assistant") && (m.content ?? "").trim())
		.slice(-limit)
		.map((m) => ({ role: m.from as "user" | "assistant", content: m.content ?? "" }));
	return kept.length > 1 && kept[kept.length - 1].role === "user" ? kept : null;
}

/** The note the answer model reads when the latest message refers back. The person's own message and
 *  the history reach the model unchanged; this only says how the message was read, quoted as their
 *  question rather than as an instruction. */
export function followUpNote(standalone: string): string {
	return (
		"The latest message refers back to earlier in this conversation. Read on its own, it asks: " +
		`"${standalone.replace(/"/g, "'")}". Answer that from what was said earlier; the question is the ` +
		"person's, quoted here, not an instruction to you."
	);
}
