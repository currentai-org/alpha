import { describe, expect, it } from "vitest";
import { MessageUpdateStatus, MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { createDetachedPersistGate } from "./detachedPersist";

const keepAlive = { type: MessageUpdateType.Status, status: MessageUpdateStatus.KeepAlive } as MessageUpdate;
const token = { type: MessageUpdateType.Stream, token: "a" } as MessageUpdate;
const final = { type: MessageUpdateType.FinalAnswer, text: "done" } as MessageUpdate;

// Mirrors update()'s detached tail: one persist call per update the gate lets through.
function drive(updates: MessageUpdate[], clock: { t: number }, stepMs: number) {
	const gate = createDetachedPersistGate(2_000, () => clock.t);
	const writes: MessageUpdate[] = [];
	for (const u of updates) {
		if (gate(u)) writes.push(u);
		clock.t += stepMs;
	}
	return writes;
}

describe("detached persistence", () => {
	it("writes nothing for 600 keepalives and at most one write per 2s window for 300 tokens (100 ms apart), then always writes the final answer", () => {
		const updates = [
			...Array.from({ length: 600 }, (_, i) => (i % 2 ? keepAlive : token)),
			...Array.from({ length: 300 }, () => token),
			final,
		];
		const writes = drive(updates, { t: 0 }, 100);
		expect(writes.filter((u) => u === keepAlive)).toHaveLength(0);
		// 900 updates x 100 ms = 90 s: one write per 2 s window is 45, plus the final answer
		expect(writes.length).toBeLessThanOrEqual(46);
		expect(writes.at(-1)).toBe(final);
	});

	it("never writes on a run of only keepalives", () => {
		expect(drive(Array.from({ length: 100 }, () => keepAlive), { t: 0 }, 2_500)).toHaveLength(0);
	});
});
