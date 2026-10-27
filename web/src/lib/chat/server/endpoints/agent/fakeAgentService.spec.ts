import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FAKE_AGENT_BASE,
	FAKE_RUN_MS,
	fakeAgentArtifact,
	fakeAgentFetch,
} from "./fakeAgentService";

// The scenario suite's in-process stand-in for agent-service. Stateless — every answer is
// derived from the task id's start time and the clock — so these tests drive the clock directly. (SOL-212)

const T0 = 1_760_000_000_000;
const RECEIPT_PROMPT =
	"Explain why community meals matter. End your answer with the line: receipt 0a1b2c3d4e5f";
const FILE_PROMPT =
	"Create a text file named potluck-e2e-1234.txt whose only content is the line: potluck 1234\nThen say done.";

async function submit(prompt: string, now = T0): Promise<string> {
	const res = await fakeAgentFetch(
		`${FAKE_AGENT_BASE}/run`,
		{ method: "POST", body: JSON.stringify({ prompt }) },
		() => now
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { id: string }).id;
}

type FrameData = { state?: string; result?: string; delta?: string; task_id?: string; artifacts?: unknown };

/** Reads the event stream to its end with the clock fixed at `now`, so only frames due by then arrive
 *  before the stream would wait; abort once nothing more is due. */
async function framesDueAt(taskId: string, now: number): Promise<{ event: string; data: FrameData }[]> {
	const ctrl = new AbortController();
	const res = await fakeAgentFetch(
		`${FAKE_AGENT_BASE}/run/${taskId}/events`,
		{ signal: ctrl.signal },
		() => now
	);
	expect(res.headers.get("content-type")).toBe("text/event-stream");
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	// Every due frame is enqueued synchronously in start(); a short timer then ends the read.
	setTimeout(() => ctrl.abort(), 20);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
	} catch (e) {
		expect((e as Error).name).toBe("AbortError");
	}
	return text
		.split("\n\n")
		.filter(Boolean)
		.map((block) => {
			const event = block.match(/^event: (.*)$/m)![1];
			const data = JSON.parse(block.match(/^data: (.*)$/m)![1]);
			return { event, data };
		});
}

