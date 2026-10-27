// The native calculate tool, driven through the real endpoint with a stubbed fetch, so the
// tool-call assembly in openAIChatToTextGenerationStream, the loop in calculateTool.ts and the wire body
// in endpointOai.ts are all under test together. What reaches the model on the second request is the
// contract: if code's result stops going back as the tool message, the answer is the model's own
// arithmetic again, and the first describe below goes red. (CUR-2273)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const warn = vi.fn();
const info = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn, info, error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

let calculateFlagOn = false;
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (key: string, fallback: () => boolean) =>
		key === "native-calculate-tool" ? calculateFlagOn : fallback(),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

const { endpointOai } = await import("./endpointOai");
const { calculateToolOffered, runCalculate, MAX_CALCULATE_ROUNDS, CALCULATE_KIT } = await import("./calculateTool");
const { buildPersonaPrompt, CALCULATE_FIRST_CLAUSE } = await import(
	"$lib/chat/server/textGeneration/persona"
);

const MODEL = "mistral-large-2512";

type Delta = Record<string, unknown>;
function sse(chunks: Array<{ delta: Delta; finish?: string | null }>): string {
	return (
		chunks
			.map(
				({ delta, finish = null }) =>
					`data: ${JSON.stringify({
						id: "c1",
						object: "chat.completion.chunk",
						created: 0,
						model: MODEL,
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`
			)
			.join("") + "data: [DONE]\n\n"
	);
}

/** Mistral's shape: the whole call in one delta, finish_reason "tool_calls". */
function toolCallBody(expression: string, id = "abc123XYZ"): string {
	return sse([
		{
			delta: {
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id,
						index: 0,
						type: "function",
						function: { name: "calculate", arguments: JSON.stringify({ expression }) },
					},
				],
			},
			finish: "tool_calls",
		},
	]);
}

/** Text streamed, then a call in the same round. */
function textThenToolCallBody(text: string, expression: string): string {
	return sse([
		{ delta: { role: "assistant", content: text } },
		{
			delta: {
				tool_calls: [
					{ id: "t1abc2DEF", index: 0, type: "function", function: { name: "calculate", arguments: JSON.stringify({ expression }) } },
				],
			},
			finish: "tool_calls",
		},
	]);
}

function answerBody(text: string): string {
	return sse([{ delta: { role: "assistant", content: text } }, { delta: {}, finish: "stop" }]);
}

/** Each fetch() answers with the next body (the last one repeats). Returns the parsed request bodies. */
function stubResponses(bodies: string[]) {
	const sent: Array<Record<string, unknown>> = [];
	let call = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body ?? "{}")));
			const body = bodies[Math.min(call++, bodies.length - 1)];
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		})
	);
	return sent;
}

async function runTurn(
	params: {
		calculateTool?: boolean;
		calculateFirst?: boolean;
		servesUserAnswer?: boolean;
		turnDeadlineAt?: number;
		rateLimitToolRound?: boolean;
		messages?: unknown[];
		nativeTools?: unknown;
	} = {}
) {
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: "https://api.mistral.ai/v1",
		apiKey: "sk-test",
		model: { id: MODEL, name: MODEL, parameters: {}, supportsTools: true },
	});
	const stream = await endpoint({
		locals: undefined,
		servesUserAnswer: true,
		...params,
		messages: params.messages ?? [{ from: "user", content: "3 workshops of 14 people at 18 each: total cost?" }],
	} as Parameters<typeof endpoint>[0]);
	const outputs = [];
	for await (const o of stream) outputs.push(o);
	const final = outputs.find((o) => o.generated_text)?.generated_text;
	const calculations = outputs.flatMap((o) => o.calculations ?? []);
	const streamed = outputs
		.filter((o) => !o.token.special)
		.map((o) => o.token.text)
		.join("");
	const roundMs = outputs.filter((o) => o.calculateToolMs !== undefined);
	return { outputs, final, calculations, streamed, roundMs };
}

type WireMessage = { role: string; content?: string; tool_call_id?: string; tool_calls?: unknown[] };
const messagesOf = (body: Record<string, unknown>) => body.messages as WireMessage[];

beforeEach(() => {
	warn.mockClear();
	info.mockClear();
	calculateFlagOn = true;
});
afterEach(() => {
	vi.unstubAllGlobals();
});

// With tool_choice auto, a model can work a large product out by hand instead of calling calculate
// (CUR-4191). A planned math turn forces the call on the first request only, so the model still answers.
describe("calculateFirst: a planned math turn forces calculate on the first request, then lets the model answer", () => {
	it("sends tool_choice calculate first and auto after the result, and answers from code's result", async () => {
		const sent = stubResponses([toolCallBody("4827 * 3916"), answerBody("4827 × 3916 = 18,902,532.")]);
		const { final, calculations } = await runTurn({ calculateTool: true, calculateFirst: true });

		expect(sent).toHaveLength(2);
		expect(sent[0].tool_choice).toEqual({ type: "function", function: { name: "calculate" } });
		expect(sent[1].tool_choice).toBe("auto");
		expect(calculations).toEqual([expect.objectContaining({ expression: "4827 * 3916", result: "18902532" })]);
		expect(final).toContain("18,902,532");
	});

	it("leaves the first request on auto without calculateFirst, so other turns are never forced", async () => {
		const sent = stubResponses([answerBody("Hello.")]);
		await runTurn({ calculateTool: true });
		expect(sent[0].tool_choice).toBe("auto");
	});

	it("forces nothing when calculate is not offered on the turn", async () => {
		const sent = stubResponses([answerBody("Hello.")]);
		await runTurn({ calculateFirst: true });
		expect(sent[0].tool_choice).toBeUndefined();
	});
});

