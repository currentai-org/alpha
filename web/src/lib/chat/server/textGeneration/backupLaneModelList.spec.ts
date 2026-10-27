/**
 * A backup lane's prompt says it is the lane's model (the lane rewrites, CUR-2460), so its list
 * of models has to say so too. The list is built for the model that serves the turn, so it names the
 * lane's model as the one in use and lists the others. (CUR-3895)
 */
import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { resolveHarness } from "../harness";

vi.mock("../mcp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../mcp")>()),
	mcpEnabled: () => false,
}));
vi.mock("$lib/chat/server/flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/flags")>()),
	ensureFlagsPolled: async () => {},
}));
vi.mock("../localitySemantic", () => ({ isLocalityQuerySemantic: async () => false }));
vi.mock("./worldModel", async (importOriginal) => ({
	...(await importOriginal<typeof import("./worldModel")>()),
	WORLD_MODEL_PREPASS: false,
	maybeWorldModelNote: async () => null,
}));
vi.mock("./turnPreferences", () => ({
	resolveTurnPreferences: async () => ({ replyInUserLanguage: true }),
	effectivePreprompt: (preprompt: string | undefined) => preprompt,
}));
vi.mock("../tuning", () => ({ getTuning: async () => ({ decoding: {} }) }));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));
// The picker's ids, which a backup lane's own id need not match.
vi.mock("$lib/chat/server/models", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/models")>()),
	models: [
		{ id: "mistral-large-2512", name: "mistral-large-2512", displayName: "Mistral Large 3" },
		{ id: "swiss-ai/apertus-v1.5-70b", name: "swiss-ai/apertus-v1.5-70b", displayName: "Apertus 1.5 70B" },
		{ id: "mistralai/mistral-medium-3-5", name: "mistralai/mistral-medium-3-5", displayName: "Mistral Medium 3.5" },
	],
}));

import { textGenerationWithoutTitle } from "./index";
import type { TextGenerationContext } from "./types";

const LARGE_3 = "mistral-large-2512";
const MEDIUM_LANE = "mistral-medium-2604";

async function laneRewritesFor(harness: "native" | "scaffolded"): Promise<{ system: string; lane: string }> {
	let recorded: { preprompt: string; laneRewrites: Record<string, Array<[string, string]>> } | undefined;
	const endpoint = async (params: { preprompt: string; laneRewrites?: Record<string, Array<[string, string]>> }) => {
		recorded = { preprompt: params.preprompt, laneRewrites: params.laneRewrites ?? {} };
		return (async function* () {
			yield { token: { id: 0, text: "ok", logprob: 0, special: false }, generated_text: null, details: null };
			yield { token: { id: 1, text: "", logprob: 0, special: true }, generated_text: "ok", details: null };
		})();
	};
	const ctx = {
		model: {
			id: LARGE_3,
			name: LARGE_3,
			supportsTools: true,
			parameters: {},
			endpoints: [{ type: "openai" }, { type: "openai", modelId: MEDIUM_LANE }],
		},
		endpoint,
		conv: { _id: new ObjectId("000000000000000000000001"), title: "t", messages: [], preprompt: "" },
		messages: [{ id: "m1", from: "user", content: "Which models can I choose?", createdAt: new Date(), updatedAt: new Date() }],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		speakMode: "auto",
		webSearchMode: "off",
		locals: undefined,
		abortController: new AbortController(),
		// A model without tools carries every trick, which is how a spec asks for the scaffolded plan.
		harness: resolveHarness({ id: LARGE_3, supportsTools: harness === "native" }),
	} as unknown as TextGenerationContext;
	for await (const _ of textGenerationWithoutTitle(ctx, new AbortController()));
	const got = recorded as typeof recorded;
	if (!got) throw new Error("the turn never reached the endpoint");
	const pairs = got.laneRewrites[MEDIUM_LANE] ?? [];
	const lane = pairs.reduce((text, [from, to]) => text.replace(from, to), got.preprompt);
	return { system: got.preprompt, lane };
}

describe("a backup lane's list of models (CUR-3895)", () => {
	for (const harness of ["native", "scaffolded"] as const) {
		it(`${harness}: the lane's prompt marks Medium as answering and lists Large 3 among the others`, async () => {
			const { system, lane } = await laneRewritesFor(harness);
			expect(system).toContain("Mistral Large 3 (answering now");
			expect(lane).toContain("Mistral Medium 3.5 (answering now");
			expect(lane).toMatch(/Mistral Large 3 \(made by Mistral AI/);
			expect(lane.match(/answering now/g)).toHaveLength(1);
			expect(lane).toMatch(/That is 3 models/);
		});
	}
});
