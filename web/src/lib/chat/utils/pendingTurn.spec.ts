import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PENDING_TURN_MAX_MS,
	clearPendingTurn,
	pendingTurnToAwait,
	recordPendingTurn,
} from "./pendingTurn";

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		getItem: (k: string) => items.get(k) ?? null,
		setItem: (k: string, v: string) => void items.set(k, v),
		removeItem: (k: string) => void items.delete(k),
	};
}

describe("pendingTurnToAwait (CUR-1893)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("waits for a turn this tab sent that the snapshot doesn't hold yet", () => {
		vi.stubGlobal("sessionStorage", memoryStorage());
		recordPendingTurn("c1", "u2", 1_000);
		expect(pendingTurnToAwait("c1", ["u1", "a1"], 3_000)).toBe("u2");
	});

	it("stops waiting once the snapshot holds the message, and forgets the record", () => {
		vi.stubGlobal("sessionStorage", memoryStorage());
		recordPendingTurn("c1", "u2", 1_000);
		expect(pendingTurnToAwait("c1", ["u1", "a1", "u2"], 3_000)).toBeUndefined();
		expect(pendingTurnToAwait("c1", ["u1"], 3_000)).toBeUndefined();
	});

	it("gives up on a turn older than the wait window rather than waiting on a lost one", () => {
		vi.stubGlobal("sessionStorage", memoryStorage());
		recordPendingTurn("c1", "u2", 1_000);
		expect(pendingTurnToAwait("c1", [], 1_000 + PENDING_TURN_MAX_MS + 1)).toBeUndefined();
	});

	it("is per conversation, and a cleared record waits for nothing", () => {
		vi.stubGlobal("sessionStorage", memoryStorage());
		recordPendingTurn("c1", "u2", 1_000);
		expect(pendingTurnToAwait("c2", [], 2_000)).toBeUndefined();
		clearPendingTurn("c1");
		expect(pendingTurnToAwait("c1", [], 2_000)).toBeUndefined();
	});

	it("does nothing, and throws nothing, when storage is unavailable", () => {
		const throwing = () => {
			throw new Error("SecurityError");
		};
		vi.stubGlobal("sessionStorage", { getItem: throwing, setItem: throwing, removeItem: throwing });
		expect(() => recordPendingTurn("c1", "u2")).not.toThrow();
		expect(pendingTurnToAwait("c1", [])).toBeUndefined();
	});
});
