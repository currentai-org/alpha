/**
 * Conversation sync against real Postgres. The token boundary (a sync token is read on the
 * sync routes and nowhere else), push idempotency, and deletes surfacing as tombstones in /changes. (CUR-4312)
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { collections } from "$lib/chat/server/database";
import { authenticateRequest, shadowUserId } from "$lib/chat/server/auth";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { cleanupTestData } from "$lib/chat/server/api/__tests__/testHelpers";
import { syncClientsPlugin } from "../syncClients";
import { storedSyncTokenHash, SYNC_ACCESS_TOKEN_PREFIX } from "../syncToken";
import { applyPush } from "../syncPush";
import { readChanges } from "../syncChanges";
import { decodeCursor, pushBodySchema, type SyncCursor } from "../syncWire";
// An empty cursor: everything from the beginning.
const START_CURSOR = decodeCursor(null);
import { writeTombstones } from "$lib/chat/server/db/syncTombstones";
import { tombstoneMessages } from "../syncTouch";
import { SYNC_SCOPE } from "../../../../../../config/thunderbolt";

const { flag } = vi.hoisted(() => ({ flag: { on: true } }));
vi.mock("$lib/chat/server/dataPortability", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/dataPortability")>()),
	thunderboltSyncEnabled: () => flag.on,
}));

const CLIENT = "thunderbolt-sandbox";

async function owner() {
	const baId = `ba-${randomUUID()}`;
	await getDb()
		.insert(schema.user)
		.values({ id: baId, name: "Sync Tester", email: `${baId}@example.org`, emailVerified: true });
	const shadow = new ObjectId(await shadowUserId(baId));
	await collections.users.insertOne({
		_id: shadow,
		createdAt: new Date(),
		updatedAt: new Date(),
		username: `sync-${baId.slice(3, 11)}`,
		name: "Sync Tester",
		email: `${baId}@example.org`,
		betterAuthUserId: baId,
	});
	return { baId, shadow };
}

async function mintToken(baId: string, scopes = [SYNC_SCOPE, "offline_access"]) {
	const token = `${SYNC_ACCESS_TOKEN_PREFIX}${randomUUID()}${randomUUID()}`;
	await getDb().insert(schema.oauthAccessToken).values({
		id: randomUUID(),
		token: storedSyncTokenHash(token),
		clientId: CLIENT,
		userId: baId,
		scopes,
		expiresAt: new Date(Date.now() + 3_600_000),
	});
	return token;
}

const bearer = (token: string) => new Headers({ Authorization: `Bearer ${token}` });
// No cookie at all: the only credential on these requests is the bearer token.
const noCookies = { get: () => undefined, getAll: () => [] } as unknown as Parameters<typeof authenticateRequest>[1];
const push = (raw: unknown) => pushBodySchema.parse(raw);
// Reads as a poll a minute from now would, past the safety lag, unless a test is about the lag.
const read = (shadow: ObjectId, cursor: SyncCursor = START_CURSOR, page?: number) =>
	readChanges(shadow, cursor, { page, now: new Date(Date.now() + 60_000) });

describe.sequential("conversation sync (CUR-4312)", () => {
	beforeEach(async () => {
		flag.on = true;
		await syncClientsPlugin().init?.({} as never);
		// The legacy bearer path asks Hugging Face who a token belongs to; it must find nobody.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await getDb().delete(schema.syncTombstones);
		await cleanupTestData();
	});
	afterAll(async () => {
		await getDb().delete(schema.oauthClient);
	});

	it("a sync token never authenticates the turn route", async () => {
		const { baId, shadow } = await owner();
		const token = await mintToken(baId);

		const onSync = await authenticateRequest(bearer(token), noCookies, new URL("http://localhost/chat/api/v2/sync/changes"));
		expect(onSync.user?._id.toString()).toBe(shadow.toString());
		expect(onSync.sync).toEqual({ clientId: CLIENT });

		for (const path of ["/chat/conversation/abc", "/chat/api/v2/conversations", "/chat/api/v2/user"]) {
			// Off the sync routes the token is an unknown bearer: the legacy path refuses it by throwing, or
			// at most leaves an anonymous request. Either way it never becomes the token's owner.
			const elsewhere = await authenticateRequest(bearer(token), noCookies, new URL(`http://localhost${path}`), true).catch(
				(e: Error) => e
			);
			if (elsewhere instanceof Error) {
				expect(elsewhere.message, path).toBe("Unauthorized");
				continue;
			}
			expect(elsewhere.user?._id.toString(), path).not.toBe(shadow.toString());
			expect(elsewhere.sync, path).toBeUndefined();
		}
	});

	it("a sync request carries its account's verified email, so a team-only flag can match it (an unverified one carries none)", async () => {
		const { baId } = await owner();
		const onSync = await authenticateRequest(bearer(await mintToken(baId)), noCookies, new URL("http://localhost/chat/api/v2/sync/changes"));
		expect(flagEmail(onSync.user)).toBe(`${baId}@example.org`);

		await getDb().update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, baId));
		const unverified = await authenticateRequest(bearer(await mintToken(baId)), noCookies, new URL("http://localhost/chat/api/v2/sync/changes"));
		expect(unverified.user).toBeDefined();
		expect(flagEmail(unverified.user)).toBeUndefined();
	});

	it("a sync token sent off the sync routes is refused before it can reach Hugging Face (CUR-4315)", async () => {
		const { baId } = await owner();
		const token = await mintToken(baId);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockClear();
		const err = await authenticateRequest(bearer(token), noCookies, new URL("http://localhost/chat/api/v2/user"), true).catch(
			(e: Error) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("Unauthorized");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("a token without conversations:sync is refused 403-shaped on the sync routes, and a revoked one 401-shaped", async () => {
		const { baId } = await owner();
		const narrow = await mintToken(baId, ["offline_access"]);
		const r1 = await authenticateRequest(bearer(narrow), noCookies, new URL("http://localhost/chat/api/v2/sync/push"));
		expect(r1.sync).toEqual({ error: "not_permitted" });
		expect(r1.user).toBeUndefined();

		const live = await mintToken(baId);
		await getDb().update(schema.oauthAccessToken).set({ revoked: new Date() });
		const r2 = await authenticateRequest(bearer(live), noCookies, new URL("http://localhost/chat/api/v2/sync/push"));
		expect(r2.sync).toEqual({ error: "unauthenticated" });
	});

	it("push is idempotent by clientId: a re-sent push creates nothing new", async () => {
		const { shadow } = await owner();
		const body = push({
			v: 1,
			conversations: [{ clientId: "tb-c1", title: "From Thunderbolt", createdAt: "2026-10-20T10:00:00.000Z" }],
			messages: [
				{ clientId: "tb-m1", conversationClientId: "tb-c1", role: "user", content: "hello", createdAt: "2026-10-20T10:00:01.000Z" },
				{ clientId: "tb-m2", conversationClientId: "tb-c1", role: "assistant", content: "hi", createdAt: "2026-10-20T10:00:02.000Z" },
			],
		});
		const first = await applyPush({ userId: shadow }, CLIENT, body, "test-model");
		const second = await applyPush({ userId: shadow }, CLIENT, body, "test-model");

		expect(second.conversations).toEqual(first.conversations);
		expect(second.messages).toEqual(first.messages);
		expect(first.rejected).toEqual([]);
		const convs = await collections.conversations.find({ userId: shadow }).toArray();
		expect(convs).toHaveLength(1);
		const msgs = convs[0].messages.filter((m) => m.from !== "system");
		expect(msgs.map((m) => [m.syncClientId, m.origin, m.content])).toEqual([
			["tb-m1", CLIENT, "hello"],
			["tb-m2", CLIENT, "hi"],
		]);
		// One branch: the answer hangs under the question, the question under the root.
		expect(msgs[1].ancestors?.at(-1)).toBe(msgs[0].id);
		expect(convs[0].syncOrigin).toBe(CLIENT);
		expect(msgs.every((m) => m.moderation === undefined)).toBe(true);
	});

	it("an id that names nothing of this account's is rejected, never inserted", async () => {
		const { shadow } = await owner();
		const other = await owner();
		const theirs = await applyPush({ userId: other.shadow }, CLIENT, push({ v: 1, conversations: [{ clientId: "x", title: "theirs" }] }), "m");
		const theirId = theirs.conversations[0].id;

		const out = await applyPush(
			{ userId: shadow },
			CLIENT,
			push({
				v: 1,
				conversations: [{ id: theirId, title: "mine now" }],
				messages: [{ id: "no-such-message", content: "x", role: "user" }],
			}),
			"m"
		);
		expect(out.conversations).toEqual([]);
		expect(out.rejected.map((r) => [r.kind, r.reason])).toEqual([
			["conversation", "not_found"],
			["message", "conversation_not_found"],
		]);
		expect(await collections.conversations.countDocuments({ userId: shadow })).toBe(0);
		const still = await collections.conversations.findOne({ _id: new ObjectId(theirId) });
		expect(still?.title).toBe("theirs");
	});

	it("a push may rename an Alpha conversation by its id, and the rename moves it in /changes", async () => {
		const { shadow } = await owner();
		const conv = await collections.conversations.insertOne({
			_id: new ObjectId(),
			title: "Alpha title",
			model: "m",
			messages: [],
			userId: shadow,
			createdAt: new Date("2026-10-01T00:00:00Z"),
			updatedAt: new Date("2026-10-01T00:00:00Z"),
		});
		const id = conv.insertedId.toString();
		const before = await read(shadow);
		expect(before.event.conversations.map((c) => [c.id, c.origin, c.clientId])).toEqual([[id, "alpha", null]]);

		await applyPush({ userId: shadow }, CLIENT, push({ v: 1, conversations: [{ id, title: "Renamed in Thunderbolt" }] }), "m");
		const after = await read(shadow, before.cursor);
		expect(after.event.conversations.map((c) => c.title)).toEqual(["Renamed in Thunderbolt"]);
	});

	it("tombstones round-trip: deletes pushed by a client come back in /changes with their clientId and origin", async () => {
		const { shadow } = await owner();
		await applyPush(
			{ userId: shadow },
			CLIENT,
			push({
				v: 1,
				conversations: [
					{ clientId: "keep", title: "keep" },
					{ clientId: "drop", title: "drop" },
				],
				messages: [
					{ clientId: "k1", conversationClientId: "keep", role: "user", content: "one" },
					{ clientId: "k2", conversationClientId: "keep", role: "user", content: "two" },
				],
			}),
			"m"
		);
		const start = await read(shadow);
		expect(start.event.conversations).toHaveLength(2);

		// Deletes carry only their ids.
		await applyPush(
			{ userId: shadow },
			CLIENT,
			push({
				v: 1,
				conversations: [{ clientId: "drop", deletedAt: "2026-10-21T00:00:00.000Z" }],
				messages: [{ clientId: "k2", deletedAt: "2026-10-21T00:00:00.000Z" }],
			}),
			"m"
		);
		const next = await read(shadow, start.cursor);
		expect(next.event.tombstones.map((t) => [t.kind, t.clientId, t.origin]).sort()).toEqual(
			[
				["conversation", "drop", CLIENT],
				["message", "k2", CLIENT],
			].sort()
		);
		expect(next.event.conversations.map((c) => c.messages.map((m) => m.clientId))).toEqual([["k1"]]);

		// A re-sent delete changes nothing: no rejection and no second tombstone.
		const again = await applyPush(
			{ userId: shadow },
			CLIENT,
			push({ v: 1, conversations: [{ clientId: "drop", deletedAt: "2026-10-21T00:00:00.000Z" }] }),
			"m"
		);
		expect(again.rejected).toEqual([]);
		const last = await read(shadow, next.cursor);
		expect(last.event.tombstones).toEqual([]);
	});

	it("a message deleted in Alpha leaves a tombstone only while the flag is on", async () => {
		const { shadow } = await owner();
		const locals = { user: { _id: shadow } } as App.Locals;
		const msg = { id: "alpha-msg", from: "user" as const, content: "x" };
		flag.on = false;
		await tombstoneMessages(locals, [msg], []);
		expect((await read(shadow)).event.tombstones).toEqual([]);
		flag.on = true;
		await tombstoneMessages(locals, [msg], []);
		const t = (await read(shadow)).event.tombstones;
		expect(t.map((x) => [x.kind, x.id, x.origin])).toEqual([["message", "alpha-msg", "alpha"]]);
	});

	it("/changes pages a backlog without skipping rows that share the page boundary", async () => {
		const { shadow } = await owner();
		const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s));
		for (let i = 0; i < 5; i++) {
			await collections.conversations.insertOne({
				_id: new ObjectId(),
				title: `c${i}`,
				model: "m",
				messages: [],
				userId: shadow,
				createdAt: at(i),
				// Two pairs share a millisecond: 0,1,1,2,2.
				updatedAt: at(Math.ceil(i / 2)),
			});
		}
		const seen: string[] = [];
		let cursor = START_CURSOR;
		for (let guard = 0; guard < 10; guard++) {
			const page = await read(shadow, cursor, 2);
			seen.push(...page.event.conversations.map((c) => c.title));
			cursor = page.cursor;
			if (!page.more) break;
		}
		expect(seen.sort()).toEqual(["c0", "c1", "c2", "c3", "c4"]);
	});

	it("/changes sends all 60 conversations and 60 tombstones that share one millisecond, each once, across pages", async () => {
		const { shadow } = await owner();
		const at = new Date("2026-10-02T00:00:00.000Z");
		for (let i = 0; i < 60; i++) {
			await collections.conversations.insertOne({
				_id: new ObjectId(),
				title: `same-ms ${i}`,
				model: "m",
				messages: [],
				userId: shadow,
				createdAt: at,
				updatedAt: at,
			});
		}
		// One call stamps every row with the same clock read.
		await writeTombstones(
			shadow.toString(),
			Array.from({ length: 60 }, (_, i) => ({ kind: "message" as const, entityId: `gone-${i}` }))
		);
		const convs: string[] = [];
		const tombs: string[] = [];
		let cursor = START_CURSOR;
		let pages = 0;
		while (pages < 10) {
			const page = await read(shadow, cursor);
			pages += 1;
			convs.push(...page.event.conversations.map((c) => c.title));
			tombs.push(...page.event.tombstones.map((t) => t.id));
			cursor = page.cursor;
			if (!page.more) break;
		}
		expect(pages, "60 rows at a 50-row page take more than one page").toBeGreaterThan(1);
		expect(convs).toHaveLength(60);
		expect(new Set(convs).size).toBe(60);
		expect(tombs).toHaveLength(60);
		expect(new Set(tombs).size).toBe(60);
	});

	it("a row stamped before a poll but committed after it still arrives on the next poll (safety lag)", async () => {
		const { shadow } = await owner();
		const t = Date.now();
		const conv = (title: string, ms: number) =>
			collections.conversations.insertOne({
				_id: new ObjectId(),
				title,
				model: "m",
				messages: [],
				userId: shadow,
				createdAt: new Date(ms),
				updatedAt: new Date(ms),
			});
		await conv("committed early", t - 100);
		const first = await readChanges(shadow, START_CURSOR, { now: new Date(t) });
		// A slow write stamped before that poll commits only now.
		await conv("committed late", t - 500);
		const second = await readChanges(shadow, first.cursor, { now: new Date(t + 5_000) });
		const seen = [...first.event.conversations, ...second.event.conversations].map((c) => c.title);
		expect(seen.sort()).toEqual(["committed early", "committed late"]);
	});

	it("a push re-stamps what it wrote once it commits, so a poll mid-push cannot pass it", async () => {
		const { shadow } = await owner();
		const stale = new Date(Date.now() - 3_600_000);
		await applyPush({ userId: shadow }, CLIENT, push({ v: 1, conversations: [{ clientId: "slow", title: "slow" }] }), "m", stale);
		const stored = await collections.conversations.findOne({ userId: shadow, syncClientId: "slow" });
		expect(new Date(stored!.updatedAt).getTime()).toBeGreaterThan(stale.getTime() + 3_000_000);
	});

	it("the Better Auth plugin's init is what registers thunderbolt-sandbox as an oauth_client", async () => {
		const db = getDb();
		await db.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.clientId, CLIENT));
		await db.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.clientId, CLIENT));
		await db.delete(schema.oauthConsent).where(eq(schema.oauthConsent.clientId, CLIENT));
		await db.delete(schema.oauthClient).where(eq(schema.oauthClient.clientId, CLIENT));
		expect(await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, CLIENT))).toHaveLength(0);
		await syncClientsPlugin().init?.({} as never);
		const rows = await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, CLIENT));
		expect(rows).toHaveLength(1);
		expect(rows[0].requirePKCE).toBe(true);
	});

	it("a client switched off in the database stays off when the seed runs again (CUR-4315)", async () => {
		const db = getDb();
		await db.update(schema.oauthClient).set({ disabled: true }).where(eq(schema.oauthClient.clientId, CLIENT));
		await syncClientsPlugin().init?.({} as never);
		const [row] = await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.clientId, CLIENT));
		expect(row.disabled).toBe(true);
	});

	it("a push may find at most 50 messages by scanning; the rest are refused too_many_lookups (CUR-4315)", async () => {
		const { shadow } = await owner();
		const n = 50 + 3;
		const body = push({
			v: 1,
			conversations: [],
			// A delete naming only a client id is the shape that has to scan for its conversation.
			messages: Array.from({ length: n }, (_, i) => ({ clientId: `orphan-${i}`, deletedAt: new Date().toISOString() })),
		});
		const out = await applyPush({ userId: shadow }, CLIENT, body, "test-model");
		const reasons = out.rejected.map((r) => r.reason);
		expect(reasons.filter((r) => r === "too_many_lookups")).toHaveLength(3);
		expect(reasons.filter((r) => r === "not_found")).toHaveLength(50);
	});
});
