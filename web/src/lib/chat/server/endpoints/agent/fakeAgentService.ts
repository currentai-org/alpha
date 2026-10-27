// A stand-in for agent-service, answered inside this deployment, so a scenario run's agent turns never
// queue on the shared develop agent machine (it runs AGENT_MAX_CONCURRENCY = 4 tasks, so parallel
// shards would refuse each other at capacity) (SOL-212).
//
// Reached through a fetch that never leaves the process, the way mcp/e2eStub.ts is: a preview's own
// URL sits behind Vercel's deployment protection, which a server-side request cannot pass, so there is
// no HTTP route for it. It answers the same endpoints and wire shapes agent-service does
// (agent-service/api/app.py): `POST /run` → RunResponse, `GET /run/{id}` and `DELETE /run/{id}` →
// StatusResponse, `GET /run/{id}/events` → SSE frames ending in `done` (`_done_payload`), `POST /route`
// → RouteResponse, and `GET /sessions/{sid}/artifacts/{name}` → the file's bytes.
//
// STATELESS, because a serverless deployment answers the turn and its re-attach from different
// instances. The task id carries the run's start time and the few things the answer needs from the
// prompt, and every read derives the run's state and frames from the time elapsed since that start. A
// run finishes FAKE_RUN_MS after it starts, which outlives `agent_turn_deadline_20s`, so the
// re-attach path (CUR-993) is exercised the way a real long run exercises it.
//
// What it reads from the prompt is two shapes our own specs write, never a judgement about language:
// a `receipt <hex>` line the answer must end with (agent-outlives-the-tab.spec.ts), and "a text file
// named X whose only content is the line: Y" (agent-file-download.spec.ts), which becomes an artifact.
//
// Chosen per request: a new turn uses it when the send carries `x-e2e-agent: fake` behind the
// fault-inject token (faultInjection.ts's resolveFakeAgent, preview/development only); a re-attach, a Stop and a
// download use it when the stored task id is one this module minted. In production every request it
// is handed answers 404, so a fake task id stored by a preview can never be served there.

import { isTestDeployment } from "$lib/chat/server/deployEnv";

/** The base URL endpointAgent uses for the stand-in. `.invalid` never resolves, so a request that
 *  somehow reached the network instead of fakeAgentFetch fails rather than going anywhere. */
export const FAKE_AGENT_BASE = "https://agent-fake.e2e.invalid";

/** How long a fake run takes, start to `done`. Past the 20s turn deadline the re-attach specs force. */
export const FAKE_RUN_MS = 35_000;

const TASK_PREFIX = "fake-";

/** The scenario knobs a send can ask for, after `fake;` in `x-e2e-agent` (faultInjection.ts's
 *  resolveFakeAgent reads the header). `at_capacity` answers `POST /run` with agent-service's 429, and
 *  `daily_limit` with the 429 its per-visitor daily cap sends (CUR-4401). */
export const FAKE_AGENT_KNOBS = ["at_capacity", "daily_limit"] as const;
export type FakeAgentKnob = (typeof FAKE_AGENT_KNOBS)[number];

export type FakeAgentRequest = { knobs: FakeAgentKnob[] };

export function fakeAgentAllowed(): boolean {
	return isTestDeployment();
}

/** What a fake task id carries: start time, the receipt nonce and the file the prompt asked for. */
type FakeRun = {
	/** Epoch ms the run started. */
	t: number;
	/** The nonce of a `receipt <nonce>` line the prompt asked the answer to end with. */
	r?: string;
	/** A file the prompt asked the agent to write. */
	f?: { name: string; text: string };
};

export function isFakeAgentTaskId(taskId: string | undefined): boolean {
	return typeof taskId === "string" && taskId.startsWith(TASK_PREFIX);
}

function encodeFakeTaskId(run: FakeRun): string {
	return TASK_PREFIX + Buffer.from(JSON.stringify(run)).toString("base64url");
}

function decodeFakeTaskId(taskId: string): FakeRun | null {
	if (!isFakeAgentTaskId(taskId)) return null;
	try {
		const run = JSON.parse(Buffer.from(taskId.slice(TASK_PREFIX.length), "base64url").toString("utf8"));
		return typeof run?.t === "number" ? (run as FakeRun) : null;
	} catch {
		return null;
	}
}

