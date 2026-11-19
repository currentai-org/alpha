import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("./logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const { resolveHarness } = await import("./harness");
const { buildPersonaPrompt, CRISIS_AND_VALUES_CLAUSE } = await import("./textGeneration/persona");
const { guardsOnlyPrompt } = await import("./textGeneration/native");
const { takesCompactFence } = await import("./harnessProfiles");

const LOCAL = "qwen2.5-0.5b-instruct";

// Every hosted row's persona prompt hash and the prompt its plan picks, taken from develop before the
// local model's row existed. A hosted model's system prompt changing fails here.
const HOSTED: Record<string, { hash: string; prompt: "persona" | "minimal" }> = {
	"mistral-large-2512": { hash: "0ea4ebe6c6f0f167", prompt: "minimal" },
	"mistral-large-2610": { hash: "04c6db7147300cfe", prompt: "minimal" },
	"mistral-small-2603": { hash: "60709dc59a0bee02", prompt: "minimal" },
	"mistral-medium-2604": { hash: "c5ce13e2da1424f4", prompt: "minimal" },
	"swiss-ai/apertus-v1.5-70b": { hash: "8961752c82bd04d2", prompt: "persona" },
	"swiss-ai/apertus-v1.5-70b-thinking": { hash: "75d7614fd813f2e8", prompt: "persona" },
	"swiss-ai/apertus-v1.5-8b": { hash: "b76ed1bbaa224efa", prompt: "persona" },
	"swiss-ai/apertus-8b-instruct": { hash: "0ed911af16cfdb3e", prompt: "persona" },
	"aisingapore/qwen-sea-lion-v4-32b-it": { hash: "f167e93bf40b1b77", prompt: "persona" },
	"aisingapore/gemma-sea-lion-v4-27b-it": { hash: "c3054100be23d443", prompt: "persona" },
	"aisingapore/nemotron-sea-lion-v4.8-120b-a12b": { hash: "d81e5e1551ad07a5", prompt: "persona" },
	"bsc-lt/alia-40b-instruct": { hash: "442e957b6977f41f", prompt: "minimal" },
	"speakleash/bielik-11b-v3.0-instruct": { hash: "b4274bbc6823d3d2", prompt: "persona" },
	"zai-org/glm-5.2": { hash: "b421da202921fd48", prompt: "minimal" },
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("the self-host local model's prompt", () => {
	it("leaves every hosted model's persona text and its plan's prompt choice byte-for-byte as before", () => {
		for (const [id, want] of Object.entries(HOSTED)) {
			expect({ id, hash: sha(buildPersonaPrompt(id)) }).toEqual({ id, hash: want.hash });
			// With tool support, so the plan is the row's alone.
			const plan = resolveHarness({ id, supportsTools: true });
			expect({ id, prompt: plan.prompt }).toEqual({ id, prompt: want.prompt });
		}
	});

	it("takes the short prompt and grounded decoding for the compose local model, with pre-turn retrieval kept because llama.cpp lists no tool support", () => {
		const plan = resolveHarness({ id: LOCAL, supportsTools: false });
		expect(plan).toMatchObject({ prompt: "minimal", retrieval: "pipeline", mathRouting: false, decoding: "grounded" });
	});

	it("gives the compose local model the short fenced guard and no hosted model", () => {
		expect(takesCompactFence(LOCAL)).toBe(true);
		for (const id of Object.keys(HOSTED)) expect({ id, compact: takesCompactFence(id) }).toEqual({ id, compact: false });
	});

	it("gives a local model under any other alias the full persona, since a row is exact-match (an unlisted model gets the conservative turn)", () => {
		expect(resolveHarness({ id: "my-own-gguf", supportsTools: false }).prompt).toBe("persona");
	});

	it("keeps the crisis, values and injection clauses in the short prompt while cutting at least a third of the persona's size", () => {
		const short = guardsOnlyPrompt({
			modelId: LOCAL,
			today: "Saturday 7 November 2026",
			account: { loginOffered: false, signedIn: false },
		} as Parameters<typeof guardsOnlyPrompt>[0]);
		expect(short).toContain(CRISIS_AND_VALUES_CLAUSE);
		expect(short).toMatch(/claim is FALSE/);
		expect(short.length).toBeLessThan(buildPersonaPrompt(LOCAL).length * 0.67);
	});
});
