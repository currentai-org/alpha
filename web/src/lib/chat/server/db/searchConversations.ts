/**
 * Search one person's whole chat history by title and message text (CUR-2630).
 *
 * The sidebar loads 30 chats at a time, so filtering its loaded pages would miss most of the history.
 * This reads every conversation the caller owns, scoped exactly as `authCondition` scopes
 * every other conversation read: a signed-in person's `user_id`, or a guest's `session_id` with no
 * `user_id`.
 *
 * No search index. Every query is scoped to one owner, and Postgres answers that from
 * `conversations_user_updated_idx` and scans the owner's rows, which is fast even for the largest
 * owner. Given a trigram index over the same expression, the planner chooses the owner
 * index over it whenever the owner is in the query.
 * Revisit when one owner holds thousands of chats, with a GIN index that leads with the owner
 * (`btree_gin`), since a trigram index alone never wins against the owner filter.
 *
 * Matching is a case-insensitive substring. Alpha is multilingual, and a substring needs no
 * language configuration where a stemmed full-text search would need one per language.
 */
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";

/** Shortest query worth sending: one character matches nearly everything. */
const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 20;
const SNIPPET_RADIUS = 60;

export interface ConversationSearchHit {
	id: string;
	title: string;
	updatedAt: Date;
	model?: string;
	/** Text around the first message that matched, when the match was in a message, not the title. */
	snippet?: string;
}

export type SearchOwner = { userId?: string; sessionId?: string };

function ownerCondition({ userId, sessionId }: SearchOwner): SQL | undefined {
	if (userId) return eq(schema.conversations.userId, userId);
	if (sessionId)
		return and(eq(schema.conversations.sessionId, sessionId), isNull(schema.conversations.userId));
	return undefined;
}

/** `%`, `_` and `\` typed by a person are literal characters, not LIKE wildcards. */
function likeLiteral(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The first message containing `needle`, cut to a window around the match with ellipses. */
function snippetAround(contents: unknown, needle: string): string | undefined {
	if (!Array.isArray(contents)) return undefined;
	for (const content of contents) {
		if (typeof content !== "string") continue;
		const at = content.toLowerCase().indexOf(needle);
		if (at === -1) continue;
		const start = Math.max(0, at - SNIPPET_RADIUS);
		const end = Math.min(content.length, at + needle.length + SNIPPET_RADIUS);
		const body = content.slice(start, end).replace(/\s+/g, " ").trim();
		return `${start > 0 ? "…" : ""}${body}${end < content.length ? "…" : ""}`;
	}
	return undefined;
}

export async function searchConversations(
	owner: SearchOwner,
	query: string
): Promise<ConversationSearchHit[]> {
	const needle = query.trim().toLowerCase();
	const scope = ownerCondition(owner);
	if (!scope || needle.length < SEARCH_MIN_CHARS) return [];

	const title = sql<string>`coalesce(${schema.conversations.doc}->>'title', '')`;
	const contents = sql`jsonb_path_query_array(${schema.conversations.doc}, '$.messages[*].content')`;
	const pattern = `%${likeLiteral(needle)}%`;

	const rows = await getDb()
		.select({
			id: schema.conversations.id,
			title,
			model: sql<string | null>`${schema.conversations.doc}->>'model'`,
			updatedAt: schema.conversations.updatedAt,
			contents: sql<unknown>`${contents}`,
		})
		.from(schema.conversations)
		.where(and(scope, sql`lower(${title} || ' ' || ${contents}::text) like ${pattern}`))
		.orderBy(desc(schema.conversations.updatedAt))
		.limit(SEARCH_LIMIT);

	return rows.map((row) => ({
		id: row.id,
		title: row.title.trim(),
		updatedAt: row.updatedAt ?? new Date(0),
		...(row.model ? { model: row.model } : {}),
		...(row.title.toLowerCase().includes(needle)
			? {}
			: { snippet: snippetAround(row.contents, needle) }),
	}));
}
