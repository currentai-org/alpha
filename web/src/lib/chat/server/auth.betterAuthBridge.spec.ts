import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors tuning.spec.ts's DB-mocking convention. The bridge branch reads/writes
// the shadow `users` doc-store row and (on fallthrough) the anonymous-session collision check.
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		users: {
			findOne: vi.fn(async () => null),
			insertOne: vi.fn(async () => ({})),
		},
		sessions: {
			findOne: vi.fn(async () => null),
		},
		// first-login migration of an anonymous session's conversations/settings. (CUR-849)
		conversations: {
			updateMany: vi.fn(async () => ({})),
		},
		settings: {
			updateOne: vi.fn(async () => ({ matchedCount: 0 })),
			insertOne: vi.fn(async () => ({})),
		},
		// mintAnonymousSession sweeps the retired coalescing rows on every mint, so the
		// anonymous fall-through these tests reach touches this collection. The mock describes the real call
		// graph; the sweep's own contract is asserted in auth.anonSessionMint.spec.ts, not here. (CUR-1645)
		semaphores: {
			deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
		},
	},
}));

// The first-login insert and migrations share one transaction. The mock records which
// collection calls ran inside it, so a test can say what the transaction covered and in what order. (CUR-769)
const inTransaction: string[] = [];
let transactionOpen = false;
const withTransaction = vi.fn(async (fn: () => Promise<unknown>) => {
	transactionOpen = true;
	try {
		return await fn();
	} finally {
		transactionOpen = false;
	}
});
vi.mock("$lib/chat/server/db/client", () => ({
	withTransaction: (fn: () => Promise<unknown>) => withTransaction(fn),
}));

// getAuth() is a lazy singleton (see betterAuth.ts) so authenticateRequest never has to touch a real
// DB/Better Auth instance to be tested — only its resolved session shape matters here.
const getSession = vi.fn(async () => null as unknown);
vi.mock("$lib/chat/server/betterAuth", () => ({
	getAuth: () => ({ api: { getSession } }),
}));

import { authenticateRequest, sessionCookieName } from "./auth";
import { collections } from "$lib/chat/server/database";
import { sha256 } from "$lib/chat/utils/sha256";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const usersFindOne = vi.mocked((collections as any).users.findOne);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const usersInsertOne = vi.mocked((collections as any).users.insertOne);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const conversationsUpdateMany = vi.mocked((collections as any).conversations.updateMany);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsUpdateOne = vi.mocked((collections as any).settings.updateOne);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsInsertOne = vi.mocked((collections as any).settings.insertOne);

const url = new URL("http://localhost/chat/");
const noCookies = { get: () => undefined } as unknown as Parameters<typeof authenticateRequest>[1];
const cookiesWithAnonymousSession = (token: string) =>
	({
		get: (name: string) => (name === sessionCookieName ? token : undefined),
	}) as unknown as Parameters<typeof authenticateRequest>[1];

