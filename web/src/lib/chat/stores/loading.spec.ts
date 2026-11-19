import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { conversationLoading } from "./loading";

describe("conversationLoading", () => {
	it("a turn running in one conversation leaves every other conversation free", () => {
		const a = conversationLoading("conv-a");
		const b = conversationLoading("conv-b");
		a.set(true);
		expect(get(a)).toBe(true);
		expect(get(b)).toBe(false);
		a.set(false);
	});

	it("a late write from one conversation's turn never clears another conversation's turn", () => {
		const a = conversationLoading("conv-c");
		const b = conversationLoading("conv-d");
		b.set(true);
		a.set(true);
		// The first turn's cleanup runs after the visitor has started a second one elsewhere.
		a.set(false);
		expect(get(b)).toBe(true);
		b.set(false);
	});

	it("stores for the same conversation agree, so the page and a turn read one state", () => {
		const page = conversationLoading("conv-e");
		const turn = conversationLoading("conv-e");
		turn.set(true);
		expect(get(page)).toBe(true);
		turn.set(false);
		expect(get(page)).toBe(false);
	});

	it("update reads the conversation's current state", () => {
		const a = conversationLoading("conv-f");
		a.update((on) => !on);
		expect(get(a)).toBe(true);
		a.update((on) => !on);
		expect(get(a)).toBe(false);
	});
});
