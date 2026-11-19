import { buildSubtree } from "$lib/chat/utils/tree/buildSubtree";
import type { Message } from "$lib/chat/types/Message";

/** One earlier turn as the panel sees it. */
export type EarlierTurn = { from: "user" | "assistant"; content: string };

// A panelist is cross-checking one answer, so it needs enough of the conversation to know what the
// question refers to ("Wer wählt den Bundesrat?" after a turn on Swiss cantons), not the whole thread.
const MAX_TURNS = 6;
const MAX_CHARS = 1500;

/**
 * The turns before `parentId` on its branch, oldest first: system messages dropped, the last
 * `MAX_TURNS` kept, each cut to `MAX_CHARS`, and opening on a user turn so roles alternate into the
 * question that follows.
 *
 * `limits` widens the window for a caller reading a whole chat rather than one answer's context:
 * Continue in a new chat takes more turns, and `throughParent` keeps `parentId` itself.
 */
export function earlierTurns(
	conversation: { messages: Message[]; rootMessageId?: Message["id"] },
	parentId: Message["id"],
	limits: { turns?: number; chars?: number; throughParent?: boolean } = {}
): EarlierTurn[] {
	const maxTurns = limits.turns ?? MAX_TURNS;
	const maxChars = limits.chars ?? MAX_CHARS;
	let path: Message[];
	try {
		path = buildSubtree(conversation, parentId);
	} catch {
		return [];
	}
	const turns = (limits.throughParent ? path : path.slice(0, -1))
		.filter((m): m is Message & EarlierTurn => (m.from === "user" || m.from === "assistant") && !!m.content?.trim())
		.map((m) => {
			const text = m.content.trim();
			return { from: m.from, content: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text };
		})
		.slice(-maxTurns);
	while (turns.length && turns[0].from !== "user") turns.shift();
	return turns;
}

/** The same turns as a text block for the aggregator's single-message input. */
export function earlierTurnsBlock(turns: EarlierTurn[]): string {
	if (!turns.length) return "";
	const lines = turns.map((t) => `${t.from === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n");
	return `EARLIER IN THE CONVERSATION (context for the question):\n${lines}\n\n`;
}
