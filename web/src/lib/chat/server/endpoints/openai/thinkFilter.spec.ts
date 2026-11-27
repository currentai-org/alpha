import { describe, it, expect, vi } from "vitest";
import { logger } from "$lib/chat/server/logger";
import { ThinkFilter, dropsReasoning, reasoningOffRequest, thinkChars } from "./thinkFilter";
import { openAIChatToTextGenerationStream } from "./openAIChatToTextGenerationStream";
import { opensReasoningUntagged } from "../../harnessProfiles";

const run = (chunks: string[]) => {
	const f = new ThinkFilter();
	const out = chunks.map((c) => f.push(c)).join("") + f.flush();
	return { out, stripped: f.stripped };
};

describe("ThinkFilter", () => {
	it("removes a block whose tags arrive split across chunks", () => {
		expect(run(["<th", "ink>Let me use the calc", " block</thi", "nk>391"])).toEqual({
			out: "391",
			stripped: "Let me use the calc block".length,
		});
	});

	it("drops an unclosed block to the end, since the answer never started", () => {
		expect(run(["Sure. <think>still reasoning when the cap hit"]).out).toBe("Sure. ");
	});

	it("releases a held '<' that turns out not to be a tag", () => {
		expect(run(["a <", "b"]).out).toBe("a <b");
	});

	it("passes text with no block through unchanged", () => {
		expect(run(["17 × 23 ", "= 391"])).toEqual({ out: "17 × 23 = 391", stripped: 0 });
	});
});

describe("dropsReasoning", () => {
	it("names GLM ids in either spelling and nothing else", () => {
		expect(dropsReasoning("zai-org/GLM-5.3")).toBe(true);
		expect(dropsReasoning("zai-org/glm-5.3")).toBe(true);
		expect(dropsReasoning("swiss-ai/apertus-v1.5-70b")).toBe(false);
		expect(dropsReasoning(undefined)).toBe(false);
	});
});

type Delta = { content?: string; reasoning_content?: string };
async function* chunks(model: string, deltas: Delta[], finish = "stop") {
	for (let i = 0; i < deltas.length; i++) {
		yield {
			model,
			choices: [{ delta: deltas[i], finish_reason: i === deltas.length - 1 ? finish : null }],
		};
	}
}
async function answer(model: string, deltas: Delta[], finish = "stop") {
	let final: string | null = null;
	let streamed = "";
	let heldFlags = 0;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for await (const o of openAIChatToTextGenerationStream(chunks(model, deltas, finish) as any)) {
		streamed += o.token.text;
		if (o.generated_text !== null) final = o.generated_text;
		if ((o as { reasoningHeld?: true }).reasoningHeld) {
			// The flag says reasoning is held; the held text itself must not ride along on that chunk.
			expect(o.token.text).toBe("");
			heldFlags++;
		}
	}
	heldCounts.set(deltas, heldFlags);
	return { streamed, final };
}
const heldCounts = new WeakMap<Delta[], number>();

// What a visitor and the stored message see when GLM answers a chat turn. Both wire
// shapes GLM arrives in are covered, and Apertus is the control that must be left alone.
describe("openAIChatToTextGenerationStream — a GLM answer carries no reasoning", () => {
	it("drops reasoning_content deltas (the Hugging Face router's shape)", async () => {
		const r = await answer("zai-org/glm-5.3", [
			{ reasoning_content: "17 * 20 = 340, " },
			{ reasoning_content: "340 + 51 = 391" },
			{ content: "17 × 23 = 391" },
		]);
		expect(r).toEqual({ streamed: "17 × 23 = 391", final: "17 × 23 = 391" });
	});

	it("drops an inline <think> block (a vLLM server with no reasoning parser)", async () => {
		const r = await answer("zai-org/GLM-5.3", [
			{ content: "<think>Let me use the calc" },
			{ content: " block as required</think>" },
			{ content: "391" },
		]);
		expect(r).toEqual({ streamed: "391", final: "391" });
	});

	it("keeps an Apertus turn's reasoning exactly as before", async () => {
		const r = await answer("swiss-ai/apertus-v1.5-70b", [
			{ reasoning_content: "thinking" },
			{ content: "391" },
		]);
		expect(r.final).toBe("<think>thinking</think>391");
	});
});

