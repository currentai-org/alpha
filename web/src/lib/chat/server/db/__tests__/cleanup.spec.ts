/**
 * The retention note tells every guest their chats are deleted after 30 days, and nothing
 * checked that the nightly sweep does it. These tests run cleanupExpired() against the real
 * conversations table at a fixed `now`. They stop short of the cron route, whose second half sweeps
 * guest files in object storage. (CUR-2796)
 */
import { describe, expect, it, afterEach } from "vitest";
import { inArray } from "drizzle-orm";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { saveReport } from "$lib/chat/server/db/reports";
import { cleanupExpired } from "$lib/chat/server/db/cleanup";
import { RETENTION_MS, SAFETY_RECORD_RETENTION_DAYS } from "$lib/chat/constants/retention";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";

const now = new Date("2026-10-06T03:00:00Z");
const pastRetention = new Date(now.getTime() - RETENTION_MS - 60_000);
const insideRetention = new Date(now.getTime() - RETENTION_MS + 60 * 60_000);

async function stillThere(ids: string[]): Promise<string[]> {
	const rows = await getDb()
		.select({ id: schema.conversations.id })
		.from(schema.conversations)
		.where(inArray(schema.conversations.id, ids));
	return rows.map((r) => r.id).sort();
}

describe.sequential("cleanupExpired: guest conversation retention (CUR-2796)", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("deletes a guest's conversation untouched for longer than the retention window", async () => {
		const guest = createTestLocals({ sessionId: `cur2796-guest-${crypto.randomUUID()}` });
		const old = await createTestConversation(guest, { updatedAt: pastRetention });
		const id = old._id.toString();
		// A report holds a foreign key to the conversation, so the sweep has to clear it first.
		await saveReport({ conversationId: id, reason: "harmful", sessionId: guest.sessionId });

		const counts = await cleanupExpired(now);

		expect(await stillThere([id])).toEqual([]);
		expect(counts.conversations).toBeGreaterThanOrEqual(1);
	});

	it("keeps a guest's conversation still inside the window, and a signed-in person's however old", async () => {
		const guest = createTestLocals({ sessionId: `cur2796-guest-${crypto.randomUUID()}` });
		const recent = await createTestConversation(guest, { updatedAt: insideRetention });
		const { locals: account } = await createTestUser();
		const accountOld = await createTestConversation(account, { updatedAt: pastRetention });
		const ids = [recent._id.toString(), accountOld._id.toString()];

		await cleanupExpired(now);

		expect(await stillThere(ids)).toEqual([...ids].sort());
		expect(await collections.conversations.countDocuments({ _id: accountOld._id })).toBe(1);
	});
});

const DAY_MS = 24 * 60 * 60 * 1000;
type SafetyKind = (typeof schema.safetyEvents.kind.enumValues)[number];

describe.sequential("cleanupExpired: safety record retention (CUR-4428)", () => {
	const seeded: string[] = [];

	afterEach(async () => {
		if (seeded.length) await getDb().delete(schema.safetyEvents).where(inArray(schema.safetyEvents.id, seeded));
		seeded.length = 0;
	});

	async function seed(kind: SafetyKind, ageDays: number): Promise<string> {
		const id = `cur4428-${kind}-${ageDays}-${crypto.randomUUID()}`;
		await getDb()
			.insert(schema.safetyEvents)
			.values({ id, kind, label: "test", createdAt: new Date(now.getTime() - ageDays * DAY_MS) });
		seeded.push(id);
		return id;
	}

	it("deletes only non-child-safety records older than 60 days, and never a child_safety record of any age", async () => {
		expect(SAFETY_RECORD_RETENTION_DAYS).toBe(60);
		const kinds = schema.safetyEvents.kind.enumValues;
		const expected: string[] = [];
		const swept: string[] = [];
		for (const kind of kinds) {
			const young = await seed(kind, SAFETY_RECORD_RETENTION_DAYS - 1);
			const old = await seed(kind, SAFETY_RECORD_RETENTION_DAYS + 1);
			expected.push(young);
			if (kind === "child_safety") expected.push(old);
			else swept.push(old);
		}
		expected.push(await seed("child_safety", 3650));

		const counts = await cleanupExpired(now);

		const left = await getDb()
			.select({ id: schema.safetyEvents.id })
			.from(schema.safetyEvents)
			.where(inArray(schema.safetyEvents.id, seeded));
		expect(left.map((r) => r.id).sort()).toEqual([...expected].sort());
		expect(counts.safetyEvents).toBeGreaterThanOrEqual(swept.length);
	});
});
