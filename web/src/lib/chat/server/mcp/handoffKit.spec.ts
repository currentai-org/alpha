import { describe, expect, it } from "vitest";
import type { StreamedToolCall } from "$lib/chat/server/endpoints/types";
import type { ConfirmStore } from "./confirm";
import { CHECK_TOOL, HAND_OFF_TOOL, handoffKit, type HandoffDeps } from "./handoffKit";
import { withHandoff } from "./turnKit";
import type { McpServersKit } from "./serversKit";

type Req = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A stand-in agent-service: /run starts a task, GET /run/{id} walks it through `states`. */
function fakeService(states: { state: string; result?: string; pending_confirmations?: unknown[] }[]) {
	const seen: Req[] = [];
	let i = 0;
	const fetch = (async (url: string, init: RequestInit) => {
		const req: Req = {
			url,
			method: String(init.method),
			headers: init.headers as Record<string, string>,
			...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
		};
		seen.push(req);
		if (url.endsWith("/run") && req.method === "POST") return Response.json({ id: "task-1", machine_id: "m-1" });
		if (url.endsWith("/confirm")) return Response.json({ ok: true });
		const s = states[Math.min(i++, states.length - 1)];
		return Response.json(s);
	}) as unknown as typeof globalThis.fetch;
	return { fetch, seen };
}

function store(answer: "accept" | "decline" | undefined): ConfirmStore & { opened: number } {
	const s = {
		opened: 0,
		async open() {
			s.opened++;
			return "c-1";
		},
		async read() {
			return answer;
		},
		async expire() {
			return true;
		},
	};
	return s;
}

function deps(over: Partial<HandoffDeps>): HandoffDeps {
	let t = 0;
	return {
		base: "https://agent.example/",
		headers: { authorization: "Bearer t", "x-agent-subject": "s" },
		sessionId: "conv-1",
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		waitMs: 9_000,
		...over,
	};
}

const handOff = (task = "build the notes package and run its tests"): StreamedToolCall => ({
	id: "call-1",
	name: HAND_OFF_TOOL,
	arguments: JSON.stringify({ task }),
});

async function drain(kit: ReturnType<typeof handoffKit>, calls: StreamedToolCall[]) {
	const frames = [];
	for await (const f of kit.beforeRun!(calls)) frames.push(f);
	return frames;
}

