/**
 * Coverage for the report endpoint — the ROOST triage write seam. Two security properties matter:
 * a report is scoped to a conversation the caller actually owns (no forging against arbitrary ids),
 * and an invalid reason is rejected. The happy path persists a row through saveReport.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { ObjectId } from "bson";
import { getDb } from "$lib/chat/server/db/client";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import * as schema from "$lib/chat/server/db/schema";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import { POST } from "./+server";

const { rateLimit } = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimit }));
const { fanOut } = vi.hoisted(() => ({ fanOut: vi.fn() }));
vi.mock("$lib/chat/server/reportFanout", () => ({ fanOutReport: fanOut }));

async function reportsFor(convId: string) {
	return getDb()
		.select()
		.from(schema.reports)
		.where(inArray(schema.reports.conversationId, [convId]));
}

async function postReport(args: {
	locals: App.Locals;
	id: string;
	body: unknown;
}): Promise<Response> {
	const request = new Request(`http://localhost/conversation/${args.id}/report`, {
		method: "POST",
		body: JSON.stringify(args.body),
	});
	return POST({
		request,
		locals: args.locals,
		params: { id: args.id },
		getClientAddress: () => "203.0.113.9",
	} as never);
}

async function expectThrownStatus(p: Promise<Response>, status: number) {
	try {
		await p;
		expect.fail("Should have thrown");
	} catch (e: unknown) {
		expect((e as { status: number }).status).toBe(status);
	}
}

describe.sequential("POST /conversation/[id]/report", () => {
	beforeEach(() => {
		rateLimit.mockReset().mockResolvedValue(undefined);
		fanOut.mockReset().mockResolvedValue({ skipped: "flag-off" });
	});

	afterEach(async () => {
		await cleanupTestData();
	});

	it("saves a report against a conversation the caller owns", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const convId = conv._id.toString();

		try {
			const res = await postReport({
				locals,
				id: convId,
				body: { reason: "harmful", messageId: "msg-1", detail: "abusive" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });

			const rows = await reportsFor(convId);
			expect(rows).toHaveLength(1);
			expect(rows[0].reason).toBe("harmful");
			expect(rows[0].messageId).toBe("msg-1");
			expect(rows[0].detail).toBe("abusive");
		} finally {
			await getDb()
				.delete(schema.reports)
				.where(inArray(schema.reports.conversationId, [convId]));
		}
	});

	it("keeps the reported answer and its serving model in the row after the conversation is deleted", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, {
			model: "requested-model",
			messages: [
				{ id: "u1", from: "user", content: "Name a river in Switzerland." },
				{
					id: "a1",
					from: "assistant",
					content: "The Aare flows through Bern.",
					routerMetadata: { route: "", model: "served-model" },
				},
			] as never,
		});
		const convId = conv._id.toString();
		let reportId: string | undefined;

		try {
			const res = await postReport({
				locals,
				id: convId,
				body: { reason: "language", messageId: "a1" },
			});
			expect(res.status).toBe(200);
			const [row] = await reportsFor(convId);
			reportId = row.id;
			expect(row.reason).toBe("language");
			expect(row.answerText).toBe("The Aare flows through Bern.");
			expect(row.answerModel).toBe("served-model");

			await deleteConversationsCascade([convId]);
			const [kept] = await getDb()
				.select()
				.from(schema.reports)
				.where(eq(schema.reports.id, reportId));
			expect(kept.conversationId).toBeNull();
			expect(kept.answerText).toBe("The Aare flows through Bern.");
		} finally {
			if (reportId) await getDb().delete(schema.reports).where(eq(schema.reports.id, reportId));
		}
	});

	it("files the model the conversation asked for when the answer carries no provenance", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, {
			model: "requested-model",
			messages: [{ id: "a1", from: "assistant", content: "I can't help with that." }] as never,
		});
		const convId = conv._id.toString();

		try {
			await postReport({ locals, id: convId, body: { reason: "refused", messageId: "a1" } });
			const [row] = await reportsFor(convId);
			expect(row.reason).toBe("refused");
			expect(row.answerModel).toBe("requested-model");
		} finally {
			await getDb()
				.delete(schema.reports)
				.where(inArray(schema.reports.conversationId, [convId]));
		}
	});

	it("rejects a report against a conversation the caller does not own (404)", async () => {
		const { locals: owner } = await createTestUser();
		const { locals: attacker } = await createTestUser();
		const conv = await createTestConversation(owner);
		const convId = conv._id.toString();

		await expectThrownStatus(
			postReport({ locals: attacker, id: convId, body: { reason: "harmful" } }),
			404
		);

		expect(await reportsFor(convId)).toHaveLength(0);
	});

	it("returns 404 for a conversation that does not exist", async () => {
		const { locals } = await createTestUser();
		await expectThrownStatus(
			postReport({ locals, id: new ObjectId().toString(), body: { reason: "harmful" } }),
			404
		);
	});

	it("rejects an invalid reason (400)", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);

		await expectThrownStatus(
			postReport({ locals, id: conv._id.toString(), body: { reason: "not-a-reason" } }),
			400
		);

		expect(await reportsFor(conv._id.toString())).toHaveLength(0);
	});
	describe("CUR-3520: a report counts against the shared per-IP limit", () => {
		it("charges the limiter with the reporter's session and address before saving", async () => {
			const { locals } = await createTestUser();
			const conv = await createTestConversation(locals);
			const convId = conv._id.toString();
			try {
				const res = await postReport({ locals, id: convId, body: { reason: "harmful" } });
				expect(res.status).toBe(200);
				expect(rateLimit).toHaveBeenCalledWith({
					userId: locals.user?._id ?? locals.sessionId,
					clientAddress: "203.0.113.9",
				});
				expect(fanOut).toHaveBeenCalledTimes(1);
			} finally {
				await getDb()
					.delete(schema.reports)
					.where(inArray(schema.reports.conversationId, [convId]));
			}
		});

		it("on the limiter's 429, saves no report and fans nothing out", async () => {
			rateLimit.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
			const { locals } = await createTestUser();
			const conv = await createTestConversation(locals);
			const convId = conv._id.toString();

			await expectThrownStatus(postReport({ locals, id: convId, body: { reason: "harmful" } }), 429);

			expect(await reportsFor(convId)).toHaveLength(0);
			expect(fanOut).not.toHaveBeenCalled();
		});

		it("does not charge the limiter for a conversation the caller does not own", async () => {
			const { locals: owner } = await createTestUser();
			const { locals: other } = await createTestUser();
			const conv = await createTestConversation(owner);
			await expectThrownStatus(
				postReport({ locals: other, id: conv._id.toString(), body: { reason: "harmful" } }),
				404
			);
			expect(rateLimit).not.toHaveBeenCalled();
		});
	});
});
