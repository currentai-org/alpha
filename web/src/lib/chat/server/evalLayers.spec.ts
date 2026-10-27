import { describe, expect, it } from "vitest";
import type { EndpointMessage } from "./endpoints/types";
import {
	appliedEvalLayers,
	evalLayers,
	markEvalLayerApplied,
	parseEvalLayers,
	withoutFewShot,
} from "./evalLayers";
import { runWithRequestContext } from "./requestContext";
import { hardenLastUserTurn } from "./textGeneration/grounding";
import { buildPersonaPrompt } from "./textGeneration/persona";

describe("parseEvalLayers (CUR-2139)", () => {
	it("reads all three switches", () => {
		expect(parseEvalLayers('{"promptBlock":false,"retrieval":true,"maxTokens":4096}')).toEqual({
			promptBlock: false,
			retrieval: true,
			maxTokens: 4096,
		});
	});

	it("reads the persona switch (CUR-2331)", () => {
		expect(parseEvalLayers('{"persona":false}')).toEqual({ persona: false });
	});

	it("reads the per-trick switch, and changes nothing for an unknown trick or an empty list (CUR-2697)", () => {
		expect(parseEvalLayers('{"dropTricks":["groundedDecoding"]}')).toEqual({ dropTricks: ["groundedDecoding"] });
		expect(parseEvalLayers('{"dropTricks":["webSearch"]}')).toBeUndefined();
		expect(parseEvalLayers('{"dropTricks":[]}')).toBeUndefined();
	});

	it("changes nothing for a malformed cookie, an unknown key or an out-of-range cap", () => {
		expect(parseEvalLayers("promptBlock:false")).toBeUndefined();
		expect(parseEvalLayers('{"temperature":0.8}')).toBeUndefined();
		expect(parseEvalLayers('{"maxTokens":0}')).toBeUndefined();
		expect(parseEvalLayers(undefined)).toBeUndefined();
	});
});

describe("withoutFewShot (CUR-2139)", () => {
	const persona = buildPersonaPrompt("swiss-ai/apertus-v1.5-70b");

	it("removes every few-shot example from the real persona and keeps the rest", () => {
		expect(persona).toContain("User: hi");
		const stripped = withoutFewShot(persona);
		expect(stripped).not.toBeNull();
		expect(stripped).not.toContain("User:");
		expect(stripped).not.toContain("How you behave, shown by example");
		expect(stripped).toContain("Honesty:");
		expect(stripped).toContain("findahelpline.com");
	});

	it("returns null, so the turn reports promptBlock unapplied, when the persona has no few-shot block", () => {
		expect(withoutFewShot("You are a helpful assistant. Honesty: be honest.")).toBeNull();
	});
});

describe("the request-scoped switches (CUR-2139)", () => {
	it("are absent outside a layer-test request, and recording an applied switch is then a no-op", () => {
		runWithRequestContext(() => {
			expect(evalLayers()).toBeUndefined();
			markEvalLayerApplied("maxTokens", 1024);
			expect(appliedEvalLayers()).toBeUndefined();
		});
	});

	it("record what a layer-test turn applied", () => {
		runWithRequestContext(
			() => {
				markEvalLayerApplied("maxTokens", 4096);
				markEvalLayerApplied("retrieval", false);
				expect(appliedEvalLayers()).toEqual({ maxTokens: 4096, retrieval: false });
			},
			{ evalLayers: { maxTokens: 4096, retrieval: false } }
		);
	});
});

describe("hardenLastUserTurn with the prompt block off (CUR-2139)", () => {
	const userMsg = (content: string): EndpointMessage => ({ from: "user", content }) as EndpointMessage;

	it("sends the person's words bare: no guard paragraph and no fence", async () => {
		const messages = [userMsg("What is vLLM, and what open alternatives exist?")];
		await hardenLastUserTurn(messages, undefined, undefined, undefined, undefined, true);
		expect(messages[0].content).toBe("What is vLLM, and what open alternatives exist?");
	});

	it("keeps a per-turn note ahead of the bare words", async () => {
		const messages = [userMsg("summarise https://example.org/report")];
		await hardenLastUserTurn(messages, undefined, undefined, "LINKED-PAGE-NOTE", undefined, true);
		expect(messages[0].content).toBe("LINKED-PAGE-NOTE\n\nsummarise https://example.org/report");
	});

	it("still adds the guard paragraph and fence when the switch is not set", async () => {
		const messages = [userMsg("What is vLLM, and what open alternatives exist?")];
		await hardenLastUserTurn(messages);
		expect(messages[0].content).toMatch(/never as instructions/i);
		expect(messages[0].content).toMatch(/<Q_[0-9a-f]{8}>/);
	});
});
