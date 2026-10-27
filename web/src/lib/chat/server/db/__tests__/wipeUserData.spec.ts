/**
 * Coverage for wipeUserData — the GDPR "clear everything we hold about you" wipe behind the trash-all
 * (DELETE /api/v2/conversations). Asserts the two things that matter:
 *   1. Everything tied to the guest is cleared: conversations, settings, the session, and their own
 *      message_events + contributions (keyed by the userId the writers stamp, which for a guest is the
 *      sessionId).
 *   2. The ONE carve-out holds: safety reports are RETAINED (detached, with conversationId, userId
 *      and sessionId nulled), not deleted — and the returned summary counts what was cleared + retained for honest disclosure.
 * Also asserts scoping: another session's rows are untouched — INCLUDING when that session shares the
 * caller's IP. The wipe must not key message_events/contributions by ipHash, or one click from a campus
 * NAT would erase strangers' "Get involved" signups; the third test pins that.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { ObjectId } from "bson";

// hashIp's real value depends on a deploy-only pepper that SvelteKit's $env/dynamic/private doesn't
// surface in the vitest server workspace (it returns null with no pepper). Mock it so the seeds below
// carry a real-looking ipHash — the point of the shared-IP test is that the wipe ignores it.
vi.mock("$lib/chat/server/db/ipHash", () => ({
	hashIp: (ip: string | null | undefined, domain = "contribution") =>
		ip ? `h:${domain}:${ip}` : null,
}));

// Only the bucket delete is stubbed, so the account-wipe test below can see which guest
// folders the wipe reaches; the rest of the storage module stays real. (CUR-3292)
const { deleteCustodialFolders } = vi.hoisted(() => ({ deleteCustodialFolders: vi.fn(async () => 0) }));
vi.mock("$lib/chat/server/storage/custodialStorage", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/storage/custodialStorage")>()),
	deleteCustodialFolders,
}));

import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";
import { hashIp } from "$lib/chat/server/db/ipHash";
import { saveReport } from "$lib/chat/server/db/reports";
import { wipeUserData } from "$lib/chat/server/db/wipeUserData";
import {
	createTestLocals,
	createTestConversation,
	createTestUser,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";

async function seedSettings(sessionId: string) {
	await getDb().insert(schema.settings).values({ id: newId(), sessionId, doc: {} });
}
async function seedSession(sessionId: string) {
	await getDb().insert(schema.sessions).values({ id: newId(), sessionId, doc: {} });
}
// Seeds mirror the real writers: rateLimit.ts and api/contribute both stamp
// `userId = user._id ?? sessionId` alongside the ipHash.
async function seedMessageEvent(sessionId: string, ip: string) {
	await getDb().insert(schema.messageEvents).values({
		id: newId(),
		userId: sessionId,
		ipHash: hashIp(ip, "rate-limit"),
		type: "message",
		doc: {},
	});
}
async function seedContribution(sessionId: string, ip: string) {
	await getDb()
		.insert(schema.contributions)
		.values({
			id: newId(),
			kind: "subscribe",
			email: "x@example.com",
			userId: sessionId,
			ipHash: hashIp(ip, "contribution"),
		});
}

async function countSettings(sessionId: string) {
	return (
		await getDb()
			.select({ id: schema.settings.id })
			.from(schema.settings)
			.where(eq(schema.settings.sessionId, sessionId))
	).length;
}
async function countSessions(sessionId: string) {
	return (
		await getDb()
			.select({ id: schema.sessions.id })
			.from(schema.sessions)
			.where(eq(schema.sessions.sessionId, sessionId))
	).length;
}
async function countMessageEvents(sessionId: string) {
	return (
		await getDb()
			.select({ id: schema.messageEvents.id })
			.from(schema.messageEvents)
			.where(eq(schema.messageEvents.userId, sessionId))
	).length;
}
async function countContributions(sessionId: string) {
	return (
		await getDb()
			.select({ id: schema.contributions.id })
			.from(schema.contributions)
			.where(eq(schema.contributions.userId, sessionId))
	).length;
}

async function reportIdentity(id: string) {
	const [row] = await getDb()
		.select({
			conversationId: schema.reports.conversationId,
			userId: schema.reports.userId,
			sessionId: schema.reports.sessionId,
			reason: schema.reports.reason,
		})
		.from(schema.reports)
		.where(eq(schema.reports.id, id));
	return row;
}

describe.sequential("wipeUserData", () => {
	afterEach(async () => {
		// cleanupTestData sweeps conversations/sessions/settings/reports/contributions but NOT
		// message_events — clear it ourselves so rows don't leak into the next test.
		await getDb().delete(schema.messageEvents);
		await cleanupTestData();
	});

	// The account wipe deletes these rows before the shadow `users` row. The foreign keys make
	// any other order, or a row naming an account that does not exist, an error instead of an orphan. (CUR-769)
	it("refuses a settings or conversation row naming a user that does not exist, and a users delete that would orphan one", async () => {
		const ghost = newId();
		await expect(
			getDb().insert(schema.settings).values({ id: newId(), userId: ghost, doc: {} })
		).rejects.toThrow();
		await expect(
			getDb().insert(schema.conversations).values({ id: newId(), userId: ghost, doc: {} })
		).rejects.toThrow();

		const owner = newId();
		await getDb().insert(schema.users).values({ id: owner, doc: {} });
		await getDb().insert(schema.settings).values({ id: newId(), userId: owner, doc: {} });
		await expect(getDb().delete(schema.users).where(eq(schema.users.id, owner))).rejects.toThrow();

		const summary = await wipeUserData({ userId: owner, deleteAccount: true });
		expect(summary.settings).toBe(1);
		expect(await getDb().select().from(schema.users).where(eq(schema.users.id, owner))).toEqual([]);
	});

	it("clears a guest's data, RETAINS their safety report, and reports accurate counts", async () => {
		const sessionId = `wipe-${newId()}`;
		const ip = "203.0.113.7";
		const locals = createTestLocals({ sessionId });

		const conv = await createTestConversation(locals, { title: "To be wiped" });
		const convId = conv._id.toString();
		const report = await saveReport({ conversationId: convId, reason: "harmful", sessionId });
		await seedSettings(sessionId);
		await seedSession(sessionId);
		await seedMessageEvent(sessionId, ip);
		await seedContribution(sessionId, ip);

		try {
			const summary = await wipeUserData({ sessionId });

			// Summary is honest about what was cleared + the retained carve-out.
			expect(summary).toEqual({
				conversations: 1,
				settings: 1,
				messageEvents: 1,
				contributions: 1,
				localInferenceEndpoints: 0,
				storageLocations: 0,
				safetyEvents: 0,
				reportsRetained: 1,
				accountDeleted: false,
			});

			// Everything tied to the guest is gone...
			expect(await collections.conversations.countDocuments({ sessionId })).toBe(0);
			expect(await countSettings(sessionId)).toBe(0);
			expect(await countSessions(sessionId)).toBe(0);
			expect(await countMessageEvents(sessionId)).toBe(0);
			expect(await countContributions(sessionId)).toBe(0);

			// ...except the safety report, which survives with nothing pointing back to the person: the
			// done screen says so in as many words (CUR-2726).
			expect(await reportIdentity(report.id)).toEqual({
				conversationId: null,
				userId: null,
				sessionId: null,
				reason: "harmful",
			});
		} finally {
			await getDb().delete(schema.reports).where(eq(schema.reports.id, report.id));
		}
	});

	it("strips who filed a general report (no conversation) and counts it retained, and leaves another session's report its identity", async () => {
		const mine = `wipe-${newId()}`;
		const theirs = `keep-${newId()}`;
		const general = await saveReport({ category: "bug", detail: "broken", sessionId: mine });
		const other = await saveReport({ category: "bug", detail: "theirs", sessionId: theirs });

		try {
			const summary = await wipeUserData({ sessionId: mine });

			expect(summary.reportsRetained).toBe(1);
			expect(await reportIdentity(general.id)).toEqual({
				conversationId: null,
				userId: null,
				sessionId: null,
				reason: null,
			});
			expect((await reportIdentity(other.id))?.sessionId).toBe(theirs);
		} finally {
			await getDb()
				.delete(schema.reports)
				.where(inArray(schema.reports.id, [general.id, other.id]));
		}
	});

	// The wipe-coverage contract for safety_events: only kind = 'child_safety' survives an account
	// wipe. A privacy decline (Coop action chat-block-privacy, kind content_policy) is deleted with the
	// account.
	it("deletes the caller's non-child-safety decline records, RETAINS child-safety ones, and leaves other users' rows", async () => {
		const me = newId();
		const other = newId();
		const seed = (userId: string, kind: "child_safety" | "content_policy", label: string) =>
			getDb().insert(schema.safetyEvents).values({ id: newId(), userId, kind, label }).returning({ id: schema.safetyEvents.id });
		const [privacy] = await seed(me, "content_policy", "chat-block-privacy");
		const [child] = await seed(me, "child_safety", "child_safety");
		const [theirs] = await seed(other, "content_policy", "chat-block-privacy");
		const alive = async (id: string) =>
			(await getDb().select({ id: schema.safetyEvents.id }).from(schema.safetyEvents).where(eq(schema.safetyEvents.id, id))).length;

		try {
			const summary = await wipeUserData({ userId: me });
			expect(summary.safetyEvents).toBe(1);
			expect(await alive(privacy.id)).toBe(0);
			expect(await alive(child.id)).toBe(1);
			expect(await alive(theirs.id)).toBe(1);
		} finally {
			await getDb().delete(schema.safetyEvents).where(inArray(schema.safetyEvents.id, [privacy.id, child.id, theirs.id]));
		}
	});

	it("only touches the targeted guest — another session/IP is left intact", async () => {
		const mine = `wipe-${newId()}`;
		const theirs = `keep-${newId()}`;
		const myIp = "203.0.113.7";
		const theirIp = "198.51.100.9";

		await createTestConversation(createTestLocals({ sessionId: mine }), { title: "mine" });
		await createTestConversation(createTestLocals({ sessionId: theirs }), { title: "theirs" });
		await seedSettings(mine);
		await seedSettings(theirs);
		await seedMessageEvent(mine, myIp);
		await seedMessageEvent(theirs, theirIp);

		const summary = await wipeUserData({ sessionId: mine });

		expect(summary.conversations).toBe(1);
		// The other guest's rows are untouched.
		expect(await collections.conversations.countDocuments({ sessionId: theirs })).toBe(1);
		expect(await countSettings(theirs)).toBe(1);
		expect(await countMessageEvents(theirs)).toBe(1);
	});

	it("leaves a stranger's signup and rate-limit rows alone when they share the caller's IP", async () => {
		const mine = `wipe-${newId()}`;
		const theirs = `keep-${newId()}`;
		const sharedIp = "203.0.113.7"; // campus NAT / carrier CGNAT: one IP, many people

		await seedMessageEvent(mine, sharedIp);
		await seedMessageEvent(theirs, sharedIp);
		await seedContribution(mine, sharedIp);
		await seedContribution(theirs, sharedIp);

		const summary = await wipeUserData({ sessionId: mine });

		expect(summary.messageEvents).toBe(1);
		expect(summary.contributions).toBe(1);
		expect(await countMessageEvents(theirs)).toBe(1);
		expect(await countContributions(theirs)).toBe(1);
	});

	// "Forget everything" and "Delete account" are separate actions. A signed-in wipe that does
	// not ask for the account clears the data and leaves the person signed in: shadow row, Better Auth
	// user, linked provider and the session row carrying their userId all survive. (CUR-1420)
	it("deletes the guest folder each moved conversation started in, on an account wipe (CUR-3292)", async () => {
		deleteCustodialFolders.mockClear();
		const { user, locals } = await createTestUser();
		const former = "c".repeat(64);
		const moved = (await createTestConversation(locals, { title: "Moved", formerGuestSessionId: former }))._id.toString();

		await wipeUserData({ userId: user._id.toString(), sessionId: locals.sessionId });

		expect(deleteCustodialFolders).toHaveBeenCalledWith(former, "conversations", [moved], "guests");
		expect(await collections.conversations.countDocuments({ _id: new ObjectId(moved) })).toBe(0);
	});

	it("keeps the account and the signed-in session when the wipe does not ask to delete the account", async () => {
		const shadowId = newId();
		const betterAuthUserId = `ba_${newId()}`;
		const sessionId = `sess-${newId()}`;
		await getDb()
			.insert(schema.users)
			.values({ id: shadowId, doc: { name: "Ada", email: "ada-keep@example.com", betterAuthUserId } });
		await getDb()
			.insert(schema.user)
			.values({ id: betterAuthUserId, name: "Ada", email: "ada-keep@example.com", emailVerified: false });
		await getDb()
			.insert(schema.account)
			.values({ id: newId(), issuer: "https://huggingface.co", accountId: "hf-keep-1", providerId: "huggingface", userId: betterAuthUserId });
		await getDb()
			.insert(schema.sessions)
			.values({ id: newId(), sessionId, userId: shadowId, expiresAt: new Date(Date.now() + 3600_000), doc: {} });

		try {
			const summary = await wipeUserData({ userId: shadowId, sessionId });

			expect(summary.accountDeleted).toBe(false);
			expect(await getDb().select().from(schema.users).where(eq(schema.users.id, shadowId))).toHaveLength(1);
			expect(await getDb().select().from(schema.user).where(eq(schema.user.id, betterAuthUserId))).toHaveLength(1);
			expect(
				await getDb().select().from(schema.account).where(eq(schema.account.userId, betterAuthUserId))
			).toHaveLength(1);
			expect(
				await getDb().select().from(schema.sessions).where(eq(schema.sessions.sessionId, sessionId)),
				"deleting the session row that carries the userId signs the person out"
			).toHaveLength(1);
		} finally {
			await getDb().delete(schema.sessions).where(eq(schema.sessions.sessionId, sessionId));
			await getDb().delete(schema.account).where(eq(schema.account.userId, betterAuthUserId));
			await getDb().delete(schema.user).where(eq(schema.user.id, betterAuthUserId));
			await getDb().delete(schema.users).where(eq(schema.users.id, shadowId));
		}
	});

	// An account wipe has to reach rows keyed by TWO identifier spaces this file's guest tests
	// never touch — Better Auth's own user.id (stored on the shadow row as betterAuthUserId, since it
	// can't be recovered from _id, a one-way hash of it) and the raw Hugging Face user id (token_caches).
	// Real DB round-trip rather than a mock, on purpose: this is exactly the class of bug — the right
	// mock, the wrong key — a mocked test would not have caught. (CUR-434)
	it("deletes the shadow row and every linked Better Auth / bearer-token row on an account wipe", async () => {
		const shadowId = newId();
		const betterAuthUserId = `ba_${newId()}`;
		const hfUserId = `hf_${newId()}`;

		await getDb()
			.insert(schema.users)
			.values({
				id: shadowId,
				hfUserId,
				doc: { name: "Ada", email: "ada@example.com", betterAuthUserId },
			});
		await getDb()
			.insert(schema.user)
			.values({ id: betterAuthUserId, name: "Ada", email: "ada@example.com", emailVerified: false });
		await getDb()
			.insert(schema.account)
			.values({
				id: newId(),
				issuer: "https://huggingface.co",
				accountId: "hf-account-1",
				providerId: "huggingface",
				userId: betterAuthUserId,
			});
		await getDb()
			.insert(schema.passkey)
			.values({
				id: newId(),
				publicKey: "pub",
				userId: betterAuthUserId,
				credentialID: "cred-1",
				counter: 0,
				deviceType: "singleDevice",
				backedUp: false,
			});
		await getDb()
			.insert(schema.session)
			.values({
				id: newId(),
				token: `tok_${newId()}`,
				expiresAt: new Date(Date.now() + 3600_000),
				userId: betterAuthUserId,
			});
		await getDb()
			.insert(schema.tokenCaches)
			.values({ id: newId(), tokenHash: "hash1", userId: hfUserId, doc: {} });
		// Keyed on the shadow row's userId, not email — the same identity space every other per-user
		// table here uses (CUR-1194).
		await getDb()
			.insert(schema.localInferenceEndpoints)
			.values({ id: newId(), userId: shadowId, label: "local", baseUrl: "http://localhost:11434/v1" });

		const summary = await wipeUserData({ userId: shadowId, deleteAccount: true });

		expect(summary.accountDeleted).toBe(true);
		expect(summary.localInferenceEndpoints).toBe(1);
		expect(
			await getDb()
				.select()
				.from(schema.localInferenceEndpoints)
				.where(eq(schema.localInferenceEndpoints.userId, shadowId))
		).toHaveLength(0);
		expect(
			await getDb().select().from(schema.users).where(eq(schema.users.id, shadowId))
		).toHaveLength(0);
		expect(
			await getDb().select().from(schema.user).where(eq(schema.user.id, betterAuthUserId))
		).toHaveLength(0);
		expect(
			await getDb().select().from(schema.account).where(eq(schema.account.userId, betterAuthUserId))
		).toHaveLength(0);
		expect(
			await getDb().select().from(schema.passkey).where(eq(schema.passkey.userId, betterAuthUserId))
		).toHaveLength(0);
		expect(
			await getDb().select().from(schema.session).where(eq(schema.session.userId, betterAuthUserId))
		).toHaveLength(0);
		expect(
			await getDb()
				.select()
				.from(schema.tokenCaches)
				.where(eq(schema.tokenCaches.userId, hfUserId))
		).toHaveLength(0);
	});

	// A legacy `sessions` row naming the account must not survive the wipe: its foreign key would then
	// refuse the shadow delete after the Better Auth user is already gone (CUR-2925).
	async function seedAccount(email: string) {
		const shadowId = newId();
		const betterAuthUserId = `ba_${newId()}`;
		await getDb().insert(schema.users).values({ id: shadowId, doc: { email, betterAuthUserId } });
		await getDb().insert(schema.user).values({ id: betterAuthUserId, name: "Ada", email, emailVerified: false });
		return { shadowId, betterAuthUserId };
	}

	it("deletes every session row naming the account, then the account, without an error", async () => {
		const { shadowId, betterAuthUserId } = await seedAccount("ada-sessions@example.com");
		for (const sessionId of [newId(), newId()]) {
			await getDb().insert(schema.sessions).values({ id: newId(), sessionId, userId: shadowId, doc: {} });
		}

		const summary = await wipeUserData({ userId: shadowId, deleteAccount: true });

		expect(summary.accountDeleted).toBe(true);
		expect(await getDb().select().from(schema.sessions).where(eq(schema.sessions.userId, shadowId))).toEqual([]);
		expect(await getDb().select().from(schema.users).where(eq(schema.users.id, shadowId))).toEqual([]);
		expect(await getDb().select().from(schema.user).where(eq(schema.user.id, betterAuthUserId))).toEqual([]);
	});

	it("keeps the Better Auth user when the shadow delete fails, so the person can still sign in and retry", async () => {
		const { shadowId, betterAuthUserId } = await seedAccount("ada-rollback@example.com");
		// A row the wipe does not know about, holding a foreign key to the shadow row, makes its delete fail.
		await getDb().execute(sql`create table if not exists wipe_blocker (user_id text references users(id))`);
		try {
			await getDb().execute(sql`insert into wipe_blocker (user_id) values (${shadowId})`);

			await expect(wipeUserData({ userId: shadowId, deleteAccount: true })).rejects.toThrow();

			expect(await getDb().select().from(schema.user).where(eq(schema.user.id, betterAuthUserId))).toHaveLength(1);
			expect(await getDb().select().from(schema.users).where(eq(schema.users.id, shadowId))).toHaveLength(1);
		} finally {
			await getDb().execute(sql`drop table if exists wipe_blocker`);
			await getDb().delete(schema.user).where(eq(schema.user.id, betterAuthUserId));
			await getDb().delete(schema.users).where(eq(schema.users.id, shadowId));
		}
	});
});
