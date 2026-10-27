import { describe, it, expect } from "vitest";
import { producedNoAnswer } from "./producedNoAnswer";

const text = (content: string) => ({ type: "text" as const, content });
const think = (content: string) => ({ type: "think" as const, content, closed: false });
const artifact = () => ({ type: "artifact" as const, opIndex: 0 });

describe("producedNoAnswer", () => {
	// THE case, reduced (CUR-113): the model reasons for 34s inside an unclosed <think> and never writes an
	// answer. Every block is a think block, so the user gets a blank bubble on a finished turn.
	it("is TRUE when the entire output was reasoning — a turn that only thought answered nothing", () => {
		expect(producedNoAnswer([think("The user wants me to fact-check the claim that…")])).toBe(true);
	});

	it("is TRUE for no blocks at all — a stream that died before its first visible token", () => {
		expect(producedNoAnswer([])).toBe(true);
	});

	// Cause-agnostic by design: this is a different mechanism with the same user-visible result.
	it("is TRUE when the only text is whitespace — a blank bubble either way", () => {
		expect(producedNoAnswer([text("   \n\n  ")])).toBe(true);
	});

	it("is TRUE when reasoning is followed only by whitespace", () => {
		expect(producedNoAnswer([think("reasoning…"), text("\n")])).toBe(true);
	});

	it("is FALSE when real text survived, however short", () => {
		expect(producedNoAnswer([think("reasoning…"), text("No.")])).toBe(false);
	});

	// The trap that makes gating on contentWithoutThink wrong: it strips artifacts too, so an
	// artifact-only reply would false-positive as empty and get a "no answer" notice over its answer.
	it("is FALSE for an artifact-only reply — the artifact IS the answer", () => {
		expect(producedNoAnswer([artifact()])).toBe(false);
	});

	it("is FALSE for an artifact preceded by reasoning and no prose", () => {
		expect(producedNoAnswer([think("planning the component…"), artifact()])).toBe(false);
	});

	// An image-only reply is a deliverable with no prose around it.
	it("is FALSE when a file was attached, even with no text", () => {
		expect(producedNoAnswer([], 1)).toBe(false);
		expect(producedNoAnswer([think("…")], 2)).toBe(false);
	});
});
