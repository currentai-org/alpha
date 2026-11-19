// The fail-open direction is the actual safety property this guard depends on (see the module
// header in entityScopeGuard.ts): an infra failure must keep a hit, never drop one, so grounding
// can only get MORE selective when the classifier genuinely runs, never less available when it
// doesn't. `withTimeout` itself (the mechanism a slow classifier degrades through) already has
// dedicated coverage in evidence.spec.ts — these tests prove the classifier's own logic and that
// filterByEntityScope wires it correctly, not the timeout primitive again.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: vi.fn(),
}));

// The guard pins to ENTITY_SCOPE_MODEL only when models.ts registered it, so both the
// config value and the registered list are test inputs here.
const pin = vi.hoisted(() => ({
	config: {} as Record<string, string>,
	models: [] as { id: string }[],
	logError: (() => {}) as (...args: unknown[]) => void,
}));
vi.mock("$lib/chat/server/config", () => ({ config: pin.config }));
vi.mock("$lib/chat/server/models", () => ({ models: pin.models }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: {
		error: (...args: unknown[]) => pin.logError(...args),
		warn: () => {},
		info: () => {},
		debug: () => {},
	},
}));

const QWEN = "Qwen/Qwen3.6-35B-A3B";
const GLM = "zai-org/GLM-5.2";

beforeEach(() => {
	vi.resetAllMocks();
	delete pin.config.ENTITY_SCOPE_MODEL;
	delete pin.config.SECOND_OPINION_MODEL;
	pin.models.length = 0;
	pin.logError = () => {};
});

import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import {
	classifyEntityMatch,
	filterByEntityScope,
	parseEntityMatchVerdict,
} from "./entityScopeGuard";

// Plain objects implementing the async-iterator protocol, not `async function*` — a generator that
// only returns (never yields) trips the main config's require-yield rule, and there's nothing to
// conditionally guard a yield behind here the way failover.spec.ts does for its throw-before-first-pull
// case. getReturnFromGenerator only ever calls `.next()`, so this is a faithful stand-in.
function immediateReturn<T>(value: T): AsyncGenerator<never, T, undefined> {
	return {
		next: async () => ({ done: true, value }),
		[Symbol.asyncIterator]() {
			return this;
		},
	} as unknown as AsyncGenerator<never, T, undefined>;
}

