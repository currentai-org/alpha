// A stand-in for agent-service, answered inside this deployment, so a scenario run's agent turns never
// queue on a shared agent-service. That service runs a fixed number of tasks at once
// (AGENT_MAX_CONCURRENCY), so parallel shards would otherwise refuse each other at capacity.
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
// re-attach path is exercised the way a real long run exercises it.
//
// One run shape holds state outside the task id: `confirm_after_handoff` opens an approval
// card after the first request has handed the run off, and the person's answer to it has to reach
// whichever instance serves the next read. The answer is a row in the chat database (FakeConfirmStore),
// and every read derives the rest of the run from when that row was written.
//
// What it reads from the prompt is two shapes our own specs write, never a judgement about language:
// a `receipt <hex>` line the answer must end with (agent-outlives-the-tab.spec.ts), and "a text file
// named X whose only content is the line: Y" (agent-file-download.spec.ts), which becomes an artifact.
//
// Chosen per request: a new turn uses it when the send carries `x-e2e-agent: fake` behind the
// fault-inject token (faultInjection.ts's resolveFakeAgent, preview/development only); a re-attach, a Stop and a
// download use it when the stored task id is one this module minted. In production every request it
// is handed answers 404, so a fake task id stored by a preview can never be served there.

import { randomBytes } from "node:crypto";
import { isTestDeployment } from "$lib/chat/server/deployEnv";

/** The base URL endpointAgent uses for the stand-in. `.invalid` never resolves, so a request that
 *  somehow reached the network instead of fakeAgentFetch fails rather than going anywhere. */
export const FAKE_AGENT_BASE = "https://agent-fake.e2e.invalid";

/** How long a fake run takes, start to `done`. Past the 20s turn deadline the re-attach specs force. */
export const FAKE_RUN_MS = 35_000;

const TASK_PREFIX = "fake-";

/** The scenario knobs a send can ask for, after `fake;` in `x-e2e-agent` (faultInjection.ts's
 *  resolveFakeAgent reads the header). `at_capacity` answers `POST /run` with agent-service's 429, and
 *  `daily_limit` with the 429 its per-visitor daily cap sends. `confirm_after_handoff`
 *  pauses the run on an approval card at FAKE_CONFIRM_AT_MS, past the first request's handoff under a
 *  20s turn deadline, and finishes it only once the card is answered. `workdir_cleared`
 *  plays the workdir being gone by the time anyone downloads: the turn still saves the file from the
 *  `done` frame's inlined text, and the download route then finds nothing for it here, so only the saved
 *  copy can answer. */
export const FAKE_AGENT_KNOBS = ["at_capacity", "daily_limit", "confirm_after_handoff", "workdir_cleared"] as const;
export type FakeAgentKnob = (typeof FAKE_AGENT_KNOBS)[number];

export type FakeAgentRequest = { knobs: FakeAgentKnob[] };

/** When a `confirm_after_handoff` run opens its approval card, measured from its start. */
const FAKE_CONFIRM_AT_MS = 25_000;
/** How long the card waits for an answer before it times out to deny, as agent-service's does. */
const FAKE_CONFIRM_TIMEOUT_MS = 120_000;
/** How long after the card's answer the run finishes. */
const AFTER_ANSWER_DONE_MS = 6_000;

/** An answer to a fake run's approval card, and when it was given (epoch ms). */
type FakeConfirmAnswer = { decision: "allow" | "deny"; at: number; reason?: string };

/** Where the answers to fake approval cards live, so any instance can read one. */
export interface FakeConfirmStore {
	read(confirmId: string): Promise<FakeConfirmAnswer | null>;
	/** Records the first answer. False when the card was already answered. */
	write(confirmId: string, decision: "allow" | "deny", at: number): Promise<boolean>;
}

const confirmKey = (confirmId: string) => `e2e.fake-agent-confirm.${confirmId}`;

/** The chat database's `semaphores` rows: `key` is unique, so a second answer to one card is refused. */
const dbFakeConfirmStore: FakeConfirmStore = {
	async read(confirmId) {
		const { collections } = await import("$lib/chat/server/database");
		const doc = (await collections.semaphores.findOne({ key: confirmKey(confirmId) } as never)) as {
			decision?: unknown;
			createdAt?: Date | string;
		} | null;
		if (!doc || (doc.decision !== "allow" && doc.decision !== "deny") || !doc.createdAt) return null;
		return { decision: doc.decision, at: new Date(doc.createdAt).getTime() };
	},
	async write(confirmId, decision, at) {
		const [{ collections }, { ObjectId }] = await Promise.all([
			import("$lib/chat/server/database"),
			import("bson"),
		]);
		try {
			await collections.semaphores.insertOne({
				_id: new ObjectId(),
				key: confirmKey(confirmId),
				decision,
				createdAt: new Date(at),
				updatedAt: new Date(at),
				deleteAt: new Date(at + 24 * 60 * 60 * 1000),
			} as never);
			return true;
		} catch {
			return false;
		}
	},
};

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
	/** `confirm_after_handoff`: the nonce naming this run's approval card. */
	c?: string;
	/** `workdir_cleared`: the run's workdir holds nothing by the time its file is downloaded. */
	g?: true;
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
function fakeRunFor(prompt: string, now: number, knobs: FakeAgentKnob[] = []): FakeRun {
	const receipts = [...prompt.matchAll(RECEIPT)];
	const file = prompt.match(FILE_ASK);
	return {
		t: now,
		...(receipts.length ? { r: receipts.at(-1)![1] } : {}),
		...(file ? { f: { name: file[1], text: file[2].trim() } } : {}),
		...(knobs.includes("confirm_after_handoff") ? { c: randomBytes(6).toString("hex") } : {}),
		...(knobs.includes("workdir_cleared") ? { g: true as const } : {}),
	};
}