describe("handoffKit", () => {
	it("offers hand_off_to_agent and check_agent_task, and runs them one after another", () => {
		const kit = handoffKit(deps({}));
		expect(kit.definitions.map((d) => d.function.name)).toEqual([HAND_OFF_TOOL, CHECK_TOOL]);
		expect(kit.sequential).toBe(true);
	});

	it("starts no agent run until the person says yes: a decline never reaches /run", async () => {
		const svc = fakeService([{ state: "COMPLETED", result: "done" }]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("decline") }));
		const frames = await drain(kit, [handOff()]);
		expect(frames[0]?.agentConfirm?.title).toBe("hand this task to the agent");
		expect(frames[1]?.agentConfirmResult?.decision).toBe("deny");
		const res = await kit.run(handOff());
		expect(res.content).toMatch(/declined/);
		expect(svc.seen).toHaveLength(0);
	});

	it("with no confirmation store, refuses the handoff rather than running it unasked", async () => {
		const svc = fakeService([{ state: "COMPLETED", result: "done" }]);
		const kit = handoffKit(deps({ fetch: svc.fetch }));
		await drain(kit, [handOff()]);
		expect((await kit.run(handOff())).mcpCall?.outcome).toBe("declined");
		expect(svc.seen).toHaveLength(0);
	});

	it("on yes, starts /run with the conversation as its session and the visitor's headers, and returns the agent's answer fenced", async () => {
		const svc = fakeService([{ state: "WORKING" }, { state: "COMPLETED", result: "All 4 tests pass." }]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		const res = await kit.run(handOff());
		const submit = svc.seen[0];
		expect(submit.url).toBe("https://agent.example/run");
		expect(submit.body).toMatchObject({ prompt: "build the notes package and run its tests", session_id: "conv-1" });
		expect(submit.headers["x-agent-subject"]).toBe("s");
		expect(svc.seen[1].headers["Fly-Force-Instance-Id"]).toBe("m-1");
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(res.content).toContain("<<agent-result>>\nAll 4 tests pass.\n<<end agent-result>>");
	});

	it("allows the agent's writes and code runs under the person's yes, and refuses any other kind it asks for", async () => {
		const svc = fakeService([
			{
				state: "AWAITING_CONFIRMATION",
				pending_confirmations: [
					{ confirm_id: "w", kind: "edit" },
					{ confirm_id: "x", kind: "execute" },
					{ confirm_id: "d", kind: "delete" },
				],
			},
			{ state: "COMPLETED", result: "ok" },
		]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		await kit.run(handOff());
		const answers = svc.seen.filter((r) => r.url.endsWith("/confirm")).map((r) => r.body);
		expect(answers).toEqual([
			{ confirm_id: "w", decision: "allow" },
			{ confirm_id: "x", decision: "allow" },
			{ confirm_id: "d", decision: "deny" },
		]);
	});

	it("stops waiting after one slice and says the agent is still working, then check_agent_task waits again", async () => {
		const svc = fakeService([
			{ state: "WORKING" },
			{ state: "WORKING" },
			{ state: "WORKING" },
			{ state: "WORKING" },
			{ state: "COMPLETED", result: "finished" },
		]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		const first = await kit.run(handOff());
		expect(first.mcpCall?.outcome).toBe("working");
		expect(first.content).toContain(`Call ${CHECK_TOOL} with this task id`);
		const second = await kit.run({ id: "call-2", name: CHECK_TOOL, arguments: JSON.stringify({ task_id: "task-1" }) });
		expect(second.mcpCall?.outcome).toBe("ok");
		expect(second.content).toContain("finished");
	});

	it("check_agent_task refuses a task id this turn did not start, without calling the service", async () => {
		const svc = fakeService([{ state: "COMPLETED", result: "someone else's" }]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("accept") }));
		const res = await kit.run({ id: "c", name: CHECK_TOOL, arguments: JSON.stringify({ task_id: "other" }) });
		expect(res.mcpCall?.outcome).toBe("unknown_task");
		expect(svc.seen).toHaveLength(0);
	});

	it("a failed run is reported as not finished, never as done", async () => {
		const svc = fakeService([{ state: "FAILED", result: "partial" }]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		const res = await kit.run(handOff());
		expect(res.mcpCall?.outcome).toBe("failed");
		expect(res.content).toMatch(/did not finish/);
	});

	it("a status read that fails is reported as unknown and retryable, never as the agent failing", async () => {
		const svc = fakeService([]);
		const failing = (async (url: string, init: RequestInit) =>
			url.endsWith("/task-1") ? new Response("bad gateway", { status: 502 }) : svc.fetch(url, init)) as unknown as typeof fetch;
		const kit = handoffKit(deps({ fetch: failing, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		const res = await kit.run(handOff());
		expect(res.mcpCall?.outcome).toBe("working");
		expect(res.content).not.toMatch(/failed/);
		expect(res.content).toContain(`Call ${CHECK_TOOL} with this task id to try again`);
	});

	it("a status read that throws (a timeout, a reset) is reported as unknown and retryable, and the run stays checkable", async () => {
		const svc = fakeService([{ state: "COMPLETED", result: "done later" }]);
		let reads = 0;
		const throwing = (async (url: string, init: RequestInit) => {
			if (url.endsWith("/task-1") && reads++ === 0) throw new DOMException("timed out", "TimeoutError");
			return svc.fetch(url, init);
		}) as unknown as typeof fetch;
		const kit = handoffKit(deps({ fetch: throwing, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		const first = await kit.run(handOff());
		expect(first.mcpCall?.outcome).toBe("working");
		expect(first.content).toContain("could not be read (TimeoutError)");
		const second = await kit.run({ id: "call-2", name: CHECK_TOOL, arguments: JSON.stringify({ task_id: "task-1" }) });
		expect(second.content).toContain("done later");
	});

	it("never promises files after the turn: a run still going when the turn ends is reported as it stood", async () => {
		const svc = fakeService([{ state: "WORKING" }]);
		const kit = handoffKit(deps({ fetch: svc.fetch, confirm: store("accept") }));
		await drain(kit, [handOff()]);
		const res = await kit.run(handOff());
		expect(res.content).toContain("was still working when the turn ended");
		expect(res.content).not.toMatch(/will appear/);
	});

	it("bounds one call's wait from the call's start, so a slow start leaves less time to poll", async () => {
		let t = 0;
		const svc = fakeService([{ state: "WORKING" }]);
		const slowStart = (async (url: string, init: RequestInit) => {
			if (url.endsWith("/run")) t += 8_000;
			return svc.fetch(url, init);
		}) as unknown as typeof fetch;
		const kit = handoffKit(deps({ fetch: slowStart, confirm: store("accept"), now: () => t, sleep: async (ms) => void (t += ms) }));
		await drain(kit, [handOff()]);
		await kit.run(handOff());
		expect(t).toBeLessThanOrEqual(9_000);
	});
});

describe("withHandoff", () => {
	it("keeps the MCP kit's confirmation cards and adds the handoff's, each for its own calls", async () => {
		const mcpSeen: string[][] = [];
		const mcp: McpServersKit = {
			label: "mcp-servers",
			definitions: [{ type: "function", function: { name: "files__write", description: "", parameters: {} } }],
			run: async () => ({ content: "mcp" }),
			async *beforeRun(calls) {
				mcpSeen.push(calls.map((c) => c.name));
				yield { agentConfirm: { taskId: "", confirmId: "m", kind: "mcp", title: "mcp card", summary: "" } };
			},
			blocked: [],
		};
		const kit = withHandoff(mcp, handoffKit(deps({ confirm: store("decline") })));
		const calls = [{ id: "a", name: "files__write", arguments: "{}" }, handOff()];
		const titles = [];
		for await (const f of kit.beforeRun(calls)) if (f.agentConfirm) titles.push(f.agentConfirm.title);
		expect(titles).toEqual(["mcp card", "hand this task to the agent"]);
		expect(mcpSeen).toEqual([["files__write"]]);
		expect((await kit.run(calls[0])).content).toBe("mcp");
		expect((await kit.run(calls[1])).mcpCall?.outcome).toBe("declined");
	});

	it("runs calls one after another even when the MCP kit alone would not", () => {
		const mcp: McpServersKit = { label: "mcp-servers", definitions: [], run: async () => ({ content: "" }), async *beforeRun() {}, blocked: [] };
		expect(withHandoff(mcp, handoffKit(deps({}))).sequential).toBe(true);
	});
});
