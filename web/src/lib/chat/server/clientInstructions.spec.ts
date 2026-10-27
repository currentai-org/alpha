import { describe, expect, it } from "vitest";
import {
	CLIENT_INSTRUCTIONS_MAX_CHARS,
	clientAuthoredInstructions,
	exceedsClientInstructionsCap,
	withClientInstructions,
} from "./clientInstructions";
import { guardChunkTexts } from "./guardGate";
import { GUARD_CORPUS_CAP, textOnlyGuardInput } from "./guardScreenTypes";

describe("CUR-3528 caller-written system text", () => {
	it("refuses a caller preprompt over the cap, and never refuses the model's own preprompt", () => {
		const long = "x".repeat(CLIENT_INSTRUCTIONS_MAX_CHARS + 1);
		expect(exceedsClientInstructionsCap(long)).toBe(true);
		expect(exceedsClientInstructionsCap(long, "something else")).toBe(true);
		expect(exceedsClientInstructionsCap(long, long)).toBe(false);
		expect(exceedsClientInstructionsCap("x".repeat(CLIENT_INSTRUCTIONS_MAX_CHARS))).toBe(false);
		expect(exceedsClientInstructionsCap(undefined)).toBe(false);
	});

	it("screens Personalization when on, else a preprompt the caller changed, and never the model's own", () => {
		expect(clientAuthoredInstructions("custom", "model default", "mine")).toBe("mine");
		expect(clientAuthoredInstructions("custom", "model default", null)).toBe("custom");
		expect(clientAuthoredInstructions("model default", "model default", null)).toBeUndefined();
		expect(clientAuthoredInstructions("   ", "", null)).toBeUndefined();
		expect(clientAuthoredInstructions(undefined, undefined, "  ")).toBeUndefined();
	});

	it("puts the instructions inside the window the guard actually screens, even behind a full history", () => {
		const history = "h".repeat(GUARD_CORPUS_CAP * 2);
		const screen = withClientInstructions(textOnlyGuardInput(history, "go on"), "MARKER instructions");
		const screened = guardChunkTexts(screen.corpus).join("");
		expect(screened).toContain("MARKER instructions");
		// The typed turn the Coop branch reads is left alone.
		expect(screen.typedTurnText).toBe("go on");
	});

	it("bounds a preprompt stored before the cap existed, so it cannot crowd the turn out of the window", () => {
		const stored = "p".repeat(GUARD_CORPUS_CAP);
		const screen = withClientInstructions(textOnlyGuardInput("TURN"), stored);
		expect(screen.corpus.length).toBe("TURN\n\n".length + CLIENT_INSTRUCTIONS_MAX_CHARS);
		expect(guardChunkTexts(screen.corpus).join("")).toContain("TURN");
	});

	it("leaves the screen untouched when the caller wrote nothing", () => {
		const input = textOnlyGuardInput("hello");
		expect(withClientInstructions(input, undefined)).toBe(input);
	});
});
