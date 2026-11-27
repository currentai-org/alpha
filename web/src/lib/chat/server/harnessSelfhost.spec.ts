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
// The hashes cover the crisis clause that names no emergency number.
const HOSTED: Record<string, { hash: string; prompt: "persona" | "minimal" }> = {
	"mistral-large-2512": { hash: "2ac4540355f35466", prompt: "minimal" },
	"mistral-large-2610": { hash: "83b0b8a7a92575d4", prompt: "minimal" },
	"mistral-small-2603": { hash: "4c6eb992b1cc8eb3", prompt: "minimal" },
	"mistral-medium-2604": { hash: "72da4d9b6500b5d0", prompt: "minimal" },
	"swiss-ai/apertus-v1.5-70b": { hash: "51444937f098fcce", prompt: "persona" },
	"swiss-ai/apertus-v1.5-70b-thinking": { hash: "20c18b4b13e91c01", prompt: "persona" },
	"swiss-ai/apertus-v1.5-8b": { hash: "29b470945b6cbee1", prompt: "persona" },
	"swiss-ai/apertus-8b-instruct": { hash: "99f48608102c3c1c", prompt: "persona" },
	"aisingapore/qwen-sea-lion-v4-32b-it": { hash: "e40e2cc60fd55c1a", prompt: "persona" },
	"aisingapore/gemma-sea-lion-v4-27b-it": { hash: "8862fcbf14e709c8", prompt: "persona" },
	"aisingapore/nemotron-sea-lion-v4.8-120b-a12b": { hash: "7205c1c253f700c4", prompt: "persona" },
	"bsc-lt/alia-40b-instruct": { hash: "8dc8f17c05c1dec3", prompt: "minimal" },
	"speakleash/bielik-11b-v3.0-instruct": { hash: "5dd9aa85cb47c66e", prompt: "persona" },
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