const RECEIPT = /\breceipt ([0-9a-f]{6,64})\b/g;
const FILE_ASK = /\bfile named (\S{1,120}) whose only content is the line: ([^\n]{1,200})/;

/** The run a prompt starts at `now`. Reads only the two spec-written shapes named in the header. */
function fakeRunFor(prompt: string, now: number): FakeRun {
	const receipts = [...prompt.matchAll(RECEIPT)];
	const file = prompt.match(FILE_ASK);
	return {
		t: now,
		...(receipts.length ? { r: receipts.at(-1)![1] } : {}),
		...(file ? { f: { name: file[1], text: file[2].trim() } } : {}),
	};
}

type Frame = { at: number; event: string; data: Record<string, unknown> };

function answerFor(run: FakeRun): string {
	const parts = [
		"This answer comes from the scenario suite's stand-in for the agent service, so no model ran.",
		"Shared community meals work because they turn a necessity into a reason to meet, they spread the cost and the work across many hands, and they give newcomers an easy way in.",
	];
	if (run.f) parts.push(`I wrote the file \`${run.f.name}\` with the line you asked for.`);
	// The real agent closes with a summary in this shape, and its answer repeats it after the reasoning
	// block. Longer than loopCut's 60-word window, so every agent scenario reads that repeat (CUR-4105).
	parts.push(
		"**Done:**\n- Read what you sent and worked out the answer above, step by step, before writing it up.\n" +
			"- Kept to the points you asked about, in the order you asked them, with nothing left out on purpose.\n" +
			"**Left:**\nNothing. If you want it shorter, longer, or in another format, say so and I will redo it."
	);
	if (run.r) parts.push(`receipt ${run.r}`);
	return parts.join("\n\n");
}

/** The `done` frame's body, in `_done_payload`'s shape (agent-service/api/app.py). */
function donePayload(run: FakeRun, taskId: string): Record<string, unknown> {
	const artifacts = run.f
		? [{ name: run.f.name, bytes: Buffer.byteLength(`${run.f.text}\n`), text: `${run.f.text}\n`, truncated: false }]
		: [];
	return {
		task_id: taskId,
		state: "COMPLETED",
		result: answerFor(run),
		summary: "completed",
		error: null,
		model: "e2e-fake-agent",
		verified: false,
		verify_method: "",
		verify_autoderived: false,
		verify_check: {},
		judge_reason: "",
		attempt_rejections: [],
		artifacts,
		artifacts_dropped: false,
		expired: false,
		unrun_detail: "",
		session_continued: false,
		session_files_at_start: 0,
		tier: "uniform",
		tasks_done: null,
		tasks_required: null,
		transport_used: "acp",
		machine_id: null,
	};
}

/** Every frame of a run, each stamped with its offset from the start. The last is `done` at FAKE_RUN_MS. */
function fakeRunFrames(run: FakeRun, taskId: string): Frame[] {
	const tool = run.f ? "edit" : "think";
	const answer = answerFor(run);
	const half = Math.ceil(answer.length / 2);
	return [
		{ at: 0, event: "state", data: { task_id: taskId, state: "working" } },
		{ at: 1_000, event: "plan", data: { steps: ["Work out the answer", "Write it up"], attempt: 1 } },
		{ at: 4_000, event: "tool_call", data: { tool, step: 1, attempt: 1 } },
		{ at: 8_000, event: "tool_result", data: { ok: true, step: 1, summary: "step 1 done", attempt: 1 } },
		{ at: 26_000, event: "token", data: { delta: answer.slice(0, half), attempt: 1 } },
		{ at: 30_000, event: "token", data: { delta: answer.slice(half), attempt: 1 } },
		{ at: FAKE_RUN_MS - 500, event: "usage", data: { tokens: 1_234, steps: 2 } },
		{ at: FAKE_RUN_MS, event: "done", data: donePayload(run, taskId) },
	];
}