describe("fakeAgentService", () => {
	const prev = { DEPLOY_ENV: process.env.DEPLOY_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
	beforeEach(() => {
		process.env.DEPLOY_ENV = "preview";
	});
	afterEach(() => {
		process.env.DEPLOY_ENV = prev.DEPLOY_ENV;
		process.env.VERCEL_ENV = prev.VERCEL_ENV;
	});

	it("derives the frames from the time elapsed since the start: a run 10s in has planned and called a tool but written no answer", async () => {
		const id = await submit(RECEIPT_PROMPT);
		const frames = await framesDueAt(id, T0 + 10_000);
		expect(frames.map((f) => f.event)).toEqual(["state", "plan", "tool_call", "tool_result"]);
	});

	it("ends a finished run with `done` whose result ends in the prompt's `receipt <nonce>` line", async () => {
		const id = await submit(RECEIPT_PROMPT);
		const frames = await framesDueAt(id, T0 + FAKE_RUN_MS);
		expect(frames.at(-1)!.event).toBe("done");
		const done = frames.at(-1)!.data;
		expect(done.state).toBe("COMPLETED");
		expect(done.result!.trim().endsWith("receipt 0a1b2c3d4e5f")).toBe(true);
		const streamed = frames.filter((f) => f.event === "token").map((f) => f.data.delta).join("");
		expect(streamed).toBe(done.result);
	});

	it("does not finish before FAKE_RUN_MS, so a run outlives the 20s turn deadline the re-attach specs force", async () => {
		const id = await submit(RECEIPT_PROMPT);
		const frames = await framesDueAt(id, T0 + FAKE_RUN_MS - 1_000);
		expect(frames.map((f) => f.event)).not.toContain("done");
		const status = await fakeAgentFetch(`${FAKE_AGENT_BASE}/run/${id}`, {}, () => T0 + 20_000);
		expect(((await status.json()) as { state: string }).state).toBe("WORKING");
	});

	it("re-attach returns the same task: a second read of the same id, later, carries the same id and answer", async () => {
		const id = await submit(RECEIPT_PROMPT);
		const first = await framesDueAt(id, T0 + FAKE_RUN_MS);
		const again = await framesDueAt(id, T0 + FAKE_RUN_MS + 60_000);
		expect(again).toEqual(first);
		expect(again.at(-1)!.data.task_id).toBe(id);
		const status = (await (await fakeAgentFetch(`${FAKE_AGENT_BASE}/run/${id}`, {}, () => T0 + FAKE_RUN_MS)).json()) as {
			id: string;
			state: string;
		};
		expect(status).toMatchObject({ id, state: "COMPLETED" });
	});

	it("a prompt with neither spec-written ask gets no receipt line and no file, and an id it never minted is a 404", async () => {
		const id = await submit("just chat");
		const done = (await framesDueAt(id, T0 + FAKE_RUN_MS)).at(-1)!.data;
		expect(done.result).not.toMatch(/receipt/);
		expect(done.artifacts).toEqual([]);
		const res = await fakeAgentFetch(`${FAKE_AGENT_BASE}/run/not-a-fake-id`, {}, () => T0);
		expect(res.status).toBe(404);
	});

	it("serves the file a prompt asked for only once the run has completed, and only by that name", async () => {
		const id = await submit(FILE_PROMPT);
		expect(fakeAgentArtifact(id, "potluck-e2e-1234.txt", T0 + 10_000)).toBeNull();
		expect(fakeAgentArtifact(id, "other.txt", T0 + FAKE_RUN_MS)).toBeNull();
		expect(fakeAgentArtifact(id, "potluck-e2e-1234.txt", T0 + FAKE_RUN_MS)).toBe("potluck 1234\n");
		const frames = await framesDueAt(id, T0 + FAKE_RUN_MS);
		expect(frames.at(-1)!.data.artifacts).toEqual([
			{ name: "potluck-e2e-1234.txt", bytes: 13, text: "potluck 1234\n", truncated: false },
		]);
	});

	it("the at_capacity knob answers POST /run with agent-service's own 429 body", async () => {
		const res = await fakeAgentFetch(
			`${FAKE_AGENT_BASE}/run`,
			{ method: "POST", body: JSON.stringify({ prompt: "x" }), knobs: ["at_capacity"] },
			() => T0
		);
		expect(res.status).toBe(429);
		expect(((await res.json()) as { detail: string }).detail).toMatch(/at capacity/);
	});

	it("the daily_limit knob answers POST /run with the 429 agent-service's per-visitor daily cap sends", async () => {
		const res = await fakeAgentFetch(
			`${FAKE_AGENT_BASE}/run`,
			{ method: "POST", body: JSON.stringify({ prompt: "x" }), knobs: ["daily_limit"] },
			() => T0
		);
		expect(res.status).toBe(429);
		expect(((await res.json()) as { detail: string }).detail).toMatch(/per-visitor task limit reached/);
	});

	it("a DELETE before the run finishes reports CANCELED", async () => {
		const id = await submit(RECEIPT_PROMPT);
		const res = await fakeAgentFetch(`${FAKE_AGENT_BASE}/run/${id}`, { method: "DELETE" }, () => T0 + 5_000);
		expect(((await res.json()) as { state: string }).state).toBe("CANCELED");
	});

	it("answers POST /route as direct, so a turn the router would hand to the agent stays plain chat", async () => {
		const res = await fakeAgentFetch(`${FAKE_AGENT_BASE}/route`, { method: "POST", body: "{}" });
		expect(((await res.json()) as { agentic: boolean }).agentic).toBe(false);
	});

	it("in production answers 404 on every endpoint and serves no file, even for a task id a preview minted", async () => {
		const id = await submit(FILE_PROMPT);
		process.env.DEPLOY_ENV = "production";
		const calls: [string, RequestInit][] = [
			["/run", { method: "POST", body: JSON.stringify({ prompt: "x" }) }],
			["/route", { method: "POST", body: "{}" }],
			[`/run/${id}`, {}],
			[`/run/${id}`, { method: "DELETE" }],
			[`/run/${id}/events`, {}],
		];
		for (const [path, init] of calls) {
			const res = await fakeAgentFetch(`${FAKE_AGENT_BASE}${path}`, init, () => T0 + FAKE_RUN_MS);
			expect(res.status, path).toBe(404);
		}
		expect(fakeAgentArtifact(id, "potluck-e2e-1234.txt", T0 + FAKE_RUN_MS)).toBeNull();
	});
});
