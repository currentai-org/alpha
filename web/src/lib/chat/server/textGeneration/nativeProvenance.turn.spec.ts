/**
 * On the native harness, asked "where are you running right now?", a model can answer "on AI
 * Potluck's infrastructure". The scaffolded turn carries the per-turn provenance facts
 * (provenanceFacts.ts, CUR-1435); the native system prompt must carry them too, or the model places
 * itself in "AI Potluck's chat".
 *
 * Drives the real turn under a tool-calling plan and records the system prompt `generate` is handed. (CUR-2135)
 */
import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const state: { preprompt?: string; laneRewrites?: Record<string, Array<[string, string]>>; factsOn: boolean } = {
	factsOn: true,
};

vi.mock("./generate", () => ({
	generate: async function* (
		ctx: { laneRewrites?: Record<string, Array<[string, string]>> },
		preprompt: string
	): AsyncGenerator<MessageUpdate> {
		state.preprompt = preprompt;
		state.laneRewrites = ctx.laneRewrites;
		yield { type: MessageUpdateType.FinalAnswer, text: "model text", interrupted: false };
	},
}));
vi.mock("./turnPreferences", () => ({
	resolveTurnPreferences: async () => ({ replyInUserLanguage: false }),
	effectivePreprompt: (preprompt: string | undefined) => preprompt,
}));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));
vi.mock("./provenanceFacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./provenanceFacts")>()),
	provenanceFactsEnabled: () => state.factsOn,
}));

import { textGenerationWithoutTitle } from "./index";
import { planFromTricks } from "../harness";
import type { TextGenerationContext } from "./types";

// The facts block's first line (provenanceFacts.ts, CUR-3771).
const PROVENANCE_FACTS_HEADER = "Background about you for this turn, never part of your reply:";

const LARGE_3 = "mistral-large-2512";
const MEDIUM_LANE = { type: "openai", baseURL: "https://api.mistral.ai/v1", modelId: "mistral-medium-2604" };
let mediumLane: Record<string, string> = MEDIUM_LANE;

function ctx(): TextGenerationContext {
	return {
		harness: planFromTricks(new Set()),
		model: {
			id: LARGE_3,
			name: LARGE_3,
			endpoints: [
				{ type: "openai", baseURL: "https://api.mistral.ai/v1" },
				mediumLane,
			],
		},
		endpoint: {},
		conv: { _id: new ObjectId(), title: "t", messages: [], preprompt: "" },
		messages: [
			{
				id: crypto.randomUUID(),
				from: "user",
				content: "Which model are you, who made you, and where are you running right now?",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
		webSearchMode: "off",
		promptedAt: new Date(),
		ip: "127.0.0.1",
		locals: undefined,
		abortController: new AbortController(),
	} as unknown as TextGenerationContext;
}

async function run(): Promise<string> {
	state.preprompt = undefined;
	for await (const _ of textGenerationWithoutTitle(ctx(), new AbortController())) void _;
	return state.preprompt ?? "";
}

describe("a native turn tells the model where it runs (CUR-2135)", () => {
	it("carries the provenance facts, naming no host even when Large 3 goes direct (CUR-3562)", async () => {
		// A fallback can serve the turn elsewhere, so only the answer's provenance line names the host.
		state.factsOn = true;
		const system = await run();
		expect(system).toContain(PROVENANCE_FACTS_HEADER);
		expect(system).toContain("do not add a line about where the answer ran");
		expect(system).not.toMatch(/La Plateforme|in France/);
	});

	it("a backup lane's prompt names the backup model in its facts, not the one it replaced", async () => {
		state.factsOn = true;
		await run();
		const [[, to]] = state.laneRewrites?.["mistral-medium-2604"] ?? [["", ""]];
		expect(to).toContain(`${PROVENANCE_FACTS_HEADER}\n- You are Mistral Medium`);
		expect(to).not.toContain("You are Mistral Large 3");
	});

	it("a backup lane whose host names Medium by a wire id is rewritten under the id failover looks up (CUR-3777)", async () => {
		// directWire gives the lane `modelId: <wire id>, servedAs: <our id>`, and laneModelIds names it by
		// servedAs. Keyed by the wire id, the pairs were never found and Medium answered as Large 3.
		state.factsOn = true;
		mediumLane = { ...MEDIUM_LANE, modelId: "mistral-medium-latest", servedAs: "mistral-medium-2604" };
		try {
			await run();
		} finally {
			mediumLane = MEDIUM_LANE;
		}
		expect(Object.keys(state.laneRewrites ?? {})).toEqual(["mistral-medium-2604"]);
		const [[, to]] = state.laneRewrites?.["mistral-medium-2604"] ?? [["", ""]];
		expect(to).toMatch(/You are Mistral Medium/);
	});

	it("with provenance-facts-per-turn off, the native prompt carries no facts block", async () => {
		state.factsOn = false;
		expect(await run()).not.toContain(PROVENANCE_FACTS_HEADER);
	});
});