// A model can open its reasoning with no `<think>` and end it with a bare `</think>` (ALIA 40B's shape). The client folds only a tagged block, so unhandled, the reasoning would be the
// visible answer.
describe("openAIChatToTextGenerationStream — an untagged-reasoning model's reasoning is folded, not shown", () => {
	const ALIA = "BSC-LT/ALIA-40b-instruct";

	it("streams reasoning live inside an opened think block and closes it at the bare </think>", async () => {
		const r = await answer(ALIA, [
			{ content: "The user's message is wrapped in markers. " },
			{ content: "I should answer concisely.\n</th" },
			{ content: "ink>The capital of Poland" },
			{ content: " is Warsaw." },
		]);
		const folded =
			"<think>The user's message is wrapped in markers. I should answer concisely.\n</think>The capital of Poland is Warsaw.";
		expect(r).toEqual({ streamed: folded, final: folded });
	});

	it("shows a reply that never closes a think block as the answer, after streaming it live in the folded block", async () => {
		const r = await answer(ALIA, [{ content: "The capital of Poland " }, { content: "is Warsaw." }]);
		const shown = "<think>The capital of Poland is Warsaw.</think>The capital of Poland is Warsaw.";
		expect(r).toEqual({ streamed: shown, final: shown });
	});

	// Holding everything until </think> or the end would leave a long answer with no reasoning blank
	// for its whole generation. Each chunk must reach the visitor as it arrives.
	it("sends each reasoning chunk on the push that brings it, not at the end", async () => {
		const { UntaggedReasoningHold } = await import("./thinkFilter");
		const hold = new UntaggedReasoningHold();
		expect(hold.push("1. **Understand")).toBe("<think>1. **Understand");
		expect(hold.push(" the goal.** ")).toBe(" the goal.** ");
		expect(hold.push("Done.</th")).toBe("Done.");
		expect(hold.push("ink>El tren arriba a les 12:15.")).toBe("</think>El tren arriba a les 12:15.");
	});

	it("streams a reply that opens with <answer> as the answer from its first chunk", async () => {
		const { UntaggedReasoningHold } = await import("./thinkFilter");
		const hold = new UntaggedReasoningHold();
		expect(hold.push("<ans")).toBe("");
		expect(hold.push("wer> Hola! ")).toBe("Hola!");
		expect(hold.push("T'esperem.")).toBe(" T'esperem.");
	});

	it("folds a reply cut off at the token cap before </think>, since it was still reasoning", async () => {
		const r = await answer(
			ALIA,
			[{ content: "The user's message is wrapped in markers. " }, { content: "I think the safest is to" }],
			"length"
		);
		expect(r.final?.startsWith("<think>The user's message is wrapped in markers. I think the safest is to")).toBe(true);
		expect(r.final).not.toContain("</think>");
	});

	// The reasoning itself streams, so the hold flag is set only while a first chunk could still be
	// `<think>` or `<answer>`.
	it("streams reasoning instead of flagging a hold, and flags only an ambiguous first chunk", async () => {
		const deltas = [
			{ content: "1. **Identify the core entity" },
			{ content: "** and answer.\n" },
			{ content: "</think>Warsaw." },
		];
		await answer(ALIA, deltas);
		expect(heldCounts.get(deltas)).toBe(0);
		const ambiguous = [{ content: "<" }, { content: "reasoning starts" }, { content: "</think>Warsaw." }];
		await answer(ALIA, ambiguous);
		expect(heldCounts.get(ambiguous)).toBe(1);
	});

	it("does not flag a reply that opens with <think>, since it streams its reasoning tagged", async () => {
		const deltas = [{ content: "<think>short" }, { content: "</think>Warsaw." }];
		await answer(ALIA, deltas);
		expect(heldCounts.get(deltas)).toBe(0);
	});

	it("does not flag a model with no untagged hold", async () => {
		const deltas = [{ content: "reasoning" }, { content: "</think>Warsaw." }];
		await answer("swiss-ai/apertus-v1.5-70b", deltas);
		expect(heldCounts.get(deltas)).toBe(0);
	});

	it("passes a reply that does open with <think> through unchanged", async () => {
		const r = await answer(ALIA, [{ content: "<think>short</think>" }, { content: "Warsaw." }]);
		expect(r.final).toBe("<think>short</think>Warsaw.");
	});

	// ALIA's shape on Catalan drafting turns with no reasoning: the reply wrapped whole.
	it("drops the <answer> wrapper around a reply with no reasoning, tags split across chunks", async () => {
		const r = await answer(ALIA, [
			{ content: "<ans" },
			{ content: "wer> Hola! T'esperem dissabte." },
			{ content: " </answ" },
			{ content: "er>" },
		]);
		expect(r).toEqual({ streamed: "Hola! T'esperem dissabte.", final: "Hola! T'esperem dissabte." });
	});

	it("drops the <answer> wrapper after folded reasoning, and keeps the words inside it", async () => {
		const r = await answer(ALIA, [
			{ content: "Short message, in Catalan.</think>\n<answer> Hola, " },
			{ content: "vine a l'hort. " },
			{ content: "</answer>" },
		]);
		const folded = "<think>Short message, in Catalan.</think>\nHola, vine a l'hort.";
		expect(r).toEqual({ streamed: folded, final: folded });
	});

	// The held text of a reply with no reasoning goes through the answer strip, which must be flushed at
	// the end of the stream, or a tail that could start "<answer>" is lost.
	it("keeps the last characters of a reply with no reasoning that could start a tag", async () => {
		const r = await answer(ALIA, [{ content: "Use a < " }, { content: "b, then a <" }]);
		const shown = "<think>Use a < b, then a <</think>Use a < b, then a <";
		expect(r).toEqual({ streamed: shown, final: shown });
	});

	it("drops the <answer> wrapper from a reply that opens with <think>", async () => {
		const r = await answer(ALIA, [{ content: "<think>short</think><answer>Warsaw." }, { content: "</answer>" }]);
		expect(r.final).toBe("<think>short</think>Warsaw.");
	});

	it("keeps an <answer> tag from a model not on the list", async () => {
		const r = await answer("swiss-ai/apertus-v1.5-70b", [{ content: "<answer>Warsaw.</answer>" }]);
		expect(r.final).toBe("<answer>Warsaw.</answer>");
	});

	it("leaves a model not on the list alone, bare </think> and all", async () => {
		const r = await answer("swiss-ai/apertus-v1.5-70b", [{ content: "reasoning</think>" }, { content: "Warsaw." }]);
		expect(r.final).toBe("reasoning</think>Warsaw.");
	});
});

