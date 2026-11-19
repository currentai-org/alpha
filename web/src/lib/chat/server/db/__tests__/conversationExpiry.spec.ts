/**
 * Conversation expiry deletes people's conversations, so each test here names the promise it
 * keeps. They run sweepExpiredConversations() against the real conversations table at fixed times:
 * launch day L, then L + 29 and L + 31 days. Every conversation is in scope: signed in or a guest's,
 * pinned, sealed. My files' half is in storage/custodialStorage.spec.ts (sweepExpiredGuestFiles, root "users").
 */
import { describe, expect, it, afterEach } from "vitest";
import { inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import {
	countExpiringConversations,
	sweepExpiredConversations,
} from "$lib/chat/server/conversationExpiry";
import { conversationExpiresAt, daysUntil } from "$lib/chat/constants/retention";
import type { Conversation } from "$lib/chat/types/Conversation";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";

const DAY = 24 * 60 * 60 * 1000;
const launch = new Date("2031-03-01T03:00:00Z");
const at = (days: number) => new Date(launch.getTime() + days * DAY);
const on = () => true;

async function stillThere(ids: string[]): Promise<string[]> {
	const rows = await getDb()
		.select({ id: schema.conversations.id })
		.from(schema.conversations)
		.where(inArray(schema.conversations.id, ids));
	return rows.map((r) => r.id).sort();
}

async function signedInConversation(createdAt: Date, extra: Partial<Conversation> = {}): Promise<string> {
	const { locals } = await createTestUser();
	const conv = await createTestConversation(locals, { createdAt, updatedAt: createdAt, ...extra });
	return conv._id.toString();
}

describe.sequential("conversation expiry", () => {
	afterEach(async () => {
		// A flag-off run clears the launch marker.
		await sweepExpiredConversations(launch);
		await cleanupTestData();
	});

	it("deletes nothing while the flag is off, and clears the launch marker", async () => {
		// Flag on once, to set a launch marker, so the off run has one to clear.
		await sweepExpiredConversations(launch, on);
		const old = await signedInConversation(at(-400));

		// No `enabled` argument: the real flag read, which is off without PostHog.
		const result = await sweepExpiredConversations(at(400));

		expect(result).toEqual({ mode: "refused", reason: "flag-off", deleted: 0 });
		expect(await stillThere([old])).toEqual([old]);
		expect((await countExpiringConversations(at(400))).launchedAt).toBeNull();
	});

	it("never deletes a conversation created within 30 days", async () => {
		await sweepExpiredConversations(launch, on);
		const young = await signedInConversation(at(2)); // 29 days old at L + 31

		await sweepExpiredConversations(at(31), on);

		expect(await stillThere([young])).toEqual([young]);
	});

	it("deletes a signed-in conversation created 31 days ago", async () => {
		await sweepExpiredConversations(launch, on);
		const old = await signedInConversation(at(0)); // 31 days old at L + 31

		const result = await sweepExpiredConversations(at(31), on);

		expect(await stillThere([old])).toEqual([]);
		expect(result.deleted).toBeGreaterThanOrEqual(1);
	});

	it("gives a conversation from before launch the full 30 days from launch day, never fewer", async () => {
		const ancient = await signedInConversation(at(-100));
		await sweepExpiredConversations(launch, on); // launch day: records L, deletes nothing

		await sweepExpiredConversations(at(29), on);
		expect(await stillThere([ancient]), "deleted before its 30 days from launch were up").toEqual([ancient]);

		await sweepExpiredConversations(at(31), on);
		expect(await stillThere([ancient])).toEqual([]);
	});

	it("keeps the launch day it first recorded: a later run never moves it", async () => {
		await sweepExpiredConversations(launch, on);
		await sweepExpiredConversations(at(5), on);
		expect((await countExpiringConversations(at(5))).launchedAt).toBe(launch.toISOString());
	});

	it("deletes a guest's, a pinned and a sealed conversation 31 days after creation, like any other", async () => {
		await sweepExpiredConversations(launch, on);
		// The guest's was active yesterday: activity does not extend the window, creation starts it.
		const guest = (
			await createTestConversation(createTestLocals({ sessionId: `cur4990-${crypto.randomUUID()}` }), {
				createdAt: at(0),
				updatedAt: at(30),
			})
		)._id.toString();
		const pinned = await signedInConversation(at(0), { pinned: true });
		const sealed = await signedInConversation(at(0), { sealedTitle: "age-encryption.org/v1 …" });

		await sweepExpiredConversations(at(29), on);
		expect(await stillThere([guest, pinned, sealed]), "deleted before 30 days").toEqual([guest, pinned, sealed].sort());

		await sweepExpiredConversations(at(31), on);
		expect(await stillThere([guest, pinned, sealed])).toEqual([]);
	});

	it("deletes every due conversation in one run and reports nothing left over", async () => {
		await sweepExpiredConversations(launch, on);
		const { locals } = await createTestUser();
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await createTestConversation(locals, { createdAt: at(0), updatedAt: at(0) }))._id.toString());

		const result = await sweepExpiredConversations(at(31), on);

		expect(await stillThere(ids)).toEqual([]);
		expect(result.mode === "swept" && result.more).toBe(false);
	});

	it("dry run counts by age and deletes nothing, with the flag on or off", async () => {
		await sweepExpiredConversations(launch, on);
		const ids = [await signedInConversation(at(-40)), await signedInConversation(at(-3))];

		const counts = await countExpiringConversations(at(31));

		expect(await stillThere(ids)).toEqual([...ids].sort());
		expect(counts.mode).toBe("dry-run");
		expect(counts.wouldDeleteNow).toBeGreaterThanOrEqual(2);
		expect(counts.byAgeDays.from60to89).toBeGreaterThanOrEqual(1);
		// Aggregates only: no field can carry an id, a user or a title.
		for (const v of Object.values(counts.byAgeDays)) expect(typeof v).toBe("number");
		expect(JSON.stringify(counts)).not.toContain(ids[0]);
	});

	it("the page's days-left date agrees with the sweep at the boundary", async () => {
		await sweepExpiredConversations(launch, on);
		const created = at(3);
		const id = await signedInConversation(created);
		const expires = conversationExpiresAt(created, launch, at(3));
		expect(daysUntil(expires, at(3))).toBe(30);

		await sweepExpiredConversations(new Date(expires.getTime() - 60_000), on);
		expect(await stillThere([id]), "the sweep deleted it before the date the page shows").toEqual([id]);
		await sweepExpiredConversations(new Date(expires.getTime() + 60_000), on);
		expect(await stillThere([id])).toEqual([]);
	});
});
