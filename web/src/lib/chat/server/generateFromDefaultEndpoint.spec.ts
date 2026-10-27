/**
 * generateFromDefaultEndpoint is EVERY side-call (title, search-decision, reasoning-summary) — never
 * the answer the user reads. A caller that resolves modelId to the turn's serving model (e.g.
 * searchDecision's `servingModel?.id`) can land on the agent model when the turn is agent-routed.
 * endpointAgent has no notion of a side-call: it always submits a full, independent /run task and
 * ignores preprompt/generateSettings, so a 3-token classifier or a 24-token title would instead get a
 * second, unrelated agent run as its "answer" (CUR-542 — fabricated conversation titles, and auto web
 * search silently never triggering under agent mode). This pins the fix: resolving to the agent model
 * id redirects to taskModel instead of ever reaching endpointAgent from this function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";

// vi.mock is hoisted above any top-level const, so the fakes it references must be built inside
// vi.hoisted rather than declared alongside it.
const { agentModel, otherModel, fallbackTaskModel, hangingModel, refusingModel, gatewayModel, apertusModel, seen } =
	vi.hoisted(() => {
	function fakeModel(id: string) {
		// getEndpoint resolves to an ENDPOINT FUNCTION (params) => AsyncGenerator, not to the generator
		// itself — generateFromDefaultEndpoint does `const endpoint = await model.getEndpoint();` then
		// calls `endpoint({...})`.
		const getEndpoint = vi.fn(async () =>
			vi.fn(async () =>
				(async function* () {
					yield { token: { id: 0, text: "", logprob: 0, special: true }, generated_text: `from ${id}` };
				})()
			)
		);
		return { id, parameters: {}, getEndpoint };
	}
	// A lane that never produces anything on its own and only ever ends by being cut: the real shape of a
	// side-call that hangs a turn. `seen` records what the endpoint was actually handed, so a test can assert
	// on the signal rather than on a wall clock.
	const seen: { signal?: AbortSignal } = {};
	const hangingModel = {
		id: "hanging-task-model",
		parameters: {},
		getEndpoint: vi.fn(async () =>
			vi.fn(async (params: { abortSignal?: AbortSignal }) => {
				seen.signal = params.abortSignal;
				return (async function* () {
					await new Promise((_resolve, reject) => {
						// Exactly what a real endpoint does: the fetch rejects when its signal aborts, and
						// does nothing at all otherwise.
						params.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
							once: true,
						});
					});
					yield { token: { id: 0, text: "", logprob: 0, special: true }, generated_text: "never" };
				})();
			})
		),
	};
	// A lane that refuses the request outright, the way the OpenAI SDK reports it: an APIError carrying
	// the HTTP status. HF's router answers 400 for a model whose only provider is in error (CUR-2107).
	const refusingModel = {
		id: "refusing-model",
		parameters: {},
		getEndpoint: vi.fn(async () =>
			vi.fn(async () => {
				throw Object.assign(new Error("400 model not supported by provider"), { status: 400 });
			})
		),
	};
	// The LiteLLM gateway's shape: provenance arrives as a metadata-only output just before the final
	// one (openAIChatToTextGenerationStream's headerMetadataOutput), and nothing else carries it.
	const gatewayModel = {
		id: "gateway-model",
		parameters: {},
		getEndpoint: vi.fn(async () =>
			vi.fn(async () =>
				(async function* () {
					yield { token: { id: 0, text: "ok", logprob: 0, special: false }, generated_text: null };
					yield {
						token: { id: 1, text: "", logprob: 0, special: true },
						generated_text: null,
						routerMetadata: { backend: "https://lane.example.test/v1", model: "served-group" },
					};
					yield { token: { id: 2, text: "", logprob: 0, special: true }, generated_text: "ok" };
				})()
			)
		),
	};
	// An Apertus id, so rolesNeedFlattening is true for it; records the request the endpoint was handed.
	const apertusModel = {
		id: "swiss-ai/apertus-v1.5-70b",
		parameters: {},
		sent: [] as Array<{ messages: unknown[]; preprompt?: string; isMultimodal?: boolean }>,
		getEndpoint: vi.fn(async () =>
			vi.fn(async (params: { messages: unknown[]; preprompt?: string; isMultimodal?: boolean }) => {
				apertusModel.sent.push({
					messages: params.messages,
					preprompt: params.preprompt,
					isMultimodal: params.isMultimodal,
				});
				return (async function* () {
					yield { token: { id: 0, text: "", logprob: 0, special: true }, generated_text: "ok" };
				})();
			})
		),
	};
	return {
		gatewayModel,
		apertusModel,
		agentModel: fakeModel("potluck-agent"),
		refusingModel,
		otherModel: fakeModel("some-other-model"),
		fallbackTaskModel: fakeModel("test-task-model"),
		hangingModel,
		seen,
	};
});

vi.mock("$lib/chat/server/models", () => ({
	models: [agentModel, otherModel, hangingModel, refusingModel, gatewayModel, apertusModel],
	defaultModel: fallbackTaskModel,
	taskModel: fallbackTaskModel,
}));

import { generateFromDefaultEndpoint } from "./generateFromDefaultEndpoint";
import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { logger } from "$lib/chat/server/logger";

describe("generateFromDefaultEndpoint", () => {
	it("redirects to taskModel when modelId resolves to the agent model, rather than calling endpointAgent", async () => {
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: AGENT_MODEL_ID,
				locals: undefined,
			})
		);
		expect(agentModel.getEndpoint).not.toHaveBeenCalled();
		expect(fallbackTaskModel.getEndpoint).toHaveBeenCalledTimes(1);
		expect(result).toBe(`from ${fallbackTaskModel.id}`);
	});

	it("hands the endpoint the caller's isMultimodal and the message's image files, and leaves it unset when the caller says nothing (CUR-4670)", async () => {
		apertusModel.sent.length = 0;
		const files = [{ type: "base64" as const, value: "aGk=", mime: "image/png", name: "sha-1" }];
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "what is in this picture?", files }],
				modelId: apertusModel.id,
				isMultimodal: true,
				locals: undefined,
			})
		);
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: apertusModel.id,
				locals: undefined,
			})
		);
		expect(apertusModel.sent[0].isMultimodal).toBe(true);
		expect(apertusModel.sent[0].messages).toEqual([{ from: "user", content: "what is in this picture?", files }]);
		expect(apertusModel.sent[1].isMultimodal).toBeUndefined();
	});

	it("still uses the requested model when it is not the agent id", async () => {
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: otherModel.id,
				locals: undefined,
			})
		);
		expect(otherModel.getEndpoint).toHaveBeenCalledTimes(1);
		expect(agentModel.getEndpoint).not.toHaveBeenCalled();
		expect(result).toBe(`from ${otherModel.id}`);
	});

	it("falls back to taskModel, unchanged, when no modelId is given at all", async () => {
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				locals: undefined,
			})
		);
		expect(fallbackTaskModel.getEndpoint).toHaveBeenCalled();
		expect(result).toBe(`from ${fallbackTaskModel.id}`);
	});
});

describe("CUR-1659: every side-call is bounded, not just the two that were noticed", () => {
	const OUTLIVED = Symbol("outlived-its-ceiling");

	beforeEach(() => {
		seen.signal = undefined;
	});

	it("cuts a side-call that outlives its ceiling instead of leaving it in flight", async () => {
		const call = getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: hangingModel.id,
				timeoutMs: 50,
				locals: undefined,
			})
		);
		const raced = await Promise.race([
			call,
			new Promise((resolve) => setTimeout(() => resolve(OUTLIVED), 600)),
		]);
		// The assertion that matters is the signal, not the clock: an unbounded side-call reaches the
		// endpoint with no abortSignal at all, so nothing can ever end it, and the upstream async
		// iterator never returns `done` — which parks screenStream's consumer and costs the turn.
		expect(
			seen.signal,
			"the side-call reached the endpoint with no abort signal at all, so nothing can ever cut it"
		).toBeDefined();
		expect(
			raced,
			"the side-call outlived its ceiling and is still in flight — an abandoned generation keeps the upstream iterator from returning done, parks screenStream's consumer, and the turn dies at the watchdog having shown the user nothing"
		).not.toBe(OUTLIVED);
		expect(raced).toBe("");
	});

	it("lets a caller's own shorter signal win over the ceiling", async () => {
		// entityCorrection and queryRewrite both pass 5s against a 15s ceiling. If the ceiling replaced
		// the caller's signal rather than racing it, both would silently get three times the bound they
		// ask for, and this file would be why.
		const call = getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: hangingModel.id,
				signal: AbortSignal.timeout(40),
				timeoutMs: 5_000,
				locals: undefined,
			})
		);
		const raced = await Promise.race([
			call,
			new Promise((resolve) => setTimeout(() => resolve(OUTLIVED), 400)),
		]);
		// Asserted on the signal, not only on the result, so a ceiling that REPLACED the caller's 40ms
		// bound with its own 5s one fails here in 400ms with a sentence naming that — rather than
		// hanging the suite to its own timeout, which would go red for almost any reason.
		expect(
			seen.signal?.aborted,
			"the caller's own 40ms signal never fired at the endpoint — the ceiling replaced it instead of racing it, so every caller silently gets the ceiling's bound rather than the one it asked for"
		).toBe(true);
		expect(raced, "the call outlived the caller's own signal").not.toBe(OUTLIVED);
		expect(raced).toBe("");
	});
});

describe("CUR-2031: a failed side-call says it failed, so its stand-in \"\" is not read as a reply", () => {
	it("reports a ceiling cut as a failure, which the title needs to avoid calling it an off-task reply", async () => {
		const failures: string[] = [];
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: hangingModel.id,
				timeoutMs: 50,
				onFailure: (kind) => failures.push(kind),
				locals: undefined,
			})
		);
		expect(result).toBe("");
		expect(failures).toEqual(["ceiling"]);
	});

	it("passes the HTTP status of a refused request, so a 400 is not read as a model that said nothing (CUR-2107)", async () => {
		const failures: [string, number | undefined][] = [];
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: refusingModel.id,
				onFailure: (kind, status) => failures.push([kind, status]),
				locals: undefined,
			})
		);
		expect(result).toBe("");
		expect(failures).toEqual([["error", 400]]);
	});

	it("reports nothing when the model answered", async () => {
		const failures: string[] = [];
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: otherModel.id,
				onFailure: (kind) => failures.push(kind),
				locals: undefined,
			})
		);
		expect(result).toBe("from some-other-model");
		expect(failures).toEqual([]);
	});
});

describe("CUR-2140: a side-call can say which lane it went to", () => {
	it("reports the requested model up front and the gateway's backend once the stream carries it", async () => {
		const reports: Record<string, string | undefined>[] = [];
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: gatewayModel.id,
				onServed: (s) => reports.push(s),
				locals: undefined,
			})
		);
		expect(result).toBe("ok");
		expect(reports[0]).toEqual({ requestedModel: "gateway-model" });
		expect(Object.assign({}, ...reports)).toMatchObject({
			requestedModel: "gateway-model",
			backend: "https://lane.example.test/v1",
			model: "served-group",
		});
	});

	it("still names the requested model on a call that never returns", async () => {
		const reports: Record<string, string | undefined>[] = [];
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: hangingModel.id,
				timeoutMs: 50,
				onServed: (s) => reports.push(s),
				locals: undefined,
			})
		);
		expect(reports).toEqual([{ requestedModel: "hanging-task-model" }]);
	});
});

describe("CUR-2319: a side call naming an unregistered model says so", () => {
	it("serves it on the task model and logs both ids at warn, rather than swapping models silently", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
		const result = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				modelId: "not/registered",
				locals: undefined,
			})
		);
		expect(result).toBe(`from ${fallbackTaskModel.id}`);
		const line = warn.mock.calls.find((c) => (c[0] as { sideCallSubstituted?: boolean })?.sideCallSubstituted);
		expect(line?.[0]).toMatchObject({ requestedModel: "not/registered", servedModel: fallbackTaskModel.id });
		warn.mockRestore();
	});

	it("warns once per unregistered id, however many side calls name it (CUR-2264)", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
		const call = (modelId: string) =>
			getReturnFromGenerator(
				generateFromDefaultEndpoint({ messages: [{ from: "user", content: "hi" }], modelId, locals: undefined })
			);
		try {
		await call("typo/task-model");
		await call("typo/task-model");
		await call("typo/other-model");
		const lines = warn.mock.calls
			.map((c) => c[0] as { sideCallSubstituted?: boolean; requestedModel?: string; servedModel?: string })
			.filter((f) => f?.sideCallSubstituted);
		expect(lines).toEqual([
			expect.objectContaining({ requestedModel: "typo/task-model", servedModel: fallbackTaskModel.id }),
			expect.objectContaining({ requestedModel: "typo/other-model", servedModel: fallbackTaskModel.id }),
		]);
		} finally {
			warn.mockRestore();
		}
	});

	it("logs nothing for a registered model or for no modelId", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({ messages: [{ from: "user", content: "hi" }], modelId: otherModel.id, locals: undefined })
		);
		await getReturnFromGenerator(generateFromDefaultEndpoint({ messages: [{ from: "user", content: "hi" }], locals: undefined }));
		expect(warn.mock.calls.some((c) => (c[0] as { sideCallSubstituted?: boolean })?.sideCallSubstituted)).toBe(false);
		warn.mockRestore();
	});
});

describe("CUR-1294: a side call to Apertus goes out as one user message", () => {
	beforeEach(() => {
		apertusModel.sent.length = 0;
	});

	it("folds the preprompt and every role into a single user message with no preprompt left", async () => {
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [
					{ from: "user", content: "first question" },
					{ from: "assistant", content: "first answer" },
					{ from: "user", content: "summarise that" },
				],
				preprompt: "You write short summaries.",
				modelId: apertusModel.id,
				locals: undefined,
			})
		);
		const [sent] = apertusModel.sent;
		expect(sent.preprompt).toBeUndefined();
		expect(sent.messages).toHaveLength(1);
		const only = sent.messages[0] as { from: string; content: string };
		expect(only.from).toBe("user");
		expect(only.content).toContain("You write short summaries.");
		expect(only.content).toContain("first answer");
		expect(only.content).toContain("summarise that");
	});

	it("leaves a call that is already one user message exactly as it was", async () => {
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "just this" }],
				modelId: apertusModel.id,
				locals: undefined,
			})
		);
		expect(apertusModel.sent[0]).toEqual({ messages: [{ from: "user", content: "just this" }], preprompt: undefined });
	});

	it("keeps real roles for a model whose deployments accept them", async () => {
		const endpoint = vi.fn(async () =>
			(async function* () {
				yield { token: { id: 0, text: "", logprob: 0, special: true }, generated_text: "ok" };
			})()
		);
		otherModel.getEndpoint.mockResolvedValueOnce(endpoint as never);
		await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: "hi" }],
				preprompt: "system text",
				modelId: otherModel.id,
				locals: undefined,
			})
		);
		expect(endpoint).toHaveBeenCalledWith(
			expect.objectContaining({ preprompt: "system text", messages: [{ from: "user", content: "hi" }] })
		);
	});
});
