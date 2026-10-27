/**
 * Regression coverage for deleteConversationsCascade — the FK-ordered delete. `reports.conversationId`
 * is an FK to `conversations.id` with no ON DELETE, and `files.conversationId` references it too, so a bare
 * conversation delete throws a foreign-key violation the moment a conversation has a report or a
 * file. The headline test below seeds BOTH a report and a file against a conversation, then deletes
 * it — the path a bare delete cannot survive.
 *
 * COMPLIANCE CARVE-OUT: safety reports are RETAINED, not deleted, when a
 * conversation is deleted — the cascade DETACHES them (nulls conversationId) so the safety record
 * survives the chat. These tests assert the report ROW still exists by id (with conversationId
 * null), not that it's gone.
 */
import { describe, expect, it, afterEach, vi } from "vitest";

// The bucket half of the cascade is mocked; custodialStorage.spec.ts owns its listing logic. (CUR-2183)
const { deleteCustodialFolders } = vi.hoisted(() => ({ deleteCustodialFolders: vi.fn() }));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({ deleteCustodialFolders }));
// The agent-service half is mocked; deleteAgentServiceData.spec.ts owns the request. (CUR-4484)
const { deleteAgentSessions } = vi.hoisted(() => ({
	deleteAgentSessions: vi.fn(async (_visitor: string | undefined, _ids: string[]) => 0 as number | undefined),
}));
vi.mock("$lib/chat/server/deleteAgentServiceData", () => ({ deleteAgentSessions }));
import { ObjectId } from "bson";
import { eq, inArray } from "drizzle-orm";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";
import { saveReport } from "$lib/chat/server/db/reports";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import { AbortRegistry } from "$lib/chat/server/abortRegistry";
import { openDurableElicitation } from "$lib/chat/server/mcp/elicitation";
import { formInputRequired } from "$lib/chat/server/mcp/testFixtures";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";

// cleanupTestData only sweeps the Mongo-adapter collections; reports/files are normalized tables
// outside the adapter, so the tests that touch them clean up after themselves.
async function deleteReportsFor(ids: string[]) {
	if (!ids.length) return;
	await getDb().delete(schema.reports).where(inArray(schema.reports.conversationId, ids));
}
async function deleteFilesFor(ids: string[]) {
	if (!ids.length) return;
	await getDb().delete(schema.files).where(inArray(schema.files.conversationId, ids));
}

async function reportCountFor(convId: string): Promise<number> {
	const rows = await getDb()
		.select({ id: schema.reports.id })
		.from(schema.reports)
		.where(inArray(schema.reports.conversationId, [convId]));
	return rows.length;
}

/** Fetch a report by its primary key — used to assert RETENTION (row survives, conversationId nulled). */
async function getReportById(
	id: string
): Promise<{ id: string; conversationId: string | null } | undefined> {
	const rows = await getDb()
		.select({ id: schema.reports.id, conversationId: schema.reports.conversationId })
		.from(schema.reports)
		.where(eq(schema.reports.id, id));
	return rows[0];
}

async function deleteReportById(id: string) {
	await getDb().delete(schema.reports).where(eq(schema.reports.id, id));
}

async function insertFile(conversationId: string): Promise<string> {
	const id = newId();
	await getDb()
		.insert(schema.files)
		.values({
			id,
			filename: "attachment.txt",
			conversationId,
			mime: "text/plain",
			data: Buffer.from("hello"),
		});
	return id;
}

