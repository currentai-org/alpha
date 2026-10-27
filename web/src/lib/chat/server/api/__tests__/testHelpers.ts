import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import { reports, contributions, localInferenceEndpoints, localInferencePairings } from "$lib/chat/server/db/schema";
import * as authSchema from "$lib/chat/server/db/schema";
import type { User } from "$lib/chat/types/User";
import type { Session } from "$lib/chat/types/Session";
import type { Conversation } from "$lib/chat/types/Conversation";

export function createTestLocals(overrides?: Partial<App.Locals>): App.Locals {
	return {
		sessionId: "test-session-id",
		isAdmin: false,
		user: undefined,
		token: undefined,
		...overrides,
	};
}

export async function createTestUser(): Promise<{
	user: User;
	session: Session;
	locals: App.Locals;
}> {
	const userId = new ObjectId();
	const sessionId = `test-session-${userId.toString()}`;

	const user: User = {
		_id: userId,
		createdAt: new Date(),
		updatedAt: new Date(),
		username: `user-${userId.toString().slice(0, 8)}`,
		name: "Test User",
		avatarUrl: "https://example.com/avatar.png",
		hfUserId: `hf-${userId.toString()}`,
	};

	const session: Session = {
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		userId,
		sessionId,
		expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
	};

	await collections.users.insertOne(user);
	await collections.sessions.insertOne(session);

	return {
		user,
		session,
		locals: {
			user,
			sessionId,
			isAdmin: false,
			token: undefined,
		},
	};
}

export async function createTestConversation(
	locals: App.Locals,
	overrides?: Partial<Conversation>
): Promise<Conversation> {
	const conv: Conversation = {
		_id: new ObjectId(),
		title: "Test Conversation",
		model: "test-model",
		messages: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...(locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }),
		...overrides,
	};

	// conversations.user_id references users.id. A signed-in caller always has that row in
	// production (auth.ts mints it at sign-in); a test that builds bare locals gets a minimal one here. (CUR-769)
	if (conv.userId) {
		await getDb()
			.insert(authSchema.users)
			.values({ id: conv.userId.toString(), doc: {} })
			.onConflictDoNothing();
	}
	await collections.conversations.insertOne(conv);
	return conv;
}

export async function cleanupTestData() {
	// reports/contributions are Drizzle-direct (NOT behind the Mongo adapter), and `reports` has a
	// foreign key to conversations.id. Delete them FIRST — otherwise conversations.deleteMany() below
	// hits an FK violation, aborts cleanup, and leaves rows that pollute whichever test file runs next
	// (the in-suite flakiness: each spec is green alone but fails after the report spec). FK-safe order.
	const db = getDb();
	await db.delete(reports);
	await db.delete(contributions);
	await db.delete(localInferencePairings);
	await db.delete(localInferenceEndpoints);
	// The Better Auth tables (Drizzle-direct, same as the three above) are cleaned here too, so a spec
	// that inserts a `user` row (e.g. wipeUserData.spec.ts's own fixture) leaves nothing behind.
	// `passkey` first: no onDelete:cascade on its userId FK (schema.ts's own comment says
	// why — deliberately the app layer's job, not the DB's). `user` cascades to session/account.
	// `verification` has no userId FK at all (keyed by `identifier`), so it needs its own delete.
	await db.delete(authSchema.passkey);
	await db.delete(authSchema.user);
	await db.delete(authSchema.verification);
	await collections.conversations.deleteMany({});
	await collections.abortedGenerations.deleteMany({});
	// conversations, sessions and settings reference users.id, so `users` goes last. (CUR-769)
	await collections.sessions.deleteMany({});
	await collections.settings.deleteMany({});
	await collections.users.deleteMany({});
}