describe("a calculate call: code evaluates it and the model continues from code's result", () => {
	it("sends code's result back as the tool message and streams one answer", async () => {
		const sent = stubResponses([toolCallBody("3 * 14 * 18"), answerBody("The total is 756.")]);
		const { final, calculations, streamed, roundMs } = await runTurn({ calculateTool: true });

		expect(sent).toHaveLength(2);
		expect(sent[0].tools).toEqual([expect.objectContaining({ type: "function" })]);
		expect(sent[0].tool_choice).toBe("auto");
		const second = messagesOf(sent[1]);
		const assistant = second[second.length - 2];
		const tool = second[second.length - 1];
		expect(assistant.role).toBe("assistant");
		expect(assistant.tool_calls).toEqual([
			{
				id: "abc123XYZ",
				type: "function",
				function: { name: "calculate", arguments: JSON.stringify({ expression: "3 * 14 * 18" }) },
			},
		]);
		expect(tool).toEqual({ role: "tool", tool_call_id: "abc123XYZ", content: "756" });
		expect(sent[1].tool_choice).toBe("auto");

		expect(calculations).toEqual([{ expression: "3 * 14 * 18", result: "756" }]);
		expect(streamed).toBe("The total is 756.");
		expect(final).toBe("The total is 756.");
		expect(roundMs).toHaveLength(1);
	});

	it("assembles a call whose arguments arrive split across deltas (OpenAI's shape)", async () => {
		const split = sse([
			{
				delta: {
					role: "assistant",
					tool_calls: [
						{ index: 0, id: "call_1", type: "function", function: { name: "calculate", arguments: "" } },
					],
				},
			},
			{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":' } }] } },
			{ delta: { tool_calls: [{ index: 0, function: { arguments: '"(9 + 3) * 0.5"}' } }] } },
			{ delta: {}, finish: "tool_calls" },
		]);
		const sent = stubResponses([split, answerBody("Six.")]);
		const { calculations, final } = await runTurn({ calculateTool: true });
		expect(calculations).toEqual([{ expression: "(9 + 3) * 0.5", result: "6" }]);
		expect(messagesOf(sent[1]).at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "6" });
		expect(final).toBe("Six.");
	});

	it("keeps text the model streamed before its tool call in the final answer", async () => {
		const withPreamble = sse([
			{ delta: { role: "assistant", content: "Let me work that out. " } },
			{
				delta: {
					tool_calls: [
						{ id: "t1", index: 0, type: "function", function: { name: "calculate", arguments: '{"expression":"2+2"}' } },
					],
				},
				finish: "tool_calls",
			},
		]);
		stubResponses([withPreamble, answerBody("It is 4.")]);
		const { final, streamed } = await runTurn({ calculateTool: true });
		expect(streamed).toBe("Let me work that out. It is 4.");
		expect(final).toBe("Let me work that out. It is 4.");
	});

	// Text, then a tool call, then more text must not run together (CUR-4086): "…para essa mudança." then
	// "Confirmação: …" read as "mudança.Confirmação".
	const sayThenCall = (text: string) =>
		sse([
			{ delta: { role: "assistant", content: text } },
			{
				delta: {
					tool_calls: [
						{ id: "t1", index: 0, type: "function", function: { name: "calculate", arguments: '{"expression":"2+2"}' } },
					],
				},
				finish: "tool_calls",
			},
		]);

	it("puts a paragraph break between a round that ends on a full stop and the next round's first word", async () => {
		stubResponses([sayThenCall("Faltam 9 dias para essa mudança."), answerBody("Confirmação: faltam 9 dias.")]);
		const { final, streamed } = await runTurn({ calculateTool: true });
		expect(streamed).toBe("Faltam 9 dias para essa mudança.\n\nConfirmação: faltam 9 dias.");
		expect(final).toBe("Faltam 9 dias para essa mudança.\n\nConfirmação: faltam 9 dias.");
	});

	it("adds no break where the next round already starts with whitespace", async () => {
		stubResponses([sayThenCall("Let me check."), answerBody(" It is 4.")]);
		const { final, streamed } = await runTurn({ calculateTool: true });
		expect(streamed).toBe("Let me check. It is 4.");
		expect(final).toBe("Let me check. It is 4.");
	});

	// A model that reasons, calls calculate, then answers (CUR-3748): the round that ended in the call
	// opens a <think> block that must be closed, or the answer reads "<think>…Let's call calculate.42".
	it("closes the reasoning a round streamed before its tool call, so the answer after it stays the answer", async () => {
		const reasonThenCall = sse([
			{ delta: { role: "assistant", reasoning_content: "They want 42. " } },
			{ delta: { reasoning_content: "Let's call calculate." } },
			{
				delta: {
					tool_calls: [
						{ id: "t1", index: 0, type: "function", function: { name: "calculate", arguments: '{"expression":"6*7"}' } },
					],
				},
				finish: "tool_calls",
			},
		]);
		const sent = stubResponses([reasonThenCall, answerBody("42")]);
		const { final } = await runTurn({ calculateTool: true });
		expect(final).toBe("<think>They want 42. Let's call calculate.</think>42");
		expect(final?.replace(/<think>[\s\S]*?<\/think>/g, "")).toBe("42");
		// The reasoning is the model's, not something it said: it does not go back as the assistant's text.
		expect(messagesOf(sent[1]).at(-2)?.content).toBe("");
	});
});

