/**
 * The snapshot a read-only share link shows. Built once when the person shares a chat, or
 * refreshes its link, and stored in `shared_conversations.doc`; the viewer at `/r/<id>` reads only
 * this.
 *
 * It holds the one branch the person was reading, as plain text turns: who spoke and what was said.
 * Nothing else crosses: no files or images, no reasoning, no sources, timings or routing records, no
 * system prompt, and nothing about the owner. Anything the viewer should one day show has to be added
 * here deliberately, which is the point.
 */
import type { Message } from "$lib/chat/types/Message";
import { buildSubtree } from "$lib/chat/utils/tree/buildSubtree";

const SHARE_SNAPSHOT_VERSION = 1;

interface SharedTurn {
	from: "user" | "assistant";
	content: string;
}

export interface ShareSnapshot {
	v: typeof SHARE_SNAPSHOT_VERSION;
	title: string;
	/** The model id the conversation ran on, for the "Answered by" line. Never the owner's identity. */
	model: string;
	/** ISO time the snapshot was taken. */
	sharedAt: string;
	turns: SharedTurn[];
}

interface ConversationLike {
	title: string;
	model: string;
	rootMessageId?: string;
	messages: Message[];
}

// A reasoning block some models write inline. It is ours to strip (a tag we parse elsewhere), not
// natural language, and reasoning never belongs in a share.
const INLINE_REASONING = /<think>[\s\S]*?(?:<\/think>|$)/gi;

/**
 * The turns from the root to `leafId` (the branch the person had open), or to the newest message
 * when `leafId` is missing or names no message here.
 */
export function buildShareSnapshot(
	conversation: ConversationLike,
	leafId: string | undefined,
	now: Date = new Date()
): ShareSnapshot {
	const messages = conversation.messages ?? [];
	const leaf =
		(leafId ? messages.find((m) => m.id === leafId) : undefined) ?? messages[messages.length - 1];
	const path = leaf ? buildSubtree(conversation, leaf.id) : [];
	const turns: SharedTurn[] = [];
	for (const m of path) {
		if (m.from !== "user" && m.from !== "assistant") continue;
		const content = (m.content ?? "").replace(INLINE_REASONING, "").trim();
		if (!content) continue;
		turns.push({ from: m.from, content });
	}
	return {
		v: SHARE_SNAPSHOT_VERSION,
		title: conversation.title.replace(/<\/?think>/gi, "").trim() || "Shared chat",
		model: conversation.model,
		sharedAt: now.toISOString(),
		turns,
	};
}

/** Reads a stored snapshot back, refusing a shape this code does not know rather than guessing. */
export function parseShareSnapshot(doc: unknown): ShareSnapshot | null {
	const d = doc as Partial<ShareSnapshot> | null;
	if (!d || d.v !== SHARE_SNAPSHOT_VERSION || !Array.isArray(d.turns)) return null;
	return {
		v: SHARE_SNAPSHOT_VERSION,
		title: String(d.title ?? ""),
		model: String(d.model ?? ""),
		sharedAt: String(d.sharedAt ?? ""),
		turns: d.turns
			.filter((t) => t && (t.from === "user" || t.from === "assistant") && typeof t.content === "string")
			.map((t) => ({ from: t.from, content: t.content })),
	};
}
