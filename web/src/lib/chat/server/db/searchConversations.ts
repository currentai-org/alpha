/**
 * Search one person's whole chat history by title and message text.
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
 *
 * A `tag:grant` term keeps only chats carrying that tag, answered from the GIN index on
 * `conversations.tags`; the words around it still match title and messages. A query that is only
 * tag terms lists every chat with those tags.
 */
import { and, arrayContains, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";
import { parseTagQuery } from "$lib/chat/utils/chatTags";

/** Shortest query worth sending: one character matches nearly everything. */
const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 20;
const SNIPPET_RADIUS = 60;

export interface ConversationSearchHit {
	id: string;
	title: string;
	updatedAt: Date;
	model?: string;
	/** An archived chat still turns up here, labelled as archived. */
	archived?: boolean;
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
	const { text, tags } = parseTagQuery(query);
	const needle = text.toLowerCase();
	const scope = ownerCondition(owner);
	if (!scope || (tags.length === 0 && needle.length < SEARCH_MIN_CHARS)) return [];

	const title = sql<string>`coalesce(${schema.conversations.doc}->>'title', '')`;
	const contents = sql`jsonb_path_query_array(${schema.conversations.doc}, '$.messages[*].content')`;
	const pattern = `%${likeLiteral(needle)}%`;

	const rows = await getDb()
		.select({
			id: schema.conversations.id,
			title,
			model: sql<string | null>`${schema.conversations.doc}->>'model'`,
			updatedAt: schema.conversations.updatedAt,
			archived: schema.conversations.archived,
			contents: sql<unknown>`${contents}`,
		})
		.from(schema.conversations)
		.where(
			and(
				scope,
				needle ? sql`lower(${title} || ' ' || ${contents}::text) like ${pattern}` : undefined,
				tags.length ? arrayContains(schema.conversations.tags, tags) : undefined
			)
		)
		.orderBy(desc(schema.conversations.updatedAt))
		.limit(SEARCH_LIMIT);

	return rows.map((row) => ({
		id: row.id,
		title: row.title.trim(),
		updatedAt: row.updatedAt ?? new Date(0),
		...(row.model ? { model: row.model } : {}),
		...(row.archived ? { archived: true } : {}),
		...(row.title.toLowerCase().includes(needle)
			? {}
			: { snippet: snippetAround(row.contents, needle) }),
	}));
}

/** How many sealed titles the browser is handed to open for Search chats: the newest, past any owner
 *  today, and a bound on what one dialog opens. */
const SEALED_TITLE_LIMIT = 500;

/** One sealed chat as Search chats lists it: its title still sealed, opened in the browser. */
export interface SealedTitleRow {
	id: string;
	sealedTitle: string;
	sealedTitleRev?: number;
	updatedAt: Date;
	model?: string;
	archived?: boolean;
	tags?: string[];
}

/**
 * The owner's chats whose title is sealed, newest first. The server cannot read a sealed
 * title, so `searchConversations` never matches one; Search chats opens these in the browser with the
 * person's history key and matches them there. Archived chats are included, as search includes them.
 */
export async function sealedTitleIndex(owner: SearchOwner, limit = SEALED_TITLE_LIMIT): Promise<SealedTitleRow[]> {
	const scope = ownerCondition(owner);
	if (!scope) return [];
	const sealedTitle = sql<string | null>`${schema.conversations.doc}->>'sealedTitle'`;
	const rows = await getDb()
		.select({
			id: schema.conversations.id,
			sealedTitle,
			sealedTitleRev: sql<string | null>`${schema.conversations.doc}->>'sealedTitleRev'`,
			model: sql<string | null>`${schema.conversations.doc}->>'model'`,
			updatedAt: schema.conversations.updatedAt,
			archived: schema.conversations.archived,
			tags: schema.conversations.tags,
		})
		.from(schema.conversations)
		.where(and(scope, sql`${sealedTitle} is not null`))
		.orderBy(desc(schema.conversations.updatedAt))
		.limit(limit);
	return rows.flatMap((row) => {
		if (!row.sealedTitle) return [];
		const rev = row.sealedTitleRev === null ? NaN : Number(row.sealedTitleRev);
		return [
			{
				id: row.id,
				sealedTitle: row.sealedTitle,
				...(Number.isSafeInteger(rev) ? { sealedTitleRev: rev } : {}),
				updatedAt: row.updatedAt ?? new Date(0),
				...(row.model ? { model: row.model } : {}),
				...(row.archived ? { archived: true } : {}),
				...(row.tags?.length ? { tags: row.tags } : {}),
			},
		];
	});
}