describe("a malformed expression returns an error to the model and never ends the turn", () => {
	it("tells the model why, shows the failed expression, and lets it answer", async () => {
		const sent = stubResponses([
			toolCallBody("3 workshops * 14"),
			answerBody("I could not compute that."),
		]);
		const { final, calculations } = await runTurn({ calculateTool: true });
		const tool = messagesOf(sent[1]).at(-1) as WireMessage;
		expect(tool.role).toBe("tool");
		expect(tool.content).toMatch(/^error: /);
		expect(calculations).toEqual([
			{ expression: "3 workshops * 14", error: expect.stringContaining("could not evaluate") },
		]);
		expect(final).toBe("I could not compute that.");
	});

	it("answers arguments that are not JSON, an unknown tool name, and an empty expression with an error", () => {
		expect(runCalculate({ id: "a", name: "calculate", arguments: "{oops" }).error).toMatch(/JSON/);
		expect(runCalculate({ id: "a", name: "web_search", arguments: '{"expression":"1+1"}' }).error).toMatch(
			/no tool named/
		);
		expect(runCalculate({ id: "a", name: "calculate", arguments: "{}" }).error).toMatch(/no expression/);
		expect(runCalculate({ id: "a", name: "calculate", arguments: '{"expression":"1/0"}' }).error).toBeDefined();
	});

	it("drops float noise from a result without rounding anything a person would type", () => {
		expect(runCalculate({ id: "a", name: "calculate", arguments: '{"expression":"0.1 + 0.2"}' }).result).toBe(
			"0.3"
		);
		expect(runCalculate({ id: "a", name: "calculate", arguments: '{"expression":"59.99 * 3"}' }).result).toBe(
			"179.97"
		);
	});
});

// A date written with hyphens is subtraction to mathjs: `2026-10-28 - 2026-10-26` evaluates to -74 and
// `(2026-10-28) - (2026-10-26)` to -2, neither of them a day count.
describe("a date sent to calculate is refused with an error that says what to use instead, never a number", () => {
	const calc = (expression: string) =>
		runCalculate({ id: "a", name: "calculate", arguments: JSON.stringify({ expression }) });

	it.each([
		"2026-10-28 - 2026-10-26",
		"(2026-10-28) - (2026-10-26)",
		"2026/10/28 - 2026/10/26",
		"28/10/2026 - 26/10/2026",
		"10-28-2026 - 10-26-2026",
		"28.10.2026 - 26.10.2026",
		"2026-1-5 + 30",
	])("refuses %s with no result", (expression) => {
		const out = calc(expression);
		expect(out.result).toBeUndefined();
		expect(out.error).toMatch(/is a date/);
	});

	it("names the date it saw, why the result would be wrong, and the two ways to count days instead", () => {
		const { error } = calc("2026-10-28 - 2026-10-26");
		expect(error).toContain('"2026-10-28"');
		expect(error).toContain("2026 - 10 - 28");
		expect(error).toMatch(/code-running tool/);
		expect(error).toContain("28 - 26");
	});

	it("goes back to the model as an error tool message, so the turn continues", async () => {
		const content = (await CALCULATE_KIT.run({
			id: "a",
			name: "calculate",
			arguments: JSON.stringify({ expression: "(2026-10-28) - (2026-10-26)" }),
		})).content;
		expect(content).toMatch(/^error: "2026-10-28" is a date/);
	});

	it("still evaluates spaced subtraction, plain numbers and day counts written as numbers", () => {
		expect(calc("2026 - 10 - 28").result).toBe("1988");
		expect(calc("28 - 26").result).toBe("2");
		expect(calc("(31 - 26) + 28").result).toBe("33");
		expect(calc("1840 * 0.65").result).toBe("1196");
		expect(calc("12.5/2.5").result).toBe("5");
	});
});