describe.sequential("deleteConversationsCascade", () => {
	afterEach(async () => {
		await cleanupTestData();
		deleteCustodialFolders.mockReset();
	});

	it("deletes the owner's My files attachment folders for every conversation, before the rows (CUR-2183)", async () => {
		const { locals } = await createTestUser();
		const a = (await createTestConversation(locals, { title: "A" }))._id.toString();
		const b = (await createTestConversation(locals, { title: "B" }))._id.toString();
		let rowsWhenBucketCalled = -1;
		deleteCustodialFolders.mockImplementation(async () => {
			// Count only this test's two rows: another stateful file in the same database can leave its own.
			rowsWhenBucketCalled =
				(await collections.conversations.countDocuments({ _id: new ObjectId(a) })) +
				(await collections.conversations.countDocuments({ _id: new ObjectId(b) }));
			return 2;
		});

		expect(await deleteConversationsCascade([a, b], "owner-1")).toBe(2);
		expect(deleteCustodialFolders).toHaveBeenCalledWith("owner-1", "conversations", [a, b]);
		expect(rowsWhenBucketCalled).toBe(2);
	});

	it("leaves the conversations in place when the bucket delete fails, so a retry can finish it", async () => {
		const { locals } = await createTestUser();
		const id = (await createTestConversation(locals, { title: "Kept" }))._id.toString();
		deleteCustodialFolders.mockRejectedValue(new Error("bucket unreachable"));

		await expect(deleteConversationsCascade([id], "owner-1")).rejects.toThrow("bucket unreachable");
		expect(await collections.conversations.countDocuments()).toBe(1);
	});

	it("deletes a guest's attachment folders under its session's guests/ prefix (CUR-2183)", async () => {
		const { locals } = await createTestUser();
		const id = (await createTestConversation(locals, { title: "Guest" }))._id.toString();
		const sid = "f".repeat(64);
		await deleteConversationsCascade([id], undefined, sid);
		expect(deleteCustodialFolders).toHaveBeenCalledWith(sid, "conversations", [id], "guests");
	});

	it("also deletes the guest folder a signed-in conversation started in, for files the sign-in move left behind (CUR-3292)", async () => {
		const { locals } = await createTestUser();
		const former = "a".repeat(64);
		const moved = (await createTestConversation(locals, { title: "Moved", formerGuestSessionId: former }))._id.toString();
		const native = (await createTestConversation(locals, { title: "Native" }))._id.toString();

		await deleteConversationsCascade([moved, native], "owner-1");
		expect(deleteCustodialFolders).toHaveBeenCalledWith("owner-1", "conversations", [moved, native]);
		expect(deleteCustodialFolders).toHaveBeenCalledWith(former, "conversations", [moved], "guests");
		expect(deleteCustodialFolders).toHaveBeenCalledTimes(2);
	});

	it("deletes the former guest folders on the account wipe's call too, which passes no owner (CUR-3292)", async () => {
		const { locals } = await createTestUser();
		const former = "b".repeat(64);
		const moved = (await createTestConversation(locals, { title: "Moved", formerGuestSessionId: former }))._id.toString();

		await deleteConversationsCascade([moved]);
		expect(deleteCustodialFolders).toHaveBeenCalledWith(former, "conversations", [moved], "guests");
		expect(deleteCustodialFolders).toHaveBeenCalledTimes(1);
	});

	it("touches no bucket with no owner, no guest session and no former guest session (the account wipe's call)", async () => {
		const { locals } = await createTestUser();
		const id = (await createTestConversation(locals, { title: "Wiped" }))._id.toString();
		await deleteConversationsCascade([id]);
		expect(deleteCustodialFolders).not.toHaveBeenCalled();
	});

	it("deletes the conversations' agent sandboxes under the owner, or the guest session (CUR-4484)", async () => {
		deleteAgentSessions.mockClear();
		const { locals } = await createTestUser();
		const id = (await createTestConversation(locals, { title: "ran code" }))._id.toString();
		expect(await deleteConversationsCascade([id], "owner-1")).toBe(1);
		expect(deleteAgentSessions).toHaveBeenCalledWith("owner-1", [id]);
		await deleteConversationsCascade(["000000000000000000000000"], undefined, "guest-sid");
		expect(deleteAgentSessions).toHaveBeenLastCalledWith("guest-sid", ["000000000000000000000000"]);
	});

	it("still deletes the conversation when the agent-service cleanup fails (CUR-4484)", async () => {
		deleteAgentSessions.mockRejectedValueOnce(new Error("agent-service down"));
		const { locals } = await createTestUser();
		const id = (await createTestConversation(locals, { title: "x" }))._id.toString();
		expect(await deleteConversationsCascade([id], "owner-1")).toBe(1);
	});

	it("returns 0 and is a no-op for an empty id list", async () => {
		const deleted = await deleteConversationsCascade([]);
		expect(deleted).toBe(0);
	});

	// This is the wiring only — that the delete actually stops a live
	// generation from ending in a user-visible error is a live-server behavior no unit test can
	// see, and web/e2e/scenarios/wipe-during-stream.spec.ts is what proves that. (CUR-1619/CUR-1620/CUR-1773)
	it("aborts a registered in-flight generation for each deleted conversation id", async () => {
		const { locals } = await createTestUser();
		const target = await createTestConversation(locals, { title: "Streaming" });
		const other = await createTestConversation(locals, { title: "Untouched" });
		const targetId = target._id.toString();
		const otherId = other._id.toString();

		const targetCtrl = new AbortController();
		const otherCtrl = new AbortController();
		AbortRegistry.getInstance().register(targetId, targetCtrl);
		AbortRegistry.getInstance().register(otherId, otherCtrl);

		try {
			await deleteConversationsCascade([targetId]);

			expect(targetCtrl.signal.aborted).toBe(true);
			expect(otherCtrl.signal.aborted).toBe(false);
		} finally {
			AbortRegistry.getInstance().unregister(otherId, otherCtrl);
		}
	});

	it("deletes a conversation that has a report AND a file, RETAINING the report (detached)", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "Flagged chat" });
		const convId = conv._id.toString();

		const report = await saveReport({
			conversationId: convId,
			reason: "harmful",
			sessionId: locals.sessionId,
		});
		await insertFile(convId);

		try {
			// Before the fix this threw a foreign-key violation instead of returning a count.
			const deleted = await deleteConversationsCascade([convId]);

			expect(deleted).toBe(1);
			expect(await collections.conversations.countDocuments()).toBe(0);
			// The conversation no longer has any attached report...
			expect(await reportCountFor(convId)).toBe(0);
			// ...but the report ROW survives (compliance carve-out), now detached: conversationId nulled.
			const surviving = await getReportById(report.id);
			expect(surviving).toBeDefined();
			expect(surviving?.conversationId).toBeNull();
		} finally {
			await deleteReportById(report.id);
		}
	});

	it("deletes plain conversations with no dependents", async () => {
		const { locals } = await createTestUser();
		const a = await createTestConversation(locals, { title: "A" });
		const b = await createTestConversation(locals, { title: "B" });

		const deleted = await deleteConversationsCascade([a._id.toString(), b._id.toString()]);

		expect(deleted).toBe(2);
		expect(await collections.conversations.countDocuments()).toBe(0);
	});

	it("deletes a parked MCP elicitation (CUR-1017) with its conversation, leaving another conversation's untouched", async () => {
		const { locals } = await createTestUser();
		const target = await createTestConversation(locals, { title: "Target" });
		const keep = await createTestConversation(locals, { title: "Keep" });

		const parkOnTarget = await openDurableElicitation({
			conversationId: target._id,
			server: "https://example.hf.space/mcp",
			tool: "ask_a_question",
			args: {},
			inputRequired: formInputRequired(),
		});
		const parkOnKeep = await openDurableElicitation({
			conversationId: keep._id,
			server: "https://example.hf.space/mcp",
			tool: "ask_a_question",
			args: {},
			inputRequired: formInputRequired(),
		});
		if (!parkOnTarget.opened || !parkOnKeep.opened) throw new Error("setup: expected opened:true");

		try {
			const deleted = await deleteConversationsCascade([target._id.toString()]);
			expect(deleted).toBe(1);
			expect(
				await collections.mcpElicitations.findOne({ _id: new ObjectId(parkOnTarget.elicitationId) })
			).toBeNull();
			expect(
				await collections.mcpElicitations.findOne({ _id: new ObjectId(parkOnKeep.elicitationId) })
			).not.toBeNull();
		} finally {
			await collections.mcpElicitations.deleteOne({ _id: new ObjectId(parkOnKeep.elicitationId) });
		}
	});

	it("only deletes the targeted conversations, leaving others (and their reports) intact", async () => {
		const { locals } = await createTestUser();
		const target = await createTestConversation(locals, { title: "Target" });
		const keep = await createTestConversation(locals, { title: "Keep" });
		const targetId = target._id.toString();
		const keepId = keep._id.toString();

		const targetReport = await saveReport({
			conversationId: targetId,
			reason: "harmful",
			sessionId: locals.sessionId,
		});
		await saveReport({ conversationId: keepId, reason: "inaccurate", sessionId: locals.sessionId });

		try {
			const deleted = await deleteConversationsCascade([targetId]);

			expect(deleted).toBe(1);
			expect(await collections.conversations.countDocuments()).toBe(1);
			// Target's report is detached (retained, conversationId nulled), not deleted.
			expect(await reportCountFor(targetId)).toBe(0);
			expect((await getReportById(targetReport.id))?.conversationId).toBeNull();
			// The kept conversation's report is untouched, still attached.
			expect(await reportCountFor(keepId)).toBe(1);
		} finally {
			await deleteReportById(targetReport.id);
			await deleteReportsFor([keepId, targetId]);
			await deleteFilesFor([keepId, targetId]);
		}
	});
});
