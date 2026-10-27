/**
 * Database seam — Postgres/Neon via Drizzle, presented through the Mongo-shaped `collections` API the
 * app is built on (B1-lite migration off MongoDB). Each collection is backed by a document-store table
 * (schema.ts) through the adapter in db/docStore.ts.
 *
 * Serverless posture: `collections` is constructed SYNCHRONOUSLY at import with zero I/O — postgres.js
 * (db/client.ts) connects lazily on the first query. This removes the eager connect-at-import IIFE and
 * the embedded MongoMemoryServer that the upstream MongoDB implementation used, both of which were
 * serverless-hostile. Schema/indexes are applied at deploy time via drizzle-kit, not here.
 */
import { docCollection, type CollectionSpec } from "./db/docStore";
import * as schema from "./db/schema";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { User } from "$lib/chat/types/User";
import type { Session } from "$lib/chat/types/Session";
import type { Settings } from "$lib/chat/types/Settings";
import type { MessageEvent } from "$lib/chat/types/MessageEvent";
import type { AbortedGeneration } from "$lib/chat/types/AbortedGeneration";
import type { McpElicitation } from "$lib/chat/types/McpElicitation";
import type { Semaphore } from "$lib/chat/types/Semaphore";
import type { TokenCache } from "$lib/chat/types/TokenCache";
import type { ConfigKey } from "$lib/chat/types/ConfigKey";

const text = (prop: string) => ({ prop, kind: "text" as const });
const date = (prop: string) => ({ prop, kind: "date" as const });

const base = { idProp: "id", idField: "_id", emitObjectId: true } satisfies Partial<CollectionSpec>;

export const collections = {
	conversations: docCollection<Conversation>({
		...base,
		table: schema.conversations,
		cols: {
			sessionId: text("sessionId"),
			userId: text("userId"),
			createdAt: date("createdAt"),
			updatedAt: date("updatedAt"),
			organizationId: text("organizationId"),
		},
	}),
	users: docCollection<User>({
		...base,
		table: schema.users,
		cols: { hfUserId: text("hfUserId"), username: text("username"), createdAt: date("createdAt") },
	}),
	sessions: docCollection<Session>({
		...base,
		table: schema.sessions,
		cols: { sessionId: text("sessionId"), userId: text("userId"), expiresAt: date("expiresAt") },
	}),
	settings: docCollection<Settings>({
		...base,
		table: schema.settings,
		cols: { userId: text("userId"), sessionId: text("sessionId") },
	}),
	messageEvents: docCollection<MessageEvent>({
		...base,
		table: schema.messageEvents,
		cols: {
			userId: text("userId"),
			ipHash: text("ipHash"),
			type: text("type"),
			expiresAt: date("expiresAt"),
			createdAt: date("createdAt"),
		},
	}),
	abortedGenerations: docCollection<AbortedGeneration>({
		...base,
		table: schema.abortedGenerations,
		cols: {
			conversationId: text("conversationId"),
			updatedAt: date("updatedAt"),
			createdAt: date("createdAt"),
		},
	}),
	mcpElicitations: docCollection<McpElicitation>({
		...base,
		table: schema.mcpElicitations,
		cols: {
			conversationId: text("conversationId"),
			updatedAt: date("updatedAt"),
			createdAt: date("createdAt"),
		},
	}),
	semaphores: docCollection<Semaphore>({
		...base,
		table: schema.semaphores,
		cols: { key: text("key"), updatedAt: date("updatedAt"), deleteAt: date("deleteAt") },
	}),
	tokenCaches: docCollection<TokenCache>({
		...base,
		table: schema.tokenCaches,
		cols: { tokenHash: text("tokenHash"), userId: text("userId"), createdAt: date("createdAt") },
	}),
	config: docCollection<ConfigKey>({
		table: schema.configKv,
		idProp: "key",
		idField: "key",
		emitObjectId: false,
		cols: {},
	}),
};

export type Collections = typeof collections;

/**
 * Compatibility shims for the document-store `Database` singleton. `collections` is populated at
 * import (no async init), so these resolve immediately.
 */
export const ready = Promise.resolve();

export async function getCollectionsEarly(): Promise<Collections> {
	return collections;
}