describe("opensReasoningUntagged", () => {
	it("names ALIA in any case and with a provider suffix, and nothing else", () => {
		expect(opensReasoningUntagged("BSC-LT/ALIA-40b-instruct")).toBe(true);
		expect(opensReasoningUntagged("bsc-lt/alia-40b-instruct:nextbit")).toBe(true);
		expect(opensReasoningUntagged("mistral-large-2512")).toBe(false);
		expect(opensReasoningUntagged(undefined)).toBe(false);
	});
});

// HF providers differ in how GLM's reasoning is turned off, so a reasoning-off call is pinned to a
// provider verified to honour its reasoning-off field, and only where the pin names a provider
// that serves the model.
describe("reasoningOffRequest pins a multi-provider GLM to a measured provider on the HF router only", () => {
	const HF = "https://router.huggingface.co/v1";

	it("refuses a GLM id with no pin on the HF router, naming it, rather than letting the router pick", () => {
		expect(() => reasoningOffRequest("zai-org/GLM-5.3", HF)).toThrow(/zai-org\/GLM-5\.3 has no HF provider pin/);
		expect(() => reasoningOffRequest("zai-org/glm-5.3", HF)).toThrow(/no HF provider pin/);
	});

	it("refuses GLM-5.2 and GLM-5.2-FP8 by name, whatever the id's case, now that neither has a pin", () => {
		expect(() => reasoningOffRequest("zai-org/GLM-5.2", HF)).toThrow(/zai-org\/GLM-5\.2 has no HF provider pin/);
		expect(() => reasoningOffRequest("zai-org/glm-5.2-fp8", HF)).toThrow(/zai-org\/glm-5\.2-fp8 has no HF provider pin/);
	});

	it("keeps a provider suffix the id already carries", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.3:baseten", HF).model).toBe("zai-org/GLM-5.3:baseten");
	});

	it("never adds an HF provider suffix off the HF router, where it would name nothing", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.3", "https://gateway.example/v1").model).toBe(
			"zai-org/GLM-5.3"
		);
		expect(reasoningOffRequest("zai-org/GLM-5.3", undefined).model).toBe("zai-org/GLM-5.3");
	});

	it("turns reasoning off with `thinking` for novita, zai-org and hosts off the router", () => {
		const off = { thinking: { type: "disabled" } };
		expect(reasoningOffRequest("zai-org/GLM-5.3:novita", HF).fields).toEqual(off);
		expect(reasoningOffRequest("zai-org/GLM-5.2-FP8:zai-org", HF).fields).toEqual(off);
		expect(reasoningOffRequest("zai-org/GLM-5.3", "https://gateway.example/v1").fields).toEqual(off);
	});

	// Scaleway ignores `thinking` and honours `reasoning_effort: "none"`, so a call that names it
	// still gets that field.
	it("turns GLM-5.2's reasoning off with reasoning_effort on scaleway, never thinking", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.2:scaleway", HF).fields).toEqual({ reasoning_effort: "none" });
	});

	// DeepInfra turns GLM-5.2's reasoning off with reasoning_effort "none". The default pin for GLM-5.2
	// is Featherless; this row serves a call that names DeepInfra explicitly.
	it("turns GLM-5.2's reasoning off with reasoning_effort none on a call that names deepinfra", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.2:deepinfra", HF).fields).toEqual({ reasoning_effort: "none" });
	});

	it("pins Gemma 4 to featherless-ai and sends it no reasoning field, since its verified row has none", () => {
		const req = reasoningOffRequest("google/gemma-4-31B-it", HF);
		expect(req.model).toBe("google/gemma-4-31B-it:featherless-ai");
		expect(req.fields).toEqual({});
	});

	// Featherless honours neither `thinking` nor `reasoning_effort` for GLM-5.2, so its profile row sends
	// nothing rather than a guess.
	it("sends no reasoning field to GLM-5.2 named on featherless-ai, since Featherless honours none", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.2:featherless-ai", HF).fields).toEqual({});
	});

	// The entity-scope guard runs on Qwen3.6, which DeepInfra serves with reasoning turned off by
	// reasoning_effort "none".
	it("pins Qwen3.6 to deepinfra and turns its reasoning off with reasoning_effort none", () => {
		const req = reasoningOffRequest("Qwen/Qwen3.6-35B-A3B", HF);
		expect(req.model).toBe("Qwen/Qwen3.6-35B-A3B:deepinfra");
		expect(req.fields).toEqual({ reasoning_effort: "none" });
	});
});