/** The confirm id of a `confirm_after_handoff` run's approval card. */
function confirmIdOf(run: FakeRun): string | undefined {
	return run.c ? `fake-confirm-${run.c}` : undefined;
}

/** The card's answer as of `now`: the stored one, or a timed-out deny once its window has passed. */
async function confirmAnswerOf(
	run: FakeRun,
	now: number,
	store: FakeConfirmStore
): Promise<FakeConfirmAnswer | null> {
	const confirmId = confirmIdOf(run);
	if (!confirmId) return null;
	const stored = await store.read(confirmId);
	if (stored) return { ...stored, at: Math.max(stored.at, run.t + FAKE_CONFIRM_AT_MS) };
	const timeoutAt = run.t + FAKE_CONFIRM_AT_MS + FAKE_CONFIRM_TIMEOUT_MS;
	return now >= timeoutAt ? { decision: "deny", at: timeoutAt, reason: "timeout" } : null;
}

/** When the run finishes, measured from its start: FAKE_RUN_MS, or for a run paused on a card, a few
 *  seconds after its answer, and never while it is unanswered. */
function runEndMs(run: FakeRun, confirmAnswer: FakeConfirmAnswer | null): number {
	if (!run.c) return FAKE_RUN_MS;
	return confirmAnswer ? confirmAnswer.at - run.t + AFTER_ANSWER_DONE_MS : Number.POSITIVE_INFINITY;
}

type Frame = { at: number; event: string; data: Record<string, unknown> };