/** The task's state `elapsedMs` after it started. */
function fakeRunState(elapsedMs: number): "WORKING" | "COMPLETED" {
	return elapsedMs >= FAKE_RUN_MS ? "COMPLETED" : "WORKING";
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const notFound = (detail: string) => json(404, { detail });

function statusOf(run: FakeRun, taskId: string, now: number, canceled = false): Record<string, unknown> {
	const state = canceled && fakeRunState(now - run.t) !== "COMPLETED" ? "CANCELED" : fakeRunState(now - run.t);
	const done = donePayload(run, taskId);
	return {
		...done,
		id: taskId,
		state,
		result: state === "COMPLETED" ? done.result : null,
		result_truncated: false,
		pending_confirmations: [],
		model_calls: 0,
		tokens: 0,
		compute_provider: null,
	};
}

function sseFrame(event: string, data: unknown, seq: number): string {
	return `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The event stream: frames already due go out at once, the rest at their offset, then it closes. */
function eventStream(run: FakeRun, taskId: string, now: () => number, signal?: AbortSignal | null): Response {
	const frames = fakeRunFrames(run, taskId);
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let seq = 0;
			const abort = () => {
				if (timer) clearTimeout(timer);
				try {
					controller.error(new DOMException("The operation was aborted.", "AbortError"));
				} catch {
					// already closed
				}
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			const next = () => {
				while (seq < frames.length && run.t + frames[seq].at <= now()) {
					controller.enqueue(encoder.encode(sseFrame(frames[seq].event, frames[seq].data, seq)));
					seq++;
				}
				if (seq >= frames.length) {
					signal?.removeEventListener("abort", abort);
					controller.close();
					return;
				}
				timer = setTimeout(next, Math.max(0, run.t + frames[seq].at - now()));
			};
			next();
		},
		cancel() {
			if (timer) clearTimeout(timer);
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	});
}

/**
 * Answers one agent-service request. Dispatches on method and path only, so it does not matter which
 * base URL the caller built. `now` is injectable for tests.
 */
export async function fakeAgentFetch(
	input: string | URL | Request,
	init: RequestInit & { knobs?: FakeAgentKnob[] } = {},
	now: () => number = Date.now
): Promise<Response> {
	if (!fakeAgentAllowed()) return notFound("Not Found");
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const path = url.pathname.replace(/\/+$/, "");

	if (method === "POST" && path.endsWith("/run")) {
		if (init.knobs?.includes("at_capacity"))
			return json(429, { detail: "server at capacity (4 concurrent runs) — retry shortly" });
		if (init.knobs?.includes("daily_limit"))
			return json(429, { detail: "per-visitor task limit reached (25 per 86400s)" });
		const body = JSON.parse(String(init.body ?? "{}")) as { prompt?: string };
		const prompt = (body.prompt ?? "").trim();
		if (!prompt) return json(400, { detail: "empty prompt" });
		const id = encodeFakeTaskId(fakeRunFor(prompt, now()));
		return json(200, { id, state: "SUBMITTED", machine_id: null });
	}

	if (method === "POST" && path.endsWith("/route")) {
		return json(200, { agentic: false, reason: "direct (scenario stand-in)", source: "model", model: "e2e-fake-agent", backend: null, api: 1 });
	}

	const runMatch = path.match(/\/run\/([^/]+)(\/events)?$/);
	if (runMatch) {
		const taskId = decodeURIComponent(runMatch[1]);
		const run = decodeFakeTaskId(taskId);
		if (!run) return notFound("no such task");
		if (runMatch[2] && method === "GET") return eventStream(run, taskId, now, init.signal);
		if (!runMatch[2] && method === "GET") return json(200, statusOf(run, taskId, now()));
		if (!runMatch[2] && method === "DELETE") return json(200, statusOf(run, taskId, now(), true));
		return json(405, { detail: "Method Not Allowed" });
	}

	return notFound("Not Found");
}

/**
 * A file a fake run wrote, for the artifact download route: its bytes when `taskId` is a fake run that
 * wrote `filename` and has finished, else null (the route's own 404). Production always gets null.
 */
export function fakeAgentArtifact(taskId: string, filename: string, now: number = Date.now()): string | null {
	if (!fakeAgentAllowed()) return null;
	const run = decodeFakeTaskId(taskId);
	if (!run?.f || run.f.name !== filename || fakeRunState(now - run.t) !== "COMPLETED") return null;
	return `${run.f.text}\n`;
}
