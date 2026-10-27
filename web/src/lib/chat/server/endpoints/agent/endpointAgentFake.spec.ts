import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRequestContext, updateRequestContext } from "$lib/chat/server/requestContext";
import { endpointAgent } from "./endpointAgent";
import { FAKE_AGENT_BASE, FAKE_RUN_MS, fakeAgentFetch, isFakeAgentTaskId } from "./fakeAgentService";

// A scenario send that carries `x-e2e-agent: fake` runs its agent turn on the in-process
// stand-in, and a re-attach to a fake task id goes back to it, without one request reaching the real
// agent-service. The global fetch throws, so any call that leaked past the stand-in fails the test. (SOL-212)

const T0 = 1_760_000_000_000;
const PROMPT = "Why do community meals matter? End your answer with the line: receipt 5eed5eed5eed";

type Chunk = { token: { text: string }; generated_text: string | null; agentRun?: { taskId?: string } };

async function drain(params: Record<string, unknown>, fake: boolean): Promise<Chunk[]> {
	const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
	return runWithRequestContext(async () => {
		if (fake) updateRequestContext({ fakeAgent: { knobs: [] } });
		const stream = await factory({
			messages: [{ from: "user", content: PROMPT }],
			...params,
		} as Parameters<typeof factory>[0]);
		const chunks: Chunk[] = [];
		for await (const c of stream) chunks.push(c as Chunk);
		return chunks;
	});
}

describe("endpointAgent on the scenario stand-in (SOL-212)", () => {
	const prevEnv = process.env.DEPLOY_ENV;
	let realFetch: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		process.env.DEPLOY_ENV = "preview";
		realFetch = vi.fn(async (url: string | URL) => {
			throw new Error(`the real agent-service was called: ${String(url)}`);
		});
		vi.stubGlobal("fetch", realFetch);
	});
	afterEach(() => {
		process.env.DEPLOY_ENV = prevEnv;
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("a fake send runs the whole turn in-process, ends with the receipt, and never calls the real service", async () => {
		vi.useFakeTimers({ now: T0 });
		const pending = drain({}, true);
		await vi.advanceTimersByTimeAsync(FAKE_RUN_MS + 1_000);
		const chunks = await pending;
		expect(realFetch).not.toHaveBeenCalled();
		expect(isFakeAgentTaskId(chunks.find((c) => c.agentRun)?.agentRun?.taskId)).toBe(true);
		expect(chunks.at(-1)?.generated_text?.trim().endsWith("receipt 5eed5eed5eed")).toBe(true);
	});

	it("re-attaching to a fake task id returns that same task's answer from the stand-in, with no fake header on the request", async () => {
		const submitted = await fakeAgentFetch(
			`${FAKE_AGENT_BASE}/run`,
			{ method: "POST", body: JSON.stringify({ prompt: PROMPT }) },
			() => T0
		);
		const { id } = (await submitted.json()) as { id: string };
		vi.useFakeTimers({ now: T0 + FAKE_RUN_MS + 5_000 });
		const pending = drain({ agentAttach: { taskId: id } }, false);
		await vi.advanceTimersByTimeAsync(1_000);
		const chunks = await pending;
		expect(realFetch).not.toHaveBeenCalled();
		expect(chunks.find((c) => c.agentRun)?.agentRun?.taskId).toBe(id);
		expect(chunks.at(-1)?.generated_text?.trim().endsWith("receipt 5eed5eed5eed")).toBe(true);
	});

	it("a send without the fake header still goes to the real service", async () => {
		await drain({}, false).catch(() => undefined);
		expect(String(realFetch.mock.calls[0]?.[0])).toBe("http://agent.test/run");
	});
});
