import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationLogWriter, type GenerationLogStore } from "./generationLog";

vi.mock("$lib/chat/server/db/generationEvents", () => ({
	insertGenerationEvents: vi.fn(),
	deleteGenerationEvents: vi.fn(),
}));

function fakeStore() {
	const inserts: Array<{ seq: number; payload: string }> = [];
	const removed: string[] = [];
	const store: GenerationLogStore = {
		insert: async (_g, _c, seq, payload) => void inserts.push({ seq, payload }),
		remove: async (g) => void removed.push(g),
	};
	return { store, inserts, removed };
}

describe("generation log writer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("writes lines buffered inside one flush window as a single ordered batch", async () => {
		const { store, inserts } = fakeStore();
		const w = createGenerationLogWriter("g", "c", { store, flushMs: 500 });
		w.append('{"a":1}');
		w.append('{"a":2}');
		expect(inserts).toEqual([]);
		await vi.advanceTimersByTimeAsync(500);
		w.append('{"a":3}');
		await w.close();
		expect(inserts).toEqual([
			{ seq: 0, payload: '{"a":1}\n{"a":2}' },
			{ seq: 1, payload: '{"a":3}' },
		]);
	});

	it("close() with nothing buffered writes nothing, and never rejects when the store throws", async () => {
		const { store, inserts } = fakeStore();
		const w = createGenerationLogWriter("g", "c", { store });
		await w.close();
		expect(inserts).toEqual([]);
		const failing = createGenerationLogWriter("g", "c", {
			store: { insert: async () => Promise.reject(new Error("db down")), remove: async () => 0 },
		});
		failing.append("{}");
		await expect(failing.close()).resolves.toBeUndefined();
	});

	it("flush() writes at once, and scheduleDelete removes the rows only after the grace period", async () => {
		const { store, inserts, removed } = fakeStore();
		const w = createGenerationLogWriter("g", "c", { store, graceMs: 1000 });
		w.append("{}");
		w.flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(inserts).toHaveLength(1);
		let held: Promise<unknown> | undefined;
		w.scheduleDelete((work) => {
			held = work;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(removed).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await held;
		expect(removed).toEqual(["g"]);
	});
});