// A model can write an arrival time as "23:35 + 1:05" (CUR-3860). Refused, its retry comes back as 1480
// minutes, which a reader cannot match to the "12:40 AM" the answer states.
describe("clock times: H:MM terms added and subtracted, answered as a time a reader can match", () => {
	const calc = (expression: string) =>
		runCalculate({ id: "a", name: "calculate", arguments: JSON.stringify({ expression }) });

	it("evaluates the train question's first call and names the time it lands on the next day", () => {
		expect(calc("23:35 + 1:05")).toEqual({ expression: "23:35 + 1:05", result: "24:40, which is 00:40 the next day" });
	});

	it("answers a sum that stays inside the day as plain H:MM, so a sum of durations reads right too", () => {
		expect(calc("9:15+2:50").result).toBe("12:05");
		expect(calc("1:05 + 2:30 - 0:45").result).toBe("2:50");
	});

	it("names the day before when a subtraction goes past midnight", () => {
		expect(calc("0:30 - 1:00").result).toBe("-0:30, which is 23:30 the day before");
	});

	it("leaves a clock time mixed with a bare number or a word to the arithmetic path, which refuses it", () => {
		expect(calc("23:35 + 65").error).toMatch(/23:35 \+ 1:05/);
		expect(calc("23:35 + 1 hour + 5 minutes").error).toMatch(/could not evaluate/);
		expect(calc("23:75 + 1:05").error).toBeDefined();
	});

	it("still evaluates plain arithmetic as numbers", () => {
		expect(calc("(23 * 60 + 35) + 65").result).toBe("1480");
	});
});

/** Like stubResponses, but each reply can carry its own status and headers. */
function stubReplies(replies: Array<{ body: string; status?: number; headers?: Record<string, string> }>) {
	const sent: Array<Record<string, unknown>> = [];
	let call = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body ?? "{}")));
			const r = replies[Math.min(call++, replies.length - 1)];
			return new Response(r.body, {
				status: r.status ?? 200,
				headers: { "content-type": r.status ? "application/json" : "text/event-stream", ...r.headers },
			});
		})
	);
	return sent;
}
const OVER_CAP = JSON.stringify({ message: "Requests rate limit exceeded" });

// A round after the first goes out once the lane has committed, so withFailover never sees
// its error; a 429 on round 2 must not end the turn on the busy notice. (CUR-2432)
describe("a later round refused as over-cap is sent again on the same lane", () => {
	it("retries a round-2 429 after the wait the host named, and the turn answers", async () => {
		const sent = stubReplies([
			{ body: toolCallBody("3 * 14 * 18") },
			{ body: OVER_CAP, status: 429, headers: { "retry-after-ms": "5" } },
			{ body: answerBody("The total is 756.") },
		]);
		const { final } = await runTurn({ calculateTool: true });
		expect(sent).toHaveLength(3);
		expect(sent[2].model).toBe(MODEL);
		expect(messagesOf(sent[2])).toEqual(messagesOf(sent[1]));
		expect(final).toBe("The total is 756.");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ round: 1, retry: 1, status: 429, delayMs: 5, hostAsked: true }),
			expect.stringContaining("retrying on the same lane")
		);
	});

	// retry-after-ms, because customFetch's own cooldown retry (gatewayRetryDelayMs) still reads a bare
	// retry-after and waits up to 6s without knowing the deadline; folding that layer into this policy
	// is a later step of CUR-2432's audit.
	it("ends the turn on the 429 at once when the named wait cannot fit before the turn's deadline", async () => {
		const sent = stubReplies([
			{ body: toolCallBody("3 * 14 * 18") },
			{ body: OVER_CAP, status: 429, headers: { "retry-after-ms": "30000" } },
		]);
		// The host's 30 s wait, if anything schedules it, fires at once: a regression then fails on the
		// assertions below rather than on the test's own timeout.
		const realSetTimeout = globalThis.setTimeout;
		const timers = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) =>
				realSetTimeout(fn, ms === 30_000 ? 0 : ms, ...args)) as typeof setTimeout);
		try {
			await expect(
				runTurn({ calculateTool: true, turnDeadlineAt: Date.now() + 20_000 })
			).rejects.toMatchObject({ status: 429 });
			expect(sent).toHaveLength(2);
			expect(
				timers.mock.calls.filter(([, ms]) => ms === 30_000),
				"a timer for the host's 30 s wait was set, so the turn waited instead of ending"
			).toEqual([]);
			expect(warn).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.stringContaining("retrying on the same lane")
			);
		} finally {
			timers.mockRestore();
		}
	});

	it("does not retry a round-2 error a resend cannot fix", async () => {
		const sent = stubReplies([
			{ body: toolCallBody("3 * 14 * 18") },
			{ body: JSON.stringify({ message: "bad request" }), status: 400 },
		]);
		await expect(runTurn({ calculateTool: true })).rejects.toMatchObject({ status: 400 });
		expect(sent).toHaveLength(2);
	});

	it("the tool_round_rate_limited fault refuses round 2 once, and the retry answers", async () => {
		const sent = stubResponses([toolCallBody("3 * 14 * 18"), answerBody("The total is 756.")]);
		const { final } = await runTurn({ calculateTool: true, rateLimitToolRound: true });
		expect(sent).toHaveLength(2);
		expect(final).toBe("The total is 756.");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ round: 1, retry: 1, status: 429, hostAsked: false }),
			expect.stringContaining("retrying on the same lane")
		);
	});
});

