/**
 * Past-chat search (CUR-4576): keyword retrieval over the signed-in person's own earlier chats.
 *
 * Memory here is search over raw history. No facts about the person are extracted or stored, and
 * deleting a chat removes it from search. Keyword search over raw history scored close to Mem0 for
 * a fraction of the cost (MemoryTax, arXiv 2610.29823), so this is the baseline before any memory layer
 * (CUR-197).
 *
 * Ranking is BM25 from MiniSearch (MIT), built per call over that one owner's messages. The default
 * tokenizer splits on Unicode spaces and punctuation and stems nothing, so it needs no per-language
 * configuration, the same reason searchConversations.ts uses a plain substring.
 */
import MiniSearch from "minisearch";
import { base } from "$lib/chat/paths";
import type { RagContext, RagSource } from "$lib/chat/types/Rag";
import { readPastChats, type PastChat } from "../db/pastChats";
import { mergeRagEvidence } from "./evidence";
import { toSnippet } from "./parseDoc";

const PAST_CHAT_ENGINE = "PastChat" as const;
/** Passages handed to the model per search. */
const PAST_CHAT_TOP_K = 4;
/** At most this many passages from one chat, so one long chat cannot fill every slot. */
const PER_CHAT = 2;
/** A passage scoring under this share of the best one is noise next to it. */
const RELATIVE_FLOOR = 0.3;
const SNIPPET_CHARS = 600;

interface PastChatHit {
	conversationId: string;
	title: string;
	updatedAt: Date;
	from: "user" | "assistant";
	text: string;
	score: number;
}

/** Rank one owner's messages against `query` by BM25. Pure: the caller decides whose chats these are. */
export function rankPastChats(query: string, chats: readonly PastChat[], topK = PAST_CHAT_TOP_K): PastChatHit[] {
	const q = query.trim();
	if (!q || topK <= 0) return [];
	type Doc = { id: string; text: string; title: string; chat: number; from: "user" | "assistant" };
	const docs: Doc[] = [];
	chats.forEach((chat, c) =>
		chat.messages.forEach((m, i) => docs.push({ id: `${c}:${i}`, text: m.content, title: chat.title, chat: c, from: m.from }))
	);
	if (!docs.length) return [];
	const index = new MiniSearch<Doc>({
		fields: ["text", "title"],
		storeFields: ["chat", "from", "text"],
		searchOptions: { boost: { title: 0.5 }, combineWith: "OR" },
	});
	index.addAll(docs);
	const results = index.search(q);
	if (!results.length) return [];
	const floor = results[0].score * RELATIVE_FLOOR;
	const perChat = new Map<number, number>();
	const hits: PastChatHit[] = [];
	for (const r of results) {
		if (r.score < floor || hits.length >= topK) break;
		const c = r.chat as number;
		const used = perChat.get(c) ?? 0;
		if (used >= PER_CHAT) continue;
		perChat.set(c, used + 1);
		const chat = chats[c];
		hits.push({
			conversationId: chat.id,
			title: chat.title,
			updatedAt: chat.updatedAt,
			from: r.from as "user" | "assistant",
			text: r.text as string,
			score: r.score,
		});
	}
	return hits;
}

function sourceOf(hit: PastChatHit): Omit<RagSource, "n"> {
	const who = hit.from === "user" ? "You wrote" : "Alpha answered";
	return {
		title: hit.title || "Untitled chat",
		url: `${base}/conversation/${hit.conversationId}`,
		snippet: `${who}: ${toSnippet(hit.text, SNIPPET_CHARS)}`,
		engine: PAST_CHAT_ENGINE,
		sourceDate: hit.updatedAt.toISOString(),
		score: hit.score,
	};
}

/**
 * Search the signed-in person's own earlier chats. Returns null for anyone without an account, so a
 * guest never reaches the database here, and for a search that found nothing.
 */
export async function searchPastChats(
	query: string,
	owner: { userId?: string; currentConversationId?: string },
	startAt = 0,
	read: typeof readPastChats = readPastChats
): Promise<RagContext | null> {
	if (!owner.userId) return null;
	const hits = rankPastChats(query, await read(owner.userId, owner.currentConversationId));
	if (!hits.length) return null;
	return mergeRagEvidence(query, hits.map(sourceOf), undefined, startAt);
}
