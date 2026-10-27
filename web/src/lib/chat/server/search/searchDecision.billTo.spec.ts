import { beforeEach, describe, expect, it, vi } from "vitest";

// The search classifier's own call must follow the one bill-to rule (CUR-1877): the org goes to the
// HF router and to nothing else. Hermetic: models, config and the client factory are stubbed, and the
// test reads the headers the decider hands the client.
const h = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	clientOpts: [] as Array<{ defaultHeaders?: Record<string, string> }>,
	requestOpts: [] as Array<{ headers?: Record<string, string> }>,
	bodies: [] as unknown[],
}));

vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));
vi.mock("$lib/chat/server/config", () => ({ config: h.cfg }));
vi.mock("$lib/chat/server/openaiClient", () => ({
	createOpenAIClient: async (opts: { defaultHeaders?: Record<string, string> }) => {
		h.clientOpts.push(opts);
		return {
			chat: {
				completions: {
					create: async (body: unknown, reqOpts: { headers?: Record<string, string> }) => {
						h.bodies.push(body);
						h.requestOpts.push(reqOpts);
						return { choices: [{ message: { tool_calls: [] } }] };
					},
				},
			},
		};
	},
}));

import { decideSearchViaTool } from "./searchDecision";

const locals = { billingOrganization: "org" } as App.Locals;
const sentBillTo = () => [
	h.clientOpts[0]?.defaultHeaders?.["X-HF-Bill-To"],
	h.requestOpts[0]?.headers?.["X-HF-Bill-To"],
];

describe("decideSearchViaTool bill-to header (CUR-1877)", () => {
	beforeEach(() => {
		h.clientOpts.length = 0;
		h.requestOpts.length = 0;
		for (const k of Object.keys(h.cfg)) delete h.cfg[k];
		h.cfg.HF_BILL_TO = "org";
	});

	it("sends the org when the classifier's lane is the HF router", async () => {
		h.cfg.OPENAI_BASE_URL = "https://router.huggingface.co/v1";
		const verdict = await decideSearchViaTool("what happened today", locals);
		expect(verdict.ok).toBe(true);
		expect(sentBillTo()).toEqual(["org", "org"]);
	});

	it("sends no org to the LiteLLM gateway", async () => {
		h.cfg.OPENAI_BASE_URL = "https://api-internal.publicai.co/v1";
		const verdict = await decideSearchViaTool("what happened today", locals);
		expect(verdict.ok).toBe(true);
		expect(sentBillTo()).toEqual([undefined, undefined]);
	});

	it("sends no org on an own lane, even one pointed at the HF router", async () => {
		const ownLane = {
			id: "m",
			name: "m",
			endpoints: [{ type: "openai", baseURL: "https://router.huggingface.co/v1", apiKeyEnv: "OWN_LANE_KEY" }],
		};
		h.cfg.OWN_LANE_KEY = "own";
		const verdict = await decideSearchViaTool("what happened today", locals, ownLane as never);
		expect(verdict.ok).toBe(true);
		expect(sentBillTo()).toEqual([undefined, undefined]);
	});
});

// The photo itself reaches the model that decides, as an image part beside the question, so the
// model can judge it and write a query from what it shows. (CUR-3192)
describe("decideSearchViaTool sees the photo (CUR-3192)", () => {
	beforeEach(() => {
		h.bodies.length = 0;
		for (const k of Object.keys(h.cfg)) delete h.cfg[k];
	});

	type Body = { messages: Array<{ content: unknown }> };
	const content = () => (h.bodies[0] as Body).messages[0].content;

	it("a photo turn sends the question, the image rule and the photo as an image part", async () => {
		await decideSearchViaTool("What brand is the logo in this picture?", undefined, undefined, ["image"], [
			{ mime: "image/jpeg", b64: "AAAA" },
		]);
		const parts = content() as Array<{ type: string; text?: string; image_url?: { url: string } }>;
		expect(parts[0].type).toBe("text");
		expect(parts[0].text).toContain("What brand is the logo in this picture?");
		expect(parts[0].text).toContain("write the query from what you see");
		expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } });
	});

	it("a turn with no photo sends plain text, so its request is unchanged", async () => {
		await decideSearchViaTool("what happened today", undefined);
		expect(content()).toBe("what happened today");
	});
});
