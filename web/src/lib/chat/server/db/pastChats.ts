/**
 * The signed-in person's own earlier chats, read for past-chat search (CUR-4576).
 *
 * Scoped by `user_id` alone. A guest has no account, so there is no owner to read for and the caller
 * never gets here; a guest's `session_id` is deliberately not an owner this reads. The conversation the
 * turn is in is left out, since the model already has it.
 *
 * Only the person's and Alpha's messages are read, and only those no screen flagged: a declined request
 * or a withheld answer never comes back into a later chat through search.
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";

/** The most recent chats searched. The 100-chat cap per account keeps a real owner under it. */
const PAST_CHATS_READ_LIMIT = 200;
/** Characters read from one message. A pasted document can be 100k; its opening is enough to find it. */
const PAST_MESSAGE_MAX_CHARS = 4000;

export interface PastChat {
	id: string;
	title: string;
	updatedAt: Date;
	messages: { from: "user" | "assistant"; content: string }[];
}

const SPOKEN =
	'(@.from == "user" || @.from == "assistant") && !(@.moderation.flagged == true) && !(@.outputModeration.flagged == true)';

export async function readPastChats(userId: string, excludeConversationId?: string): Promise<PastChat[]> {
	if (!userId) return [];
	const conv = schema.conversations;
	const owner = eq(conv.userId, userId);
	const scope = excludeConversationId ? and(owner, ne(conv.id, excludeConversationId)) : owner;
	const rows = await getDb()
		.select({
			id: conv.id,
			title: sql<string>`coalesce(${conv.doc}->>'title', '')`,
			updatedAt: conv.updatedAt,
			froms: sql<unknown>`jsonb_path_query_array(${conv.doc}, ${`$.messages[*] ? (${SPOKEN}).from`}::jsonpath)`,
			contents: sql<unknown>`jsonb_path_query_array(${conv.doc}, ${`$.messages[*] ? (${SPOKEN}).content`}::jsonpath)`,
		})
		.from(conv)
		.where(scope)
		.orderBy(desc(conv.updatedAt))
		.limit(PAST_CHATS_READ_LIMIT);

	return rows.map((row) => {
		const froms = Array.isArray(row.froms) ? row.froms : [];
		const contents = Array.isArray(row.contents) ? row.contents : [];
		const messages: PastChat["messages"] = [];
		// A message with no `content` drops out of the content array and not the from array, so pairing
		// by index would misalign; the two only pair when every message had both.
		if (froms.length === contents.length) {
			for (let i = 0; i < froms.length; i++) {
				const from = froms[i];
				const content = contents[i];
				if ((from !== "user" && from !== "assistant") || typeof content !== "string") continue;
				const text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
				if (text) messages.push({ from, content: text.slice(0, PAST_MESSAGE_MAX_CHARS) });
			}
		}
		return { id: row.id, title: row.title.trim(), updatedAt: row.updatedAt ?? new Date(0), messages };
	});
}
