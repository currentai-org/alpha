/**
 * Stream-follow's event log against the real table: append and replay in order, a repeated
 * batch is ignored, the TTL sweep and the conversation delete both remove it. Needs the migration, so
 * it runs in the stateful project after db:migrate.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteGenerationEvents,
	generationLogState,
	insertGenerationEvents,
	readGenerationEvents,
	sweepGenerationEvents,
} from "$lib/chat/server/db/generationEvents";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import {
	cleanupTestData,
	createTestConversation,
	createTestLocals,
} from "$lib/chat/server/api/__tests__/testHelpers";

const gen = () => `gen-${crypto.randomUUID()}`;

describe.sequential("generation_events (stream-follow log)", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("replays batches in seq order, only those after the offset", async () => {
		const g = gen();
		await insertGenerationEvents(g, "c1", 1, "b");
		await insertGenerationEvents(g, "c1", 0, "a");
		await insertGenerationEvents(g, "c1", 2, "c");
		expect((await readGenerationEvents(g, -1)).map((r) => r.payload)).toEqual(["a", "b", "c"]);
		expect((await readGenerationEvents(g, 0)).map((r) => r.payload)).toEqual(["b", "c"]);
		expect((await generationLogState(g)).count).toBe(3);
		await deleteGenerationEvents(g);
	});

	it("a repeated (generation, seq) is ignored, so a retried flush cannot duplicate text", async () => {
		const g = gen();
		await insertGenerationEvents(g, "c1", 0, "first");
		await insertGenerationEvents(g, "c1", 0, "again");
		expect((await readGenerationEvents(g, -1)).map((r) => r.payload)).toEqual(["first"]);
		await deleteGenerationEvents(g);
	});

	it("the TTL sweep removes batches older than the cutoff and keeps newer ones", async () => {
		const old = gen();
		await insertGenerationEvents(old, "c1", 0, "x");
		const swept = await sweepGenerationEvents(new Date(Date.now() + 60_000));
		expect(swept).toBeGreaterThanOrEqual(1);
		expect(await readGenerationEvents(old, -1)).toEqual([]);
		const fresh = gen();
		await insertGenerationEvents(fresh, "c1", 0, "y");
		await sweepGenerationEvents(new Date(Date.now() - 60_000));
		expect(await readGenerationEvents(fresh, -1)).toHaveLength(1);
		await deleteGenerationEvents(fresh);
	});

	it("deleting a conversation removes its log (the user data wipe and delete paths)", async () => {
		const user = createTestLocals({ sessionId: `cur4716-${crypto.randomUUID()}` });
		const conv = await createTestConversation(user, {});
		const id = conv._id.toString();
		const g = gen();
		await insertGenerationEvents(g, id, 0, "answer text");
		await deleteConversationsCascade([id]);
		expect(await readGenerationEvents(g, -1)).toEqual([]);
	});
});