// Mistral's API answers 422 extra_forbidden on `thinking`, so a direct host gets no guess.
describe("reasoningOffRequest sends the unverified thinking field only to the gateway and the HF router", () => {
	const GATEWAY = "https://gateway.example/v1";
	it("sends nothing to a direct host with no verified row", () => {
		expect(reasoningOffRequest("mistral-medium-2604", "https://api.mistral.ai/v1", GATEWAY)).toEqual({
			model: "mistral-medium-2604",
			fields: {},
		});
	});

	it("still sends the fallback to the gateway itself", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.3", `${GATEWAY}/`, GATEWAY).fields).toEqual({
			thinking: { type: "disabled" },
		});
	});
});

describe("thinkChars", () => {
	it("sums every closed block, counts an unclosed one to the end, and finds none in plain text", () => {
		expect(thinkChars("<think>abc</think>x<think>de</think>y")).toBe(5);
		expect(thinkChars("x<think>still going")).toBe("still going".length);
		expect(thinkChars("no reasoning here")).toBe(0);
	});
});

// The finish line's reasoningChars sizes each model's reasoning allowance, so it must read the
// same for reasoning in its own field (Large 4) and reasoning written into the content (ALIA, GLM).
describe("the [generation] finish line counts reasoning however the model sends it", () => {
	async function reasoningCharsOf(model: string, deltas: Delta[]) {
		const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
		try {
			await answer(model, deltas);
			const finish = info.mock.calls.find((c) => c[1] === "[generation] finish");
			return (finish?.[0] as { reasoningChars?: number }).reasoningChars;
		} finally {
			info.mockRestore();
		}
	}

	it("counts reasoning sent in its own field", async () => {
		expect(
			await reasoningCharsOf("mistral-large-2610", [{ reasoning_content: "Plan the days." }, { content: "Day 1." }])
		).toBe("Plan the days.".length);
	});

	it("counts ALIA's untagged reasoning up to its bare </think>", async () => {
		expect(
			await reasoningCharsOf("BSC-LT/ALIA-40b-instruct", [{ content: "Think it over.\n</think>Warsaw." }])
		).toBe("Think it over.\n".length);
	});

	it("reads zero for an ALIA reply that never closed a block, though the answer is copied into one", async () => {
		expect(await reasoningCharsOf("BSC-LT/ALIA-40b-instruct", [{ content: "Warsaw is the capital." }])).toBe(0);
	});

	it("counts the reasoning a GLM answer drops", async () => {
		expect(await reasoningCharsOf("zai-org/GLM-5.2", [{ content: "<think>17 × 23</think>391" }])).toBe(
			"17 × 23".length
		);
	});
});
