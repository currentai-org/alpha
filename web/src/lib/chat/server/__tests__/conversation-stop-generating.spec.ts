import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";

import { collections } from "$lib/chat/server/database";
import { AbortRegistry } from "$lib/chat/server/abortRegistry";
import { claimGeneration, finishGeneration } from "$lib/chat/server/generations";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import type { Message } from "$lib/chat/types/Message";
import {
	cleanupTestData,
	createTestConversation,
	createTestLocals,
	createTestUser,
} from "$lib/chat/server/api/__tests__/testHelpers";
import { POST } from "../../../../routes/chat/conversation/[id]/stop-generating/+server";

describe.sequential("POST /conversation/[id]/stop-generating", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await cleanupTestData();
	});

	it(
		"creates abort marker and aborts active registry controllers",
		{ timeout: 30000 },
		async () => {
			const { locals } = await createTestUser();
			const conversation = await createTestConversation(locals);
			const abortSpy = vi.spyOn(AbortRegistry.getInstance(), "abort");

			const response = await POST({
				params: { id: conversation._id.toString() },
				locals,
			} as never);

			expect(response.status).toBe(200);
			expect(abortSpy).toHaveBeenCalledWith(conversation._id.toString());

			const marker = await collections.abortedGenerations.findOne({
				conversationId: conversation._id,
			});
			expect(marker).not.toBeNull();
			expect(marker?.createdAt).toBeInstanceOf(Date);
			expect(marker?.updatedAt).toBeInstanceOf(Date);
		}
	);

	it("stores the stop point from the request body on the marker", async () => {
		const { locals } = await createTestUser();
		const conversation = await createTestConversation(locals);
		const generationId = "22222222-2222-4222-8222-222222222222";

		const response = await POST({
			params: { id: conversation._id.toString() },
			locals,
			request: new Request("http://localhost/stop-generating", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ generationId, seenContentLength: 1234 }),
			}),
		} as never);

		expect(response.status).toBe(200);
		const marker = await collections.abortedGenerations.findOne({
			conversationId: conversation._id,
		});
		expect(marker?.generationId).toBe(generationId);
		expect(marker?.seenContentLength).toBe(1234);
	});

	it("ignores malformed stop-point bodies but still records the stop", async () => {
		const { locals } = await createTestUser();
		const conversation = await createTestConversation(locals);

		const response = await POST({
			params: { id: conversation._id.toString() },
			locals,
			request: new Request("http://localhost/stop-generating", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ generationId: "not-a-uuid", seenContentLength: -5 }),
			}),
		} as never);

		expect(response.status).toBe(200);
		const marker = await collections.abortedGenerations.findOne({
			conversationId: conversation._id,
		});
		expect(marker).not.toBeNull();
		expect(marker?.generationId).toBeUndefined();
		expect(marker?.seenContentLength).toBeUndefined();
	});

	it("updates updatedAt while preserving createdAt on repeated stop", async () => {
		const { locals } = await createTestUser();
		const conversation = await createTestConversation(locals);

		await POST({
			params: { id: conversation._id.toString() },
			locals,
		} as never);
		const firstMarker = await collections.abortedGenerations.findOne({
			conversationId: conversation._id,
		});

		await new Promise((resolve) => setTimeout(resolve, 5));

		await POST({
			params: { id: conversation._id.toString() },
			locals,
		} as never);
		const secondMarker = await collections.abortedGenerations.findOne({
			conversationId: conversation._id,
		});

		expect(firstMarker).not.toBeNull();
		expect(secondMarker).not.toBeNull();
		expect(secondMarker?.createdAt.getTime()).toBe(firstMarker?.createdAt.getTime());
		expect(secondMarker?.updatedAt.getTime()).toBeGreaterThan(
			firstMarker?.updatedAt.getTime() ?? 0
		);
	});

	// Smooth mode was still revealing an answer the server had already stored in full. (CUR-2306)
	describe("an answer that finished on the server before the stop arrived", () => {
		const ANSWER = "The whole answer, of which the reader had only seen the start.";

		async function finishedTurn(generationId: string, status: "complete" | "in_flight") {
			const { locals } = await createTestUser();
			const assistantId = "33333333-3333-4333-8333-333333333333";
			const messages = [
				{ id: "44444444-4444-4444-8444-444444444444", from: "user", content: "hi", children: [assistantId] },
				{
					id: assistantId,
					from: "assistant",
					content: ANSWER,
					interrupted: false,
					updates: [{ type: MessageUpdateType.FinalAnswer, text: ANSWER, interrupted: false }],
				},
			] as unknown as Message[];
			const conversation = await createTestConversation(locals, { messages });
			await claimGeneration(generationId, conversation._id.toString(), assistantId);
			if (status === "complete") await finishGeneration(generationId, "complete");
			return { locals, conversation, assistantId };
		}

		function stop(locals: App.Locals, id: ObjectId, generationId: string, seen: number) {
			return POST({
				params: { id: id.toString() },
				locals,
				request: new Request("http://localhost/stop-generating", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ generationId, seenContentLength: seen }),
				}),
			} as never);
		}

		it("stores only what was on screen, marked interrupted, so the reload does not grow it", async () => {
			const generationId = "55555555-5555-4555-8555-555555555555";
			const { locals, conversation, assistantId } = await finishedTurn(generationId, "complete");

			expect((await stop(locals, conversation._id, generationId, 16)).status).toBe(200);

			const stored = await collections.conversations.findOne({ _id: conversation._id });
			const message = stored?.messages.find((m) => m.id === assistantId);
			expect(message?.content).toBe(ANSWER.slice(0, 16));
			expect(message?.interrupted).toBe(true);
			expect(message?.updates?.find((u) => u.type === MessageUpdateType.FinalAnswer)).toMatchObject({
				text: ANSWER.slice(0, 16),
				interrupted: true,
			});
		});

		it("leaves the answer whole when the stop names a different generation", async () => {
			const generationId = "66666666-6666-4666-8666-666666666666";
			const { locals, conversation, assistantId } = await finishedTurn(generationId, "complete");

			await stop(locals, conversation._id, "77777777-7777-4777-8777-777777777777", 16);

			const stored = await collections.conversations.findOne({ _id: conversation._id });
			expect(stored?.messages.find((m) => m.id === assistantId)?.content).toBe(ANSWER);
		});

		it(
			"leaves a generation that never settles to its own finalize, rather than writing under it",
			{ timeout: 30000 },
			async () => {
				const generationId = "88888888-8888-4888-8888-888888888888";
				const { locals, conversation, assistantId } = await finishedTurn(generationId, "in_flight");

				await stop(locals, conversation._id, generationId, 16);

				const stored = await collections.conversations.findOne({ _id: conversation._id });
				expect(stored?.messages.find((m) => m.id === assistantId)?.content).toBe(ANSWER);
			}
		);
	});

	it("throws 404 when conversation is not found", async () => {
		const { locals } = await createTestUser();
		const missingId = new ObjectId().toString();

		try {
			await POST({
				params: { id: missingId },
				locals,
			} as never);
			expect.fail("Expected 404 error");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
	});

	it("throws 401 for unauthenticated requests", async () => {
		const locals = createTestLocals({ user: undefined, sessionId: undefined });

		try {
			await POST({
				params: { id: new ObjectId().toString() },
				locals,
			} as never);
			expect.fail("Expected 401 error");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(401);
		}
	});
});
