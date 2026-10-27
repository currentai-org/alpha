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
 * question that follows (CUR-3319).
 */
export function earlierTurns(
	conversation: { messages: Message[]; rootMessageId?: Message["id"] },
	parentId: Message["id"]
): EarlierTurn[] {
	let path: Message[];
	try {
		path = buildSubtree(conversation, parentId);
	} catch {
		return [];
	}
	const turns = path
		.slice(0, -1)
		.filter((m): m is Message & EarlierTurn => (m.from === "user" || m.from === "assistant") && !!m.content?.trim())
		.map((m) => {
			const text = m.content.trim();
			return { from: m.from, content: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text };
		})
		.slice(-MAX_TURNS);
	while (turns.length && turns[0].from !== "user") turns.shift();
	return turns;
}

/** The same turns as a text block for the aggregator's single-message input. */
export function earlierTurnsBlock(turns: EarlierTurn[]): string {
	if (!turns.length) return "";
	const lines = turns.map((t) => `${t.from === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n");
	return `EARLIER IN THE CONVERSATION (context for the question):\n${lines}\n\n`;
}
