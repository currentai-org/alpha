/**
 * POST /chat/api/v2/sync/push, applied (CUR-4312). Wire contract:
 * syncWire.ts.
 *
 * Each row names its target by Alpha's `id` first, then by the pushing client's `clientId` (scoped to
 * that client's `origin`, so two clients' ids never collide). Anything matched is never inserted again,
 * so a re-sent push is a no-op, and an `id` naming nothing of this account's is refused in `rejected`
 * rather than created under a new id.
 *
 * What a push can do: create a conversation, rename one, delete one; append a message to a
 * conversation's live branch, delete one. It cannot edit a message's content (Alpha's copy stands), and
 * it cannot write a system message, which would become instructions to the model on Alpha's next turn.
 *
 * Pushed messages are stored as written and carry no moderation verdict: nothing screened them, and
 * `screened: false` would read as a screen that failed open. Alpha's own turn screen still runs on what
 * the person types next.
 *
 * Creates and appends run under one advisory lock per account, so two pushes of the same new row
 * cannot both miss the lookup and both insert. Conversation deletes run after it, outside the lock:
 * they touch storage buckets, and a repeated delete is already a no-op.
 */
import { ObjectId } from "bson";
import { and, eq, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { withAdvisoryLock } from "$lib/chat/server/db/advisoryLock";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import { writeTombstones, type TombstoneInput } from "$lib/chat/server/db/syncTombstones";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { usageLimits } from "$lib/chat/server/usageLimits";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import {
	SYNC_WIRE_VERSION,
	type PushBody,
	type PushConversation,
	type PushMessage,
	type PushRejection,
	type PushResponseV1,
} from "./syncWire";

/** `conversationLimit` overrides USAGE_LIMITS.conversations for this owner (conversationLimitFor, CUR-4620). */
export type PushOwner = { userId: ObjectId; conversationLimit?: number };

type Ctx = {
	owner: PushOwner;
	origin: string;
	now: Date;
	out: PushResponseV1;
	tombstones: TombstoneInput[];
	/** Conversations this push wrote, re-stamped once the push has committed (see applyPush). */
	touched: Set<string>;
	/** Pushed conversation clientId → Alpha id, for messages in the same push. */
	byClientId: Map<string, string>;
};

const userKey = (o: PushOwner) => o.userId.toString();

function reject(ctx: Ctx, kind: PushRejection["kind"], row: { id?: string | null; clientId?: string | null }, reason: string) {
	ctx.out.rejected.push({ kind, id: row.id ?? null, clientId: row.clientId ?? null, reason });
}

async function ownedConversation(owner: PushOwner, id: string): Promise<Conversation | null> {
	if (!ObjectId.isValid(id)) return null;
	return collections.conversations.findOne({ _id: new ObjectId(id), userId: owner.userId });
}

async function conversationByClientId(ctx: Ctx, clientId: string): Promise<Conversation | null> {
	return collections.conversations.findOne({
		userId: ctx.owner.userId,
		syncClientId: clientId,
		syncOrigin: ctx.origin,
	});
}

/** The conversation of this account's holding a message that matches `probe` (JSONB containment). */
async function conversationHoldingMessage(owner: PushOwner, probe: Record<string, string>): Promise<Conversation | null> {
	const [row] = await getDb()
		.select({ id: schema.conversations.id })
		.from(schema.conversations)
		.where(
			and(
				eq(schema.conversations.userId, userKey(owner)),
				sql`${schema.conversations.doc} -> 'messages' @> ${JSON.stringify([probe])}::jsonb`
			)
		)
		.limit(1);
	return row ? ownedConversation(owner, row.id) : null;
}

function findMessage(conv: Conversation, ctx: Ctx, row: { id?: string | null; clientId?: string | null }) {
	if (row.id) return conv.messages.find((m) => m.id === row.id);
	return conv.messages.find((m) => m.syncClientId === row.clientId && m.origin === ctx.origin);
}

const cleanTitle = (t: string) => t.replace(/<\/?think>/gi, "").trim().slice(0, 100) || "New Chat";

async function applyConversation(ctx: Ctx, row: PushConversation, model: string, remaining: { n: number }) {
	const existing = row.id ? await ownedConversation(ctx.owner, row.id) : await conversationByClientId(ctx, row.clientId ?? "");
	if (row.id && !existing) return reject(ctx, "conversation", row, "not_found");
	if (existing) {
		const id = existing._id.toString();
		if (typeof row.title === "string" && cleanTitle(row.title) !== existing.title) {
			await collections.conversations.updateOne(
				{ _id: existing._id, userId: ctx.owner.userId },
				{ $set: { title: cleanTitle(row.title), updatedAt: ctx.now } }
			);
			ctx.touched.add(id);
		}
		if (row.clientId) ctx.byClientId.set(row.clientId, id);
		ctx.out.conversations.push({ clientId: row.clientId ?? null, id });
		return;
	}
	if (remaining.n <= 0) return reject(ctx, "conversation", row, "conversation_limit");
	remaining.n -= 1;
	const created = row.createdAt ? new Date(row.createdAt) : ctx.now;
	const root: Message = {
		id: v4(),
		from: "system",
		content: "",
		createdAt: created,
		updatedAt: created,
		children: [],
		ancestors: [],
	};
	const res = await collections.conversations.insertOne({
		_id: new ObjectId(),
		title: cleanTitle(row.title ?? ""),
		rootMessageId: root.id,
		messages: [root],
		model,
		preprompt: "",
		createdAt: created,
		updatedAt: ctx.now,
		userId: ctx.owner.userId,
		syncClientId: row.clientId ?? undefined,
		syncOrigin: ctx.origin,
	});
	const id = res.insertedId.toString();
	ctx.touched.add(id);
	if (row.clientId) ctx.byClientId.set(row.clientId, id);
	ctx.out.conversations.push({ clientId: row.clientId ?? null, id });
}

/**
 * Messages per push that may be found by scanning the account's conversations (a row naming no
 * conversation). Each scan reads every conversation the account has, so a push may not ask for 1,000.
 */
const PUSH_SCAN_LIMIT = 50;

type Target = Conversation | null | "scan_limit";

async function targetConversation(ctx: Ctx, row: PushMessage, scans: { n: number }): Promise<Target> {
	// A row that names its conversation is found by key; only a row that names none falls back to a scan.
	if (row.conversationId) return ownedConversation(ctx.owner, row.conversationId);
	if (row.conversationClientId) {
		const known = ctx.byClientId.get(row.conversationClientId);
		if (known) return ownedConversation(ctx.owner, known);
		return conversationByClientId(ctx, row.conversationClientId);
	}
	if (scans.n <= 0) return "scan_limit";
	scans.n -= 1;
	if (row.id) return conversationHoldingMessage(ctx.owner, { id: row.id });
	return conversationHoldingMessage(ctx.owner, { syncClientId: row.clientId ?? "", origin: ctx.origin });
}

/** Appends and deletes for one conversation's rows, saved in one merge. */
async function applyMessages(ctx: Ctx, conv: Conversation, rows: PushMessage[]) {
	const base = snapshotConversation(conv);
	let messages = [...conv.messages];
	let changed = false;
	const ordered = [...rows].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
	for (const row of ordered) {
		const match = findMessage({ ...conv, messages }, ctx, row);
		if (row.deletedAt) {
			if (!match || match.from === "system") {
				if (row.id && !match) reject(ctx, "message", row, "not_found");
				continue;
			}
			const gone = messages.filter((m) => m.id === match.id || m.ancestors?.includes(match.id));
			messages = removeMessage(messages, match.id);
			for (const m of gone) {
				ctx.tombstones.push({ kind: "message", entityId: m.id, clientId: m.syncClientId, origin: m.origin });
			}
			changed = true;
			continue;
		}
		if (match) {
			ctx.out.messages.push({ clientId: row.clientId ?? null, id: match.id });
			continue;
		}
		if (row.id) {
			reject(ctx, "message", row, "not_found");
			continue;
		}
		if (row.role === "system") {
			reject(ctx, "message", row, "role_not_accepted");
			continue;
		}
		const leaf = messages.at(-1);
		const at = row.createdAt ? new Date(row.createdAt) : ctx.now;
		const msg = syncedMessage(row, ctx.origin, leaf, at);
		if (leaf) messages = messages.map((m) => (m.id === leaf.id ? { ...m, children: [...(m.children ?? []), msg.id] } : m));
		messages.push(msg);
		ctx.out.messages.push({ clientId: row.clientId ?? null, id: msg.id });
		changed = true;
	}
	if (!changed) return;
	await saveConversationMessages({ _id: conv._id, userId: ctx.owner.userId }, base, { messages, updatedAt: ctx.now });
	ctx.touched.add(conv._id.toString());
}

/**
 * A message a sync client wrote, appended under `leaf`. An assistant one arrives finished, so it
 * carries a final answer: without one the page reads the turn as still generating and offers Stop.
 */
export function syncedMessage(row: PushMessage, origin: string, leaf: Message | undefined, at: Date): Message {
	const from = row.role ?? "user";
	const content = row.content ?? "";
	return {
		id: v4(),
		from,
		content,
		origin,
		syncClientId: row.clientId ?? undefined,
		createdAt: at,
		updatedAt: at,
		ancestors: leaf ? [...(leaf.ancestors ?? []), leaf.id] : [],
		children: [],
		...(from === "assistant"
			? { updates: [{ type: MessageUpdateType.FinalAnswer, text: content, interrupted: false }] }
			: {}),
	};
}

/** `id` and everything below it go; its parent stops listing it. */
export function removeMessage(messages: Message[], id: string): Message[] {
	const gone = new Set(messages.filter((m) => m.id === id || m.ancestors?.includes(id)).map((m) => m.id));
	return messages
		.filter((m) => !gone.has(m.id))
		.map((m) => (m.children?.some((c) => gone.has(c)) ? { ...m, children: m.children.filter((c) => !gone.has(c)) } : m));
}

export async function applyPush(owner: PushOwner, origin: string, body: PushBody, model: string, now = new Date()): Promise<PushResponseV1> {
	const ctx: Ctx = {
		owner,
		origin,
		now,
		out: { v: SYNC_WIRE_VERSION, conversations: [], messages: [], rejected: [] },
		tombstones: [],
		touched: new Set(),
		byClientId: new Map(),
	};
	const deletes = body.conversations.filter((c) => c.deletedAt);
	await withAdvisoryLock(`sync-push:${userKey(owner)}`, async () => {
		const limit = "conversationLimit" in owner ? owner.conversationLimit : usageLimits?.conversations;
		const count = limit ? await collections.conversations.countDocuments({ userId: owner.userId }) : 0;
		const remaining = { n: limit ? Math.max(0, limit - count) : Number.POSITIVE_INFINITY };
		for (const row of body.conversations) {
			if (!row.deletedAt) await applyConversation(ctx, row, model, remaining);
		}
		const groups = new Map<string, { conv: Conversation; rows: PushMessage[] }>();
		const scans = { n: PUSH_SCAN_LIMIT };
		for (const row of body.messages) {
			const conv = await targetConversation(ctx, row, scans);
			if (conv === "scan_limit") {
				reject(ctx, "message", row, "too_many_lookups");
				continue;
			}
			if (!conv) {
				reject(ctx, "message", row, row.deletedAt && !row.id ? "not_found" : "conversation_not_found");
				continue;
			}
			const key = conv._id.toString();
			const g = groups.get(key) ?? { conv, rows: [] };
			g.rows.push(row);
			groups.set(key, g);
		}
		for (const { conv, rows } of groups.values()) await applyMessages(ctx, conv, rows);
	});
	// Everything above was stamped `now` but only became visible when the lock's transaction
	// committed, which can be seconds later. /changes reads by updatedAt, so stamp the rows again now,
	// one statement that commits as it runs, or a poll in between would move past them for good.
	if (ctx.touched.size) {
		await collections.conversations.updateMany(
			{ _id: { $in: [...ctx.touched] }, userId: owner.userId },
			{ $set: { updatedAt: new Date() } }
		);
	}

	const doomed: { conv: Conversation; row: PushConversation }[] = [];
	for (const row of deletes) {
		const conv = row.id ? await ownedConversation(owner, row.id) : await conversationByClientId(ctx, row.clientId ?? "");
		if (conv) doomed.push({ conv, row });
		// A delete for a row already gone is a no-op: the client re-sending it is the normal case.
		else if (row.id && !ObjectId.isValid(row.id)) reject(ctx, "conversation", row, "not_found");
	}
	if (doomed.length) {
		await deleteConversationsCascade(
			doomed.map((d) => d.conv._id.toString()),
			userKey(owner)
		);
		for (const { conv } of doomed) {
			ctx.tombstones.push({ kind: "conversation", entityId: conv._id.toString(), clientId: conv.syncClientId, origin: conv.syncOrigin });
		}
	}
	await writeTombstones(userKey(owner), ctx.tombstones);
	return ctx.out;
}
