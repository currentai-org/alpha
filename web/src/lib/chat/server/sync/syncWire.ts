/**
 * The conversation-sync wire format, v1 (CUR-4312). Both halves build against the contract
 * defined here; change it here first. Plain JSON, not superjson.
 */
import { z } from "zod";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";

export const SYNC_WIRE_VERSION = 1;

/** Caps on one push. A client with more to send splits it; the server refuses rather than truncates. */
export const PUSH_LIMITS = {
	bodyBytes: 2_000_000,
	conversations: 200,
	messages: 1_000,
	contentChars: 100_000,
	titleChars: 200,
	idChars: 200,
} as const;

type Role = "user" | "assistant" | "system";

type MessageV1 = {
	id: string;
	clientId: string | null;
	role: Role;
	content: string;
	createdAt: string;
	origin: string;
	model?: string;
};

export type ConversationV1 = {
	id: string;
	/** The id `origin` gave this row; meaningful only together with `origin`. */
	clientId: string | null;
	/** The OAuth client_id that created it, or "alpha". */
	origin: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: MessageV1[];
};

type TombstoneV1 = {
	kind: "conversation" | "message";
	id: string;
	clientId: string | null;
	origin: string;
	deletedAt: string;
};

export type ChangesEventV1 = {
	v: typeof SYNC_WIRE_VERSION;
	cursor: string;
	conversations: ConversationV1[];
	tombstones: TombstoneV1[];
};

const id = z.string().min(1).max(PUSH_LIMITS.idChars);
const iso = z.string().datetime({ offset: true });

/**
 * A pushed row. `id` (Alpha's) or `clientId` names it, and at least one must. A row with `deletedAt`
 * needs nothing else, because Thunderbolt clears a soft-deleted row's columns.
 */
const pushConversation = z
	.object({
		id: id.nullish(),
		clientId: id.nullish(),
		title: z.string().max(PUSH_LIMITS.titleChars).nullish(),
		createdAt: iso.nullish(),
		deletedAt: iso.nullish(),
	})
	.strict()
	.refine((r) => Boolean(r.id || r.clientId), { message: "a conversation needs id or clientId" });

const pushMessage = z
	.object({
		id: id.nullish(),
		clientId: id.nullish(),
		conversationId: id.nullish(),
		conversationClientId: id.nullish(),
		role: z.enum(["user", "assistant", "system"]).nullish(),
		content: z.string().max(PUSH_LIMITS.contentChars).nullish(),
		createdAt: iso.nullish(),
		deletedAt: iso.nullish(),
	})
	.strict()
	.refine((r) => Boolean(r.id || r.clientId), { message: "a message needs id or clientId" })
	.refine((r) => Boolean(r.deletedAt || r.id || r.conversationId || r.conversationClientId), {
		message: "a new message needs conversationId or conversationClientId",
	})
	.refine((r) => Boolean(r.deletedAt || r.id || (r.role && typeof r.content === "string")), {
		message: "a new message needs role and content",
	});

export const pushBodySchema = z
	.object({
		v: z.literal(SYNC_WIRE_VERSION),
		conversations: z.array(pushConversation).max(PUSH_LIMITS.conversations).default([]),
		messages: z.array(pushMessage).max(PUSH_LIMITS.messages).default([]),
	})
	.strict();

export type PushBody = z.infer<typeof pushBodySchema>;
export type PushConversation = PushBody["conversations"][number];
export type PushMessage = PushBody["messages"][number];

export type PushRejection = { kind: "conversation" | "message"; id: string | null; clientId: string | null; reason: string };

export type PushResponseV1 = {
	v: typeof SYNC_WIRE_VERSION;
	conversations: { clientId: string | null; id: string }[];
	messages: { clientId: string | null; id: string }[];
	/** Rows not applied, each with why: an `id` that names nothing of this account's, for one. */
	rejected: PushRejection[];
};

const isoOf = (d: Date | string | undefined, fallback: Date) => new Date(d ?? fallback).toISOString();

/**
 * The branch Alpha opens a conversation on: the newest message and its ancestors, oldest first,
 * system prompt left out. Every other branch a regenerate or an edit made stays in Alpha only.
 */
export function liveBranch(messages: Message[]): Message[] {
	const last = messages.at(-1);
	if (!last) return [];
	const byId = new Map(messages.map((m) => [m.id, m]));
	const chain = [...(last.ancestors ?? []).map((a) => byId.get(a)), last].filter((m): m is Message => Boolean(m));
	// A legacy conversation has no ancestors at all; its list is already the one branch.
	const branch = last.ancestors ? chain : messages;
	return branch.filter((m) => m.from !== "system");
}

export function toConversationV1(conv: Conversation): ConversationV1 {
	const updated = new Date(conv.updatedAt ?? conv.createdAt ?? 0);
	return {
		id: conv._id.toString(),
		clientId: conv.syncClientId ?? null,
		origin: conv.syncOrigin ?? "alpha",
		title: conv.title ?? "",
		createdAt: isoOf(conv.createdAt, updated),
		updatedAt: updated.toISOString(),
		messages: liveBranch(conv.messages ?? []).map((m) => ({
			id: m.id,
			clientId: m.syncClientId ?? null,
			role: m.from,
			content: m.content ?? "",
			createdAt: isoOf(m.createdAt, updated),
			origin: m.origin ?? "alpha",
			...(m.from === "assistant" && m.routerMetadata?.model ? { model: m.routerMetadata.model } : {}),
		})),
	};
}

/**
 * Where a client has read up to, per stream: the (time, id) of the last conversation and of the last
 * tombstone it was sent. Keyset order on (time, id) means rows sharing one millisecond are never
 * skipped at a page edge, which a time-only cursor did.
 */
export type SyncCursor = { conv: { at: number; id: string }; tomb: { at: number; id: string } };

const START_CURSOR: SyncCursor = { conv: { at: 0, id: "" }, tomb: { at: 0, id: "" } };

/** `v2.<convMs>.<convId>.<tombMs>.<tombId>`. Ids are ObjectId hex and UUIDs, so never contain a dot. */
export function encodeCursor(c: SyncCursor): string {
	return `v2.${c.conv.at}.${c.conv.id}.${c.tomb.at}.${c.tomb.id}`;
}

/** Anything unreadable starts over: a repeat of rows the client has is harmless, a gap is not. */
export function decodeCursor(raw: string | null | undefined): SyncCursor {
	const v2 = raw?.match(/^v2\.(\d{1,15})\.([0-9a-f-]{0,64})\.(\d{1,15})\.([0-9a-f-]{0,64})$/);
	if (v2) return { conv: { at: Number(v2[1]), id: v2[2] }, tomb: { at: Number(v2[3]), id: v2[4] } };
	return START_CURSOR;
}