describe("the round cap: after the last tool round the model must answer without the tool", () => {
	it(`offers the tool for ${MAX_CALCULATE_ROUNDS} rounds, then sends tool_choice none`, async () => {
		const sent = stubResponses([
			toolCallBody("1 + 1", "r1"),
			toolCallBody("2 + 2", "r2"),
			toolCallBody("3 + 3", "r3"),
			answerBody("Done."),
		]);
		const { final, calculations } = await runTurn({ calculateTool: true });
		expect(sent.map((b) => b.tool_choice)).toEqual(["auto", "auto", "auto", "none"]);
		expect(calculations.map((c) => c.result)).toEqual(["2", "4", "6"]);
		expect(final).toBe("Done.");
	});

	// Under tool_choice "none" a model can keep searching in its text until max_tokens (CUR-4552).
	it("ends only the none round's request on the closing message, and never carries it into the history", async () => {
		const sent = stubResponses([
			toolCallBody("1 + 1", "r1"),
			toolCallBody("2 + 2", "r2"),
			toolCallBody("3 + 3", "r3"),
			answerBody("Done."),
		]);
		await runTurn({ calculateTool: true });
		const closing = (m: WireMessage) => m.role === "user" && String(m.content).startsWith("Tool use is finished");
		for (const b of sent.slice(0, 3)) expect(messagesOf(b).some(closing)).toBe(false);
		expect(closing(messagesOf(sent[3]).at(-1)!)).toBe(true);
		expect(messagesOf(sent[3]).filter(closing)).toHaveLength(1);
	});

	it("a kit that carries its own maxRounds (the sandbox's 6, CUR-4239) gets that many rounds, not 3", async () => {
		const sent = stubResponses([
			...[1, 2, 3, 4, 5, 6].map((n) => toolCallBody(`${n} + ${n}`, `r${n}`)),
			answerBody("Done."),
		]);
		const { final, calculations } = await runTurn({ nativeTools: { ...CALCULATE_KIT, maxRounds: 6 } });
		expect(sent.map((b) => b.tool_choice)).toEqual(["auto", "auto", "auto", "auto", "auto", "auto", "none"]);
		expect(calculations).toHaveLength(6);
		expect(final).toBe("Done.");
	});

	it("ends the turn on the text so far when the model writes something and calls the tool anyway after the cap", async () => {
		const sent = stubResponses([
			toolCallBody("1 + 1", "r1"),
			toolCallBody("2 + 2", "r2"),
			toolCallBody("3 + 3", "r3"),
			textThenToolCallBody("Let me check once more.", "4 + 4"),
		]);
		const { final } = await runTurn({ calculateTool: true });
		expect(sent).toHaveLength(MAX_CALCULATE_ROUNDS + 1);
		expect(final).toBe("Let me check once more.");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ leg: "calculate-tool" }),
			expect.stringContaining("after the round cap")
		);
	});
});

// A model can answer the tool_choice "none" round after three calculate rounds with
// `calculate{"expression": …}` typed as text and nothing else (CUR-4495). The strip must not leave the
// round with no visible text, or the turn reads "couldn't answer" though code could evaluate the call.
describe("a round after the cap that only calls the tool still ends on an answer carrying the total, never an empty one", () => {
	// Without min() the cap is applied by hand, as the model did (CUR-4490).
	const CAP = "1150 + 2 * 42";
	const inlineCall = answerBody(`calculate{"expression": "${CAP}"}`);
	const capped = [toolCallBody("1840 * 0.65", "r1"), toolCallBody("1150 + 84", "r2"), toolCallBody("1196 + 84", "r3")];

	it("runs an inline call written on the none round, then answers from its result on one more none round", async () => {
		const sent = stubResponses([...capped, inlineCall, answerBody("The first month is 1,234 €.")]);
		const { final, calculations } = await runTurn({ calculateTool: true });
		expect(sent.map((b) => b.tool_choice)).toEqual(["auto", "auto", "auto", "none", "none"]);
		expect(calculations.at(-1)).toMatchObject({ expression: CAP, result: "1234" });
		const replayed = messagesOf(sent[4]).at(-2);
		expect(replayed).toMatchObject({ role: "tool", content: "1234" });
		expect(final).toBe("The first month is 1,234 €.");
	});

	it("states the evaluated total when the model calls again instead of answering", async () => {
		const sent = stubResponses([...capped, inlineCall, inlineCall]);
		const { final, streamed } = await runTurn({ calculateTool: true });
		expect(sent).toHaveLength(MAX_CALCULATE_ROUNDS + 2);
		expect(final).toBe(`${CAP} = 1234`);
		// Streamed as well, since output screening builds the answer from streamed text.
		expect(streamed).toContain(`${CAP} = 1234`);
	});

	it("states the total when every round after the cap is a structured call", async () => {
		const sent = stubResponses([toolCallBody("1 + 1")]);
		const { final } = await runTurn({ calculateTool: true });
		expect(sent).toHaveLength(MAX_CALCULATE_ROUNDS + 2);
		expect(final).toBe("1 + 1 = 2");
	});
});

