/**
 * Regression for the null-byte write crash. Postgres jsonb rejects U+0000 outright ("unsupported
 * Unicode escape sequence"), so a pasted/crafted null byte anywhere in a message must not fail the whole
 * conversation write (a 500 on send). toStorage() strips U+0000 at the doc-store boundary; these assert
 * the write survives and the null is gone on read-back, while ordinary control whitespace is preserved.
 */
import { describe, expect, it, afterEach } from "vitest";
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import type { Conversation } from "$lib/chat/types/Conversation";
import { cleanupTestData } from "$lib/chat/server/api/__tests__/testHelpers";

const NUL = String.fromCharCode(0);

describe.sequential("doc-store null-byte sanitization", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("does not throw when a message contains a null byte, and strips it on storage", async () => {
		const _id = new ObjectId();
		const conv = {
			_id,
			title: `clean${NUL}title`,
			model: "test-model",
			sessionId: "sess-nul",
			createdAt: new Date(),
			updatedAt: new Date(),
			messages: [{ from: "user", id: "m1", content: `hi${NUL}there`, createdAt: new Date() }],
		} as unknown as Conversation;

		// Before the fix this rejected at the database with "unsupported Unicode escape sequence".
		await expect(collections.conversations.insertOne(conv)).resolves.toBeDefined();

		const stored = await collections.conversations.findOne({ _id });
		expect(stored).toBeTruthy();
		expect(stored?.title).toBe("cleantitle");
		expect(stored?.messages?.[0]?.content).toBe("hithere");
		expect(JSON.stringify(stored)).not.toContain(NUL);
	});

	it("leaves ordinary whitespace and content untouched", async () => {
		const _id = new ObjectId();
		await collections.conversations.insertOne({
			_id,
			title: "normal title with spaces",
			model: "test-model",
			sessionId: "sess-ok",
			createdAt: new Date(),
			updatedAt: new Date(),
			messages: [{ from: "user", id: "m1", content: "line one\n\ttabbed", createdAt: new Date() }],
		} as unknown as Conversation);

		const stored = await collections.conversations.findOne({ _id });
		expect(stored?.title).toBe("normal title with spaces");
		expect(stored?.messages?.[0]?.content).toBe("line one\n\ttabbed");
	});
});