function immediateThrow(err: Error): AsyncGenerator<never, string, undefined> {
	return {
		next: async () => {
			throw err;
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	} as unknown as AsyncGenerator<never, string, undefined>;
}

function mockReply(text: string) {
	vi.mocked(generateFromDefaultEndpoint).mockReturnValueOnce(immediateReturn(text));
}

function mockThrows() {
	vi.mocked(generateFromDefaultEndpoint).mockReturnValueOnce(immediateThrow(new Error("boom")));
}

describe("parseEntityMatchVerdict", () => {
	it.each([
		["yes", "yes"],
		["Yes.", "yes"],
		["  yes, it does", "yes"],
		["no", "no"],
		["No.", "no"],
		["", "unparseable"],
		["maybe", "unparseable"],
		["I think yes but also no", "unparseable"],
	] as const)("%s -> %s", (raw, expected) => {
		expect(parseEntityMatchVerdict(raw)).toBe(expected);
	});
});

describe("classifyEntityMatch", () => {
	const hit = { title: "AI Potluck", snippet: "AI Potluck is a market map." };

	it("keeps the hit when the classifier says yes", async () => {
		mockReply("yes");
		await expect(classifyEntityMatch("What is AI Potluck?", hit, undefined)).resolves.toBe(true);
	});

	it("drops the hit when the classifier says no", async () => {
		mockReply("no");
		await expect(
			classifyEntityMatch("What is OpenAI working on right now?", hit, undefined)
		).resolves.toBe(false);
	});

	it("keeps the hit on unparseable output — fail-open, not a coin flip", async () => {
		mockReply("uh, hard to say");
		await expect(
			classifyEntityMatch("Compare Anthropic and OpenAI on safety.", hit, undefined)
		).resolves.toBe(true);
	});

	it("keeps the hit when the classifier call throws", async () => {
		mockThrows();
		await expect(
			classifyEntityMatch("Compare Anthropic and OpenAI on safety.", hit, undefined)
		).resolves.toBe(true);
	});

	it("keeps the hit for a too-short query without calling the model at all", async () => {
		await expect(classifyEntityMatch("hi", hit, undefined)).resolves.toBe(true);
		expect(generateFromDefaultEndpoint).not.toHaveBeenCalled();
	});

	// classifyEntityMatch's call goes through generateFromDefaultEndpoint -> endpointOai.ts,
	// which reads locals?.billingOrganization to bill the HF Inference-Providers call to the org
	// instead of the personal-user scope. A locals of undefined
	// resolves on the personal scope and 403s — the same mechanism classifySearchNeed already
	// threads locals through for (searchDecision.ts). This asserts the plumbing, not the HTTP call.
	it("forwards the real per-request locals to generateFromDefaultEndpoint, not undefined", async () => {
		mockReply("yes");
		const locals = { billingOrganization: "current-ai-official" } as App.Locals;
		await classifyEntityMatch("What is AI Potluck?", hit, locals);
		expect(generateFromDefaultEndpoint).toHaveBeenCalledWith(
			expect.objectContaining({ locals })
		);
	});

	// The gateway caches identical requests: without the opt-out the guard's samples of one hit return
	// one cached answer, and the majority vote is a single check counted CLASSIFY_SAMPLES times.
	it("asks the endpoint to skip the gateway cache, so each sample of a hit reaches the model", async () => {
		mockReply("yes");
		await classifyEntityMatch("What is AI Potluck?", hit, undefined);
		expect(generateFromDefaultEndpoint).toHaveBeenCalledWith(
			expect.objectContaining({ skipGatewayCache: true })
		);
	});

	// A model asked loosely can read "Who runs Current AI?" against the AI Potluck passage as "does
	// this passage answer it?" and say no, dropping the only about-us hit. The request has to tell the
	// model to judge the passage's subject only. This pins what is sent; whether the model
	// follows it is the live collision probe's job (pnpm eval:rag-collision).
	it("asks the model which entity the passage is about, never whether it answers the question", async () => {
		mockReply("yes");
		await classifyEntityMatch("Who runs Current AI?", hit, undefined);
		const args = vi.mocked(generateFromDefaultEndpoint).mock.calls[0][0];
		expect(args.preprompt).toMatch(/never whether it answers the question/i);
		expect(args.preprompt).toMatch(/even when it lacks the specific fact/i);
	});
});

describe("classifyEntityMatch model pin", () => {
	const hit = { title: "AI Potluck", snippet: "AI Potluck is a market map." };

	it("pins to ENTITY_SCOPE_MODEL, not SECOND_OPINION_MODEL, with thinking disabled and the provider pin lifted", async () => {
		pin.config.ENTITY_SCOPE_MODEL = QWEN;
		pin.config.SECOND_OPINION_MODEL = GLM;
		pin.models.push({ id: QWEN }, { id: GLM });
		mockReply("no");
		await classifyEntityMatch("What is OpenAI working on right now?", hit, undefined);
		expect(generateFromDefaultEndpoint).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: QWEN, disableThinking: true, provider: "auto" })
		);
	});

	it("falls back to the default endpoint, with no thinking field and a logged error, when ENTITY_SCOPE_MODEL is set but unregistered", async () => {
		// models.ts registers the lane only when base URL and key are both set, so an id alone must
		// not route: generateFromDefaultEndpoint would silently swap in the task model anyway, and
		// the task model's lane may reject a reasoning field. A registered SECOND_OPINION_MODEL is no
		// stand-in: the guard was measured on its own role's model.
		vi.resetModules();
		const fresh = await import("./entityScopeGuard");
		const gen = (await import("$lib/chat/server/generateFromDefaultEndpoint"))
			.generateFromDefaultEndpoint;
		const errors: unknown[][] = [];
		pin.logError = (...args) => errors.push(args);
		pin.config.ENTITY_SCOPE_MODEL = QWEN;
		pin.config.SECOND_OPINION_MODEL = GLM;
		pin.models.push({ id: GLM });
		vi.mocked(gen).mockReturnValueOnce(immediateReturn("no"));
		await fresh.classifyEntityMatch("What is OpenAI working on right now?", hit, undefined);
		const args = vi.mocked(gen).mock.calls[0][0];
		expect(args.modelId).toBeUndefined();
		expect(args.disableThinking).toBeUndefined();
		expect(errors).toEqual([
			[
				{ entityScopeModelSet: true },
				expect.stringContaining("ENTITY_SCOPE_MODEL unregistered"),
			],
		]);
	});

	it("drops the hit when a closed think block precedes a no — leaked reasoning is not unparseable", async () => {
		mockReply("<think>the passage is about us</think>no");
		await expect(
			classifyEntityMatch("What is OpenAI working on right now?", hit, undefined)
		).resolves.toBe(false);
	});

	it("keeps the hit when the budget ran out inside a think block — still fail-open", async () => {
		mockReply("<think>the passage");
		await expect(
			classifyEntityMatch("What is OpenAI working on right now?", hit, undefined)
		).resolves.toBe(true);
	});
});

