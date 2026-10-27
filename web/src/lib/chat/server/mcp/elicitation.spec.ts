import { describe, expect, it, afterEach } from "vitest";
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import { openDurableElicitation, submitElicitationAnswer } from "./elicitation";
import { formInputRequired } from "./testFixtures";
import type { McpCallResult } from "./client";

// openDurableElicitation/submitElicitationAnswer are the real-DB half of the 2026-era
// elicitation park/resolve mechanism. Real Postgres, not mocks — same reasoning workspaceUsage.spec.ts
// gives for its own real-DB tests: a mocked collection can't prove a CAS filter or a cross-conversation
// scope actually holds against the real adapter. (CUR-1017)

afterEach(async () => {
	await collections.mcpElicitations.deleteMany({});
});

describe.sequential("openDurableElicitation (CUR-1017)", () => {
	it("parks a well-formed elicitation-shaped input_required entry", async () => {
		const conversationId = new ObjectId();
		const result = await openDurableElicitation({
			conversationId,
			server: "https://example.hf.space/mcp",
			tool: "ask_a_question",
			args: { foo: "bar" },
			inputRequired: formInputRequired(),
		});
		expect(result.opened).toBe(true);
		if (!result.opened) throw new Error("expected opened:true");

		const doc = await collections.mcpElicitations.findOne({ _id: new ObjectId(result.elicitationId) });
		expect(doc).toMatchObject({
			conversationId,
			status: "pending",
			request: { server: "https://example.hf.space/mcp", mode: "form", message: "What's your name?" },
			pending: { server: "https://example.hf.space/mcp", tool: "ask_a_question", inputKey: "q1" },
		});
	});

	it("does not park a batch with no elicitation-shaped entry (e.g. a sampling-only request)", async () => {
		const result = await openDurableElicitation({
			conversationId: new ObjectId(),
			server: "https://example.hf.space/mcp",
			tool: "do_something",
			args: {},
			inputRequired: {
				kind: "input_required",
				// Not elicitation-shaped: no message/requestedSchema and no url mode.
				inputRequests: { s1: { messages: [], maxTokens: 100 } },
			} as unknown as Extract<McpCallResult, { kind: "input_required" }>,
		});
		expect(result.opened).toBe(false);
	});
});

describe.sequential("submitElicitationAnswer (CUR-1017)", () => {
	async function park(conversationId = new ObjectId()) {
		const opened = await openDurableElicitation({
			conversationId,
			server: "https://example.hf.space/mcp",
			tool: "ask_a_question",
			args: {},
			inputRequired: formInputRequired(),
		});
		if (!opened.opened) throw new Error("setup: expected opened:true");
		return { conversationId, elicitationId: opened.elicitationId };
	}

	it("accepts a valid answer and marks the row resolved", async () => {
		const { conversationId, elicitationId } = await park();
		const result = await submitElicitationAnswer({
			elicitationId,
			conversationId,
			action: "accept",
			content: { name: "Ada" },
		});
		expect(result).toMatchObject({ ok: true, resume: true });

		const doc = await collections.mcpElicitations.findOne({ _id: new ObjectId(elicitationId) });
		expect(doc).toMatchObject({
			status: "resolved",
			action: "accept",
			content: { name: "Ada" },
		});
	});

	it("re-validates the answer server-side and rejects one that fails the stored schema", async () => {
		const { conversationId, elicitationId } = await park();
		// "name" is required — an empty answer must fail even though the client's own shape check
		// (content is a valid record) would pass it.
		const result = await submitElicitationAnswer({
			elicitationId,
			conversationId,
			action: "accept",
			content: {},
		});
		expect(result).toMatchObject({ ok: false, status: 400 });

		const doc = await collections.mcpElicitations.findOne({ _id: new ObjectId(elicitationId) });
		expect(doc?.status).toBe("pending"); // rejected answer must not resolve the row
	});

	it("404s an unknown elicitationId", async () => {
		const result = await submitElicitationAnswer({
			elicitationId: new ObjectId().toHexString(),
			conversationId: new ObjectId(),
			action: "decline",
		});
		expect(result).toMatchObject({ ok: false, status: 404 });
	});

	it("404s a real elicitationId scoped to a DIFFERENT conversation — holding an id is not authority", async () => {
		const { elicitationId } = await park();
		const result = await submitElicitationAnswer({
			elicitationId,
			conversationId: new ObjectId(), // a different conversation
			action: "decline",
		});
		expect(result).toMatchObject({ ok: false, status: 404 });
	});

	it("409s a second submission — the CAS filter makes a double-submit a no-op, not an overwrite", async () => {
		const { conversationId, elicitationId } = await park();
		const first = await submitElicitationAnswer({
			elicitationId,
			conversationId,
			action: "accept",
			content: { name: "Ada" },
		});
		expect(first.ok).toBe(true);

		const second = await submitElicitationAnswer({
			elicitationId,
			conversationId,
			action: "accept",
			content: { name: "Grace" }, // a different answer — must NOT overwrite the first
		});
		expect(second).toMatchObject({ ok: false, status: 409 });

		const doc = await collections.mcpElicitations.findOne({ _id: new ObjectId(elicitationId) });
		expect(doc?.content).toEqual({ name: "Ada" }); // unchanged
	});

	it("accepts a decline with no content, and does not run content validation for it", async () => {
		const { conversationId, elicitationId } = await park();
		const result = await submitElicitationAnswer({ elicitationId, conversationId, action: "decline" });
		expect(result).toMatchObject({ ok: true, resume: true });

		const doc = await collections.mcpElicitations.findOne({ _id: new ObjectId(elicitationId) });
		expect(doc).toMatchObject({ status: "resolved", action: "decline" });
		expect(doc?.content).toBeUndefined();
	});
});
