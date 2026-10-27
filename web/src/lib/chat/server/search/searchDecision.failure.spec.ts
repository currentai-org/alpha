import { describe, it, expect, vi, beforeEach } from "vitest";

// classifySearchNeed through the REAL generateFromDefaultEndpoint, so the failure shape is the one the
// wrapper actually produces (it never throws; a failed call returns ""). Only the endpoint is faked.
const h = vi.hoisted(() => ({ endpoint: vi.fn(), turnEndpoint: vi.fn(), taskId: "test-model" }));

// The task model and the turn's default model are different models with different endpoints, so a
// call that reached the turn's model would land on turnEndpoint and never on h.endpoint.
vi.mock("$lib/chat/server/models", () => {
	const task = {
		get id() {
			return h.taskId;
		},
		get name() {
			return h.taskId;
		},
		getEndpoint: async () => h.endpoint,
	};
	const turn = { id: "mistral-large-2512", name: "mistral-large-2512", getEndpoint: async () => h.turnEndpoint };
	return { models: [task, turn], defaultModel: turn, taskModel: task };
});
vi.mock("$lib/chat/server/tuning", () => ({ getTuning: async () => ({}) }));

import { classifySearchNeed } from "./searchDecision";
import { logger } from "$lib/chat/server/logger";

function answering(text: string) {
	return async function* () {
		yield { token: { text }, generated_text: text };
	};
}

describe("classifySearchNeed tells a failed call from a model 'no' (CUR-2108)", () => {
	beforeEach(() => {
		h.endpoint.mockReset();
		h.turnEndpoint.mockReset();
		h.taskId = "test-model";
	});

	it("a refused call is ok:false, not a 'no'", async () => {
		h.endpoint.mockImplementation(async function* () {
			yield* [];
			throw Object.assign(new Error("503 upstream refused"), { status: 503 });
		});
		expect(await classifySearchNeed("what's the weather in Lima today", undefined)).toEqual({
			shouldSearch: false,
			ok: false,
		});
	});

	// Real time, not fake timers: the deadline is AbortSignal.timeout, which Node arms on its own
	// internal timer. Without the decider's own deadline this inherits the 15 s side-call ceiling
	// and the test times out at 8 s.
	it("a decider call that stalls is ok:false within its 3 s deadline, not a 15 s wait (CUR-3952)", { timeout: 8_000 }, async () => {
		h.endpoint.mockImplementation(async function* ({ abortSignal }: { abortSignal: AbortSignal }) {
			await new Promise((_, reject) => (abortSignal.onabort = () => reject(abortSignal.reason)));
			yield* [];
		});
		const started = Date.now();
		expect(await classifySearchNeed("what is a prime number", undefined)).toEqual({
			shouldSearch: false,
			ok: false,
		});
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(2_900);
		expect(elapsed).toBeLessThan(4_500);
	});

	it("a model that answers 'no' is ok:true", async () => {
		h.endpoint.mockImplementation(answering("no"));
		expect(await classifySearchNeed("what is a prime number", undefined)).toEqual({
			shouldSearch: false,
			ok: true,
			// The model that gave the verdict, for X-ray (CUR-984). A failed call above names none.
			served: { model: "test-model" },
		});
	});

	it("a reply that is neither yes nor no still decides 'no', and is logged as malformed (CUR-2141)", async () => {
		const warn = vi.spyOn(logger, "warn");
		h.endpoint.mockImplementation(answering("The user"));
		expect(await classifySearchNeed("what's new with the EU AI Act", undefined)).toEqual({
			shouldSearch: false,
			ok: true,
			// The model that gave the verdict, for X-ray (CUR-984). A failed call above names none.
			served: { model: "test-model" },
		});
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "malformed", replyLength: 8 }),
			"search-need classifier reply was neither yes nor no"
		);
		warn.mockRestore();
	});

	it("a real 'no' is not logged as malformed", async () => {
		const warn = vi.spyOn(logger, "warn");
		h.endpoint.mockImplementation(answering("No."));
		await classifySearchNeed("what is a prime number", undefined);
		expect(warn).not.toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "malformed" }),
			expect.anything()
		);
		warn.mockRestore();
	});

	it("sends an Apertus task model one user message with no system role, since its pooled deployments refuse one (CUR-2141)", async () => {
		h.taskId = "swiss-ai/apertus-v1.5-70b";
		h.endpoint.mockImplementation(answering("no"));
		await classifySearchNeed("what is a prime number", undefined);
		const { messages, preprompt } = h.endpoint.mock.calls[0][0];
		expect(preprompt, "a preprompt becomes a system message on the wire").toBeFalsy();
		expect(messages).toHaveLength(1);
		expect(messages[0].from).toBe("user");
		expect(messages[0].content).toContain('Output ONLY the single word "yes" or "no"');
		expect(messages[0].content).toContain('User message: "what is a prime number"');
	});

	it("keeps the system preprompt for a model that serves roles", async () => {
		h.endpoint.mockImplementation(answering("no"));
		await classifySearchNeed("what is a prime number", undefined);
		const { messages, preprompt } = h.endpoint.mock.calls[0][0];
		expect(preprompt).toContain('Output ONLY the single word "yes" or "no"');
		expect(messages).toEqual([{ from: "user", content: 'User message: "what is a prime number"' }]);
	});

	it("asks TASK_MODEL, never the model answering the turn (CUR-2092)", async () => {
		h.endpoint.mockImplementation(answering("no"));
		await classifySearchNeed("what is a prime number", undefined);
		expect(h.endpoint).toHaveBeenCalledTimes(1);
		expect(h.turnEndpoint).not.toHaveBeenCalled();
	});

	it("a model that answers 'yes' searches", async () => {
		h.endpoint.mockImplementation(answering("yes"));
		expect(await classifySearchNeed("who won the match last night", undefined)).toEqual({
			shouldSearch: true,
			ok: true,
			// The model that gave the verdict, for X-ray (CUR-984). A failed call above names none.
			served: { model: "test-model" },
		});
	});
});

// The classifier judged "What's in this picture?" without the picture and searched it. It is
// now told what came with the message; these read the request the endpoint actually received. (CUR-3192)
describe("classifySearchNeed is told what came with the message (CUR-3192)", () => {
	beforeEach(() => {
		h.endpoint.mockReset();
		h.taskId = "test-model";
		h.endpoint.mockImplementation(answering("no"));
	});

	const sent = () => JSON.stringify(h.endpoint.mock.calls[0]?.[0]);

	it("a photo turn's request names the photo and carries the attachment rule", async () => {
		await classifySearchNeed("What's in this picture?", undefined, ["image"]);
		expect(sent()).toContain("Attached to the message: 1 image.");
		expect(sent()).toContain("answered from the file");
	});

	it("a turn with no file gets neither, so its request is unchanged", async () => {
		await classifySearchNeed("What's in this picture?", undefined);
		expect(sent()).not.toContain("Attached to the message");
		expect(sent()).not.toContain("answered from the file");
	});
});