describe("filterByEntityScope", () => {
	it("keeps every hit when the flag is effectively off (caller doesn't call this)", async () => {
		// entityScopeGuardEnabled() gates the CALL in rag/index.ts; filterByEntityScope itself always
		// runs the check on whatever it's given, so an empty list is the only "off" shape it owns.
		await expect(filterByEntityScope("q", [], undefined)).resolves.toEqual([]);
	});

	it("drops the collider, keeps the control — the shape, unanimous across samples", async () => {
		const control = { title: "AI Potluck", snippet: "AI Potluck is a market map." };
		const collider = { title: "safety screen (Safety)", snippet: "Our safety category." };
		mockReply("yes"); // control, sample 1
		mockReply("yes"); // control, sample 2
		mockReply("yes"); // control, sample 3
		mockReply("no"); // collider, sample 1
		mockReply("no"); // collider, sample 2
		mockReply("no"); // collider, sample 3
		await expect(
			filterByEntityScope("What is AI Potluck?", [control, collider], undefined)
		).resolves.toEqual([control]);
	});

	it("one hit's classifier throwing doesn't drop a sibling hit's verdict", async () => {
		const keptByVerdict = { title: "AI Potluck", snippet: "AI Potluck is a market map." };
		const keptByFailOpen = { title: "safety screen (Safety)", snippet: "Our safety category." };
		mockReply("yes");
		mockReply("yes");
		mockReply("yes");
		mockThrows();
		mockThrows();
		mockThrows();
		await expect(
			filterByEntityScope("q", [keptByVerdict, keptByFailOpen], undefined)
		).resolves.toEqual([keptByVerdict, keptByFailOpen]);
	});

	// "Who runs Current AI?" retrieves the one passage that actually names Current AI at a
	// cosine rank nowhere near the top-K cutoff, so a single noisy classifier sample answering "no" on
	// that passage would zero out the only relevant hit. Dropping a hit needs a majority of
	// independent samples to agree, not one roll.
	it("keeps the hit when only a minority of samples say no — a single flaky verdict can't drop the only relevant hit", async () => {
		const control = { title: "AI Potluck", snippet: "AI Potluck is a market map." };
		mockReply("no"); // sample 1 — the flake
		mockReply("yes"); // sample 2
		mockReply("yes"); // sample 3
		await expect(
			filterByEntityScope("Who runs Current AI?", [control], undefined)
		).resolves.toEqual([control]);
	});

	it("still drops the hit when a majority of samples say no — the collider protection holds under sampling", async () => {
		const collider = { title: "safety screen (Safety)", snippet: "Our safety category." };
		mockReply("no");
		mockReply("no");
		mockReply("yes");
		await expect(
			filterByEntityScope("What is OpenAI working on right now?", [collider], undefined)
		).resolves.toEqual([]);
	});
});
