// A sandbox call that hangs must not hold the chat turn past its own cap. The turn's watchdog
// ends an ordinary turn at 45 s and a sandbox call may take 90 s, so the call has to hear
// the turn's abort, or a hung sandbox holds the visitor on a spinner until "took too long".
//
// The fake connection's call never settles unless its signal aborts, so whether the kit's run() settles at
// all, and when, is read off the clock rather than off our own outcome label. (CUR-4627)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/database", () => ({ collections: {} }));

const { mcpServersKit, ANSWER_MARGIN_MS } = await import("./serversKit");
type ServerTool = import("./serverTools").ServerTool;
type McpServerConfig = import("./servers").McpServerConfig;
type McpCallOptions = import("./client").McpCallOptions;
type McpCallResult = import("./client").McpCallResult;

const TURN_CAP_MS = 45_000;
const SANDBOX_CAP_MS = 90_000;

const TOOL: ServerTool = {
	fnName: "sandbox__run_code",
	server: "sandbox",
	tool: "run_code",
	sha256: "x",
	definition: { type: "function", function: { name: "sandbox__run_code", parameters: { type: "object", properties: {} } } },
} as ServerTool;

const SERVER: McpServerConfig = {
	name: "sandbox",
	url: "https://agent.example/mcp/",
	headers: {},
	origin: "https://agent.example",
	fetch: async () => new Response(null),
	progressIsSandboxWait: true,
	callTimeoutMs: SANDBOX_CAP_MS,
};

const RUN = { id: "c1", name: "sandbox__run_code", arguments: JSON.stringify({ code: "print(1)" }) };

/** A connection whose call settles only by `answer`, or never; it records the options it was given. */
function fakeConn(answer?: (opts: McpCallOptions | undefined) => Promise<McpCallResult>) {
	const seen: { opts?: McpCallOptions } = {};
	let connects = 0;
	const connect = async () => {
		connects++;
		return {
			tools: [],
			openaiTools: [],
			call: (_n: string, _a: Record<string, unknown>, opts?: McpCallOptions) => {
				seen.opts = opts;
				return answer ? answer(opts) : new Promise<McpCallResult>(() => {});
			},
			close: async () => {},
		};
	};
	return { connect, seen, connects: () => connects };
}

function kitFor(connect: ReturnType<typeof fakeConn>["connect"], extra: { signal?: AbortSignal; turnDeadlineAt?: number } = {}) {
	return mcpServersKit({
		tools: [TOOL],
		servers: [SERVER],
		policies: { [TOOL.fnName]: "allow" },
		shownServers: ["sandbox"],
		connect,
		...extra,
	});
}

/** Runs `p` under fake time and reports when it settled, in ms from the start, or undefined if it had not by `untilMs`. */
async function settledAt<T>(p: Promise<T>, untilMs: number): Promise<number | undefined> {
	const start = Date.now();
	let at: number | undefined;
	void p.then(() => (at = Date.now() - start));
	for (let t = 0; t < untilMs && at === undefined; t += 500) await vi.advanceTimersByTimeAsync(500);
	return at;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a sandbox call is bounded by the turn's time left (CUR-4627)", () => {
	it("a sandbox call that outlives the turn's budget is aborted before the turn's cap and the answer says the run timed out", async () => {
		const { connect, seen } = fakeConn();
		const kit = kitFor(connect, { turnDeadlineAt: Date.now() + TURN_CAP_MS, signal: new AbortController().signal });
		const running = kit.run(RUN);
		const at = await settledAt(running, SANDBOX_CAP_MS + 5_000);
		expect(at, "the hung call held the turn past its own cap").toBeDefined();
		expect(at!).toBeLessThanOrEqual(TURN_CAP_MS - ANSWER_MARGIN_MS + 500);
		const res = await running;
		expect(res.mcpCall?.outcome).toBe("call_timeout");
		expect(res.content).toMatch(/code run timed out/i);
		expect(res.content).not.toMatch(/succeeded|^\s*$/);
		expect(res.mcpCall?.output).toMatch(/did not answer within 35 seconds/);
		expect(seen.opts?.signal?.aborted, "the abort never reached the SDK request").toBe(true);
	});

	it("a turn stopped while a sandbox call is pending ends the call at once, with a timed-out result rather than an empty one", async () => {
		const { connect, seen } = fakeConn();
		const turn = new AbortController();
		const kit = kitFor(connect, { turnDeadlineAt: Date.now() + TURN_CAP_MS, signal: turn.signal });
		const running = kit.run(RUN);
		await vi.advanceTimersByTimeAsync(1_000);
		turn.abort();
		const at = await settledAt(running, 1_000);
		expect(at, "the stopped turn's call kept running").toBeDefined();
		const res = await running;
		expect(res.mcpCall?.outcome).toBe("call_timeout");
		expect(res.content).toMatch(/code run timed out: the turn was stopped/i);
		expect(seen.opts?.signal?.aborted).toBe(true);
	});

	it("with no turn deadline, a hung call still ends at the sandbox's own cap instead of never", async () => {
		const { connect } = fakeConn();
		const kit = kitFor(connect);
		const running = kit.run(RUN);
		const at = await settledAt(running, SANDBOX_CAP_MS + 5_000);
		expect(at).toBeDefined();
		expect(at!).toBeGreaterThanOrEqual(SANDBOX_CAP_MS);
		expect((await running).mcpCall?.outcome).toBe("call_timeout");
	});

	it("a call the turn has no time left for is not started, and the model is told it timed out", async () => {
		const { connect, connects } = fakeConn(async () => ({ kind: "text", text: "ran" }));
		const kit = kitFor(connect, { turnDeadlineAt: Date.now() + ANSWER_MARGIN_MS + 1_000 });
		const res = await kit.run(RUN);
		expect(connects()).toBe(0);
		expect(res.mcpCall?.outcome).toBe("call_timeout");
		expect(res.content).toMatch(/code run timed out/i);
	});

	it("while the host-full wait is shown the turn's clock is held, so the call may run on to its own cap and answer", async () => {
		const { connect } = fakeConn(
			(opts) =>
				new Promise((resolve) => {
					setTimeout(() => opts?.onProgress?.("waiting for a free sandbox"), 1_000);
					setTimeout(() => resolve({ kind: "text", text: "42" }), 60_000);
				})
		);
		const kit = kitFor(connect, { turnDeadlineAt: Date.now() + TURN_CAP_MS });
		const running = kit.run(RUN);
		const at = await settledAt(running, SANDBOX_CAP_MS);
		expect(at).toBeDefined();
		const res = await running;
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(res.content).toContain("42");
	});

	it("a call that answers inside the budget is untouched", async () => {
		const { connect } = fakeConn(async () => ({ kind: "text", text: "7" }));
		const kit = kitFor(connect, { turnDeadlineAt: Date.now() + TURN_CAP_MS });
		const res = await kit.run(RUN);
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(res.content).toContain("7");
	});
});
