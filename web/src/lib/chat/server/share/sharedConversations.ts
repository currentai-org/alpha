/**
 * Read-only share links: create or refresh one for a conversation, list a person's links,
 * revoke one, and read one for the signed-out viewer at `/r/<id>`.
 *
 * Every write is keyed by the owner's shadow `users.id`, so nobody can refresh or revoke a link that
 * is not theirs; the viewer's read is keyed by the token alone, which is the whole point of a link.
 * Revoking deletes the row: a revoked snapshot is not kept.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import * as schema from "../db/schema";
import { buildShareSnapshot, parseShareSnapshot, type ShareSnapshot } from "./snapshot";
import type { Message } from "$lib/chat/types/Message";

/** 18 random bytes, base64url: 24 characters and 144 bits, so a link cannot be guessed. */
export function newShareToken(): string {
	return randomBytes(18).toString("base64url");
}

/** A token we could have issued, or one an Open WebUI import carried (a uuid). Anything else is a 404
 *  without a query. */
export function isShareToken(id: string): boolean {
	return /^[A-Za-z0-9_-]{22,64}$/.test(id);
}

export interface ShareLinkSummary {
	id: string;
	conversationId: string;
	title: string;
	createdAt: Date;
	updatedAt: Date;
}

const summaryColumns = {
	id: schema.sharedConversations.id,
	conversationId: schema.sharedConversations.conversationId,
	title: schema.sharedConversations.title,
	createdAt: schema.sharedConversations.createdAt,
	updatedAt: schema.sharedConversations.updatedAt,
};

interface ShareableConversation {
	_id: { toString(): string };
	title: string;
	model: string;
	rootMessageId?: string;
	messages: Message[];
}

/**
 * Shares `conversation` for its owner, or refreshes the snapshot on the link it already has (one link
 * per conversation, so a refresh keeps the URL people were sent). The caller has already checked the
 * conversation belongs to `userId`.
 */
export async function shareConversation(
	userId: string,
	conversation: ShareableConversation,
	leafId: string | undefined
): Promise<ShareLinkSummary> {
	const snapshot = buildShareSnapshot(conversation, leafId);
	const now = new Date();
	const [row] = await getDb()
		.insert(schema.sharedConversations)
		.values({
			id: newShareToken(),
			conversationId: conversation._id.toString(),
			userId,
			title: snapshot.title,
			doc: snapshot as unknown as Record<string, unknown>,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: schema.sharedConversations.conversationId,
			set: { title: snapshot.title, doc: snapshot as unknown as Record<string, unknown>, updatedAt: now },
			// A conversation id is the owner's, so this never fires across owners; the guard keeps it so.
			setWhere: eq(schema.sharedConversations.userId, userId),
		})
		.returning(summaryColumns);
	if (!row) throw new Error("share link was not written");
	return row;
}

/** The link this owner has for one conversation, or null. */
export async function shareForConversation(
	userId: string,
	conversationId: string
): Promise<ShareLinkSummary | null> {
	const [row] = await getDb()
		.select(summaryColumns)
		.from(schema.sharedConversations)
		.where(
			and(
				eq(schema.sharedConversations.userId, userId),
				eq(schema.sharedConversations.conversationId, conversationId)
			)
		);
	return row ?? null;
}

/** Every live link this owner has, newest first. */
export async function listShares(userId: string): Promise<ShareLinkSummary[]> {
	return getDb()
		.select(summaryColumns)
		.from(schema.sharedConversations)
		.where(eq(schema.sharedConversations.userId, userId))
		.orderBy(desc(schema.sharedConversations.createdAt));
}

/** Revokes one of this owner's links by token. True when a link went. */
export async function revokeShare(userId: string, id: string): Promise<boolean> {
	const gone = await getDb()
		.delete(schema.sharedConversations)
		.where(and(eq(schema.sharedConversations.userId, userId), eq(schema.sharedConversations.id, id)))
		.returning({ id: schema.sharedConversations.id });
	return gone.length > 0;
}

/** Revokes the link on one of this owner's conversations. True when a link went. */
export async function revokeShareForConversation(userId: string, conversationId: string): Promise<boolean> {
	const gone = await getDb()
		.delete(schema.sharedConversations)
		.where(
			and(
				eq(schema.sharedConversations.userId, userId),
				eq(schema.sharedConversations.conversationId, conversationId)
			)
		)
		.returning({ id: schema.sharedConversations.id });
	return gone.length > 0;
}

/** What the signed-out viewer may show for a token: the snapshot, or null for a link that does not
 *  exist, was revoked, or holds a snapshot shape this code does not read. */
export async function readSharedSnapshot(id: string): Promise<ShareSnapshot | null> {
	if (!isShareToken(id)) return null;
	const [row] = await getDb()
		.select({ doc: schema.sharedConversations.doc })
		.from(schema.sharedConversations)
		.where(eq(schema.sharedConversations.id, id));
	return row ? parseShareSnapshot(row.doc) : null;
}