describe("a sequential kit runs a round's calls in the order the model gave them (the sandbox's workspace)", () => {
	// Two calls in one round: write a file, then read it. Run together, the read lands before the slow
	// write finishes and finds nothing, which is what Promise.all does in the sandbox.
	function writeThenReadBody(): string {
		const call = (id: string, index: number, name: string) => ({
			id,
			index,
			type: "function",
			function: { name, arguments: "{}" },
		});
		return sse([
			{
				delta: { role: "assistant", content: "", tool_calls: [call("w1", 0, "write_file"), call("r1", 1, "read_file")] },
				finish: "tool_calls",
			},
		]);
	}
	function workspaceKit(sequential: boolean) {
		let file: string | undefined;
		const def = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: {} } });
		return {
			label: "workspace",
			definitions: [def("write_file"), def("read_file")],
			...(sequential ? { sequential: true } : {}),
			run: async (call: { name: string }) => {
				if (call.name === "write_file") {
					await new Promise((r) => setTimeout(r, 20));
					file = "42";
					return { content: "written" };
				}
				return { content: file ?? "'out.txt' is not a file in the workspace" };
			},
		};
	}
	const toolMessages = (body: Record<string, unknown>) =>
		(body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content);

	it("the read sees the write before it", async () => {
		const sent = stubResponses([writeThenReadBody(), answerBody("It holds 42.")]);
		await runTurn({ nativeTools: workspaceKit(true) });
		expect(toolMessages(sent[1])).toEqual(["written", "42"]);
	});

	it("a kit without it still runs the round's calls at once", async () => {
		const sent = stubResponses([writeThenReadBody(), answerBody("Nothing there.")]);
		await runTurn({ nativeTools: workspaceKit(false) });
		expect(toolMessages(sent[1])).toEqual(["written", "'out.txt' is not a file in the workspace"]);
	});
});

describe("a call that waits for a free sandbox shows so while it runs (CUR-4584)", () => {
	it("yields the kit's waiting frame before the call returns, then the ready frame, then the answer", async () => {
		const { toolFrames } = await import("../toolFrames");
		const frames = toolFrames();
		const order: string[] = [];
		let release: () => void = () => {};
		const def = { type: "function" as const, function: { name: "run_code", description: "run", parameters: {} } };
		const kit = {
			label: "sandbox",
			definitions: [def],
			frames,
			run: async () => {
				frames.push({ sandboxWait: "waiting" });
				await new Promise<void>((r) => (release = r));
				order.push("returned");
				frames.push({ sandboxWait: "ready" });
				return { content: "exit code 0\nstdout:\n42" };
			},
		};
		const body = sse([
			{
				delta: {
					role: "assistant",
					content: "",
					tool_calls: [{ id: "r1", index: 0, type: "function", function: { name: "run_code", arguments: "{}" } }],
				},
				finish: "tool_calls",
			},
		]);
		stubResponses([body, answerBody("It printed 42.")]);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "https://api.mistral.ai/v1",
			apiKey: "sk-test",
			model: { id: MODEL, name: MODEL, parameters: {}, supportsTools: true },
		});
		const stream = await endpoint({
			locals: undefined,
			servesUserAnswer: true,
			nativeTools: kit,
			messages: [{ from: "user", content: "Run some code." }],
		} as unknown as Parameters<typeof endpoint>[0]);
		const waits: string[] = [];
		let final: string | undefined;
		for await (const o of stream) {
			if (o.sandboxWait) {
				waits.push(o.sandboxWait);
				order.push(`frame:${o.sandboxWait}`);
				if (o.sandboxWait === "waiting") release();
			}
			if (o.generated_text) final = o.generated_text;
		}
		expect(waits).toEqual(["waiting", "ready"]);
		expect(order).toEqual(["frame:waiting", "returned", "frame:ready"]);
		expect(final).toContain("It printed 42.");
	});
});

describe("no tool is offered unless the turn asks for it", () => {
	it("sends no tools and no tool_choice when the turn did not offer calculate", async () => {
		const sent = stubResponses([answerBody("hi")]);
		const { final } = await runTurn({});
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toHaveProperty("tools");
		expect(sent[0]).not.toHaveProperty("tool_choice");
		expect(final).toBe("hi");
	});

	it("never offers it on a side call, even when asked", async () => {
		const sent = stubResponses([answerBody("title")]);
		await runTurn({ calculateTool: true, servesUserAnswer: false });
		expect(sent[0]).not.toHaveProperty("tools");
	});

	it("is not offered with the flag off, even to a model that supports tools", () => {
		calculateFlagOn = false;
		expect(calculateToolOffered({ id: MODEL, supportsTools: true })).toBe(false);
	});

	it("is offered with the flag on to a model whose config sets supportsTools", () => {
		expect(calculateToolOffered({ id: MODEL, supportsTools: true })).toBe(true);
	});

	it("is not offered, and says so loudly, with the flag on and a model without tool support", () => {
		expect(calculateToolOffered({ id: "swiss-ai/apertus-v1.5-70b", supportsTools: false })).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ model: "swiss-ai/apertus-v1.5-70b" }),
			expect.stringContaining("supportsTools")
		);
	});

	it("adds the calc-first paragraph to the persona only when the tool is offered", () => {
		expect(buildPersonaPrompt(MODEL, undefined, {})).not.toContain(CALCULATE_FIRST_CLAUSE);
		expect(buildPersonaPrompt(MODEL, undefined, { calculateTool: true }).endsWith(CALCULATE_FIRST_CLAUSE)).toBe(
			true
		);
	});
});