describe("authenticateRequest — Better Auth bridge (CUR-434)", () => {
	beforeEach(() => {
		getSession.mockReset();
		usersFindOne.mockReset().mockResolvedValue(null);
		usersInsertOne.mockReset().mockResolvedValue({});
		conversationsUpdateMany.mockReset().mockResolvedValue({});
		settingsUpdateOne.mockReset().mockResolvedValue({ matchedCount: 0 });
		settingsInsertOne.mockReset().mockResolvedValue({});
		withTransaction.mockClear();
		inTransaction.length = 0;
		const record = (name: string) => () => {
			if (transactionOpen) inTransaction.push(name);
		};
		usersInsertOne.mockImplementation(async () => (record("users.insertOne")(), {}));
		settingsUpdateOne.mockImplementation(async () => (record("settings.updateOne")(), { matchedCount: 0 }));
		settingsInsertOne.mockImplementation(async () => (record("settings.insertOne")(), {}));
		conversationsUpdateMany.mockImplementation(async () => (record("conversations.updateMany")(), {}));
	});

	it("falls through to the legacy branches (never touches the shadow users collection) when there is no Better Auth session", async () => {
		getSession.mockResolvedValueOnce(null);

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(usersFindOne).not.toHaveBeenCalled();
		expect(usersInsertOne).not.toHaveBeenCalled();
		// Falls all the way through to the anonymous-session branch — the shape every branch returns.
		expect(result.user).toBeUndefined();
		expect(typeof result.secretSessionId).toBe("string");
	});

	it("swallows a Better Auth getSession failure and falls through, rather than 500ing the whole request", async () => {
		getSession.mockRejectedValueOnce(new Error("boom"));

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.user).toBeUndefined();
		expect(usersFindOne).not.toHaveBeenCalled();
	});

	it("creates the shadow users row on a Better Auth user's first sign-in, with hfUserId left unset", async () => {
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_1", name: "Ada", email: "ada@example.com", image: null },
			session: { token: "ba_session_token_1" },
		});

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(usersInsertOne).toHaveBeenCalledTimes(1);
		const inserted = usersInsertOne.mock.calls[0][0];
		expect(inserted.name).toBe("Ada");
		expect(inserted.email).toBe("ada@example.com");
		expect(inserted.hfUserId).toBeUndefined();
		// The verification bit is per request, from the session, and never written to the row. (CUR-3182)
		expect(inserted).not.toHaveProperty("emailVerified");
		expect(result.user).toEqual({ ...inserted, emailVerified: false });
		// Not the raw HF token even when the linked account IS Hugging Face — see the comment in auth.ts.
		expect(result.token).toBeUndefined();
	});

	// A visitor's anonymous conversations/settings otherwise stay orphaned on the old
	// sessionId forever, since authCondition switches to querying by userId the moment locals.user
	// exists — see auth.ts's authCondition and the ticket for the full symptom. (CUR-849)
	it("migrates an anonymous session's conversations and settings on first Better Auth login", async () => {
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_3", name: "Cid", email: "cid@example.com", image: null },
			session: { token: "ba_session_token_4" },
		});

		const anonymousToken = "anon_token_1";
		await authenticateRequest(new Headers(), cookiesWithAnonymousSession(anonymousToken), url);

		const expectedSessionId = await sha256(anonymousToken);
		expect(conversationsUpdateMany).toHaveBeenCalledTimes(1);
		expect(conversationsUpdateMany.mock.calls[0][0]).toEqual({ sessionId: expectedSessionId });
		expect(settingsUpdateOne).toHaveBeenCalledTimes(1);
		expect(settingsUpdateOne.mock.calls[0][0]).toEqual({ sessionId: expectedSessionId });
	});

	// Settings and conversations reference users.id, so the shadow row must exist before
	// either is re-keyed. CUR-1558 needs the opposite from the outside: no other request may see
	// that row before the migration lands. One transaction, row first, satisfies both. (CUR-769)
	it("inserts the shadow user first and re-keys settings and conversations in the same transaction", async () => {
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_tx", name: "Tx", email: "tx@example.com", image: null },
			session: { token: "ba_session_token_tx" },
		});

		await authenticateRequest(new Headers(), cookiesWithAnonymousSession("anon_token_tx"), url);

		expect(withTransaction).toHaveBeenCalledTimes(1);
		expect(inTransaction).toEqual([
			"users.insertOne",
			"settings.updateOne",
			"settings.insertOne",
			"conversations.updateMany",
		]);
	});

	// The catch treats any failure as a lost insert race. When no winner's row turns up, the failure
	// was real (a migration error, say), and it must reach the log rather than vanish behind the
	// race message.
	it("keeps the transaction's own error as the cause when a first sign-in fails with no winner to adopt", async () => {
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_fail", name: "Fail", email: "fail@example.com", image: null },
			session: { token: "ba_session_token_fail" },
		});
		const migrationError = new Error("conversations update failed");
		conversationsUpdateMany.mockRejectedValueOnce(migrationError);

		const thrown = await authenticateRequest(new Headers(), cookiesWithAnonymousSession("anon_token_fail"), url).catch(
			(e: unknown) => e
		);

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("no winner to adopt");
		expect((thrown as Error).cause).toBe(migrationError);
	});

	it("does nothing on first login when there's no anonymous session cookie to migrate", async () => {
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_4", name: "Dee", email: "dee@example.com", image: null },
			session: { token: "ba_session_token_5" },
		});

		await authenticateRequest(new Headers(), noCookies, url);

		expect(conversationsUpdateMany).not.toHaveBeenCalled();
		expect(settingsUpdateOne).not.toHaveBeenCalled();
	});

	// A returning user (shadow row already exists) who signs out, goes anonymous in the same
	// browser, has a conversation, then signs back in must have it migrated, so
	// migrateAnonymousConversations runs on every sign-in, not only inside the first-login `if (!user)`
	// branch. Settings still must NOT re-migrate here — migrateAnonymousSettings' own docstring warns that
	// calling it for a returning user "would stomp them". (CUR-1719)
	it("re-migrates a fresh anonymous session's conversations (but not settings) on a returning Better Auth user", async () => {
		const shadowId = { toHexString: () => "existing-2" };
		usersFindOne.mockResolvedValueOnce({ _id: shadowId, name: "Cid", email: "cid@example.com" });

		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_3", name: "Cid", email: "cid@example.com", image: null },
			session: { token: "ba_session_token_6" },
		});

		const anonymousToken = "anon_token_2";
		await authenticateRequest(new Headers(), cookiesWithAnonymousSession(anonymousToken), url);

		const expectedSessionId = await sha256(anonymousToken);
		expect(conversationsUpdateMany).toHaveBeenCalledTimes(1);
		expect(conversationsUpdateMany.mock.calls[0][0]).toEqual({ sessionId: expectedSessionId });
		expect(settingsUpdateOne).not.toHaveBeenCalled();
	});

	it("does nothing on a returning Better Auth user with no anonymous session cookie to migrate", async () => {
		const shadowId = { toHexString: () => "existing-3" };
		usersFindOne.mockResolvedValueOnce({ _id: shadowId, name: "Eve", email: "eve@example.com" });

		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_5", name: "Eve", email: "eve@example.com", image: null },
			session: { token: "ba_session_token_7" },
		});

		await authenticateRequest(new Headers(), noCookies, url);

		expect(conversationsUpdateMany).not.toHaveBeenCalled();
		expect(settingsUpdateOne).not.toHaveBeenCalled();
	});

	it("reuses the existing shadow row on a returning Better Auth user, without inserting a duplicate", async () => {
		const shadowId = { toHexString: () => "existing" };
		const existingUser = { _id: shadowId, name: "Ada", email: "ada@example.com" };
		usersFindOne.mockResolvedValueOnce(existingUser);

		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_1", name: "Ada", email: "ada@example.com", image: null },
			session: { token: "ba_session_token_2" },
		});

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(usersInsertOne).not.toHaveBeenCalled();
		expect(result.user).toEqual({ ...existingUser, emailVerified: false });
	});

	it("carries Better Auth's emailVerified onto the request's user, so flag evaluation can tell a verified address (CUR-3182)", async () => {
		const existingUser = { _id: { toHexString: () => "existing" }, name: "Ada", email: "ada@currentai.org" };
		usersFindOne.mockResolvedValueOnce(existingUser);
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_1", name: "Ada", email: "ada@currentai.org", emailVerified: true, image: null },
			session: { token: "ba_session_token_v" },
		});

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.user?.emailVerified).toBe(true);
	});

	it("derives the same shadow id for the same Better Auth user.id every time (stable identity across sign-ins)", async () => {
		const expectedId = (await sha256("ba_user_stable")).slice(0, 24);

		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_stable", name: "Ada", email: "ada@example.com", image: null },
			session: { token: "t1" },
		});
		await authenticateRequest(new Headers(), noCookies, url);
		const firstInsertedId = usersInsertOne.mock.calls[0][0]._id.toHexString();

		expect(firstInsertedId).toBe(expectedId);
	});

	it("derives sessionId from the Better Auth session token, matching the sha256(secretSessionId) shape every other branch uses", async () => {
		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_2", name: "Bea", email: "bea@example.com", image: null },
			session: { token: "ba_session_token_3" },
		});

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.secretSessionId).toBe("ba_session_token_3");
		expect(result.sessionId).toBe(await sha256("ba_session_token_3"));
	});

	// Admin comes only from the stored isAdmin flag; this proves this authenticateRequest() branch
	// passes it through. (CUR-575)
	it("surfaces an existing shadow user's isAdmin flag (CUR-575)", async () => {
		const shadowId = { toHexString: () => "existing-admin" };
		const adminUser = { _id: shadowId, name: "Ada", email: "ada@example.com", isAdmin: true };
		usersFindOne.mockResolvedValueOnce(adminUser);

		getSession.mockResolvedValueOnce({
			user: { id: "ba_user_admin", name: "Ada", email: "ada@example.com", image: null },
			session: { token: "ba_session_token_admin" },
		});

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.isAdmin).toBe(true);
	});
});
