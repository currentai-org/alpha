/**
 * A self-hosted Alpha's own daily timer deletes expired guest conversations and guest files,
 * against the real database and the `local` custodial backend in a fresh directory (the store a
 * self-host's compose file can use). The schedule runs with its default run, the one the server starts
 * at boot, so this covers the in-process path end to end; only the first run's delay is shortened.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";

const dir = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	return mkdtempSync(join(tmpdir(), "daily-cleanup-stateful-"));
});

// The real config with the custodial store answered here: the local-disk backend in that directory.
vi.mock("$lib/chat/server/config", async (importOriginal) => {
	const real = await importOriginal<typeof import("$lib/chat/server/config")>();
	const local: Record<string, string> = { CUSTODIAL_STORAGE_BACKEND: "local", CUSTODIAL_LOCAL_DIR: dir };
	return {
		...real,
		config: new Proxy(real.config, {
			get: (target, prop, receiver) => (typeof prop === "string" && prop in local ? local[prop] : Reflect.get(target, prop, receiver)),
		}),
	};
});

import { startDailyCleanupSchedule } from "$lib/chat/server/dailyCleanupSchedule";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { RETENTION_MS } from "$lib/chat/constants/retention";
import { cleanupTestData, createTestConversation, createTestLocals } from "$lib/chat/server/api/__tests__/testHelpers";

const DAY = 24 * 60 * 60 * 1000;

async function conversationExists(id: string): Promise<boolean> {
	const rows = await getDb().select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.id, id));
	return rows.length > 0;
}

async function storedFile(relPath: string, ageMs: number): Promise<string> {
	const full = path.join(dir, relPath);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, "ciphertext");
	const when = new Date(Date.now() - ageMs);
	await utimes(full, when, when);
	return full;
}

describe.sequential("self-host daily cleanup schedule — deletes expired guest data in process", () => {
	beforeAll(async () => {
		await cleanupTestData();
	});
	afterAll(async () => {
		await cleanupTestData();
		rmSync(dir, { recursive: true, force: true });
	});

	it("its scheduled run deletes a guest conversation and a guest file past retention, and keeps recent ones", async () => {
		const sid = "e".repeat(64);
		const guest = createTestLocals({ sessionId: sid });
		const past = new Date(Date.now() - RETENTION_MS - DAY);
		const expired = await createTestConversation(guest, { createdAt: past, updatedAt: past });
		const recent = await createTestConversation(guest);
		const oldFile = await storedFile(`guests/${sid}/conversations/c/s/old.txt`, RETENTION_MS + DAY);
		const newFile = await storedFile(`guests/${sid}/conversations/c/s/new.txt`, DAY);
		expect(await conversationExists(expired._id.toString())).toBe(true);

		const stop = startDailyCleanupSchedule({ dev: false, onVercel: false, firstDelayMs: 10 });
		expect(stop).not.toBeNull();
		try {
			await vi.waitFor(
				async () => {
					expect(existsSync(oldFile)).toBe(false);
					expect(await conversationExists(expired._id.toString())).toBe(false);
				},
				{ timeout: 20_000, interval: 200 }
			);
		} finally {
			stop!();
		}
		expect(await conversationExists(recent._id.toString())).toBe(true);
		expect(existsSync(newFile)).toBe(true);
	});
});
