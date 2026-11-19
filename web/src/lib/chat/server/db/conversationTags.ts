/**
 * A person's own chat tags: the names they type on a chat, to filter the sidebar and search.
 *
 * @remarks
 * Shaped as Open WebUI keeps them, so its import is a copy: one `conversation_tags` row per tag keyed
 * (id, user_id), and a chat naming its tags by id in `conversations.tags`. The id is the name
 * lowercased with spaces as underscores, Open WebUI's own rule, so "Grant" and "grant" are one tag and
 * the row keeps the spelling first typed. Tags are typed by the person; no model writes them.
 *
 * Signed-in accounts only, since the row is keyed on the shadow `users` id. A tag no chat uses any
 * more is deleted when the last chat drops it, so the list never offers an empty filter.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";
import { collections } from "$lib/chat/server/database";
import { normalizeTagNames, type ChatTag } from "$lib/chat/utils/chatTags";

export { TAGS_PER_CHAT_MAX } from "$lib/chat/utils/chatTags";
export type ConversationTag = ChatTag;

/** `conversation_tags.id` is used by one of `userId`'s chats (optionally only unarchived ones). */
function inUse(userId: string, unarchivedOnly: boolean): SQL {
	const c = schema.conversations;
	return sql`exists (select 1 from ${c} where ${c.userId} = ${userId} and ${c.tags} @> array[${schema.conversationTags.id}]::text[]${
		unarchivedOnly ? sql` and ${c.archived} = false` : sql``
	})`;
}

/** The tags on `userId`'s sidebar chats (archived ones aside), by name: what the filter row offers. */
export async function listTags(userId: string): Promise<ConversationTag[]> {
	const t = schema.conversationTags;
	return getDb()
		.select({ id: t.id, name: t.name })
		.from(t)
		.where(and(eq(t.userId, userId), inUse(userId, true)))
		.orderBy(sql`lower(${t.name})`, t.id);
}

/** Every tag `userId` has, id to name. Export reads this to write names rather than ids. */
export async function tagNames(userId: string): Promise<Map<string, string>> {
	const t = schema.conversationTags;
	const rows = await getDb().select({ id: t.id, name: t.name }).from(t).where(eq(t.userId, userId));
	return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Adds tag rows for `userId`, leaving any that exist as they are (the person's own spelling wins).
 * Returns how many rows were new.
 */
export async function ensureTags(
	userId: string,
	tags: readonly (ConversationTag & { meta?: Record<string, unknown> | null })[]
): Promise<number> {
	if (!tags.length) return 0;
	const inserted = await getDb()
		.insert(schema.conversationTags)
		.values(tags.map((t) => ({ id: t.id, userId, name: t.name, meta: t.meta ?? null })))
		.onConflictDoNothing()
		.returning({ id: schema.conversationTags.id });
	return inserted.length;
}

/**
 * Sets the tags on one of `userId`'s chats to `names`, creating tags it has not used before and
 * deleting any this chat was the last to use. `where` is the caller's ownership filter for the chat
 * (authCondition plus its id). Returns the chat's tags with their stored names, or null when no chat
 * matched.
 */
export async function setConversationTags(
	userId: string,
	where: Record<string, unknown>,
	names: readonly unknown[]
): Promise<ConversationTag[] | null> {
	const wanted = normalizeTagNames(names);
	const before = await collections.conversations.findOne(where);
	if (!before) return null;
	await ensureTags(userId, wanted);
	const ids = wanted.map((t) => t.id);
	const res = await collections.conversations.updateOne(where, { $set: { tags: ids } });
	if (res.matchedCount === 0) return null;

	const dropped = (before.tags ?? []).filter((id) => !ids.includes(id));
	if (dropped.length) {
		const t = schema.conversationTags;
		await getDb()
			.delete(t)
			.where(and(eq(t.userId, userId), inArray(t.id, dropped), sql`not ${inUse(userId, false)}`));
	}
	if (!ids.length) return [];
	const stored = await tagNames(userId);
	return ids.map((id) => ({ id, name: stored.get(id) ?? id }));
}