function answerFor(run: FakeRun): string {
	const parts = [
		"This answer comes from the scenario suite's stand-in for the agent service, so no model ran.",
		"Shared community meals work because they turn a necessity into a reason to meet, they spread the cost and the work across many hands, and they give newcomers an easy way in.",
	];
	if (run.f) parts.push(`I wrote the file \`${run.f.name}\` with the line you asked for.`);
	// The real agent closes with a summary in this shape, and its answer repeats it after the reasoning
	// block. Longer than loopCut's 60-word window, so every agent scenario reads that repeat.
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

/** Every frame of a run, each stamped with its offset from the start. The last is `done` at FAKE_RUN_MS,
 *  or for a run paused on a card, AFTER_ANSWER_DONE_MS after the card's answer; until it is answered the
 *  list ends on the card. */
function fakeRunFrames(run: FakeRun, taskId: string, confirmAnswer: FakeConfirmAnswer | null = null): Frame[] {
	const tool = run.f ? "edit" : "think";
	const answer = answerFor(run);
	const half = Math.ceil(answer.length / 2);
	const confirmId = confirmIdOf(run);
	if (confirmId) {
		const frames: Frame[] = [
			{ at: 0, event: "state", data: { task_id: taskId, state: "working" } },
			{ at: 1_000, event: "plan", data: { steps: ["Work out the answer", "Write it up"], attempt: 1 } },
			{ at: 4_000, event: "tool_call", data: { tool, step: 1, attempt: 1 } },
			{ at: 8_000, event: "tool_result", data: { ok: true, step: 1, summary: "step 1 done", attempt: 1 } },
			{
				at: FAKE_CONFIRM_AT_MS,
				event: "awaiting_confirmation",
				data: {
					confirm_id: confirmId,
					kind: "edit",
					title: "Write notes.md",
					summary: "notes.md",
					plain: "save a file named notes.md",
					timeout_secs: FAKE_CONFIRM_TIMEOUT_MS / 1000,
				},
			},
		];
		if (!confirmAnswer) return frames;
		const at = confirmAnswer.at - run.t;
		return [
			...frames,
			{
				at,
				event: "confirm_result",
				data: { confirm_id: confirmId, decision: confirmAnswer.decision, reason: confirmAnswer.reason ?? "" },
			},
			{ at: at + 1_000, event: "token", data: { delta: answer.slice(0, half), attempt: 1 } },
			{ at: at + 3_000, event: "token", data: { delta: answer.slice(half), attempt: 1 } },
			{ at: at + AFTER_ANSWER_DONE_MS - 500, event: "usage", data: { tokens: 1_234, steps: 2 } },
			{ at: at + AFTER_ANSWER_DONE_MS, event: "done", data: donePayload(run, taskId) },
		];
	}
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

/** The task's state `elapsedMs` after it started, for a run that ends `endMs` after its start. */
function fakeRunState(elapsedMs: number, endMs: number = FAKE_RUN_MS): "WORKING" | "COMPLETED" {
	return elapsedMs >= endMs ? "COMPLETED" : "WORKING";
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const notFound = (detail: string) => json(404, { detail });

function statusOf(
	run: FakeRun,
	taskId: string,
	now: number,
	canceled = false,
	endMs: number = FAKE_RUN_MS
): Record<string, unknown> {
	const finished = fakeRunState(now - run.t, endMs);
	const state = canceled && finished !== "COMPLETED" ? "CANCELED" : finished;
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

/** How often a stream paused on an unanswered card looks for the answer. */
const CONFIRM_POLL_MS = 1_000;

/** The event stream: frames already due go out at once, the rest at their offset, then it closes. A run
 *  paused on an unanswered card keeps the stream open and looks for the answer every CONFIRM_POLL_MS. */
function eventStream(
	run: FakeRun,
	taskId: string,
	now: () => number,
	signal: AbortSignal | null | undefined,
	store: FakeConfirmStore
): Response {
	let frames = fakeRunFrames(run, taskId);
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ended = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let seq = 0;
			const abort = () => {
				ended = true;
				if (timer) clearTimeout(timer);
				try {
					controller.error(new DOMException("The operation was aborted.", "AbortError"));
				} catch {
					// already closed
				}
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			const next = async () => {
				// Only a run paused on a card awaits here; any other run enqueues its due frames synchronously.
				if (run.c) frames = fakeRunFrames(run, taskId, await confirmAnswerOf(run, now(), store));
				if (ended) return;
				while (seq < frames.length && run.t + frames[seq].at <= now()) {
					controller.enqueue(encoder.encode(sseFrame(frames[seq].event, frames[seq].data, seq)));
					seq++;
				}
				if (seq >= frames.length && frames.at(-1)?.event === "done") {
					ended = true;
					signal?.removeEventListener("abort", abort);
					controller.close();
					return;
				}
				const wait = seq < frames.length ? Math.max(0, run.t + frames[seq].at - now()) : CONFIRM_POLL_MS;
				timer = setTimeout(() => void next(), run.c ? Math.min(wait, CONFIRM_POLL_MS) : wait);
			};
			void next();
		},
		cancel() {
			ended = true;
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
	now: () => number = Date.now,
	store: FakeConfirmStore = dbFakeConfirmStore
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
		const id = encodeFakeTaskId(fakeRunFor(prompt, now(), init.knobs));
		return json(200, { id, state: "SUBMITTED", machine_id: null });
	}

	if (method === "POST" && path.endsWith("/route")) {
		return json(200, { agentic: false, reason: "direct (scenario stand-in)", source: "model", model: "e2e-fake-agent", backend: null, api: 1 });
	}

	const confirmMatch = path.match(/\/run\/([^/]+)\/confirm$/);
	if (confirmMatch) {
		// agent-service's `POST /run/{id}/confirm`: 404 for a card it never opened, 409 once answered.
		if (method !== "POST") return json(405, { detail: "Method Not Allowed" });
		const run = decodeFakeTaskId(decodeURIComponent(confirmMatch[1]));
		const body = JSON.parse(String(init.body ?? "{}")) as { confirm_id?: string; decision?: string };
		const confirmId = run ? confirmIdOf(run) : undefined;
		if (!run || !confirmId || body.confirm_id !== confirmId) return notFound("no such confirmation");
		if (body.decision !== "allow" && body.decision !== "deny") return json(422, { detail: "bad decision" });
		if (await confirmAnswerOf(run, now(), store)) return json(409, { detail: "already resolved" });
		if (!(await store.write(confirmId, body.decision, now()))) return json(409, { detail: "already resolved" });
		return json(200, { ok: true });
	}

	const runMatch = path.match(/\/run\/([^/]+)(\/events)?$/);
	if (runMatch) {
		const taskId = decodeURIComponent(runMatch[1]);
		const run = decodeFakeTaskId(taskId);
		if (!run) return notFound("no such task");
		if (runMatch[2] && method === "GET") return eventStream(run, taskId, now, init.signal, store);
		const endMs = runEndMs(run, await confirmAnswerOf(run, now(), store));
		if (!runMatch[2] && method === "GET") return json(200, statusOf(run, taskId, now(), false, endMs));
		if (!runMatch[2] && method === "DELETE") return json(200, statusOf(run, taskId, now(), true, endMs));
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
	if (!run?.f || run.g || run.f.name !== filename || fakeRunState(now - run.t) !== "COMPLETED") return null;
	return `${run.f.text}\n`;
}
