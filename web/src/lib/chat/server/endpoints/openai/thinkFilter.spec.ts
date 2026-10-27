import { describe, it, expect } from "vitest";
import { ThinkFilter, dropsReasoning, reasoningOffRequest } from "./thinkFilter";
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

// What a visitor and the stored message see when GLM answers a chat turn (CUR-1933). Both wire
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
// visible answer (CUR-2470).
describe("openAIChatToTextGenerationStream — an untagged-reasoning model's reasoning is folded, not shown", () => {
	const ALIA = "BSC-LT/ALIA-40b-instruct";

	it("streams no reasoning as answer text and closes it into a think block at the bare </think>", async () => {
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

	it("releases a reply that never closes a think block as the answer, rather than hiding it", async () => {
		const r = await answer(ALIA, [{ content: "The capital of Poland " }, { content: "is Warsaw." }]);
		expect(r).toEqual({ streamed: "The capital of Poland is Warsaw.", final: "The capital of Poland is Warsaw." });
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

	// While the reasoning is held the visitor sees nothing, so the hold is flagged (CUR-3942).
	it("flags the hold once, on the first held chunk, without the held text", async () => {
		const deltas = [
			{ content: "1. **Identify the core entity" },
			{ content: "** and answer.\n" },
			{ content: "</think>Warsaw." },
		];
		await answer(ALIA, deltas);
		expect(heldCounts.get(deltas)).toBe(1);
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

	// Shape from develop: Catalan drafting turns with no reasoning, the reply wrapped whole.
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

	// CUR-2470 review: the held text of a reply with no reasoning went through a second strip nobody flushed,
	// so a tail that could start "<answer>" was lost at the end of the stream.
	it("keeps the last characters of a reply with no reasoning that could start a tag", async () => {
		const r = await answer(ALIA, [{ content: "Use a < " }, { content: "b, then a <" }]);
		expect(r).toEqual({ streamed: "Use a < b, then a <", final: "Use a < b, then a <" });
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

// CUR-2090. HF providers disagree about how GLM's reasoning is turned off, so a reasoning-off call is
// pinned to the one measured to honour `thinking: disabled`, and only where the pin names a provider
// that serves the model.
describe("reasoningOffRequest pins a multi-provider GLM to a measured provider on the HF router only", () => {
	const HF = "https://router.huggingface.co/v1";

	it("refuses a GLM id with no pin on the HF router, naming it, rather than letting the router pick (CUR-2112)", () => {
		expect(() => reasoningOffRequest("zai-org/GLM-5.3", HF)).toThrow(/zai-org\/GLM-5\.3 has no HF provider pin/);
		expect(() => reasoningOffRequest("zai-org/glm-5.3", HF)).toThrow(/no HF provider pin/);
	});

	it("pins GLM-5.2-FP8 to zai-org, its one provider, whatever the id's case", () => {
		expect(reasoningOffRequest("zai-org/GLM-5.2-FP8", HF)).toEqual({
			model: "zai-org/GLM-5.2-FP8:zai-org",
			fields: { thinking: { type: "disabled" } },
		});
		expect(reasoningOffRequest("zai-org/glm-5.2-fp8", HF).model).toBe("zai-org/glm-5.2-fp8:zai-org");
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
		expect(reasoningOffRequest("zai-org/GLM-5.2-FP8", HF).fields).toEqual(off);
		expect(reasoningOffRequest("zai-org/GLM-5.3", "https://gateway.example/v1").fields).toEqual(off);
	});

	// Scaleway ignores `thinking` and honours `reasoning_effort: "none"` (CUR-2104): sent `thinking`, a
	// title or classifier call would keep reasoning and could spend its whole budget on it.
	it("pins GLM-5.2 to scaleway and turns its reasoning off with reasoning_effort, never thinking", () => {
		const req = reasoningOffRequest("zai-org/GLM-5.2", HF);
		expect(req.model).toBe("zai-org/GLM-5.2:scaleway");
		expect(req.fields).toEqual({ reasoning_effort: "none" });
		expect(reasoningOffRequest("zai-org/GLM-5.2:scaleway", HF).fields).toEqual({ reasoning_effort: "none" });
	});
});

// Mistral's API answered 422 extra_forbidden on `thinking`, so a direct host gets no guess. (CUR-2282)
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
