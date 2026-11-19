/**
 * previewWipe is the confirm panel's count, and wipeUserData is the receipt's. Both read their rows
 * through wipeScope, so for the same caller the two must agree bucket for bucket, and the
 * preview must count only the caller's own rows, never another session's.
 */
import { describe, expect, it, afterEach, vi } from "vitest";

// The bucket listing is the wipe's own; stubbed here so the preview's handling of it can be driven.
const { countFiles } = vi.hoisted(() => ({ countFiles: vi.fn(async (): Promise<number | undefined> => undefined) }));
vi.mock("$lib/chat/server/storage/custodialStorage", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/storage/custodialStorage")>()),
	countCustodialFilesForWipe: countFiles,
}));
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";
import { previewWipe } from "$lib/chat/server/db/wipeScope";
import { wipeUserData } from "$lib/chat/server/db/wipeUserData";
import {
	createTestLocals,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";

async function seed(sessionId: string, conversations: number) {
	for (let i = 0; i < conversations; i++) {
		await createTestConversation(createTestLocals({ sessionId }), { title: `chat ${i}` });
	}
	await getDb().insert(schema.settings).values({ id: newId(), sessionId, doc: {} });
	await getDb().insert(schema.messageEvents).values({ id: newId(), userId: sessionId, type: "message", doc: {} });
	await getDb().insert(schema.messageEvents).values({ id: newId(), userId: sessionId, type: "message", doc: {} });
}

describe.sequential("previewWipe", () => {
	afterEach(async () => {
		countFiles.mockClear();
		await getDb().delete(schema.messageEvents);
		await cleanupTestData();
	});

	it("counts exactly what the wipe's own summary then reports, bucket for bucket", async () => {
		const mine = `mine-${newId()}`;
		await seed(mine, 2);
		const preview = await previewWipe({ sessionId: mine });
		const summary = await wipeUserData({ sessionId: mine });
		expect(preview).toEqual({
			conversations: 2,
			settings: 1,
			messageEvents: 2,
			contributions: 0,
			localInferenceEndpoints: 0,
			storageLocations: 0,
			safetyEvents: 0,
			accountDeleted: false,
			agentHistoryPossible: false,
		});
		// The database buckets, which both sides read through wipeScope. Files and agent history come from outside it.
		const dbBuckets = [
			"conversations",
			"settings",
			"messageEvents",
			"contributions",
			"localInferenceEndpoints",
			"storageLocations",
			"safetyEvents",
			"accountDeleted",
		] as const;
		for (const key of dbBuckets) {
			expect(preview[key], `preview.${key} differs from the receipt`).toEqual(summary[key]);
		}
	});

	it("counts only the caller's own rows and leaves the other session's out", async () => {
		const mine = `mine-${newId()}`;
		const theirs = `theirs-${newId()}`;
		await seed(mine, 1);
		await seed(theirs, 3);
		const preview = await previewWipe({ sessionId: mine });
		expect(preview.conversations).toBe(1);
		expect(preview.messageEvents).toBe(2);
		expect((await previewWipe({ sessionId: theirs })).conversations).toBe(3);
	});

	it("deletes nothing: a second preview after the first reads the same counts", async () => {
		const mine = `mine-${newId()}`;
		await seed(mine, 1);
		const first = await previewWipe({ sessionId: mine });
		expect(await previewWipe({ sessionId: mine })).toEqual(first);
	});

	it("counts nothing, rather than everything, when the caller has no identity", async () => {
		await seed(`other-${newId()}`, 1);
		const preview = await previewWipe({});
		expect(preview.conversations).toBe(0);
		expect(preview.messageEvents).toBe(0);
		expect(preview.accountDeleted).toBe(false);
	});

	it("carries the uploaded-file count for a signed-in caller, and no count (not zero) when the listing fails", async () => {
		countFiles.mockResolvedValueOnce(3);
		expect((await previewWipe({ userId: "u-files" })).custodialFiles).toBe(3);
		countFiles.mockRejectedValueOnce(new Error("hub down"));
		expect((await previewWipe({ userId: "u-files" })).custodialFiles).toBeUndefined();
	});

	it("never lists files for a guest, who has no account folder", async () => {
		await previewWipe({ sessionId: `guest-${newId()}` });
		expect(countFiles).not.toHaveBeenCalled();
	});
});
