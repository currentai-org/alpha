/**
 * W2 idempotency state machine (claim / read / finish). Runs against the real Postgres (matches the
 * other db specs) and cleans up its own rows. Each test mints unique generationIds so concurrent/
 * repeated runs can't collide.
 *
 * The contract under test:
 *   - first claim of an id wins (true); a second claim while in-flight loses (false → caller 409s)
 *   - a COMPLETE turn cannot be re-claimed (false → 409); the client refreshes the finished turn
 *   - an ERROR turn IS re-claimable by a fresh attempt (true; flips back to in_flight) — this is what
 *     lets W3's auto-retry recover a failed turn without spawning a parallel one
 */
import { describe, expect, it, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import {
	claimGeneration,
	readGeneration,
	finishGeneration,
	answersInFlight,
} from "$lib/chat/server/generations";

const ids: string[] = [];
function genId(tag: string): string {
	const id = `test-gen-${tag}-${Math.random().toString(36).slice(2)}`;
	ids.push(id);
	return id;
}

afterAll(async () => {
	for (const id of ids) {
		await getDb().delete(schema.generations).where(eq(schema.generations.id, id));
	}
});

describe("generations idempotency", () => {
	it("first claim wins; a duplicate in-flight claim loses", async () => {
		const id = genId("dup");
		expect(await claimGeneration(id, "conv1", "msg1")).toBe(true);
		expect(await claimGeneration(id, "conv1", "msg1")).toBe(false);
		expect((await readGeneration(id))?.status).toBe("in_flight");
	});

	it("a completed turn cannot be re-claimed", async () => {
		const id = genId("complete");
		expect(await claimGeneration(id, "conv2", "msg2")).toBe(true);
		await finishGeneration(id, "complete");
		expect(await claimGeneration(id, "conv2", "msg2")).toBe(false);
		expect((await readGeneration(id))?.status).toBe("complete");
	});

	it("an errored turn is re-claimable by a fresh attempt (flips back to in_flight)", async () => {
		const id = genId("error");
		expect(await claimGeneration(id, "conv3", "msg3")).toBe(true);
		await finishGeneration(id, "error");
		expect((await readGeneration(id))?.status).toBe("error");
		expect(await claimGeneration(id, "conv3", "msgRetry")).toBe(true);
		const after = await readGeneration(id);
		expect(after?.status).toBe("in_flight");
		expect(after?.messageId).toBe("msgRetry"); // re-claim adopts the new attempt's message id
	});

	// A new turn waits on this before building on an answer whose turn has not saved. (CUR-2667)
	it("answersInFlight is true only while a generation writing one of the named answers is in flight", async () => {
		const conv = `conv-${Math.random().toString(36).slice(2)}`;
		const id = genId("inflight");
		expect(await claimGeneration(id, conv, "answerA")).toBe(true);
		expect(await answersInFlight(conv, ["answerB", "answerA"])).toBe(true);
		expect(await answersInFlight(conv, ["answerB"])).toBe(false);
		expect(await answersInFlight("another-conv", ["answerA"])).toBe(false);
		await finishGeneration(id, "complete");
		expect(await answersInFlight(conv, ["answerA"])).toBe(false);
	});

	it("readGeneration returns null for an unknown id", async () => {
		expect(await readGeneration(`test-gen-nope-${Math.random().toString(36).slice(2)}`)).toBeNull();
	});
});