describe("the tool and its persona paragraph are withheld where the answer cannot run the loop", () => {
	// A tool-capable Apertus model with no measured profile row goes out native-first, and that path
	// drops the tool. Offering it anyway would put the calculate paragraph in the
	// persona with no tool behind it, and Large 3 would write "Calling `calculate`" as prose.
	// Only the Apertus family is flattened when unmeasured, so the case uses one.
	const UNPROFILED = "swiss-ai/apertus-v1.5-70b-thinking";

	it("is not offered, and says so loudly, to a tool-capable model whose answer goes out native-first", () => {
		expect(calculateToolOffered({ id: UNPROFILED, supportsTools: true })).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ model: UNPROFILED }),
			expect.stringContaining("native-first")
		);
	});
});

describe("a follow-up sees the calculate calls earlier answers made (CUR-1202)", () => {
	const history = [
		{ from: "user", content: "5 full-time students and 4 at half time: how many full-time equivalents?" },
		{
			from: "assistant",
			content: "That is 7 full-time equivalents.",
			calculations: [
				{ expression: "5 + (4 * 0.5)", result: "7" },
				{ expression: "5 +", error: "the expression is incomplete" },
			],
		},
		{ from: "user", content: "One more full-time student joins. How many now?" },
	];

	it("puts each answered call and its result before the answer that used it, with Mistral-valid ids", async () => {
		const sent = stubResponses([answerBody("8")]);
		await runTurn({ calculateTool: true, messages: history });
		const wire = messagesOf(sent[0]).filter((m) => m.role !== "system");
		expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		const call = wire[1].tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
		expect(call).toHaveLength(1);
		expect(call[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
		expect(call[0].function).toEqual({ name: "calculate", arguments: JSON.stringify({ expression: "5 + (4 * 0.5)" }) });
		expect(wire[2]).toMatchObject({ tool_call_id: call[0].id, content: "7" });
		expect(wire[3].content).toBe("That is 7 full-time equivalents.");
	});

	it("sends a call's group list back with its expression, so the follow-up regroups from it", async () => {
		const sent = stubResponses([answerBody("10.5")]);
		const counted = [
			{ ...history[0] },
			{
				...history[1],
				calculations: [{ expression: "8 + (2 * 0.5)", result: "9", counts: "full-time: 8\nhalf-time: 2" }],
			},
			{ ...history[2] },
		];
		await runTurn({ calculateTool: true, messages: counted });
		const wire = messagesOf(sent[0]).filter((m) => m.role !== "system");
		const call = wire[1].tool_calls as Array<{ function: { arguments: string } }>;
		expect(JSON.parse(call[0].function.arguments)).toEqual({
			counts: "full-time: 8\nhalf-time: 2",
			expression: "8 + (2 * 0.5)",
		});
	});

	it("leaves the history as it was on a request that does not offer calculate", async () => {
		const sent = stubResponses([answerBody("8")]);
		await runTurn({ messages: history });
		const roles = messagesOf(sent[0]).filter((m) => m.role !== "system").map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "user"]);
	});
});

describe("a tool round's log splits the search from the next request (CUR-4282)", () => {
	it("logs searchMs and nextRequestMs beside ms, with searchMs no larger than ms on a slow search", async () => {
		const def = { type: "function" as const, function: { name: "web_search", description: "search", parameters: {} } };
		const call = { id: "s1", index: 0, type: "function", function: { name: "web_search", arguments: "{}" } };
		const kit = {
			label: "web",
			definitions: [def],
			run: async () => {
				await new Promise((r) => setTimeout(r, 80));
				return { content: "results" };
			},
		};
		stubResponses([
			sse([{ delta: { role: "assistant", content: "", tool_calls: [call] }, finish: "tool_calls" }]),
			answerBody("Done."),
		]);
		const { roundMs } = await runTurn({ nativeTools: kit });

		const line = info.mock.calls.find((c) => c[1] === "[web] round")?.[0] as Record<string, number>;
		expect(line).toEqual(expect.objectContaining({ ms: expect.any(Number), searchMs: expect.any(Number), nextRequestMs: expect.any(Number) }));
		expect(line.searchMs).toBeGreaterThanOrEqual(70);
		expect(line.searchMs).toBeLessThanOrEqual(line.ms);
		expect(roundMs[0].toolRunMs).toBe(line.searchMs);
	});
});

