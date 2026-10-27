// Settings › Data & privacy › Your usage reads these totals. Every conversation stores a hidden
// system prompt as its first message, which the visitor never sees, so it must not reach the tiles.
import { describe, expect, it, afterEach } from "vitest";
import { getAccountUsage } from "$lib/chat/server/accountUsage";
import {
	createTestLocals,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import type { Message } from "$lib/chat/types/Message";

function msg(from: Message["from"], content: string): Message {
	return { from, id: crypto.randomUUID(), content };
}

describe.sequential("getAccountUsage", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("counts only the messages a visitor sees in Total messages, leaving out each conversation's system prompt", async () => {
		const locals = createTestLocals();
		for (let i = 0; i < 3; i++) {
			await createTestConversation(locals, {
				messages: [msg("system", "You are Alpha."), msg("user", "hello"), msg("assistant", "hi there")],
			});
		}

		const { totals } = await getAccountUsage(locals);

		expect(totals).toEqual({ conversations: 3, messages: 6, userMessages: 3, characters: 15 });
	});
});
