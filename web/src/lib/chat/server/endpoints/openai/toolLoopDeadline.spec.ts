// The tool loop's deadline check and Continue, driven through the real endpoint with a stubbed fetch,
// so the decision in answerRoundBudget.ts, its wiring in endpointOai.ts and the loop in calculateTool.ts
// are under test together. What the second request offers the model is the contract.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (_key: string, fallback: () => boolean) => fallback(),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

const { endpointOai, CONTINUE_ANSWER_MESSAGE } = await import("./endpointOai");
const { forgetAnswerRounds } = await import("./answerRoundBudget");

const MODEL = "mistral-large-2512";

function sse(chunks: Array<{ delta: Record<string, unknown>; finish?: string | null }>): string {
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

const toolCallBody = sse([
	{
		delta: {
			role: "assistant",
			content: "",
			tool_calls: [
				{
					id: "abc123XYZ",
					index: 0,
					type: "function",
					function: { name: "calculate", arguments: JSON.stringify({ expression: "3 * 14 * 18" }) },
				},
			],
		},
		finish: "tool_calls",
	},
]);
const answerBody = (text: string) => sse([{ delta: { role: "assistant", content: text } }, { delta: {}, finish: "stop" }]);

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

async function runTurn(params: Record<string, unknown>) {
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: "https://api.mistral.ai/v1",
		apiKey: "sk-test",
		model: { id: MODEL, name: MODEL, parameters: {}, supportsTools: true },
	});
	const stream = await endpoint({
		locals: undefined,
		servesUserAnswer: true,
		messages: [{ from: "user", content: "3 workshops of 14 people at 18 each: total cost?" }],
		...params,
	} as Parameters<typeof endpoint>[0]);
	let final: string | null | undefined;
	for await (const o of stream) if (o.generated_text) final = o.generated_text;
	return final;
}

type WireMessage = { role: string; content?: string };
const lastMessage = (body: Record<string, unknown>) => (body.messages as WireMessage[]).at(-1);

afterEach(() => {
	vi.unstubAllGlobals();
	forgetAnswerRounds();
});

describe("a tool loop near its turn's ceiling asks for the answer instead of offering another tool round", () => {
	it("sends the next request without tools when the answer round would not end before the ceiling", async () => {
		const sent = stubResponses([toolCallBody, answerBody("The total is 756.")]);
		// Nothing measured yet, so the answer round is the 4,096-token reserve at 40 tok/s, about 102 s:
		// a ceiling 30 s away cannot hold it.
		const final = await runTurn({ calculateTool: true, turnCeilingAt: () => Date.now() + 30_000 });

		expect(sent).toHaveLength(2);
		expect(sent[0].tool_choice).toBe("auto");
		expect(sent[1].tool_choice).toBe("none");
		expect(lastMessage(sent[1])).toEqual(
			expect.objectContaining({ role: "user", content: expect.stringContaining("Answer the question now") })
		);
		expect(final).toBe("The total is 756.");
	});

	it("keeps offering tools while the answer round still fits before the ceiling", async () => {
		const sent = stubResponses([toolCallBody, answerBody("The total is 756.")]);
		await runTurn({ calculateTool: true, turnCeilingAt: () => Date.now() + 600_000 });

		expect(sent.map((b) => b.tool_choice)).toEqual(["auto", "auto"]);
	});

	it("reads the ceiling again before each round, so a turn whose ceiling moves is judged on the new one", async () => {
		const sent = stubResponses([toolCallBody, toolCallBody, answerBody("The total is 756.")]);
		// Far off after the first round, near after the second: only a loop that asks again sees the change.
		await runTurn({
			calculateTool: true,
			turnCeilingAt: () => Date.now() + (sent.length < 2 ? 600_000 : 30_000),
		});

		expect(sent.map((b) => b.tool_choice)).toEqual(["auto", "auto", "none"]);
	});
});

describe("Continue: an answer cut off at the time limit is finished from where it stopped", () => {
	it("sends the cut answer as the model's own turn, then asks it to go on, after the question", async () => {
		const sent = stubResponses([answerBody("so the highest tides come when the two line up.")]);
		await runTurn({ continueFrom: "Tides rise and fall twice a day because " });

		const messages = sent[0].messages as WireMessage[];
		expect(messages.slice(-3)).toEqual([
			expect.objectContaining({ role: "user", content: "3 workshops of 14 people at 18 each: total cost?" }),
			{ role: "assistant", content: "Tides rise and fall twice a day because " },
			{ role: "user", content: CONTINUE_ANSWER_MESSAGE },
		]);
	});
});