// A round-2 request can accept the connection and send nothing (CUR-4372); the turn then ends on the
// 45 s cap, and a line must say which round, lane or wait. withToolLoop is driven directly here, so the
// request can hang exactly that way: it settles only when its own signal is cut.
describe("a later round's request that never reaches its headers", () => {
	type Out = { token: { id: number; text: string; logprob: number; special: boolean }; generated_text: string | null; details: null; toolCalls?: unknown[] };
	const kit = {
		label: "web",
		definitions: [{ type: "function" as const, function: { name: "web_search", description: "search", parameters: {} } }],
		run: async () => ({ content: "results" }),
	};
	async function* toolCallRound(): AsyncGenerator<Out, void, void> {
		yield { token: { id: 0, text: "", logprob: 0, special: true }, generated_text: null, details: null, toolCalls: [{ id: "s1", name: "web_search", arguments: "{}" }] };
	}
	async function* answer(text: string): AsyncGenerator<Out, void, void> {
		yield { token: { id: 1, text, logprob: 0, special: false }, generated_text: null, details: null };
		yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: text, details: null };
	}
	/** A request that never answers: it rejects only when its own signal (or the turn's) is cut. */
	const hang = (signal?: AbortSignal) =>
		new Promise<never>((_, reject) => {
			const cut = () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" }));
			if (signal?.aborted) cut();
			else signal?.addEventListener("abort", cut, { once: true });
		});

	async function drain(gen: AsyncGenerator<Out, void, void>) {
		let final: string | null = null;
		for await (const o of gen) if (o.generated_text) final = o.generated_text;
		return final;
	}

	it("logs the round's request before it goes out, and an abort line naming round, lane and wait when the turn is cut", async () => {
		const { withToolLoop } = await import("./calculateTool");
		const turn = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		const gen = await withToolLoop({
			messages: [{ role: "user", content: "q" }],
			attempt: (_m, _c, signal) => {
				signals.push(signal);
				if (signals.length === 1) return Promise.resolve(toolCallRound());
				setTimeout(() => turn.abort(), 30);
				return hang(signal ?? turn.signal);
			},
			kit,
			retry: { signal: turn.signal, hedgeAfterMs: null, log: { model: "mistral-large-2512", lane: "router.example" } },
		} as Parameters<typeof withToolLoop>[0]);

		await expect(drain(gen as AsyncGenerator<Out, void, void>)).rejects.toThrow("Request was aborted.");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ round: 1, searchMs: expect.any(Number), model: "mistral-large-2512", lane: "router.example" }),
			"[web] round request sent"
		);
		const failed = warn.mock.calls.find((c) => c[1] === "[web] round request failed")?.[0];
		expect(failed, "no line says where the stalled round waited").toEqual(
			expect.objectContaining({ round: 1, aborted: true, hedged: 0, lane: "router.example", model: "mistral-large-2512" })
		);
		expect(failed.elapsedMs).toBeGreaterThanOrEqual(25);
		expect(info).not.toHaveBeenCalledWith(expect.anything(), "[web] round");
	});

	it("sends a second request on the same lane once the first has no headers past the hedge delay, cuts the first, and the turn answers", async () => {
		const { withToolLoop } = await import("./calculateTool");
		const { createHedgeThrottle } = await import("../retryPolicy");
		const turn = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		const gen = await withToolLoop({
			messages: [{ role: "user", content: "q" }],
			attempt: (_m, _c, signal) => {
				signals.push(signal);
				if (signals.length === 1) return Promise.resolve(toolCallRound());
				if (signals.length === 2) return hang(signal);
				return Promise.resolve(answer("Gaudí, 1900–1914."));
			},
			kit,
			retry: { signal: turn.signal, hedgeAfterMs: 20, throttle: createHedgeThrottle(), log: { lane: "router.example" } },
		} as Parameters<typeof withToolLoop>[0]);

		expect(await drain(gen as AsyncGenerator<Out, void, void>)).toBe("Gaudí, 1900–1914.");
		expect(signals).toHaveLength(3);
		expect(signals[1]?.aborted, "the stalled first request was left open").toBe(true);
		expect(signals[2]?.aborted).toBe(false);
		expect(turn.signal.aborted, "cutting the loser cut the turn").toBe(false);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ round: 1, hedgeAfterMs: 20, lane: "router.example" }),
			expect.stringContaining("sending a second alongside it on the same lane")
		);
		expect(info).toHaveBeenCalledWith(expect.objectContaining({ round: 1, hedged: 1 }), "[web] round");
	});

	it("sends no second request with the hedge off, and none for a round that answers inside the delay", async () => {
		const { withToolLoop } = await import("./calculateTool");
		const { createHedgeThrottle } = await import("../retryPolicy");
		for (const hedgeAfterMs of [null, 200]) {
			let sends = 0;
			const gen = await withToolLoop({
				messages: [{ role: "user", content: "q" }],
				attempt: async () => {
					sends++;
					if (sends === 1) return toolCallRound();
					await new Promise((r) => setTimeout(r, 30));
					return answer("ok");
				},
				kit,
				retry: { hedgeAfterMs, throttle: createHedgeThrottle() },
			} as Parameters<typeof withToolLoop>[0]);
			expect(await drain(gen as AsyncGenerator<Out, void, void>)).toBe("ok");
			expect(sends, `hedgeAfterMs ${hedgeAfterMs}`).toBe(2);
		}
	});

	it("hands withRetry the error when both requests fail, so a 400 still ends the turn without a third send", async () => {
		const { withToolLoop } = await import("./calculateTool");
		const { createHedgeThrottle } = await import("../retryPolicy");
		let sends = 0;
		const gen = await withToolLoop({
			messages: [{ role: "user", content: "q" }],
			attempt: async () => {
				sends++;
				if (sends === 1) return toolCallRound();
				await new Promise((r) => setTimeout(r, sends === 2 ? 40 : 5));
				throw Object.assign(new Error("bad request"), { status: 400 });
			},
			kit,
			retry: { hedgeAfterMs: 10, throttle: createHedgeThrottle() },
		} as Parameters<typeof withToolLoop>[0]);
		await expect(drain(gen as AsyncGenerator<Out, void, void>)).rejects.toMatchObject({ status: 400 });
		expect(sends).toBe(3);
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({ round: 1, status: 400, hedged: 1 }), "[web] round request failed");
	});
});
