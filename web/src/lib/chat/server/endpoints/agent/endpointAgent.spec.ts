import { MY_FILES_FACT } from "$lib/chat/server/textGeneration/persona";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { marked } from "marked";
import { sha256 } from "$lib/chat/utils/sha256";
import { logger } from "$lib/chat/server/logger";
import { AGENT_HANDOFF_WALL_CLOCK_SECS, AGENT_SERVICE_WALL_CLOCK_SECS } from "$lib/chat/utils/deadlineLadder";
import {
	endpointAgent,
	buildTaskPrompt,
	agentIdentityPreamble,
	deriveAgentSubject,
	agentServiceHeaders,
	renderArtifacts,
	claimedStepsWithoutObservedTools,
	claimedActionOnContinuedSession,
	editedCodeArtifact,
	wroteCodeWithoutRunningIt,
	sessionHadSomethingToMeasure,
	noticeForCaveat,
	UNRUN_CODE_NOTICE,
	UNOBSERVED_ACTION_NOTICE,
	STRUCTURAL_FAILURE_NOTICE,
	partialRunAnswer,
	AGENT_HANDOFF_TEXT,
} from "./endpointAgent";
import { GenerationWatchdogAbort } from "$lib/chat/server/chat/generationDeadline";
import { agentConfirmOpened, agentConfirmResolved } from "$lib/chat/messageProvenance";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";

// The daily allowance reads chat's database; these tests set its answer rather than reach one. (CUR-4401)
const allowance = vi.hoisted(() => ({
	room: vi.fn(async (): Promise<{ ok: true } | { ok: false; retryAfterSecs: number | null }> => ({ ok: true })),
	record: vi.fn(async () => {}),
}));
vi.mock("$lib/chat/server/db/agentTaskAllowance", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/db/agentTaskAllowance")>()),
	agentTaskRoom: allowance.room,
	recordAgentTask: allowance.record,
}));

// Auto mode is read from the person's "Ask before every step" setting; tests set its answer.
const autoApprove = vi.hoisted(() => ({ on: vi.fn(async () => false) }));
vi.mock("$lib/chat/server/agentConfirmUi", () => ({ agentAutoApproveFor: autoApprove.on }));

// `agent-run-handoff`, off unless a test turns it on. (CUR-4410)
const handoffFlag = vi.hoisted(() => ({ on: false }));
vi.mock("$lib/chat/server/agentRunHandoffGate", () => ({ agentRunHandoffEnabled: () => handoffFlag.on }));

describe("agent auto mode (CUR-3142)", () => {
	async function run(frames: string[]) {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			void init;
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "make me a budget" }],
		} as Parameters<typeof factory>[0]);
		const chunks: { token: { text: string }; agentConfirm?: { plain?: string; summary: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		const submit = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/run"));
		const body = JSON.parse(String((submit?.[1] as RequestInit).body));
		return { chunks, body, text: chunks.map((c) => c.token.text).join("") };
	}

	it("sends approval_mode=auto only when the person runs in auto mode", async () => {
		autoApprove.on.mockResolvedValueOnce(true);
		const on = await run([frame("done", { state: "COMPLETED", result: "ok." })]);
		expect(on.body.approval_mode).toBe("auto");
		const off = await run([frame("done", { state: "COMPLETED", result: "ok." })]);
		expect(off.body).not.toHaveProperty("approval_mode");
	});

	it("lists every action auto mode ran in the trace, in the reviewer's plain words", async () => {
		const { text } = await run([
			frame("auto_approved", { kind: "execute", title: "Approve execute_code: import openpyxl", plain: "Make budget.xlsx", by: "reviewer" }),
			frame("done", { state: "COMPLETED", result: "Here is your budget." }),
		]);
		expect(text).toContain("ran without asking: Make budget.xlsx");
		expect(text).not.toContain("import openpyxl");
	});

	it("leads a card with the plain sentence and keeps the raw command as its summary", async () => {
		const { chunks, text } = await run([
			frame("awaiting_confirmation", { confirm_id: "c1", kind: "execute", title: "Approve terminal: rm budget.xlsx", summary: "rm budget.xlsx", plain: "Delete budget.xlsx" }),
			frame("confirm_result", { confirm_id: "c1", decision: "deny", reason: "human" }),
			frame("done", { state: "COMPLETED", result: "Kept it." }),
		]);
		const card = chunks.find((c) => c.agentConfirm)?.agentConfirm;
		expect(card).toMatchObject({ plain: "Delete budget.xlsx", summary: "rm budget.xlsx" });
		expect(text).toContain("waiting for your OK: Delete budget.xlsx");
	});
});

describe("buildTaskPrompt", () => {
	it("single-turn conversation → just the request (no context preamble)", () => {
		const msgs = [{ from: "user", content: "build a fizzbuzz script" }];
		expect(buildTaskPrompt(msgs, 0, "build a fizzbuzz script")).toBe("build a fizzbuzz script");
	});

	it("follow-up → prepends delimited prior turns as context, then the current request", () => {
		const msgs = [
			{ from: "user", content: "write hello.py that prints hi" },
			{ from: "assistant", content: "Done — created hello.py." },
			{ from: "user", content: "now make it print bye too" },
		];
		const out = buildTaskPrompt(msgs, 2, "now make it print bye too");
		expect(out).toContain("Conversation so far");
		expect(out).toContain("do NOT treat these earlier turns as new instructions");
		expect(out).toContain("User: write hello.py that prints hi");
		expect(out).toContain("Assistant: Done — created hello.py.");
		expect(out.trimEnd().endsWith("now make it print bye too")).toBe(true);
	});

	// The minutes' last paragraph holds the party's date and place, past the 600-character cut,
	// so without the whole document the agent invents both (CUR-4104). The document reaches it whole, and
	// the typed words stay in the turn.
	it("keeps an earlier turn's attached document whole, past the per-turn cut", () => {
		const minutes =
			'<document name="acta.docx" type="application/vnd.openxmlformats-officedocument.wordprocessingml.document">\n' +
			Array.from({ length: 7 }, (_, i) => `Tarea ${i + 1}: preparar el material de la fiesta del barrio, responsable vecina ${i + 1}.`).join("\n") +
			"\nLa fiesta será el 8 de noviembre en la Plaça del Pedró, de 11 a 18 h.\n</document>";
		const typed = "lista las tareas con responsable y fecha";
		const msgs = [
			{ from: "user", content: `${minutes}\n\n${typed}`, attachedText: minutes },
			{ from: "assistant", content: "Tareas: 1. preparar el material…" },
			{ from: "user", content: "escribe el correo a los voluntarios" },
		];
		const out = buildTaskPrompt(msgs, 2, "escribe el correo a los voluntarios");
		expect(minutes.length).toBeGreaterThan(600);
		expect(out).toContain("8 de noviembre en la Plaça del Pedró, de 11 a 18 h");
		expect(out).toContain(`User: ${typed}`);
		expect(out.trimEnd().endsWith("escribe el correo a los voluntarios")).toBe(true);
	});

	it("keeps the newest earlier attachment when they exceed the attachment budget, and says it cut one", () => {
		const old = `<document name="old.txt">\n${"a".repeat(59_000)}\n</document>`;
		const recent = `<document name="recent.txt">\n${"b".repeat(5_000)}\n</document>`;
		const msgs = [
			{ from: "user", content: `${old}\n\nfirst`, attachedText: old },
			{ from: "assistant", content: "ok" },
			{ from: "user", content: `${recent}\n\nsecond`, attachedText: recent },
			{ from: "assistant", content: "ok" },
			{ from: "user", content: "now" },
		];
		const out = buildTaskPrompt(msgs, 4, "now");
		expect(out).toContain(recent);
		expect(out).toContain("(the rest of this file was left out)");
		expect(out.length).toBeLessThan(100_000);
	});

	// The current turn's files are sent uncut, so the earlier ones get only what is left of the service's
	// 100,000-character limit: two 50,000-character files on consecutive turns must not make a refused prompt.
	it("shrinks the earlier-attachment budget to what the current turn leaves under the service's prompt limit", () => {
		const old = `<document name="old.txt">\n${"a".repeat(50_000)}\n</document>`;
		const current = `<document name="new.txt">\n${"c".repeat(50_000)}\n</document>\n\ncompare them`;
		const msgs = [
			{ from: "user", content: `${old}\n\nread this`, attachedText: old },
			{ from: "assistant", content: "ok" },
			{ from: "user", content: current },
		];
		const out = buildTaskPrompt(msgs, 2, current, "identity line");
		expect(out.length).toBeLessThanOrEqual(100_000);
		expect(out).toContain("(the rest of this file was left out)");
		expect(out.trimEnd().endsWith("compare them")).toBe(true);
	});

	it("bounds context to the most recent turns", () => {
		const msgs = Array.from({ length: 20 }, (_, i) => ({
			from: i % 2 === 0 ? "user" : "assistant",
			content: `turn ${i}`,
		}));
		const out = buildTaskPrompt(msgs, 18, "turn 18");
		expect(out).not.toContain("turn 0"); // oldest dropped (cap = 6 prior turns)
		expect(out).toContain("turn 17"); // newest prior kept
	});

	// The /run wire has one `prompt` field, no separate system-prompt slot, so the identity
	// preamble (see agentIdentityPreamble below) has to be prepended here; without it the model answers
	// "who are you" from its own pretrained priors (CUR-573).
	it("prepends the identity preamble when present, single-turn", () => {
		const msgs = [{ from: "user", content: "who are you?" }];
		const out = buildTaskPrompt(msgs, 0, "who are you?", "You are potluck agent, an open model.");
		expect(out).toBe("You are potluck agent, an open model.\n\nwho are you?");
	});

	it("prepends the identity preamble ahead of the delimited conversation context", () => {
		const msgs = [
			{ from: "user", content: "write hello.py that prints hi" },
			{ from: "assistant", content: "Done — created hello.py." },
			{ from: "user", content: "now make it print bye too" },
		];
		const out = buildTaskPrompt(
			msgs,
			2,
			"now make it print bye too",
			"You are potluck agent, an open model."
		);
		expect(out.startsWith("You are potluck agent, an open model.\n\nConversation so far")).toBe(true);
	});

	it("omits the preamble block entirely when unset or blank", () => {
		const msgs = [{ from: "user", content: "who are you?" }];
		expect(buildTaskPrompt(msgs, 0, "who are you?")).toBe("who are you?");
		expect(buildTaskPrompt(msgs, 0, "who are you?", "   ")).toBe("who are you?");
	});

	// A system prompt or Personalization asking for emoji got an agent answer with none. (CUR-4088)
	it("carries the visitor's own instructions after the identity line and before the task", () => {
		const msgs = [{ from: "user", content: "summarise this" }];
		const out = buildTaskPrompt(msgs, 0, "summarise this", "IDENTITY", "Answer with lots of emoji.");
		expect(out).toContain("Answer with lots of emoji.");
		expect(out.indexOf("IDENTITY")).toBeLessThan(out.indexOf("Answer with lots of emoji."));
		expect(out.trimEnd().endsWith("summarise this")).toBe(true);
	});

	it("caps the visitor's instructions at the length the input guard screens", () => {
		const msgs = [{ from: "user", content: "hi" }];
		const out = buildTaskPrompt(msgs, 0, "hi", undefined, "a".repeat(9000) + "TAIL");
		expect(out).not.toContain("TAIL");
		expect(out).toContain("a".repeat(8000));
	});
});

describe("agentIdentityPreamble", () => {
	// The agent half of "which of my files can you read", answered from nowhere. (CUR-4052)
	it("tells the agent it cannot see My files, in the same words the chat persona uses", () => {
		expect(agentIdentityPreamble("potluck-agent")).toContain(MY_FILES_FACT);
	});

	// With no identity text at all, the model names a maker from its own pretrained priors (CUR-573).
	// This is deliberately NOT the full conversational
	// persona (buildPersonaPrompt) — see the doc comment on agentIdentityPreamble for why gluing that
	// template's few-shot dialogue onto a task prompt is its own hazard.
	it("names an honest, generic identity for the agent's own model id — never a real-world company", () => {
		const out = agentIdentityPreamble("potluck-agent");
		expect(out).toContain("potluck agent");
		expect(out).toContain("an open source community");
		expect(out).not.toMatch(/nous research/i);
	});

	it("derives from resolveModelIdentity — a served id containing a real maker name resolves to it", () => {
		// Same authority persona.ts uses, so if the agent backend is ever ACTUALLY reported as an
		// Apertus checkpoint, this reflects that honestly rather than staying stuck on the generic
		// fallback — resolveModelIdentity itself is covered elsewhere; this only proves the wiring.
		const out = agentIdentityPreamble("swiss-ai/Apertus-70B-Instruct-2509");
		expect(out).toContain("Apertus 70B");
		expect(out).toContain("Swiss National AI Institute");
	});

	// Asked what it can do, the model recited its raw tool schema (terminal(), read_file,
	// search_files...) instead of the jobs those tools accomplish. The /run wire has one prompt field
	// and no separate system-prompt slot, so this instruction has to live in the same preamble as the
	// identity line above — there's nowhere else for it to reach the model. (CUR-594)
	it("instructs plain-language capability descriptions, not tool/function names", () => {
		const out = agentIdentityPreamble("potluck-agent");
		expect(out).toMatch(/plain task language/i);
		expect(out).toMatch(/function, tool, method, or API/i);
	});

	// This preamble is the agent path's only prompt slot (no separate system prompt, see
	// buildTaskPrompt), and unlike persona.ts's non-agent prose it needs its own language instruction: without
	// one a Portuguese task is answered in English with the agent on. (CUR-706)
	it("instructs the model to reply in the user's language", () => {
		const out = agentIdentityPreamble("potluck-agent");
		expect(out).toMatch(/reply in the user's language/i);
	});

	// The agent ignores `preprompt` (CUR-542), so a fixed answer language from settings can
	// only reach it through this preamble. With none, the preamble is today's, byte for byte.
	// The literal is the preamble as it stood before the parameter existed, typed out rather than
	// rebuilt from the function under test, so a wording change cannot pass by matching itself. (CUR-3929)
	const PREAMBLE_BEFORE_THE_PARAMETER = `If asked who you are or who made you, answer honestly: you are potluck agent, developed by an open source community, answering inside AI Potluck, a chat app that Current AI runs; Current AI did not build you and does not run you. Never claim a different name or maker. If asked what you can do, describe it in plain task language — "read and summarize a document," "run a script and check its output" — never by naming a function, tool, method, or API. Reply in the user's language (default English) — a task written in Portuguese, German, or any other language gets its answer in that language, not English. ${MY_FILES_FACT}`;

	it("is byte-identical with no fixed language to the preamble before the parameter existed", () => {
		expect(agentIdentityPreamble("potluck-agent")).toBe(PREAMBLE_BEFORE_THE_PARAMETER);
		expect(agentIdentityPreamble("potluck-agent", undefined)).toBe(PREAMBLE_BEFORE_THE_PARAMETER);
	});

	it("names the fixed language in its reply-language sentence and drops the default-English phrase", () => {
		const out = agentIdentityPreamble("potluck-agent", "pt");
		expect(out.endsWith(`Reply in Portuguese, whatever language the task is written in. ${MY_FILES_FACT}`)).toBe(true);
		expect(out).not.toContain("(default English)");
		expect(out).not.toMatch(/reply in the user's language/i);
		// The identity half is unchanged.
		expect(out.startsWith("If asked who you are or who made you, answer honestly: you are potluck agent")).toBe(true);
	});

	it("reaches the task prompt through buildTaskPrompt", () => {
		const msgs = [{ from: "user", content: "resume em três linhas" }];
		const out = buildTaskPrompt(msgs, 0, "resume em três linhas", agentIdentityPreamble("potluck-agent", "pt"));
		expect(out).toContain("Reply in Portuguese");
		expect(out.endsWith("resume em três linhas")).toBe(true);
	});
});

describe("renderArtifacts", () => {
	it("wraps a file containing ``` in a fence that file cannot close", async () => {
		// Agents write markdown, and markdown holds fences. A 3-backtick wrapper around a file that
		// itself contains ``` ends the block on the file's OWN fence and spills the remainder as prose —
		// the CUR-227 failure from the other side, where there a marker broke someone else's fence and
		// here the content breaks its own. Judged through the real marked, because the claim is about
		// what the reader sees.
		const body = "Intro.\n\n```python\nprint(1)\n```\n\nOutro.\n";
		const out = renderArtifacts([{ name: "README.md", bytes: 44, text: body }], false, "", undefined);
		const html = await marked.parse(out);
		const inCode = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1]).join("");
		expect(inCode).toContain("Outro."); // the whole file is inside the block…
		expect(out).not.toContain("Files this turn produced\n\n```markdown"); // …via a longer fence
	});

	it("names a file the answer already quoted instead of pasting it twice", () => {
		const text = "print('hi')\n";
		const out = renderArtifacts(
			[{ name: "hi.py", bytes: 12, text }],
			false,
			`Here it is:\n\n${text}`,
			undefined
		);
		expect(out).toContain("shown above");
		expect(out).not.toContain("print('hi')");
	});

	it("re-shows a file the answer only partly quoted", () => {
		// Containment is exact, so a partial paste re-renders. That errs toward putting the real bytes
		// in front of the reader, which is the direction this whole feature exists to move.
		const out = renderArtifacts(
			[{ name: "hi.py", bytes: 40, text: "print('hi')\nprint('bye')\n" }],
			false,
			"Here it is:\n\nprint('hi')\n",
			undefined
		);
		expect(out).toContain("print('bye')");
	});

	it("names an oversized file with its true size rather than pasting it", () => {
		const out = renderArtifacts(
			[{ name: "big.csv", bytes: 900_000, text: "x".repeat(60_000) }],
			false,
			"",
			undefined
		);
		expect(out).toContain("900,000 bytes");
		expect(out).toContain("too large to show here");
		expect(out).not.toContain("xxxxx");
	});

	it("reports a file it was sent no text for by size alone", () => {
		const out = renderArtifacts(
			[{ name: "chart.png", bytes: 8_120, text: null, truncated: true }],
			false,
			"",
			undefined
		);
		expect(out).toContain("chart.png");
		expect(out).toContain("8,120 bytes");
		expect(out).toContain("not shown");
	});

	it("says so when the service withheld files", () => {
		const out = renderArtifacts([{ name: "a.txt", bytes: 2, text: "a\n" }], true, "", undefined);
		expect(out).toContain("more files than are listed");
	});

	it("returns nothing at all for no artifacts", () => {
		expect(renderArtifacts([], false, "answer", undefined)).toBe("");
	});

	// A live session turns the bare filename into a real download link. (CUR-546)
	it("links each filename to a download href, keyed by name, when a live session exists", () => {
		const out = renderArtifacts(
			[{ name: "notes.txt", bytes: 5, text: "hello" }],
			false,
			"",
			"/chat/conversation/abc123/agent-artifact"
		);
		expect(out).toContain("[`notes.txt`](/chat/conversation/abc123/agent-artifact/notes.txt)");
		expect(out).toContain("Available to download for about four hours after this conversation's last agent turn.");
	});

	it("encodes each path segment of a nested artifact name in the download href", () => {
		const out = renderArtifacts(
			[{ name: "sub dir/report.csv", bytes: 5, text: "a,b\n1,2\n" }],
			false,
			"",
			"/chat/conversation/abc123/agent-artifact"
		);
		expect(out).toContain(
			"[`sub dir/report.csv`](/chat/conversation/abc123/agent-artifact/sub%20dir/report.csv)"
		);
	});

	it("renders no link and no availability line when there's no live session", () => {
		const out = renderArtifacts([{ name: "notes.txt", bytes: 5, text: "hello" }], false, "", undefined);
		expect(out).not.toContain("](");
		expect(out).not.toContain("Available to download");
	});
});

// Pure unit test for the agent endpoint's SSE→chunk translation (no network). Complements the live spec
// (which auto-skips in CI): this one locks the contract chat-ui's generate.ts depends on — provenance
// chunk, a streamed <think> block, per-step lines, and a terminal generated_text carrying the answer.

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const f of frames) controller.enqueue(enc.encode(f));
			controller.close();
		},
	});
}

const frame = (event: string, data: unknown) =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

afterEach(() => vi.unstubAllGlobals());

describe("endpointAgent (unit, mocked agent service)", () => {
	it("submits with synthesize:true and translates the SSE stream into chat-ui chunks", async () => {
		const frames = [
			frame("state", { state: "working" }),
			frame("plan", { attempt: 1, steps: ["tool", "write"] }),
			frame("tool_call", { tool: "tool", step: 0 }),
			frame("tool_result", { ok: true, step: 0, summary: "5 bytes" }),
			frame("tool_call", { tool: "write", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "2 bytes" }),
			// A real agent-service `done` frame carries the model that actually served (agent-service 5fe24ff);
			// endpointAgent corrects the badge from it (line ~322). The mock must send one too, else the badge
			// falls to the intentional ""-default (no hardcoded brand in source) and routerMetadata.model stays unset.
			frame("done", {
				state: "COMPLETED",
				result: "There are 3 files.",
				verified: false,
				model: "swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO",
			}),
		];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/run")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			}
			if (u.includes("/run/t1/events")) {
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			}
			throw new Error(`unexpected url ${u} ${init?.method ?? ""}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "how many files?" }],
		} as Parameters<typeof factory>[0]);

		const chunks: {
			token: { text: string };
			generated_text: string | null;
			routerMetadata?: { model?: string };
			agentStep?: { index: number; tool: string; total?: number };
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		// submit: POST /run with the prompt + synthesize:true + bearer auth
		const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/run"));
		if (!submitCall) throw new Error("expected a POST /run call");
		const submitInit = submitCall[1] as RequestInit;
		const body = JSON.parse(submitInit.body as string);
		expect(body.synthesize).toBe(true);
		// The /run wire has one `prompt` field, so the identity preamble (agentIdentityPreamble)
		// rides ahead of the real task — this is what makes the model answer "who are you" honestly
		// instead of from its own pretrained priors. (CUR-573)
		expect(body.prompt.startsWith(agentIdentityPreamble("potluck-agent"))).toBe(true);
		expect(body.prompt.trimEnd().endsWith("how many files?")).toBe(true);
		// Asserted on the REQUEST BODY, not on the constant: the ladder spec already proves the number
		// is sized correctly, and that proof is worth nothing if this call site stops sending it. Omit
		// the field and the service falls back to its own 300s, ~145s past where this client gives up.
		expect(body.wall_clock_secs).toBe(AGENT_SERVICE_WALL_CLOCK_SECS);
		expect(submitInit.headers).toMatchObject({ authorization: "Bearer tok" });

		const text = chunks.map((c) => c.token.text).join("");
		const finalChunk = chunks.find((c) => c.generated_text);

		expect(chunks.some((c) => c.routerMetadata?.model)).toBe(true); // provenance → badge + StackMap node
		expect(text).toContain("<think>");
		expect(text).toContain("</think>");
		expect(text).toContain("step 0: tool");
		expect(text).toContain("5 bytes");
		expect(text).toContain("There are 3 files."); // the answer streams after </think>
		expect(finalChunk?.generated_text).toContain("<think>");
		expect(finalChunk?.generated_text).toContain("There are 3 files.");

		// per-step live-stack beat: one agentStep chunk per tool_call, carrying the step index, tool name,
		// and the plan's total step count (→ generate.ts forwards as MessageUpdateType.AgentStep → the
		// client beats the Hermes node on the map). Two tool_calls in the canned SSE → two agentStep chunks.
		const steps = chunks.flatMap((c) => (c.agentStep ? [c.agentStep] : []));
		expect(steps).toHaveLength(2);
		expect(steps[0]).toMatchObject({ index: 0, tool: "tool", total: 2 });
		expect(steps[1]).toMatchObject({ index: 1, tool: "write", total: 2 });
	});

	// agent-service's own live-polled provider (CUR-1107's `_effective_compute_provider()`)
	// corrects the badge the same way `done.model` already does — a `done` frame carrying
	// `compute_provider` must win over the endpoint's static configured `provenanceProvider`. (CUR-996)
	it("corrects the provider badge from done.compute_provider", async () => {
		const frames = [
			frame("done", {
				state: "COMPLETED",
				result: "Done.",
				model: "swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO",
				compute_provider: "Infomaniak",
			}),
		];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) return { ok: true, status: 200, json: async () => ({ id: "t1" }) } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "who served this?" }],
		} as Parameters<typeof factory>[0]);

		const chunks: { routerMetadata?: { provider?: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		expect(chunks.some((c) => c.routerMetadata?.provider === "Infomaniak")).toBe(true);
	});

	// agent-service refuses a /run that doesn't say the visitor is signed in, so the submit
	// and the event stream a signed-in turn opens must both carry the claim. (CUR-4402)
	it("a signed-in visitor's /run and its event stream say the visitor is signed in", async () => {
		const frames = [frame("done", { state: "COMPLETED", result: "Done.", model: "some/model" })];
		const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/run")) return { ok: true, status: 200, json: async () => ({ id: "t1" }) } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "add 2 and 2" }],
			locals: { user: { _id: "u1" }, sessionId: "s1" },
		} as unknown as Parameters<typeof factory>[0]);
		for await (const _ of stream) void _;

		for (const suffix of ["/run", "/run/t1/events"]) {
			const call = fetchMock.mock.calls.find(([u]) => new URL(String(u)).pathname === suffix);
			if (!call) throw new Error(`expected a ${suffix} call`);
			expect(call[1]?.headers, suffix).toMatchObject({ "x-agent-account": "user" });
		}
	});

	// A `done` frame with no `compute_provider` (older agent-service, or the field genuinely absent)
	// must keep falling back to the endpoint's own static `provenanceProvider` — the pre-CUR-996 badge
	// behavior — rather than clearing the field.
	it("falls back to the configured provider when done carries no compute_provider", async () => {
		const frames = [frame("done", { state: "COMPLETED", result: "Done.", model: "some/model" })];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) return { ok: true, status: 200, json: async () => ({ id: "t1" }) } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "who served this?" }],
		} as Parameters<typeof factory>[0]);

		const chunks: { routerMetadata?: { provider?: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const withProvider = chunks.find((c) => c.routerMetadata?.provider !== undefined);
		expect(withProvider?.routerMetadata?.provider).toBe(""); // default provenanceProvider in this harness
	});

	// ── CUR-759: a submit failure's real message must survive both generate.ts and screenOutputStream ──
	// generate.ts's FinalAnswer branch reads its text from `generated_text`, not `token.text` — and
	// screenOutputStream discards a FinalAnswer's own text unconditionally, trusting only content it saw as a
	// Stream token first. So a real message here has to actually stream (this test asserts on `chunks.map(c =>
	// c.token.text).join("")`, the same way the happy-path test above does), not just ride along on the
	// terminal chunk.
	it("a submit rejection streams the real message (not just carries it on generated_text)", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: false, status: 502, text: async () => "moderation pipeline unavailable" } as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "hi" }],
		} as Parameters<typeof factory>[0]);

		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const text = chunks.map((c) => c.token.text).join("");
		const finalChunk = chunks.find((c) => c.generated_text);

		expect(text).toContain("HTTP 502");
		expect(text).toContain("moderation pipeline unavailable");
		expect(finalChunk?.generated_text).toContain("HTTP 502");
		expect(finalChunk?.generated_text).toContain("moderation pipeline unavailable");
	});

	it("a missing task id streams the real message the same way", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) return { ok: true, status: 200, json: async () => ({}) } as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "hi" }],
		} as Parameters<typeof factory>[0]);

		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const text = chunks.map((c) => c.token.text).join("");
		const finalChunk = chunks.find((c) => c.generated_text);

		expect(text).toBe("The agent service returned no task id.");
		expect(finalChunk?.generated_text).toBe("The agent service returned no task id.");
	});

	// ── CUR-1067: a CONFIGURED but UNREACHABLE service (network-level failure before any Response) ──
	// is a different failure than the non-OK branch above: `fetch` itself throws (DNS, ECONNREFUSED, TLS)
	// rather than resolving. Left uncaught, a bare `TypeError: fetch failed` propagates to the turn's
	// top-level stream catch, which renders `err.message` straight to the user.
	it("a network failure on /run submission (service unreachable) streams a friendly message, not the raw fetch error", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) throw new TypeError("fetch failed");
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "hi" }],
		} as Parameters<typeof factory>[0]);

		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const text = chunks.map((c) => c.token.text).join("");
		const finalChunk = chunks.find((c) => c.generated_text);

		expect(text).not.toContain("fetch failed");
		expect(text).toContain("isn't reachable right now");
		expect(finalChunk?.generated_text).toContain("isn't reachable right now");
	});

	// A genuine user-initiated stop (or the caller's own global abort) must still propagate as an
	// AbortError rather than be swallowed into the "unreachable" copy above — the outer stream catch's
	// abort handling (an interrupted answer, not an error) depends on seeing the real AbortError.
	it("an AbortError on /run submission is NOT rewritten into the unreachable-service message", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) {
				const err = new Error("The operation was aborted.");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey: "tok",
			model: {},
		});
		const stream = await factory({
			messages: [{ from: "user", content: "hi" }],
		} as Parameters<typeof factory>[0]);

		await expect(async () => {
			for await (const _c of stream) {
				/* drain */
			}
		}).rejects.toMatchObject({ name: "AbortError" });
	});

	// ── CUR-218: agent confirmation gate (ACP_PERMISSION_POLICY=confirm) ─────────────────────────────
	it("translates awaiting_confirmation + confirm_result frames into agentConfirm chunks, narrated and carrying taskId", async () => {
		const beforeMs = Date.now();
		const frames = [
			frame("awaiting_confirmation", {
				confirm_id: "c1",
				kind: "edit",
				title: "write_file: notes.txt",
				summary: "notes.txt: hello",
				attempt: 1,
				timeout_secs: 45,
			}),
			frame("confirm_result", { confirm_id: "c1", decision: "allow", reason: "human", attempt: 1 }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "edit notes.txt" }],
		} as Parameters<typeof factory>[0]);

		const chunks: {
			token: { text: string };
			agentConfirm?: {
				taskId: string;
				confirmId: string;
				kind: string;
				title: string;
				summary: string;
				deadlineAt?: number;
			};
			agentConfirmResult?: { confirmId: string; decision: string; reason: string };
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("waiting for your OK: edit — write_file: notes.txt");
		expect(text).toContain("confirmed");

		const opened = chunks.find((c) => c.agentConfirm)?.agentConfirm;
		// deadlineAt is stamped from THIS process's own Date.now(), not agent-service's clock —
		// assert it lands in the expected window (±slack for test overhead) rather than an exact value. (CUR-1094)
		expect(opened?.deadlineAt).toBeGreaterThanOrEqual(beforeMs + 45_000);
		expect(opened?.deadlineAt).toBeLessThan(beforeMs + 45_000 + 5_000);
		expect({ ...opened, deadlineAt: undefined }).toEqual({
			taskId: "t1",
			confirmId: "c1",
			kind: "edit",
			title: "write_file: notes.txt",
			summary: "notes.txt: hello",
			deadlineAt: undefined,
		});

		const resolved = chunks.find((c) => c.agentConfirmResult)?.agentConfirmResult;
		expect(resolved).toEqual({ confirmId: "c1", decision: "allow", reason: "human" });
	});

	it("CUR-4070: a stream that drops with a confirmation still open cancels it, so no Allow/Deny card is left resolving to nothing", async () => {
		// awaiting_confirmation opens c1, then the web↔agent SSE resets before any confirm_result or done
		// (CUR-4030). The turn ends on "stream dropped" with the card open.
		const enc = new TextEncoder();
		let pulls = 0;
		const droppedStream = new ReadableStream<Uint8Array>({
			// pull, not an eager start+error: calling error() discards any queued chunk, so the frame must
			// be delivered on the first read and the reset raised only on the next one.
			pull(controller) {
				if (pulls++ === 0) {
					controller.enqueue(
						enc.encode(
							frame("awaiting_confirmation", {
								confirm_id: "c1",
								kind: "edit",
								title: "Approve edit: agenda.txt",
								summary: "",
								timeout_secs: 180,
							})
						)
					);
				} else {
					controller.error(new Error("connection reset")); // a mid-turn connection reset
				}
			},
		});
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: droppedStream } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "make an agenda" }],
		} as Parameters<typeof factory>[0]);

		const chunks: {
			token: { text: string };
			agentConfirm?: { confirmId: string };
			agentConfirmResult?: { confirmId: string; decision: "allow" | "deny" | "canceled"; reason: string };
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("stream dropped"); // the reported symptom, confirmed reproduced

		// the card opened once, and the drop left it with exactly one cancellation — no allow/deny arrived
		expect(chunks.filter((c) => c.agentConfirm?.confirmId === "c1")).toHaveLength(1);
		const results = chunks.flatMap((c) => (c.agentConfirmResult ? [c.agentConfirmResult] : []));
		expect(results).toEqual([{ confirmId: "c1", decision: "canceled", reason: "stream-ended" }]);

		// folded the way streamUpdate folds every confirm chunk, the persisted entry reads terminal, so a
		// reload renders "Canceled." rather than a live Allow/Deny card (CUR-4070 Done when).
		const opened = agentConfirmOpened(undefined, {
			type: MessageUpdateType.AgentConfirm,
			taskId: "t1",
			confirmId: "c1",
			kind: "edit",
			title: "Approve edit: agenda.txt",
			summary: "",
		});
		const persisted =
			agentConfirmResolved(opened, { type: MessageUpdateType.AgentConfirmResult, ...results[0] }) ?? opened;
		expect(persisted[0].decision).toBe("canceled");
	});

	describe("CUR-4660: a turn that ends with approval cards still open", () => {
		/** Opens `confirmIds` as cards, then holds the stream open until the turn's signal aborts. */
		async function turnEndedBy(abort: (ctrl: AbortController) => void, confirmIds: string[]) {
			const enc = new TextEncoder();
			const ctrl = new AbortController();
			const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
				const u = String(url);
				if (u.endsWith("/run"))
					return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
				if (u.includes("/run/t1/events")) {
					const signal = init?.signal as AbortSignal;
					let sent = false;
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (!sent) {
								sent = true;
								for (const id of confirmIds)
									controller.enqueue(
										enc.encode(
											frame("awaiting_confirmation", {
												confirm_id: id,
												kind: "edit",
												title: `write_file: ${id}.txt`,
												summary: "",
												timeout_secs: 180,
											})
										)
									);
								// Every card is on screen; now the turn ends the way the case says.
								setTimeout(() => abort(ctrl), 0);
								return;
							}
							return new Promise<void>((_resolve, reject) => {
								const fail = () => reject(new DOMException("aborted", "AbortError"));
								if (signal.aborted) fail();
								else signal.addEventListener("abort", fail, { once: true });
							});
						},
					});
					return { ok: true, status: 200, body } as unknown as Response;
				}
				return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
			});
			vi.stubGlobal("fetch", fetchMock);
			const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
			const stream = await factory({
				messages: [{ from: "user", content: "write three files" }],
				abortSignal: ctrl.signal,
			} as Parameters<typeof factory>[0]);
			const chunks: {
				token: { text: string };
				generated_text: string | null;
				agentConfirmResult?: { confirmId: string; decision: "allow" | "deny" | "canceled"; reason: string };
			}[] = [];
			for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
			return {
				results: chunks.flatMap((c) => (c.agentConfirmResult ? [c.agentConfirmResult] : [])),
				final: chunks.at(-1)?.generated_text ?? "",
			};
		}

		it("the watchdog ending a turn nobody answered resolves every open card as a timed-out deny, and the answer names the unanswered approvals, not a stop", async () => {
			const { results, final } = await turnEndedBy(
				(ctrl) => ctrl.abort(new GenerationWatchdogAbort()),
				["c1", "c2", "c3"]
			);
			expect(results).toEqual([
				{ confirmId: "c1", decision: "deny", reason: "timeout" },
				{ confirmId: "c2", decision: "deny", reason: "timeout" },
				{ confirmId: "c3", decision: "deny", reason: "timeout" },
			]);
			expect(final).toContain("No answer arrived in time for the agent's 3 approval requests");
			expect(final).not.toContain("stopped before it finished");

			// Folded the way streamUpdate folds it, the persisted card reads as timed out on reload too.
			const opened = agentConfirmOpened(undefined, {
				type: MessageUpdateType.AgentConfirm,
				taskId: "t1",
				confirmId: "c1",
				kind: "edit",
				title: "write_file: c1.txt",
				summary: "",
			});
			const persisted = agentConfirmResolved(opened, { type: MessageUpdateType.AgentConfirmResult, ...results[0] });
			expect(persisted?.[0]).toMatchObject({ decision: "deny", reason: "timeout" });
		});

		it("a person's Stop with a card open still cancels it and says the run was stopped (a Stop is not an unanswered approval)", async () => {
			const { results, final } = await turnEndedBy((ctrl) => ctrl.abort(), ["c1"]);
			expect(results).toEqual([{ confirmId: "c1", decision: "canceled", reason: "stream-ended" }]);
			expect(final).toContain("The agent run was stopped before it finished.");
		});

		it("names a single unanswered approval in the singular", async () => {
			const { results, final } = await turnEndedBy((ctrl) => ctrl.abort(new GenerationWatchdogAbort()), ["c1"]);
			expect(results).toEqual([{ confirmId: "c1", decision: "deny", reason: "timeout" }]);
			expect(final).toContain("No answer arrived in time for the agent's approval request, so it was denied");
		});
	});

	it("CUR-1094: an older/coarse awaiting_confirmation frame with no timeout_secs produces no deadlineAt (never a fabricated countdown)", async () => {
		const { chunks } = await agentRun([
			frame("awaiting_confirmation", { confirm_id: "c1", kind: "edit", title: "write_file: x", summary: "" }),
			frame("confirm_result", { confirm_id: "c1", decision: "allow", reason: "human" }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		]);
		const opened = chunks.find(
			(c) => (c as { agentConfirm?: { confirmId: string } }).agentConfirm
		) as { agentConfirm?: { deadlineAt?: number } } | undefined;
		expect(opened?.agentConfirm?.deadlineAt).toBeUndefined();
	});

	it("narrates a timed-out confirmation as denied (agent-service's own fail-closed default)", async () => {
		const frames = [
			frame("awaiting_confirmation", { confirm_id: "c1", kind: "terminal", title: "run: rm x", summary: "" }),
			frame("confirm_result", { confirm_id: "c1", decision: "deny", reason: "timeout" }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "delete x" }],
		} as Parameters<typeof factory>[0]);

		const chunks: { token: { text: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		expect(chunks.map((c) => c.token.text).join("")).toContain("declined (timed out)");
	});

	// ── A proposed-but-denied call must not count as "ran" (CUR-705) ────────────────────────────────
	// A continued-session turn that proposes an edit whose confirm times out and is denied writes
	// nothing, yet the model can answer with fabricated figures anyway. toolKinds must therefore be set
	// on the tool's result, not at `tool_call` (mere proposal), or claimedActionOnContinuedSession (gated
	// on toolKinds.size === 0) stays quiet. In the production wire shape (acp_client.py) a denied or
	// timed-out confirm never produces a tool_result for that call at all, which these two tests
	// reproduce exactly (no tool_result frame follows the denial) rather than simulating one with ok:false.

	it("CUR-705: a denied/timed-out tool call does not count toward toolKinds — the honesty caveat fires", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("awaiting_confirmation", { confirm_id: "c1", kind: "edit", title: "Approve edit: x.csv", summary: "" }),
			frame("confirm_result", { confirm_id: "c1", decision: "deny", reason: "timeout" }),
			frame("done", {
				state: "COMPLETED",
				result: "Top three months: June $18,500, May $7,200, April $6,000.",
				session_continued: true,
				session_files_at_start: 2,   // CUR-1394: this shape's session holds prior files
				transport_used: "acp",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		// A continued-session-no-action verdict. The caveat still fires — this session held
		// files and the denied edit never ran — but it no longer claims to know files were written. (CUR-1394)
		expect(afterThink).toContain("no tool call was observed");
		expect(afterThink).not.toContain("wrote files");
		expect(afterThink).toContain("June $18,500"); // the answer itself is untouched
	});

	it("stays quiet on the identical shape when the confirm is actually allowed", async () => {
		// The control for the test above: proposal + APPROVAL, no result frame either (a coarse/older
		// build might not send one) — toolKinds still must NOT end up crediting a call whose outcome we
		// never observed. This is deliberately a non-assertion about firing (a bare edit into a `.csv`
		// artifact-less turn wouldn't trip wroteNotRun regardless); it only proves allow ≠ deny didn't
		// somehow become "anything not denied counts."
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("awaiting_confirmation", { confirm_id: "c1", kind: "edit", title: "Approve edit: x.csv", summary: "" }),
			frame("confirm_result", { confirm_id: "c1", decision: "allow", reason: "human" }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("done", { state: "COMPLETED", result: "Updated the file.", session_continued: true }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	// ── session_id: keys agent-service's workdir reuse (CUR-196 / CUR-542) ───────────────────────────
	it("sends session_id on /run, derived from the conversation id, so a follow-up reuses the workdir", async () => {
		const frames = [frame("done", { state: "COMPLETED", result: "ok." })];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			void init;
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "now edit that file" }],
			conversationId: { toString: () => "conv-abc123" },
		} as Parameters<typeof factory>[0]);
		for await (const _ of stream) void _; // drain

		const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/run"));
		if (!submitCall) throw new Error("expected a POST /run call");
		const body = JSON.parse((submitCall[1] as RequestInit).body as string);
		expect(body.session_id).toBe("conv-abc123");
	});

	it("omits session_id rather than sending the literal string \"undefined\" when there is no conversation", async () => {
		const frames = [frame("done", { state: "COMPLETED", result: "ok." })];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			void init;
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<
			typeof factory
		>[0]);
		for await (const _ of stream) void _; // drain

		const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/run"));
		if (!submitCall) throw new Error("expected a POST /run call");
		const body = JSON.parse((submitCall[1] as RequestInit).body as string);
		expect(body).not.toHaveProperty("session_id");
	});

	it("omits the provenance model when the done frame carries none — graceful fallback, no crash", async () => {
		// Companion to the happy path above. A `done` frame WITHOUT `model` (an older agent-service, or
		// an error path) must NOT correct the badge: routerMetadata.model stays unset so the client falls
		// back to the conversation's default model, and the answer still streams. This pins the
		// provenanceModel ""-default's no-hardcoded-brand behavior, which the with-model test no longer exercises.
		const frames = [
			frame("state", { state: "working" }),
			frame("plan", { attempt: 1, steps: ["write"] }),
			frame("tool_call", { tool: "write", step: 0 }),
			frame("tool_result", { ok: true, step: 0, summary: "ok" }),
			frame("done", { state: "COMPLETED", result: "Answer without provenance.", verified: false }),
		];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "go" }],
		} as Parameters<typeof factory>[0]);
		const chunks: {
			token: { text: string };
			generated_text: string | null;
			routerMetadata?: { model?: string };
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		// no done.model → no badge correction → the client keeps the conversation default (no hardcoded brand)
		expect(chunks.some((c) => c.routerMetadata?.model)).toBe(false);
		// …but the turn still completes and the answer streams
		const finalChunk = chunks.find((c) => c.generated_text);
		expect(finalChunk?.generated_text).toContain("Answer without provenance.");
	});

	// Consumer half of the agent-service "Contract (BINDING)" (docs/streaming-spec.md). The done-frame
	// `state` is the UPPERCASE State enum value; this endpoint compares against "COMPLETED". These pin that
	// dependency so a backend casing change (or a refactor here) is caught cross-repo, not in prod.
	it("translates a `policy` frame into a writePolicy chunk, not <think> narration (CUR-471)", async () => {
		// agent-service fires `policy` once, early (same point as `plan`), reporting this caller's
		// write-permission resolution for the task. Deliberately a structured chunk, not prose: the
		// model gets its own explanation via a server-injected prompt note, and this must stay
		// authoritative independent of what the model says.
		const frames = [
			frame("policy", { policy: "deny_writes", tier: "new", tasks_done: 1, tasks_required: 3 }),
			frame("plan", { attempt: 1, steps: ["read"] }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "run a script" }],
		} as Parameters<typeof factory>[0]);
		const chunks: {
			token: { text: string };
			generated_text: string | null;
			writePolicy?: {
				policy: string;
				tier: string;
				tasksDone?: number | null;
				tasksRequired?: number | null;
			};
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const policyChunks = chunks.filter((c) => c.writePolicy);
		expect(policyChunks).toHaveLength(1);
		expect(policyChunks[0].writePolicy).toEqual({
			policy: "deny_writes",
			tier: "new",
			tasksDone: 1,
			tasksRequired: 3,
		});
		// carried on an empty-text chunk (structured signal, not answer prose)
		expect(policyChunks[0].token.text).toBe("");

		const text = chunks.map((c) => c.token.text).join("");
		expect(text).not.toContain("Write access"); // not narrated into the think block
	});

	it("stamps an agentTools chunk when toolKinds is non-empty at done, not before (CUR-601)", async () => {
		const frames = [
			frame("plan", { attempt: 1, steps: ["write"] }),
			frame("tool_call", { tool: "write_file", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("tool_call", { tool: "terminal", step: 2 }),
			frame("tool_result", { ok: true, step: 2, summary: "ok" }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "write and run a script" }],
		} as Parameters<typeof factory>[0]);
		const chunks: {
			token: { text: string };
			generated_text: string | null;
			agentTools?: { toolKinds: string[]; counts?: Record<string, number> };
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const agentToolsChunks = chunks.filter((c) => c.agentTools);
		expect(agentToolsChunks).toHaveLength(1);
		expect(agentToolsChunks[0].agentTools).toEqual({
			toolKinds: ["write_file", "terminal"],
			counts: { write_file: 1, terminal: 1 },
		});
		// carried on an empty-text chunk, same as writePolicy above
		expect(agentToolsChunks[0].token.text).toBe("");
	});

	// toolKinds is a distinct-kind list (deduped), but the accumulator underneath it now also
	// tracks per-kind counts for the tool-run summary line — this proves the two stay independently
	// correct against a real repeated-tool SSE stream, not just a hand-built literal. (CUR-775)
	it("dedupes toolKinds but preserves per-kind counts across repeated tool_call frames", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("tool_call", { tool: "edit", step: 2 }),
			frame("tool_result", { ok: true, step: 2, summary: "ok" }),
			frame("tool_call", { tool: "edit", step: 3 }),
			frame("tool_result", { ok: true, step: 3, summary: "ok" }),
			frame("done", { state: "COMPLETED", result: "Edited three files." }),
		]);
		const agentToolsChunks = chunks.filter((c) => (c as { agentTools?: unknown }).agentTools) as unknown as {
			agentTools: { toolKinds: string[]; counts?: Record<string, number> };
		}[];
		expect(agentToolsChunks).toHaveLength(1);
		expect(agentToolsChunks[0].agentTools).toEqual({
			toolKinds: ["edit"],
			counts: { edit: 3 },
		});
	});

	it("emits no agentTools chunk when toolKinds is empty at done", async () => {
		const { chunks } = await agentRun([
			frame("plan", { attempt: 1, steps: ["think"] }),
			frame("done", { state: "COMPLETED", result: "Just an answer, no tools needed." }),
		]);
		expect(chunks.some((c) => (c as { agentTools?: unknown }).agentTools)).toBe(false);
	});

	async function runWithDone(done: Record<string, unknown>) {
		const frames = [frame("plan", { attempt: 1, steps: ["write"] }), frame("done", done)];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "go" }] } as Parameters<
			typeof factory
		>[0]);
		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		return chunks.find((c) => c.generated_text)?.generated_text ?? "";
	}

	it("treats UPPERCASE COMPLETED (no result) as success — casing is load-bearing", async () => {
		const upper = await runWithDone({ state: "COMPLETED", verified: true });
		expect(upper).toContain("Done.");
		expect(upper).not.toContain("could not finish");
		// the same frame with lowercase casing would be read as a non-completion — proving the consumer
		// depends on the contract's UPPERCASE enum, so a backend that lowercased it would break here first.
		const lower = await runWithDone({ state: "completed", verified: true });
		expect(lower).toContain("could not finish");
	});

	it("handles a FAILED terminal gracefully (no throw, honest message)", async () => {
		const failed = await runWithDone({ state: "FAILED", result: null });
		expect(failed).toContain("could not finish");
		expect(failed).toContain("FAILED");
	});

	it("surfaces agent-service's own reason when a FAILED task carries one (CUR-856)", async () => {
		// The case this exists for: a moderation block or failure on the agent's OWN artifacts leaves
		// `result` empty on a FAILED task — without `error`, the person sees only "(FAILED)" with no
		// hint a safety check fired, let alone which one.
		const failed = await runWithDone({
			state: "FAILED",
			result: null,
			error: "blocked by moderation (artifacts): sexual",
		});
		expect(failed).toContain("blocked by moderation (artifacts): sexual");
		expect(failed).not.toContain("(FAILED)"); // the specific reason replaces the bare state, not appends to it
	});

	it("surfaces a submit failure as an answer instead of throwing", async () => {
		const fetchMock = vi.fn(
			async () =>
				({
					ok: false,
					status: 503,
					json: async () => ({}),
					text: async () => "upstream down",
				}) as Response
		);
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<
			typeof factory
		>[0]);
		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const finalChunk = chunks.find((c) => c.generated_text);
		expect(finalChunk?.generated_text).toContain("503");
		expect(chunks.map((c) => c.token.text).join("")).toContain("503");
	});

	it("surfaces a 429 (AGENT_MAX_CONCURRENCY ceiling) still refusing after the wait as a friendly retry message, not the raw HTTP dump", async () => {
		const fetchMock = vi.fn(
			async () =>
				({
					ok: false,
					status: 429,
					json: async () => ({}),
					text: async () => "server at capacity (4 concurrent runs) — retry shortly",
				}) as Response
		);
		vi.stubGlobal("fetch", fetchMock);

		// Asked again inside the wait (30 ms here, a minute in production), then given up. (CUR-4584)
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {}, capacityWaitMs: 30 });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<
			typeof factory
		>[0]);
		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		// The user sees a plain wait-and-retry message, not "HTTP 429" or the service's own wording —
		// that's the whole point of this branch (endpointAgent.ts's submit-failure handling).
		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("please wait a moment and try again");
		expect(text).not.toContain("429");
		expect(text).not.toContain("HTTP");
		expect(fetchMock.mock.calls.length, "the capacity answer was not asked again").toBeGreaterThan(1);
	});

	it("waits through a 'server at capacity' answer, showing the wait, and runs the task once a slot frees (CUR-4584)", async () => {
		let runs = 0;
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) {
				runs++;
				if (runs === 1)
					return {
						ok: false,
						status: 429,
						headers: new Headers({ "retry-after": "1" }),
						json: async () => ({}),
						text: async () => '{"detail":"server at capacity (4 concurrent runs) — retry shortly"}',
					} as Response;
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			}
			if (u.includes("/run/t1/events"))
				return {
					ok: true,
					status: 200,
					body: sseStream([frame("done", { state: "COMPLETED", result: "Done." })]),
				} as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {}, capacityWaitMs: 1500 });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { sandboxWait?: string; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		expect(runs).toBe(2);
		expect(chunks.flatMap((c) => (c.sandboxWait ? [c.sandboxWait] : []))).toEqual(["waiting", "ready"]);
		expect(chunks.at(-1)?.generated_text).toContain("Done.");
	});

	it("waits through a draining machine's 503 and runs the task on the machine that replaces it (CUR-4598)", async () => {
		let runs = 0;
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run")) {
				runs++;
				if (runs === 1)
					return {
						ok: false,
						status: 503,
						headers: new Headers({ "retry-after": "1" }),
						json: async () => ({}),
						text: async () => '{"detail":"agent service restarting for an update — retry shortly"}',
					} as Response;
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			}
			if (u.includes("/run/t1/events"))
				return {
					ok: true,
					status: 200,
					body: sseStream([frame("done", { state: "COMPLETED", result: "Done." })]),
				} as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {}, capacityWaitMs: 1500 });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		expect(runs).toBe(2);
		expect(chunks.at(-1)?.generated_text).toContain("Done.");
	});

	it("says the service is restarting, not an HTTP dump, when the drain outlasts the wait (CUR-4598)", async () => {
		const fetchMock = vi.fn(
			async () =>
				({
					ok: false,
					status: 503,
					json: async () => ({}),
					text: async () => '{"detail":"agent service restarting for an update — retry shortly"}',
				}) as Response
		);
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {}, capacityWaitMs: 30 });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { token: { text: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("restarting for an update");
		expect(text).not.toContain("HTTP");
	});

	it("tells the person a restart ended the task and to send it again, never the dropped-stream line (CUR-4598)", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events"))
				return {
					ok: true,
					status: 200,
					body: sseStream([
						frame("done", { state: "FAILED", error: "interrupted by server restart", interrupted: "restart" }),
					]),
				} as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		const final = chunks.at(-1)?.generated_text ?? "";
		expect(final).toContain("restarted for an update before this task finished");
		expect(final).toContain("send your message again");
		expect(final).not.toContain("stream dropped");
	});

	it("does not wait on a 429 a retry cannot clear: the daily limit is said at once", async () => {
		const fetchMock = vi.fn(
			async () =>
				({
					ok: false,
					status: 429,
					json: async () => ({}),
					text: async () => "daily task limit reached",
				}) as Response
		);
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { token: { text: string }; sandboxWait?: string }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(chunks.some((c) => c.sandboxWait)).toBe(false);
		expect(chunks.map((c) => c.token.text).join("")).toContain("today's task limit");
	});

	// A daily limit is a 429 a retry cannot clear, so "wait a moment" must not answer every 429 (CUR-4401).
	it("says today's task limit is reached, not 'wait a moment', when agent-service's daily cap answers 429", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: false,
						status: 429,
						json: async () => ({}),
						text: async () => '{"detail":"per-visitor task limit reached (25 per 86400s)"}',
					}) as Response
			)
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { token: { text: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("today's task limit");
		expect(text).not.toContain("wait a moment");
	});

	// One visitor's live-task cap clears when their own task ends, so neither "at capacity" nor
	// "try tomorrow" is the true thing to tell them. (CUR-2194)
	it("says the visitor's own tasks are still running when agent-service's per-visitor live cap answers 429", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: false,
						status: 429,
						json: async () => ({}),
						text: async () =>
							'{"detail":"this visitor already has 2 agent task(s) running — wait for one to finish"}',
					}) as Response
			)
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "hi" }] } as Parameters<typeof factory>[0]);
		const chunks: { token: { text: string } }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("You already have agent tasks running");
		expect(text).not.toContain("today's task limit");
		expect(text).not.toContain("at capacity");
	});

	describe("the per-account daily allowance (CUR-4401)", () => {
		const locals = { user: { _id: "user-1" }, sessionId: "sess-1" } as unknown as App.Locals;
		// beforeEach: the rest of the suite runs the same mocks with no reset of its own.
		beforeEach(() => {
			allowance.room.mockReset().mockResolvedValue({ ok: true });
			allowance.record.mockReset();
		});

		async function run(fetchMock: ReturnType<typeof vi.fn>) {
			vi.stubGlobal("fetch", fetchMock);
			const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
			const stream = await factory({ messages: [{ from: "user", content: "hi" }], locals } as Parameters<
				typeof factory
			>[0]);
			const chunks: { token: { text: string } }[] = [];
			for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
			return chunks.map((c) => c.token.text).join("");
		}

		it("refuses a visitor whose day's tasks are used before calling agent-service, and says when the next opens", async () => {
			allowance.room.mockResolvedValue({ ok: false, retryAfterSecs: 3 * 3600 - 60 });
			const fetchMock = vi.fn();
			const text = await run(fetchMock);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(text).toBe("You've used today's 25 agent tasks. The next one opens up in about 3 hours.");
			expect(allowance.record).not.toHaveBeenCalled();
		});

		it("counts a task agent-service accepted, and not one it refused", async () => {
			const accepted = vi.fn(async (url: string | URL) =>
				String(url).endsWith("/run")
					? ({ ok: true, status: 200, json: async () => ({ id: "task-1" }) } as Response)
					: ({ ok: false, status: 404, text: async () => "", body: null } as unknown as Response)
			);
			await run(accepted);
			expect(allowance.room).toHaveBeenCalledWith(locals);
			expect(allowance.record).toHaveBeenCalledTimes(1);
			expect(allowance.record).toHaveBeenCalledWith(locals);

			allowance.record.mockReset();
			await run(vi.fn(async () => ({ ok: false, status: 503, text: async () => "down" }) as Response));
			expect(allowance.record).not.toHaveBeenCalled();
		});
	});

	// ── Coarse (ACP-OFF) transport — the one every DEPLOYED env runs today (endpointAgent.ts:17) ─────────
	// Every other streaming test above opens with a `plan` frame and narrates `tool_call`s, i.e. the ACP-ON
	// path. The deployed contract has NO per-tool frames — just state{working} · usage · done — so the
	// usage-derived step summary at endpointAgent.ts:308-317 (the code that keeps the coarse <think> block
	// from rendering as a bare shell) was reachable nowhere in the hermetic suite. These pin it. (CUR-67)
	async function coarseChunks(frames: string[]) {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "how many packages?" }] } as Parameters<
			typeof factory
		>[0]);
		const chunks: {
			token: { text: string };
			generated_text: string | null;
			routerMetadata?: { model?: string };
			agentStep?: { index: number; tool: string; total?: number };
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		return chunks;
	}

	it("coarse path (ACP off): state · usage{tokens,steps} · done → usage-derived summary, no per-tool narration", async () => {
		const chunks = await coarseChunks([
			frame("state", { state: "working" }),
			// LIVE usage frames carry only {tokens} — no {steps} — so they must NOT emit a summary line.
			frame("usage", { tokens: 512 }),
			// The FINAL usage frame (just before done) adds {steps}: THIS is the one that renders.
			frame("usage", { tokens: 2048, steps: 3 }),
			frame("done", {
				state: "COMPLETED",
				result: "The repo has 3 packages.",
				model: "swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO",
			}),
		]);

		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("<think>");
		expect(text).toContain("</think>");
		// the usage-derived summary renders from the FINAL usage frame
		expect(text).toContain("Ran 3 step(s) · 2048 tokens.");
		// …exactly once: the live {tokens}-only frame produced no line (stepCount stays undefined)
		expect(text.match(/Ran \d+ step/g) ?? []).toHaveLength(1);
		// no ACP frames arrived → none of the per-tool narration paths fired
		expect(text).not.toContain("Planned");
		expect(text).not.toContain("step 0:");
		expect(chunks.flatMap((c) => (c.agentStep ? [c.agentStep] : []))).toHaveLength(0);
		// the answer still streams after the think block, and provenance is corrected from done.model
		expect(text).toContain("The repo has 3 packages.");
		expect(chunks.some((c) => c.routerMetadata?.model)).toBe(true);
		const finalChunk = chunks.find((c) => c.generated_text);
		expect(finalChunk?.generated_text).toContain("<think>");
		expect(finalChunk?.generated_text).toContain("The repo has 3 packages.");
	});

	it("coarse path: a final usage frame with steps but no tokens omits the token suffix", async () => {
		// The token count is optional in the summary (`typeof ev.tokens === "number"` guard at :315). A
		// usage frame that reports steps without a token total must still render the step line, sans "· … tokens".
		const chunks = await coarseChunks([
			frame("state", { state: "working" }),
			frame("usage", { steps: 2 }),
			frame("done", { state: "COMPLETED", result: "ok." }),
		]);
		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("Ran 2 step(s).");
		expect(text).not.toContain("tokens");
		expect(chunks.find((c) => c.generated_text)?.generated_text).toContain("ok.");
	});

	it("answers honestly when the event stream drops MID-read (no throw, think closed)", async () => {
		// Stream opens fine, emits a plan frame, then the connection resets mid-flight. The endpoint
		// must close the <think> block and emit an honest drop message — not throw out of the generator
		// (which would surface as a generic stream error and lose the agent context). Demo-day insurance:
		// an agent service that dies after the stream opens degrades gracefully.
		const enc = new TextEncoder();
		const droppingStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode(frame("plan", { attempt: 1, steps: ["write"] })));
				controller.error(new Error("ECONNRESET"));
			},
		});
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: droppingStream } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "go" }] } as Parameters<
			typeof factory
		>[0]);
		const chunks: { token: { text: string }; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);

		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("</think>"); // think block closed despite the drop
		expect(text).toContain("dropped before the task finished"); // honest message
		const finalChunk = chunks.find((c) => c.generated_text);
		expect(finalChunk?.generated_text).toContain("dropped before the task finished");
	});

	// ── `token` frames: the answer prose, live ────────────────────────────────────────────────────────
	// The service emits these (AGENT_STREAM_TOKENS). A frame the etype chain does not handle falls through
	// silently, so a turn would show its steps and then sit mute until `done`.
	async function agentRun(frames: string[], params: Record<string, unknown> = {}, apiKey = "") {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			void init; // declared so mock.calls is typed at index 1 — the headers are what these tests read
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({
			type: "agent",
			baseURL: "http://agent.test",
			apiKey,
			model: {},
		});
		return { chunks: await drain(factory, params), fetchMock, factory };
	}

	/** Headers of the Nth fetch (0 = POST /run, 1 = GET the event stream). */
	const headersOf = (
		calls: [string | URL, RequestInit?][],
		n: number
	): Record<string, string> => (calls[n]?.[1]?.headers ?? {}) as Record<string, string>;

	async function drain(
		factory: Awaited<ReturnType<typeof endpointAgent>>,
		params: Record<string, unknown> = {}
	) {
		const stream = await factory({
			messages: [{ from: "user", content: "go" }],
			...params,
		} as Parameters<typeof factory>[0]);
		const chunks: {
			token: { text: string; special?: boolean };
			generated_text: string | null;
		}[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		return chunks;
	}

	it("holds answer prose until done, and keeps step narration inside the think block when it interleaves", async () => {
		// `token` deltas are buffered per-attempt (see pendingTokenBuffer), not pushed live —
		// only tool_call/plan/usage narration streams as it arrives. So the surviving attempt's prose
		// lands as one piece at `done`, AFTER any tool narration that interleaved with it, not
		// interleaved with it the way it arrived on the wire. This test is the guard: if a future change
		// closes </think> on the first token instead of flushing pendingTokenBuffer there, the "step 2:
		// read" narration lands in the answer and the ordering assertion below fails. (CUR-767)
		const { chunks } = await agentRun([
			frame("plan", { attempt: 1, steps: ["edit", "read"] }),
			frame("token", { delta: "I'll write the file ", attempt: 1 }),
			frame("token", { delta: "and read it back.\n", attempt: 1 }),
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_call", { tool: "read", step: 2 }),
			frame("token", { delta: "It says hello (5 bytes).", attempt: 1 }),
			frame("usage", { tokens: 900, steps: 2 }),
			frame("done", {
				state: "COMPLETED",
				result: "I'll write the file and read it back.\nIt says hello (5 bytes).",
			}),
		]);

		const text = chunks.map((c) => c.token.text).join("");
		const close = text.indexOf("</think>");
		expect(close).toBeGreaterThan(-1);

		// the buffered prose (both deltas, concatenated) is flushed before the block closes…
		expect(text.slice(0, close)).toContain("I'll write the file and read it back.");
		expect(text.slice(0, close)).toContain("It says hello (5 bytes).");
		// …and so is the tool narration that arrived while it was still buffered. Both inside the block,
		// and the tool narration — pushed live — lands BEFORE the flushed prose, not interleaved with it.
		expect(text.slice(0, close)).toContain("step 2: read");
		expect(text.indexOf("step 2: read")).toBeLessThan(close);
		expect(text.indexOf("step 2: read")).toBeLessThan(text.indexOf("I'll write the file"));

		// the answer still lands whole at `done`, after the block
		expect(text.slice(close)).toContain("It says hello (5 bytes).");
		expect(chunks.find((c) => c.generated_text)?.generated_text).toContain("(5 bytes)");
	});

	it("CUR-767: discards a rejected attempt's buffered prose — it never appears anywhere in the stream", async () => {
		const { chunks } = await agentRun([
			frame("token", { delta: "The answer is definitely 42", attempt: 1 }),
			frame("attempt_rejected", { attempt: 1, reason: "judge rejected: unsupported claim" }),
			frame("token", { delta: "Let me check that properly. ", attempt: 2 }),
			frame("token", { delta: "The answer is 7.", attempt: 2 }),
			frame("done", { state: "COMPLETED", result: "The answer is 7." }),
		]);

		const text = chunks.map((c) => c.token.text).join("");
		// the rejected attempt's prose never rendered — not live, not retroactively, not at all
		expect(text).not.toContain("definitely 42");
		// the narration says an attempt was rejected, with the (already-scrubbed) reason
		expect(text).toContain("Attempt rejected");
		expect(text).toContain("judge rejected: unsupported claim");
		// the surviving (second) attempt's prose still lands
		expect(text).toContain("The answer is 7.");
	});

	it("CUR-767: two attempts run without an intervening attempt_rejected frame — doesn't carry the first attempt's text into the second's buffer (defensive, contract says this shouldn't happen)", async () => {
		const { chunks } = await agentRun([
			frame("token", { delta: "stale attempt-1 prose", attempt: 1 }),
			frame("token", { delta: "attempt-2 prose", attempt: 2 }),
			frame("done", { state: "COMPLETED", result: "attempt-2 prose" }),
		]);

		const text = chunks.map((c) => c.token.text).join("");
		expect(text).not.toContain("stale attempt-1 prose");
		expect(text).toContain("attempt-2 prose");
	});

	it("says when the live output was capped, rather than just stopping", async () => {
		// Without this the text stops mid-answer, which looks exactly like the agent stopping. The
		// service caps frames per attempt so a long answer can't evict this turn's plan/tool_call frames.
		const { chunks } = await agentRun([
			frame("token", { delta: "Here is the first part", attempt: 1 }),
			frame("token_truncated", { attempt: 1, frames: 400 }),
			frame("done", { state: "COMPLETED", result: "Here is the first part and the rest." }),
		]);
		const text = chunks.map((c) => c.token.text).join("");
		expect(text).toContain("live output capped");
		expect(text).toContain("Here is the first part and the rest."); // done.result is complete
	});

	it("an empty delta produces no content chunk", async () => {
		// An empty Stream token is not free: the two screening wrappers batch content tokens, so a stream
		// of empty ones is buffered work that can never release on its own.
		const { chunks } = await agentRun([
			frame("token", { delta: "", attempt: 1 }),
			frame("done", { state: "COMPLETED", result: "ok." }),
		]);
		const emptyContent = chunks.filter((c) => c.token.text === "" && !c.token.special);
		expect(emptyContent).toHaveLength(0);
		expect(chunks.map((c) => c.token.text).join("")).toContain("ok.");
	});

	// ── progress markers begin a line, whatever prose preceded them (CUR-227) ─────────────────────────

	it("a step summary landing on a closing code fence still lets that fence close", async () => {
		// The failure this names, precisely. `token` deltas are raw model prose and carry no trailing
		// newline, so a marker emitted right after one lands MID-LINE. When that line is a closing ```
		// fence, CommonMark says it is not a close at all — a closing fence may hold only fence
		// characters and whitespace — and an unclosed fenced block runs to the end of the document. The
		// whole tail of the turn then renders as monospace inside a code box. Nothing throws, so only the
		// rendered output shows it.
		//
		// Asserted through the real marked, the version package.json ships, rather than by inspecting
		// the string for a shape. The claim is about what the reader sees, so the renderer is the judge.
		const { chunks } = await agentRun([
			frame("token", { delta: "```python\nprint(1)\n```", attempt: 1 }),
			frame("usage", { tokens: 5094, steps: 1 }),
			frame("done", { state: "COMPLETED", result: "It prints 1." }),
		]);
		const think = chunks
			.map((c) => c.token.text)
			.join("")
			.split("</think>")[0];
		expect(think).toContain("Ran 1 step(s)");

		const html = await marked.parse(think);
		const inCode = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1]).join("");
		expect(inCode).toContain("print(1)"); // the fence still opens a block…
		expect(inCode).not.toContain("Ran 1 step(s)"); // …and that block ends before the summary
	});

	it("every progress marker begins a line, whatever prose preceded it", async () => {
		// The general form: five line-oriented emitters each end with "\n" and none leads with one, so
		// each assumes the accumulator already sits at a line start. True between two markers, false
		// against `token`. Every delta here deliberately ends without a newline, so a regression in any
		// one emitter surfaces as a mid-line match rather than as a rendering surprise later.
		const { chunks } = await agentRun([
			frame("token", { delta: "Let me write the file first.", attempt: 1 }),
			frame("plan", { attempt: 1, steps: ["edit"] }),
			frame("token", { delta: "Writing it now.", attempt: 1 }),
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("token", { delta: "Checking what landed.", attempt: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "12 bytes" }),
			frame("token", { delta: "One more thing.", attempt: 1 }),
			frame("message", { text: "retrying" }),
			frame("token", { delta: "…ordered from oldest to newest.", attempt: 1 }),
			frame("usage", { tokens: 17873, steps: 4 }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		]);
		const text = chunks.map((c) => c.token.text).join("");

		for (const marker of [
			"Planned 1 step(s)",
			"→ step 1: edit",
			"12 bytes",
			"note: retrying",
			"Ran 4 step(s)",
			// NOT "</think>": it can land mid-line too, but the client slices the tags off before any
			// markdown runs, so asserting a line start there would be pinning something that costs
			// nothing to get wrong.
		]) {
			const at = text.indexOf(marker);
			expect(at, `${marker} never appeared`).toBeGreaterThan(-1);
			const lineStart = text.lastIndexOf("\n", at) + 1;
			expect(text.slice(lineStart, at).trim(), `${marker} does not begin its line`).toBe("");
		}
	});

	// ── an un-run turn says so, in the answer (CUR-226) ───────────────────────────────────────────────

	it("says the code was never run when the turn only edited — in the answer, not the think block", async () => {
		// The case: a cold first turn writes a sieve script, emits no execute step, and prints a block
		// headed "Execution result:" whose numbers its own code cannot produce. The caveat has to sit where
		// someone who never expands `Computed` will read it, because that
		// is the reader the fabricated measurement fools.
		//
		// artifacts carries the sieve script itself (CUR-592 also requires a code/script artifact to
		// fire the caveat, not just the edit tool kind — this file IS that artifact).
		const { chunks } = await agentRun([
			frame("plan", { attempt: 1, steps: ["edit"] }),
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "210 bytes" }),
			frame("usage", { tokens: 5094, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "Execution result:\n25 primes; last three [97, 89, 83].",
				artifacts: [{ name: "sieve.py", bytes: 210, text: "primes = [2, 3, 5]\n", truncated: false }],
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		expect(afterThink).toContain("never ran anything");
		expect(afterThink).toContain("25 primes"); // the answer itself is untouched
	});

	// ── CUR-592: the caveat also requires an actual code/script artifact, not just the tool kind ───────
	// A turn that only rewrites a `.txt` benefits letter (no computation, nothing to "run") must not trip
	// this caveat, so `wroteCodeWithoutRunningIt` looks at what got edited. The caveat is wrong on a
	// plain-language task, and it teaches a non-technical user to distrust a fine answer.

	it("stays quiet when the only edited artifact is plain text — CUR-542's benefits-letter finding", async () => {
		const { chunks } = await agentRun([
			frame("plan", { attempt: 1, steps: ["edit"] }),
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "640 bytes" }),
			frame("usage", { tokens: 812, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "Here is the revised letter.",
				artifacts: [{ name: "benefits-letter.txt", bytes: 640, text: "Dear Sam,\n", truncated: false }],
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("stays quiet on an edit-only turn with no artifacts reported at all", async () => {
		// No artifact list means no structural evidence of what got edited — the same "we know nothing,
		// so say nothing" posture INERT_TOOL_KINDS already takes on an unrecognised tool kind.
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("usage", { tokens: 300, steps: 1 }),
			frame("done", { state: "COMPLETED", result: "Done." }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("still fires when a code artifact sits alongside a plain-text one", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "40 bytes" }),
			frame("usage", { tokens: 900, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "Execution result:\n42.",
				artifacts: [
					{ name: "notes.txt", bytes: 20, text: "reminder\n", truncated: false },
					{ name: "calc.py", bytes: 40, text: "print(42)\n", truncated: false },
				],
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		expect(afterThink).toContain("never ran anything");
	});

	it("stays quiet when the turn actually executed something", async () => {
		// The control for the test above. Without this, a caveat that fired unconditionally would pass
		// the first test just as well, and would be worse than the bug — it would teach readers to skip it.
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("tool_call", { tool: "execute", step: 2 }),
			frame("tool_result", { ok: true, step: 2, summary: "25 primes." }),
			frame("usage", { tokens: 17873, steps: 4 }),
			frame("done", { state: "COMPLETED", result: "Execution result:\n25 primes." }),
		]);
		expectNoUnrunCaveat(chunks.find((c) => c.generated_text)?.generated_text ?? "");
	});

	it("stays quiet when no tool frames arrived at all — not knowing is not the same as knowing it didn't", async () => {
		// The coarse (ACP-off) path emits state/usage/done and NO tool frames, so the tool set is empty
		// for a reason that has nothing to do with what the agent did. Claiming "never ran anything" there
		// would be the same class of error as the bug: an assertion about something never observed.
		const { chunks } = await agentRun([
			frame("state", { state: "working" }),
			frame("usage", { tokens: 5094, steps: 1 }),
			frame("done", { state: "COMPLETED", result: "Execution result:\n25 primes." }),
		]);
		expectNoUnrunCaveat(chunks.find((c) => c.generated_text)?.generated_text ?? "");
	});

	it("stays quiet on a tool kind it does not recognise", async () => {
		// `other` is what the ACP bridge reports for anything it has no kind for, and a future Hermes
		// build can introduce kinds this file has never heard of. An unknown kind could have run code, so
		// the inert list is an allowlist and anything outside it buys silence rather than a wrong claim.
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("tool_call", { tool: "other", step: 2 }),
			frame("tool_result", { ok: true, step: 2, summary: "ok" }),
			frame("usage", { tokens: 5094, steps: 2 }),
			frame("done", { state: "COMPLETED", result: "Execution result:\n25 primes." }),
		]);
		expectNoUnrunCaveat(chunks.find((c) => c.generated_text)?.generated_text ?? "");
	});

	// ── transport observability, so an empty toolKinds is legible from outside (CUR-234) ─────────────
	// "ACP off, correctly never observed a tool" and "ACP on but a check silently didn't run" both render
	// as an empty toolKinds and no caveat — indistinguishable from outside.
	// `done.transport_used` (CUR-773) is agent-service's own record of which transport ran, which these
	// pin directly — not a guess reconstructed from which frames happened to arrive. `state{working}`
	// fires unconditionally on BOTH transports (see the file header), so its presence proves nothing
	// about which one ran; it's included below only for wire realism.

	it("logs transport:coarse when transport_used is oneshot on the done frame", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("state", { state: "working" }),
			frame("usage", { tokens: 5094, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "Execution result:\n25 primes.",
				transport_used: "oneshot",
			}),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({ transport: "coarse", toolKinds: [], unrunCodeCaveat: false });
		infoSpy.mockRestore();
	});

	it("logs transport:acp when transport_used is acp, even though the agent used zero tools", async () => {
		// No tool_call arrived — a turn that genuinely reasoned its way to an answer without touching a
		// tool. The old signal (toolKinds alone) can't tell this apart from the coarse case above;
		// done.transport_used is what does.
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("state", { state: "working" }),
			frame("usage", { tokens: 512, steps: 0 }),
			frame("done", { state: "COMPLETED", result: "The answer is 4.", transport_used: "acp" }),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({ transport: "acp", toolKinds: [], unrunCodeCaveat: false });
		infoSpy.mockRestore();
	});

	it("logs transport:coarse (not acp) when transport_used is absent — an old build or an undecided task", async () => {
		// Before this field existed, an empty/missing value here would have been misread by the OLD
		// guess (state-frame presence) in whichever direction the frame happened to arrive. The new
		// check has one fail-quiet default: anything that isn't literally "acp" reads as not-ACP.
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("state", { state: "working" }),
			frame("usage", { tokens: 512, steps: 0 }),
			// session_files_at_start present so this stays quiet because the session is fresh, which is
			// what it claims to test — not because the field was missing too (CUR-1394).
			frame("done", { state: "COMPLETED", result: "The answer is 4.", session_files_at_start: 2 }),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({ transport: "coarse", toolKinds: [], unrunCodeCaveat: false });
		infoSpy.mockRestore();
	});

	it("logs transport:acp with the un-run caveat flagged when a real turn triggers it", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("plan", { attempt: 1, steps: ["edit"] }),
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "210 bytes" }),
			frame("usage", { tokens: 5094, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "Execution result:\n25 primes.",
				transport_used: "acp",
				// wroteNotRun also requires a code/script artifact now. (CUR-592)
				artifacts: [{ name: "sieve.py", bytes: 210, text: "primes = [2, 3, 5]\n", truncated: false }],
			}),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({
			transport: "acp",
			toolKinds: ["edit"],
			unrunCodeCaveat: true,
			caveatReason: "wrote-not-run",
		});
		infoSpy.mockRestore();
	});

/**
 * No unrun caveat of ANY kind reached the answer.
 *
 * The notice has two sentences (CUR-1394), so asserting the absence of the original string alone is
 * not sufficient: a branch that wrongly fired UNOBSERVED_ACTION_NOTICE would sail past a check that
 * only looks for "never ran anything". Both sentences are named from the exported constants rather than
 * retyped, so a future copy edit cannot quietly blind every negative assertion in this file at once.
 */
function expectNoUnrunCaveat(text: string): void {
	expect(text).not.toContain(UNRUN_CODE_NOTICE.trim());
	expect(text).not.toContain(UNOBSERVED_ACTION_NOTICE.trim());
	expect(text).not.toContain("never ran anything");
	expect(text).not.toContain("no tool call was observed");
}

describe("claimedStepsWithoutObservedTools", () => {
	it("fires only under ACP transport, with claimed steps, and zero observed tools", () => {
		expect(claimedStepsWithoutObservedTools(new Map(), true, 1, 2)).toBe(true);
	});

	it("stays quiet under coarse transport, however many steps are claimed", () => {
		// The coarse (ACP-off) wire never sends tool_call frames, so an empty toolKinds there proves
		// nothing — same reasoning wroteCodeWithoutRunningIt applies to its own "edit" check.
		expect(claimedStepsWithoutObservedTools(new Map(), false, 1, 2)).toBe(false);
	});

	it("stays quiet when zero steps are claimed", () => {
		// A turn that genuinely reasoned to an answer without needing any tool reports no steps (or 0)
		// — nothing to have missed observing.
		expect(claimedStepsWithoutObservedTools(new Map(), true, 0, 2)).toBe(false);
		expect(claimedStepsWithoutObservedTools(new Map(), true, undefined, 2)).toBe(false);
	});

	it("stays quiet when any tool was actually observed, inert or not", () => {
		// A legitimate read-and-summarize turn also claims steps > 0 with no execute-capable tool. The
		// gate is on toolKinds being EMPTY, not merely non-executing — wroteCodeWithoutRunningIt already
		// covers the "wrote via edit, ran nothing" shape; this one is only for zero observed tool calls.
		expect(
			claimedStepsWithoutObservedTools(
				new Map([
					["read", 1],
					["search", 1],
				]),
				true,
				2,
				2
			)
		).toBe(false);
		expect(claimedStepsWithoutObservedTools(new Map([["edit", 1]]), true, 1, 2)).toBe(false);
	});

	// Coverage for the Set→Map widening (CUR-775) — a repeatedly-called tool (count > 1) must
	// still read as "a tool was observed", the same as the count=1 case above. Note this test does NOT
	// discriminate a hypothetical sum-of-counts bug from the correct .size read: both agree whenever
	// claimedSteps > 0 and the map is non-empty, since every key here only ever exists with count >= 1
	// (sum and size are zero together or nonzero together). The doc comment above states the intended
	// contract for a human reader; no input to this two-argument boolean gate can pin it as a test.
	it("stays quiet on a repeatedly-called tool, same as a single call", () => {
		expect(claimedStepsWithoutObservedTools(new Map([["edit", 5]]), true, 5, 2)).toBe(false);
	});
});

describe("claimedActionOnContinuedSession", () => {
	it("fires on a continued session under ACP transport with zero observed tools", () => {
		expect(claimedActionOnContinuedSession(new Map(), true, true, 2)).toBe(true);
	});

	it("stays quiet on a fresh (non-continued) session — a plain question needs no tool", () => {
		expect(claimedActionOnContinuedSession(new Map(), true, false, 2)).toBe(false);
	});

	it("stays quiet under coarse transport, continued or not", () => {
		expect(claimedActionOnContinuedSession(new Map(), false, true, 2)).toBe(false);
	});

	it("stays quiet when any tool was actually observed, inert or not", () => {
		expect(claimedActionOnContinuedSession(new Map([["read", 1]]), true, true, 2)).toBe(false);
		expect(claimedActionOnContinuedSession(new Map([["edit", 1]]), true, true, 2)).toBe(false);
	});
});

// Named for the contract rather than the behaviour, per this repo's rule 1 — the guarantee wanted is
// that the caveat only speaks about a session where a measurement was possible at all (CUR-1394).
describe("the unrun caveat only fires where there was something to measure", () => {
	it("stays quiet on a continued session whose workdir is empty — the ordinary chat follow-up", () => {
		// The chat client sends session_id=conversationId, so every turn after the first is `sessionContinued:
		// true` with zero files ever written. "What time does the train arrive?" is answered correctly with no
		// tools needed, and must not be told its output was predicted rather than measured.
		expect(claimedActionOnContinuedSession(new Map(), true, true, 0)).toBe(false);
		expect(claimedStepsWithoutObservedTools(new Map(), true, 3, 0)).toBe(false);
	});

	it("still fires on a continued session that DOES hold files — CUR-705 keeps its caveat", () => {
		// A claim of "I have updated sample_revenue.csv" with zero tool calls, against a workdir holding both
		// files, is checkable and wrong. The narrowing must not reach it.
		expect(claimedActionOnContinuedSession(new Map(), true, true, 2)).toBe(true);
	});

	it("still fires on a fresh session that already claimed steps against files — CUR-574 keeps its caveat", () => {
		expect(claimedStepsWithoutObservedTools(new Map(), true, 1, 1)).toBe(true);
	});

	it("treats an absent count as unknown and stays quiet, rather than as an empty workdir", () => {
		// A service build older than `session_files_at_start` sends nothing. Firing on unknown would make an
		// unearned claim, and so would assuming zero. Both checks go quiet
		// until agent-service ships its half — see sessionHadSomethingToMeasure.
		expect(claimedActionOnContinuedSession(new Map(), true, true, undefined)).toBe(false);
		expect(claimedStepsWithoutObservedTools(new Map(), true, 3, undefined)).toBe(false);
	});

	it("reads only zero-versus-non-zero, never the count itself", () => {
		// The service's count saturates one past its own file cap, so nothing may depend on its
		// magnitude. One file is as much grounds as twenty.
		expect(sessionHadSomethingToMeasure(1)).toBe(true);
		expect(sessionHadSomethingToMeasure(21)).toBe(true);
		expect(sessionHadSomethingToMeasure(0)).toBe(false);
		expect(sessionHadSomethingToMeasure(undefined)).toBe(false);
	});
});

describe("noticeForCaveat", () => {
	it("gives the two tool-stream branches a sentence that does not claim files were written", () => {
		// One sentence must not serve all four verdicts. These two branches observe an empty tool
		// stream and know nothing about what the turn wrote, so "wrote files" is not theirs to say.
		for (const reason of ["claimed-not-observed", "continued-session-no-action"] as const) {
			const notice = noticeForCaveat(reason);
			expect(notice).toBe(UNOBSERVED_ACTION_NOTICE);
			expect(notice).not.toContain("wrote files");
		}
	});

	it("keeps the wrote-and-never-ran sentence for the branch that proved an edit happened", () => {
		// wroteNotRun is the one verdict backed by both an `edit` tool call and a code artifact, so it is
		// the one place the original sentence is literally true.
		expect(noticeForCaveat("wrote-not-run")).toBe(UNRUN_CODE_NOTICE);
		expect(noticeForCaveat("wrote-not-run")).toContain("wrote files");
	});

	it("keeps the structural-failure sentence distinct from every overclaim sentence", () => {
		expect(noticeForCaveat("service-verdict-structural")).toBe(STRUCTURAL_FAILURE_NOTICE);
		expect(noticeForCaveat("service-verdict-structural")).not.toBe(UNRUN_CODE_NOTICE);
		expect(noticeForCaveat("service-verdict-structural")).not.toBe(UNOBSERVED_ACTION_NOTICE);
	});

	it("returns empty for no verdict rather than throwing, so a caveat bug cannot eat a real answer", () => {
		expect(noticeForCaveat(null)).toBe("");
	});
});

describe("wroteCodeWithoutRunningIt", () => {
	// Direct unit coverage, beside the indirect SSE-integration coverage (CUR-775); the parameter is a
	// Map<string, number>.
	it("requires an edit among only inert kinds", () => {
		expect(wroteCodeWithoutRunningIt(new Map([["edit", 1]]))).toBe(true);
		expect(
			wroteCodeWithoutRunningIt(
				new Map([
					["edit", 1],
					["read", 3],
				])
			)
		).toBe(true);
	});

	it("stays quiet without an edit at all", () => {
		expect(wroteCodeWithoutRunningIt(new Map([["read", 1]]))).toBe(false);
		expect(wroteCodeWithoutRunningIt(new Map())).toBe(false);
	});

	it("stays quiet when any non-inert (executing) kind ran alongside the edit", () => {
		expect(
			wroteCodeWithoutRunningIt(
				new Map([
					["edit", 1],
					["execute", 1],
				])
			)
		).toBe(false);
	});
});

describe("editedCodeArtifact", () => {
	it("fires on a recognised code extension", () => {
		expect(editedCodeArtifact([{ name: "sieve.py" }])).toBe(true);
	});

	it("stays quiet on plain text — CUR-592's benefits-letter shape", () => {
		expect(editedCodeArtifact([{ name: "benefits-letter.txt" }])).toBe(false);
	});

	it("stays quiet on no artifacts at all", () => {
		expect(editedCodeArtifact([])).toBe(false);
	});

	it("stays quiet on a name with no extension, or a dotfile with nothing before the dot", () => {
		// "we know nothing, so say nothing" — same posture INERT_TOOL_KINDS takes on an unrecognised
		// tool kind, applied here to an unrecognised (or absent) extension.
		expect(editedCodeArtifact([{ name: "README" }])).toBe(false);
		expect(editedCodeArtifact([{ name: ".gitignore" }])).toBe(false);
		expect(editedCodeArtifact([{ name: "trailing." }])).toBe(false);
	});

	it("fires if ANY artifact in the list matches, not just the first", () => {
		expect(editedCodeArtifact([{ name: "notes.txt" }, { name: "calc.py" }])).toBe(true);
	});

	it("matches the extension case-insensitively", () => {
		expect(editedCodeArtifact([{ name: "Script.PY" }])).toBe(true);
	});

	it("treats a missing or blank name as no evidence, not a match", () => {
		expect(editedCodeArtifact([{}])).toBe(false);
		expect(editedCodeArtifact([{ name: "" }])).toBe(false);
		expect(editedCodeArtifact([{ name: "   " }])).toBe(false);
	});
});

	// ── a claimed step with no tool behind it, on a transport that would have shown one (CUR-574) ────
	// wroteCodeWithoutRunningIt only fires when THIS turn's own tool_call frames show an edit-and-
	// nothing-else. A follow-up that calls no tool at all ("actually run it," answered with numbers, zero
	// tool_call frames) would slip past that check even though the ACP transport (which reports every tool
	// call) proves nothing ran, and can come back with fabricated months from test data that only covers
	// Jan-Apr.

	it("flags a follow-up that answers with no tool call at all, when the service claims a step ran", async () => {
		const { chunks } = await agentRun([
			frame("usage", { tokens: 5235, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				// The session held the file the agent was asked to re-run (top_months.py), so "claimed a
				// step, called nothing" has something to bite on. Stated in the coarse-transport
				// case below too, so that test stays quiet for the transport gate alone rather than for two
				// reasons at once. (CUR-1394)
				session_files_at_start: 2,
				result: "The three best months are 2025-10, 2025-08, 2025-09.",
				transport_used: "acp",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		// This branch observes an empty tool stream and cannot know what was written, so it does
		// not use the wrote-and-never-ran sentence. The warning stays; the claim narrows. (CUR-1394)
		expect(afterThink).toContain("no tool call was observed");
		expect(afterThink).not.toContain("wrote files");
		expect(afterThink).toContain("2025-10, 2025-08, 2025-09"); // the answer itself is untouched
	});

	// `usage.steps` is the model-call count, at least 1 on every answer, so the shape above also
	// matched an honest "I cannot send emails" in a conversation holding a file. The service's no-tool review
	// now says when the answer claimed nothing. (CUR-4599)
	for (const verdict of ["declined", "answered"]) {
		it(`stays quiet on that shape when the service's no-tool review calls the answer ${verdict}`, async () => {
			const { chunks } = await agentRun([
				frame("usage", { tokens: 8675, steps: 1 }),
				frame("done", {
					state: "COMPLETED",
					session_files_at_start: 1,
					session_continued: true,
					no_tool_answer: verdict,
					result: "I cannot send emails. You will need to attach heating_repair_request.docx and send it yourself.",
					transport_used: "acp",
				}),
			]);
			const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
			expectNoUnrunCaveat(answer);
			expect(answer).toContain("I cannot send emails.");
		});
	}

	it("still flags that shape when the no-tool review says anything else (a narrated run is retried, never cleared)", async () => {
		const { chunks } = await agentRun([
			frame("usage", { tokens: 5235, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				session_files_at_start: 2,
				no_tool_answer: "narrated",
				result: "The three best months are 2025-10, 2025-08, 2025-09.",
				transport_used: "acp",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer.slice(answer.indexOf("</think>"))).toContain("no tool call was observed");
	});

	it("stays quiet on the same shape when the service claims zero steps — nothing to have missed", async () => {
		// The control for the test above: an empty toolKinds with a genuinely-zero claimed step count
		// (the "reasoned to an answer, no tool needed" case already covered by the transport-log test
		// higher up) must not regress into a false positive just because toolKinds is empty.
		const { chunks } = await agentRun([
			frame("usage", { tokens: 512, steps: 0 }),
			frame("done", { state: "COMPLETED", result: "The answer is 4." }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("stays quiet when the claimed steps are backed by real (if inert) tool calls", async () => {
		// The risk a broad fix here would create: a legitimate multi-step read-and-summarize turn also
		// reports claimed steps > 0 with no execute-capable tool. It must NOT get "wrote files but never
		// ran anything" — it never wrote anything, and the notice would misdescribe it. What distinguishes
		// this from the case above is that toolKinds is non-empty (real tool calls were observed), not
		// merely non-executing.
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "read", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("tool_call", { tool: "search", step: 2 }),
			frame("tool_result", { ok: true, step: 2, summary: "ok" }),
			frame("usage", { tokens: 900, steps: 2 }),
			frame("done", { state: "COMPLETED", result: "Both files agree on the total: $4,200." }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("logs caveatReason:claimed-not-observed for the CUR-574 shape, distinct from CUR-226's", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("usage", { tokens: 5235, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				// CUR-574 asked the agent to re-run top_months.py, so its session held that file
				// and "claimed a step, called nothing" had something to bite on. Stated in the coarse-transport
				// case below too, so that test stays quiet for the transport gate alone rather than for two
				// reasons at once. (CUR-1394)
				session_files_at_start: 2,
				result: "The three best months are 2025-10, 2025-08.",
				transport_used: "acp",
			}),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({
			transport: "acp",
			toolKinds: [],
			claimedSteps: 1,
			unrunCodeCaveat: true,
			caveatReason: "claimed-not-observed",
		});
		infoSpy.mockRestore();
	});

	it("stays quiet on the coarse transport even when a final usage frame claims steps", async () => {
		// The coarse (ACP-off) path never sends tool_call frames at all, so an empty toolKinds there
		// proves nothing — same reasoning as wroteCodeWithoutRunningIt's, applied to this second check.
		// Without the transport gate this would fire on every turn.
		const { chunks } = await agentRun([
			frame("state", { state: "working" }),
			frame("usage", { tokens: 5235, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				// CUR-574 asked the agent to re-run top_months.py, so its session held that file
				// and "claimed a step, called nothing" had something to bite on. Stated in the coarse-transport
				// case below too, so that test stays quiet for the transport gate alone rather than for two
				// reasons at once. (CUR-1394)
				session_files_at_start: 2,
				result: "The three best months are 2025-10, 2025-08.",
				transport_used: "oneshot",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	// ── the repair loop's own verdict, when neither client heuristic can see it (CUR-574 follow-up) ──
	// wroteCodeWithoutRunningIt and claimedStepsWithoutObservedTools both read the tool-call stream this
	// endpoint itself observed. agent-service's in-session repair loop can exhaust its retry budget (or
	// the attempt's wall clock) on a turn that DID call real tools but whose answer repair_check still
	// rejected — there was just nothing left to retry with. That verdict never shows up as an absent tool
	// call, so it rides the wire directly as `done.unrun_detail` instead of being re-derived here.

	it("flags a turn real tool calls back but the service's own repair check rejected", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "execute", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("usage", { tokens: 4000, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "The script found 12 matches.",
				unrun_detail: "wrote-and-never-ran:tool-call-failed:execute",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		expect(afterThink).toContain("never ran anything");
		expect(afterThink).toContain("12 matches"); // the answer itself is untouched
	});

	it("stays quiet when unrun_detail is absent", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "execute", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("done", { state: "COMPLETED", result: "The script found 12 matches." }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("stays quiet when unrun_detail is the empty string, not just absent", async () => {
		// _done_payload always sends the key (Task.unrun_detail defaults to ""); only a non-blank value
		// should caveat, or every ordinary completed turn would trip this the moment the field shipped.
		const { chunks } = await agentRun([
			frame("done", { state: "COMPLETED", result: "The script found 12 matches.", unrun_detail: "" }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("logs caveatReason:service-verdict, distinct from the two client-observed shapes", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("tool_call", { tool: "execute", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("usage", { tokens: 4000, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "The script found 12 matches.",
				unrun_detail: "wrote-and-never-ran:tool-call-failed:execute",
			}),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({
			toolKinds: ["execute"],
			unrunCodeCaveat: true,
			caveatReason: "service-verdict",
		});
		infoSpy.mockRestore();
	});

	// CUR-855/846: a structural failure (gateway down, wall-clock cap, the agent process crashing) is a
	// different claim than the other four unrun_detail shapes above — those all mean "the agent
	// overclaimed what it did," which UNRUN_CODE_NOTICE ("wrote files but never ran anything") describes
	// accurately. A structural failure tried and didn't finish; that sentence would be false there.
	it("shows honest structural-failure copy, not the overclaim notice, for structural-failure: unrun_detail", async () => {
		const { chunks } = await agentRun([
			frame("done", {
				state: "FAILED",
				result: "Partial output before the gateway dropped.",
				unrun_detail: "structural-failure:attempt 2: model gateway unavailable (RuntimeError)",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer).toContain("did not finish");
		expectNoUnrunCaveat(answer);
		expect(answer).toContain("Partial output before the gateway dropped."); // the answer itself is untouched
	});

	it("logs caveatReason:service-verdict-structural, distinct from an overclaim service-verdict", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("done", {
				state: "FAILED",
				result: "Partial output before the gateway dropped.",
				unrun_detail: "structural-failure:attempt 2: model gateway unavailable (RuntimeError)",
			}),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({
			unrunCodeCaveat: true,
			caveatReason: "service-verdict-structural",
		});
		infoSpy.mockRestore();
	});

	// ── CUR-1341: the same verdict carried as structure, so the reasoning panel's header can read it ──
	// The header at OpenReasoningResults.svelte read `loading ? "Computing…" : "Computed"` — whether the
	// block finished STREAMING, which is a different question — so a turn whose answer opens "This turn
	// wrote files but never ran anything" rendered "Computed" one line above the sentence denying it,
	// and the header is what a reader who never expands the block walks away with.
	//
	// These name the COUPLING, not the chunk on its own, and the names say so: what has to hold is that
	// the prose and the structured flag fire on exactly the same turns. Two independent conditions are
	// what let the two lines disagree in the first place, so a test that only checked the chunk existed
	// would pass just as happily on the arrangement that produced the bug.

	it("emits an unrunCode chunk on the same turn the prose caveat fires, never one without the other", async () => {
		const { chunks } = await agentRun([
			frame("plan", { attempt: 1, steps: ["edit"] }),
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "210 bytes" }),
			frame("usage", { tokens: 5094, steps: 1 }),
			frame("done", {
				state: "COMPLETED",
				result: "Execution result:\n25 primes; last three [97, 89, 83].",
				artifacts: [{ name: "sieve.py", bytes: 210, text: "primes = [2, 3, 5]\n", truncated: false }],
			}),
		]);
		const unrunChunks = chunks.filter((c) => (c as { unrunCode?: unknown }).unrunCode) as unknown as {
			token: { text: string };
			unrunCode: { reason: string };
		}[];
		expect(unrunChunks).toHaveLength(1);
		expect(unrunChunks[0].unrunCode).toEqual({ reason: "wrote-not-run" });
		// Structured signal on an empty-text chunk — same contract as writePolicy/agentTools above. It
		// must not reach the think block as prose; the panel renders it as a header, not as content.
		expect(unrunChunks[0].token.text).toBe("");

		// The other half of the coupling, and the half the ticket is actually about.
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer.slice(answer.indexOf("</think>"))).toContain("never ran anything");
	});

	it("emits no unrunCode chunk on a turn that genuinely ran what it wrote, so the header keeps saying Computed", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "210 bytes" }),
			frame("tool_call", { tool: "execute", step: 2 }),
			frame("tool_result", { ok: true, step: 2, summary: "25 primes" }),
			frame("done", { state: "COMPLETED", result: "25 primes; last three [97, 89, 83]." }),
		]);
		expect(chunks.some((c) => (c as { unrunCode?: unknown }).unrunCode)).toBe(false);
		expect(chunks.find((c) => c.generated_text)?.generated_text ?? "").not.toContain(
			"never ran anything"
		);
	});

	it("carries service-verdict-structural apart from an overclaim, the split the header copy turns on", async () => {
		// The panel says "Did not finish" here and "Predicted" for the four overclaim reasons, matching
		// the split the answer prefix already makes between STRUCTURAL_FAILURE_NOTICE and
		// UNRUN_CODE_NOTICE. Collapsing the reason to a bare boolean on the wire would make that
		// impossible to render, which is why this rides as a reason rather than a flag.
		const { chunks } = await agentRun([
			frame("done", {
				state: "FAILED",
				result: "Partial output before the gateway dropped.",
				unrun_detail: "structural-failure:attempt 2: model gateway unavailable (RuntimeError)",
			}),
		]);
		const unrunChunks = chunks.filter((c) => (c as { unrunCode?: unknown }).unrunCode) as unknown as {
			unrunCode: { reason: string };
		}[];
		expect(unrunChunks).toHaveLength(1);
		expect(unrunChunks[0].unrunCode).toEqual({ reason: "service-verdict-structural" });
	});

	it("flags a bare \"Done.\" the same as any other answer, which is the case it matters most on", async () => {
		// `unrunCodeCaveat` is gated on `answer.trim()`, and this is the turn that looks like it should
		// trip that guard and does not: an empty `result` on a COMPLETED task is replaced by the literal
		// "Done." before the check runs (endpointAgent.ts, the `ev.result ?? ""` fallback), so the answer
		// is never actually empty on this path and the caveat fires normally.
		//
		// That is the right behaviour rather than an accident worth working around. A turn that wrote a
		// script, ran none of it, and reports "Done." is the most misleading shape this caveat exists for
		// — there is no output for a reader to be suspicious of, just a claim of completion. It is also
		// the turn where the panel header carries the most weight, since "Done." plus "Computed" is the
		// entire visible result.
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "210 bytes" }),
			frame("done", {
				state: "COMPLETED",
				result: "",
				artifacts: [{ name: "sieve.py", bytes: 210, text: "primes = [2, 3, 5]\n", truncated: false }],
			}),
		]);
		const unrunChunks = chunks.filter((c) => (c as { unrunCode?: unknown }).unrunCode) as unknown as {
			unrunCode: { reason: string };
		}[];
		expect(unrunChunks).toHaveLength(1);
		expect(unrunChunks[0].unrunCode).toEqual({ reason: "wrote-not-run" });
		// Still coupled to the prose, same as every other case above.
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		// A wrote-not-run verdict: an edit tool ran and left sieve.py, so this keeps the original
		// sentence — it is the one branch that genuinely proved a file was written (CUR-1394).
		expect(answer.slice(answer.indexOf("</think>"))).toContain("never ran anything");
	});

	// ── a continued-session follow-up that calls no tool at all, and never even claims a step (CUR-705) ─
	// The CUR-574 shape above still has ONE structured signal to compare against: a `usage` frame
	// claiming steps > 0. This turn had none — no plan, no tool_call, no usage/steps — while its prose
	// claimed a file was edited and a script re-run, with wrong numbers. `claimedStepsWithoutObserved
	// Tools` requires a claimed step count precisely so it stays quiet, which is correct for a fresh
	// session's plain question but wrong here: `session_continued` is what tells the two apart.

	it("flags a continued-session follow-up with zero tool frames and zero claimed steps", async () => {
		const { chunks } = await agentRun([
			frame("done", {
				state: "COMPLETED",
				result: "I have updated sample_revenue.csv and run top_months.py again. June, March, May.",
				session_continued: true,
				session_files_at_start: 2,   // CUR-1394: this shape's session holds prior files
				transport_used: "acp",
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		// The session held both files the answer claims to have touched, so it keeps its caveat (CUR-705).
		// The sentence asserts only that no tool call was observed — an empty tool stream cannot tell us a
		// file was written (CUR-1394).
		expect(afterThink).toContain("no tool call was observed");
		expect(afterThink).not.toContain("wrote files");
		expect(afterThink).toContain("June, March, May"); // the answer itself is untouched
	});

	it("stays quiet on the identical shape when the session is NOT continued", async () => {
		// The control: same zero-frame shape, but a fresh/sessionless task, where a plain "what's the
		// answer" question legitimately needs no tool and reports nothing.
		const { chunks } = await agentRun([
			frame("done", { state: "COMPLETED", result: "The answer is 4." }),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("stays quiet on a continued session when a real tool actually ran", async () => {
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_result", { ok: true, step: 1, summary: "ok" }),
			frame("done", {
				state: "COMPLETED",
				result: "Added the June rows. June, March, May.",
				session_continued: true,
				session_files_at_start: 2,   // CUR-1394: this shape's session holds prior files
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expectNoUnrunCaveat(answer);
	});

	it("logs caveatReason:continued-session-no-action, distinct from the other three shapes", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
		await agentRun([
			frame("done", {
				state: "COMPLETED",
				result: "I have updated the file.",
				session_continued: true,
				session_files_at_start: 2,   // CUR-1394: this shape's session holds prior files
				transport_used: "acp",
			}),
		]);
		const call = infoSpy.mock.calls.find(([, msg]) => msg === "[agent] tool-frame observability");
		expect(call?.[0]).toMatchObject({
			transport: "acp",
			toolKinds: [],
			sessionContinued: true,
			unrunCodeCaveat: true,
			caveatReason: "continued-session-no-action",
		});
		infoSpy.mockRestore();
	});

	// ── the agent's files reach the reader (CUR-228 / CUR-195) ───────────────────────────────────────

	it("renders the files the turn produced, which the wire has always carried", async () => {
		// A sieve script redirects stdout to a file, so the run's REAL numbers live in primes_output.txt and
		// nowhere in the answer prose (CUR-226). `done.artifacts` carries that file (CUR-195), and the client
		// must render it, not only `ev.result`.
		const { chunks } = await agentRun([
			frame("tool_call", { tool: "edit", step: 1 }),
			frame("tool_call", { tool: "execute", step: 2 }),
			frame("done", {
				state: "COMPLETED",
				result: "I wrote the sieve and ran it.",
				artifacts: [
					{ name: "sieve.py", bytes: 210, text: "primes = [2, 3, 5]\n", truncated: false },
					{ name: "primes_output.txt", bytes: 44, text: "25\n[83, 89, 97]\n", truncated: false },
				],
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		const afterThink = answer.slice(answer.indexOf("</think>"));
		expect(afterThink).toContain("primes_output.txt");
		expect(afterThink).toContain("[83, 89, 97]"); // the measured order, not the fabricated one
		expect(afterThink).toContain("sieve.py");
	});

	it("still hands back what a failed turn wrote", async () => {
		// A half-written file is the most useful thing a failure can return, and it is exactly the turn
		// whose prose is least worth trusting. The un-run caveat is deliberately narrower than this.
		const { chunks } = await agentRun([
			frame("done", {
				state: "FAILED",
				artifacts: [{ name: "half.py", bytes: 12, text: "def parse(\n", truncated: false }],
			}),
		]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer).toContain("half.py");
		expect(answer).toContain("def parse(");
	});

	it("adds nothing when the turn produced no files", async () => {
		const { chunks } = await agentRun([frame("done", { state: "COMPLETED", result: "No files needed." })]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer).not.toContain("Files this turn produced");
	});

	// ── X-Agent-Subject: per-visitor attribution under one shared service token ───────────────────────
	it("sends a derived per-visitor subject on BOTH the submit and the event stream", async () => {
		const { fetchMock } = await agentRun(
			[frame("done", { state: "COMPLETED", result: "ok." })],
			{ locals: { sessionId: "session-cookie-value" } },
			"svc-token"
		);
		const sent = fetchMock.mock.calls.map((_, i) => headersOf(fetchMock.mock.calls, i));
		expect(sent).toHaveLength(2); // POST /run and GET /run/t1/events

		// A GOLDEN VECTOR, not a recomputation. Asserting `deriveAgentSubject(...)` here would pass
		// under any derivation at all, including the unkeyed one this replaced — the test would be
		// measuring itself. This literal is HMAC-SHA256("svc-token", "agent-subject:session-cookie-value")
		// truncated to 128 bits. If you change the construction this goes red, which is the point:
		// changing it re-buckets every existing visitor's quota, so it must be a deliberate act.
		const expected = "df85e7735453f9a68998430139c8ac43";
		for (const h of sent) expect(h).toMatchObject({ "x-agent-subject": expected });
		expect(expected).toMatch(/^[0-9a-f]{32}$/);

		// NEVER the raw session id: that value IS the session cookie (auth.ts refreshSessionCookie), so
		// forwarding it would hand another service a session-hijacking credential to store.
		for (const h of sent) {
			expect(JSON.stringify(h)).not.toContain("session-cookie-value");
		}

		// And never an UNKEYED digest of the visitor. The signed-in id is email-derived, so a plain hash
		// of it is a confirm-this-address oracle for anyone holding the service's task table — hashing a
		// low-entropy input protects nothing. This assertion catches an empty-token path: with no key,
		// an unkeyed hash would emit exactly this value.
		expect(expected).not.toBe((await sha256("agent-subject::session-cookie-value")).slice(0, 32));
		expect(expected).not.toBe((await sha256("session-cookie-value")).slice(0, 32));
	});

	it("omits the subject rather than sending an unkeyed digest when no service token is set", async () => {
		// REACHABLE, not hypothetical: apiKey is `z.string().default("")` and the schema documents it as
		// empty whenever the agent service's own auth is disabled. The header is the only thing we can
		// safely drop here — an unkeyed digest of an email-derived id is the oracle described above, and
		// a placeholder subject would ration every visitor as one shared bucket. endpointAgent logs once
		// at construction so this degradation is visible instead of silent.
		const { fetchMock } = await agentRun(
			[frame("done", { state: "COMPLETED", result: "ok." })],
			{ locals: { sessionId: "session-cookie-value" } },
			"" // no service token
		);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
		fetchMock.mock.calls.forEach((_, i) =>
			expect(headersOf(fetchMock.mock.calls, i)).not.toHaveProperty("x-agent-subject")
		);
	});

	it("derives nothing without a key, and a stable 128-bit value with one", () => {
		// The unit-level contract, exercised directly so the properties are pinned independently of a
		// whole simulated run.
		expect(deriveAgentSubject("", "visitor")).toBe("");
		expect(deriveAgentSubject("k", "")).toBe("");
		expect(deriveAgentSubject("k", "visitor")).toMatch(/^[0-9a-f]{32}$/);
		// Deterministic for the same pair (quota buckets have to be stable across turns) …
		expect(deriveAgentSubject("k", "visitor")).toBe(deriveAgentSubject("k", "visitor"));
		// … and separated by BOTH inputs: a different visitor, and a rotated token.
		expect(deriveAgentSubject("k", "a")).not.toBe(deriveAgentSubject("k", "b"));
		expect(deriveAgentSubject("k1", "a")).not.toBe(deriveAgentSubject("k2", "a"));
	});

	it("CUR-4402: tells agent-service the visitor is signed in only when there is an account", () => {
		const user = { user: { _id: "u1" }, sessionId: "s1" } as unknown as App.Locals;
		const guest = { sessionId: "s1" } as unknown as App.Locals;
		expect(agentServiceHeaders("k", user)).toMatchObject({ "x-agent-account": "user" });
		expect(agentServiceHeaders("k", guest)).not.toHaveProperty("x-agent-account");
		expect(agentServiceHeaders("k", undefined)).not.toHaveProperty("x-agent-account");
	});

	it("CUR-4620: tells agent-service a team account's 1,000-task allowance, and sends nothing for anyone else", () => {
		const team = { user: { _id: "u1", email: "someone@currentai.org", emailVerified: true }, sessionId: "s1" } as unknown as App.Locals;
		const unverified = { user: { _id: "u2", email: "someone@currentai.org", emailVerified: false }, sessionId: "s2" } as unknown as App.Locals;
		const stranger = { user: { _id: "u3", email: "stranger@example.com", emailVerified: true }, sessionId: "s3" } as unknown as App.Locals;
		expect(agentServiceHeaders("k", team)).toMatchObject({ "x-agent-subject-daily-tasks": "1000" });
		expect(agentServiceHeaders("k", unverified)).not.toHaveProperty("x-agent-subject-daily-tasks");
		expect(agentServiceHeaders("k", stranger)).not.toHaveProperty("x-agent-subject-daily-tasks");
	});

	it("keys a signed-in visitor on the user id, not the session cookie", async () => {
		const { fetchMock } = await agentRun(
			[frame("done", { state: "COMPLETED", result: "ok." })],
			{ locals: { sessionId: "cookie-abc", user: { _id: "user-42" } } },
			"svc-token"
		);
		const h = headersOf(fetchMock.mock.calls, 0);
		// Recomputing via deriveAgentSubject is right HERE — the claim under test is WHICH input was
		// keyed on, a relationship between two derivations, not the derivation itself. The construction
		// is pinned by the golden vector above.
		expect(h["x-agent-subject"]).toBe(deriveAgentSubject("svc-token", "user-42"));
		// the session cookie is present on locals and must not be what we keyed on
		expect(h["x-agent-subject"]).not.toBe(deriveAgentSubject("svc-token", "cookie-abc"));
	});

	it("one endpoint serving two visitors does not leak the first visitor's subject onto the second", async () => {
		// The regression this guards: the headers object is built ONCE per endpoint and reused by every
		// concurrent turn. Setting the subject on it, instead of on a per-request copy, would attribute
		// one visitor's run to another — and silently, since both requests still succeed.
		const { factory, fetchMock } = await agentRun(
			[frame("done", { state: "COMPLETED", result: "ok." })],
			{ locals: { sessionId: "visitor-one" } },
			"svc-token"
		);
		const first = headersOf(fetchMock.mock.calls, 0);

		await drain(factory, { locals: { sessionId: "visitor-two" } });
		const second = headersOf(fetchMock.mock.calls, 2); // visitor two's POST /run

		expect(second["x-agent-subject"]).not.toBe(first["x-agent-subject"]);
		expect(first["x-agent-subject"]).toBe(deriveAgentSubject("svc-token", "visitor-one"));
		expect(second["x-agent-subject"]).toBe(deriveAgentSubject("svc-token", "visitor-two"));
	});

	it("omits the subject header entirely when there is no visitor to name", async () => {
		// Dev and the hermetic suite call the endpoint with no locals. An empty or placeholder subject
		// would be worse than none: the service would ration every such caller as one shared visitor.
		const { fetchMock } = await agentRun([frame("done", { state: "COMPLETED", result: "ok." })]);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
		fetchMock.mock.calls.forEach((_, i) =>
			expect(headersOf(fetchMock.mock.calls, i)).not.toHaveProperty("x-agent-subject")
		);
	});

	// ── CUR-895: pin the events stream to the machine that created the task ──────────────────────────
	// Task state (TASKS + the SQLite mirror) lives on whichever Fly machine ran /run, and a multi-machine
	// deploy has no session affinity by default — the GET /run/{id}/events open below is a SEPARATE
	// request from the POST that could land on a machine that never saw the task and 404 immediately
	// (CUR-651).
	it("pins the events stream to the machine /run reports", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1", machine_id: "3d8d9djklxyz01" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return {
					ok: true,
					status: 200,
					body: sseStream([frame("done", { state: "COMPLETED", result: "ok." })]),
				} as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		await drain(factory);
		const h = headersOf(fetchMock.mock.calls, 1); // GET /run/t1/events
		expect(h["Fly-Force-Instance-Id"]).toBe("3d8d9djklxyz01");
		expect(headersOf(fetchMock.mock.calls, 0)).not.toHaveProperty("Fly-Force-Instance-Id"); // POST /run itself has no machine to pin to yet
	});

	it("records the task and its machine before any other chunk streams, so a closed tab leaves the handle behind (CUR-993)", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: "t1", machine_id: "3d8d9djklxyz01" }),
					text: async () => "",
				} as Response;
			if (u.includes("/run/t1/events"))
				return {
					ok: true,
					status: 200,
					body: sseStream([frame("done", { state: "COMPLETED", result: "ok." })]),
				} as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = (await drain(factory)) as Array<{ agentRun?: unknown; routerMetadata?: unknown }>;
		const runAt = chunks.findIndex((c) => c.agentRun);
		expect(chunks[runAt]?.agentRun).toEqual({ taskId: "t1", machineId: "3d8d9djklxyz01" });
		expect(runAt).toBeLessThan(chunks.findIndex((c) => c.routerMetadata));
	});

	it("re-attaches to the stored task without submitting a new one, on the machine that holds it (CUR-993)", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes("/run/t-stored/events"))
				return {
					ok: true,
					status: 200,
					body: sseStream([frame("done", { state: "COMPLETED", result: "Finished while you were away." })]),
				} as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = (await drain(factory, {
			agentAttach: { taskId: "t-stored", machineId: "3d8d9djklxyz01" },
		})) as Array<{ agentRun?: unknown; generated_text: string | null }>;
		expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(["http://agent.test/run/t-stored/events"]);
		expect(headersOf(fetchMock.mock.calls, 0)).toHaveProperty("Fly-Force-Instance-Id", "3d8d9djklxyz01");
		expect(chunks.find((c) => c.agentRun)?.agentRun).toEqual({ taskId: "t-stored", machineId: "3d8d9djklxyz01" });
		expect(chunks.at(-1)?.generated_text).toContain("Finished while you were away.");
	});

	it("closes the handle when agent-service no longer holds the stored task, so a reload doesn't retry it (CUR-993)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 404, body: null }) as unknown as Response)
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = (await drain(factory, { agentAttach: { taskId: "t-gone" } })) as Array<{
			agentRun?: { closed?: boolean };
			generated_text: string | null;
		}>;
		expect(chunks.filter((c) => c.agentRun).at(-1)?.agentRun).toEqual({ taskId: "t-gone", closed: true });
		expect(chunks.at(-1)?.generated_text).toContain("no longer held by the agent service");
	});

	it("leaves the handle open on a 404 for a fresh task: only a re-attach reads it as gone", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) =>
				String(url).endsWith("/run")
					? ({ ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response)
					: ({ ok: false, status: 404, body: null } as unknown as Response)
			)
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = (await drain(factory)) as Array<{ agentRun?: { closed?: boolean } }>;
		expect(chunks.some((c) => c.agentRun?.closed)).toBe(false);
	});

	// ── CUR-4393: a follow-up goes to the machine that holds the conversation's workdir ─────────────
	const earlierAgentTurn = [
		{ from: "user", content: "make notes.txt" },
		{ from: "assistant", content: "done", agentRun: { taskId: "t0", machineId: "owner-machine" } },
		{ from: "user", content: "print notes.txt" },
	];
	function followUpFetch(runStatus: (pinned: string | undefined) => number, frames: string[]) {
		return vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/run")) {
				const pinned = (init?.headers as Record<string, string>)["Fly-Force-Instance-Id"];
				const status = runStatus(pinned);
				return {
					ok: status < 400,
					status,
					json: async () => ({ id: "t1", machine_id: pinned ?? "other-machine" }),
					text: async () => "",
				} as Response;
			}
			if (u.includes("/run/t1/events"))
				return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
			throw new Error(`unexpected url ${u}`);
		});
	}
	const runBodies = (calls: unknown[][]) =>
		calls
			.filter(([u]) => String(u).endsWith("/run"))
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

	it("pins a follow-up /run to the machine that ran the conversation's earlier agent turn and says it continues", async () => {
		const fetchMock = followUpFetch(() => 200, [frame("done", { state: "COMPLETED", result: "kestrel" })]);
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		await drain(factory, { messages: earlierAgentTurn, conversationId: "conv-1" });
		expect(headersOf(fetchMock.mock.calls, 0)).toHaveProperty("Fly-Force-Instance-Id", "owner-machine");
		expect(runBodies(fetchMock.mock.calls)).toEqual([
			expect.objectContaining({ session_id: "conv-1", continues_session: true }),
		]);
	});

	it("resubmits unpinned when the owning machine is gone, still saying the session continues", async () => {
		const fetchMock = followUpFetch((pinned) => (pinned ? 503 : 200), [
			frame("done", { state: "COMPLETED", result: "No such file.", expired: true }),
		]);
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = await drain(factory, { messages: earlierAgentTurn, conversationId: "conv-1" });
		const runCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/run"));
		expect(runCalls).toHaveLength(2);
		expect(headersOf(runCalls, 1)).not.toHaveProperty("Fly-Force-Instance-Id");
		expect(runBodies(fetchMock.mock.calls)[1]).toMatchObject({ continues_session: true });
		expect(chunks.at(-1)?.generated_text).toMatch(/<\/think>\n_The files from earlier in this conversation are no longer available[^\n]*\n\nNo such file\.$/);
	});

	it("keeps a 429 from the owning machine as a capacity answer rather than moving the session", async () => {
		const fetchMock = followUpFetch(() => 429, []);
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = await drain(factory, { messages: earlierAgentTurn, conversationId: "conv-1" });
		expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/run"))).toHaveLength(1);
		expect(chunks.at(-1)?.generated_text).toContain("at capacity");
	});

	it("sends no pin and no continues flag on a conversation's first agent turn", async () => {
		const fetchMock = followUpFetch(() => 200, [frame("done", { state: "COMPLETED", result: "ok." })]);
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const chunks = await drain(factory, { conversationId: "conv-1" });
		expect(headersOf(fetchMock.mock.calls, 0)).not.toHaveProperty("Fly-Force-Instance-Id");
		expect(runBodies(fetchMock.mock.calls)[0]).not.toHaveProperty("continues_session");
		expect(chunks.at(-1)?.generated_text).not.toContain("no longer available");
	});

	it("omits the pin header when the service reports no machine_id (off Fly, or an older build)", async () => {
		const { fetchMock } = await agentRun([frame("done", { state: "COMPLETED", result: "ok." })]);
		const h = headersOf(fetchMock.mock.calls, 1);
		expect(h).not.toHaveProperty("Fly-Force-Instance-Id");
	});
});

// Each SSE frame the agent service sends is expected to name its event and parse as JSON, and
// the stream to end on a done frame, a timeout or a stop. A keepalive is expected; the rest is a departure. (CUR-68)
describe("endpointAgent fail-open departures", () => {
	async function run(frames: string[]) {
		const warn = vi.spyOn(logger, "warn");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const u = String(url);
				if (u.endsWith("/run"))
					return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
				if (u.includes("/run/t1/events"))
					return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
				throw new Error(`unexpected url ${u}`);
			})
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "go" }] } as Parameters<typeof factory>[0]);
		for await (const _ of stream) void _;
		const out = warn.mock.calls
			.map((c) => c[0] as unknown as Record<string, unknown>)
			.filter((o) => o && typeof o === "object" && "failopen" in o)
			.map((o) => `${String(o.failopen)}:${String(o.reason)}`);
		warn.mockRestore();
		return out;
	}
	const done = frame("done", { state: "COMPLETED", result: "ok", verified: false });

	it("records nothing for a clean run with a keepalive in it", async () => {
		expect(await run([": keepalive\n\n", frame("state", { state: "working" }), done])).toEqual([]);
	});

	it("records a frame with data but no event name", async () => {
		expect(await run(['data: {"state":"working"}\n\n', done])).toEqual(["agent-frame:unnamed-event"]);
	});

	it("records a frame whose data does not parse", async () => {
		expect(await run(["event: tool_call\ndata: {not json\n\n", done])).toEqual(["agent-frame:unparseable-json"]);
	});

	it("records a stream that ends with no done frame", async () => {
		expect(await run([frame("state", { state: "working" })])).toEqual(["agent-stream:ended-without-result"]);
	});
});

// textGeneration/index.ts hardens the last user turn for every model, agent turns included,
// which rewrites it into grounding.ts's whole user-role preamble plus a <Q_…> fence. The agent service
// must not read that rewritten turn as its task, or a question it cannot read (Tzeltal, say) comes
// back as the preamble's own decline rule ("I don't have real steps for this query…"). (CUR-750)
describe("endpointAgent task text (CUR-750)", () => {
	it("sends the person's own words as the task, never the hardened grounding preamble", async () => {
		const { hardenLastUserTurn } = await import("$lib/chat/server/textGeneration/grounding");
		const original = "Bin ut'il ya xju' ya akoltayon?";
		const messages = [{ from: "user" as const, content: original }];
		await hardenLastUserTurn(messages as Parameters<typeof hardenLastUserTurn>[0]);
		// Precondition: hardening really did bury the question under the preamble.
		expect(messages[0].content).toContain("real steps");

		const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			return {
				ok: true,
				status: 200,
				body: sseStream([frame("done", { state: "COMPLETED", result: "ok." })]),
			} as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);

		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", apiKey: "tok", model: {} });
		const stream = await factory({
			messages,
			unhardenedUserText: original,
		} as Parameters<typeof factory>[0]);
		for await (const _ of stream) void _;

		const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/run"));
		if (!submitCall) throw new Error("expected a POST /run call");
		const { prompt } = JSON.parse((submitCall[1] as RequestInit).body as string);
		expect(prompt.trimEnd().endsWith(original)).toBe(true);
		expect(prompt).not.toContain("real steps");
		expect(prompt).not.toMatch(/<\/?Q_[0-9a-f]{8}>/);
	});
});

// The preamble is built per call, so the language a person fixes between two turns reaches
// the next task. Two calls on one endpoint, one with a fixed language and one without. (CUR-3929)
describe("endpointAgent reads replyLanguage per call (CUR-3929)", () => {
	it("prepends the fixed-language preamble on the call that carries one, and today's on the call that does not", async () => {
		const prompts: string[] = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/run")) {
				prompts.push(JSON.parse(init?.body as string).prompt as string);
				return { ok: true, status: 200, json: async () => ({ id: `t${prompts.length}` }), text: async () => "" } as Response;
			}
			if (u.includes("/events")) {
				return {
					ok: true,
					status: 200,
					body: sseStream([frame("done", { state: "COMPLETED", result: "ok", verified: false, model: "m" })]),
				} as unknown as Response;
			}
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", apiKey: "tok", model: {} });
		const drain = async (stream: AsyncIterable<unknown>) => {
			for await (const _ of stream) void _;
		};
		await drain(await factory({ messages: [{ from: "user", content: "resume" }], replyLanguage: "pt" } as Parameters<typeof factory>[0]));
		await drain(await factory({ messages: [{ from: "user", content: "resume" }] } as Parameters<typeof factory>[0]));
		expect(prompts).toHaveLength(2);
		expect(prompts[0].startsWith(agentIdentityPreamble("potluck-agent", "pt"))).toBe(true);
		expect(prompts[0]).toContain("Reply in Portuguese");
		expect(prompts[1].startsWith(agentIdentityPreamble("potluck-agent"))).toBe(true);
		expect(prompts[1]).toContain("(default English)");
	});
});

// The stream is read by eventsource-parser (CUR-4065), so a frame follows the SSE spec rather than the
// single-line LF shape agent-service happens to send today. A reader that split frames on "\n\n" only
// would never yield a frame from a CRLF stream, and the turn would end with no answer. The other two
// cases pin the remaining legal shapes.
describe("endpointAgent reads the event stream by the SSE spec (CUR-4065)", () => {
	async function answerFrom(body: string): Promise<string> {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const u = String(url);
				if (u.endsWith("/run"))
					return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
				if (u.includes("/run/t1/events"))
					return { ok: true, status: 200, body: sseStream([body]) } as unknown as Response;
				throw new Error(`unexpected url ${u}`);
			})
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", apiKey: "tok", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "how many files?" }],
		} as Parameters<typeof factory>[0]);
		let finalText = "";
		for await (const c of stream) {
			const g = (c as { generated_text: string | null }).generated_text;
			if (g) finalText = g;
		}
		return finalText;
	}

	it("a stream with CRLF line ends still delivers the answer", async () => {
		const done = JSON.stringify({ state: "COMPLETED", result: "There are 3 files.", model: "m" });
		expect(await answerFrom(`event: done\r\ndata: ${done}\r\n\r\n`)).toContain("There are 3 files.");
	});

	it("a done event spread over several data: lines is read whole", async () => {
		const pretty = JSON.stringify({ state: "COMPLETED", result: "There are 3 files.", model: "m" }, null, 2);
		const lines = pretty
			.split("\n")
			.map((l) => `data: ${l}`)
			.join("\n");
		expect(await answerFrom(`event: done\n${lines}\n\n`)).toContain("There are 3 files.");
	});

	it("a data: value with extra leading spaces and an id: line still parses", async () => {
		const done = JSON.stringify({ state: "COMPLETED", result: "There are 3 files.", model: "m" });
		// The spec drops one space after the colon and keeps the rest. JSON ignores the second, so this pins
		// that the value parses rather than which spaces survive.
		expect(await answerFrom(`event: done\ndata:  ${done}\nid: 7\n\n`)).toContain("There are 3 files.");
	});
});

// A person has two live agent tasks. A turn chat has given up on must not keep one of them. (CUR-2194)
describe("a turn that ends without the service's result gives back its task slot", () => {
	async function turn(events: () => Response | Promise<Response>, abortSignal?: AbortSignal) {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith("/run") && init?.method === "POST")
				return { ok: true, status: 200, json: async () => ({ id: "t9", machine_id: "m1" }), text: async () => "" } as Response;
			if (u.includes("/run/t9/events")) return events();
			if (u.endsWith("/run/t9") && init?.method === "DELETE") return { ok: true, status: 200 } as Response;
			throw new Error(`unexpected url ${u}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "make me a spreadsheet" }],
			abortSignal,
		} as Parameters<typeof factory>[0]);
		for await (const c of stream) void c;
		const cancels = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
		return { cancels };
	}

	it("a task whose stream drops before its result is canceled at once, on the machine that runs it", async () => {
		const dropping = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(frame("tool_call", { step: 1, tool: "execute_code" })));
				c.error(new TypeError("socket hang up"));
			},
		});
		const { cancels } = await turn(() => ({ ok: true, status: 200, body: dropping }) as unknown as Response);
		expect(cancels).toHaveLength(1);
		expect(String(cancels[0][0])).toBe("http://agent.test/run/t9");
		expect(((cancels[0][1] as RequestInit).headers as Record<string, string>)["Fly-Force-Instance-Id"]).toBe("m1");
	});

	it("a task whose stream closes with no result, or never opens, is canceled", async () => {
		const closed = await turn(
			() => ({ ok: true, status: 200, body: sseStream([frame("tool_call", { step: 1, tool: "x" })]) }) as unknown as Response
		);
		expect(closed.cancels).toHaveLength(1);
		const refused = await turn(() => ({ ok: false, status: 502, body: null }) as unknown as Response);
		expect(refused.cancels).toHaveLength(1);
	});

	it("a finished task is not canceled, and neither is one the caller stopped (Stop cancels it elsewhere)", async () => {
		const finished = await turn(
			() => ({ ok: true, status: 200, body: sseStream([frame("done", { state: "FAILED", error: "x" })]) }) as unknown as Response
		);
		expect(finished.cancels).toHaveLength(0);
		const ctrl = new AbortController();
		const stopped = await turn(() => {
			ctrl.abort();
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		}, ctrl.signal);
		expect(stopped.cancels).toHaveLength(0);
	});
});

describe("endpointAgent — an agent task waiting for a free sandbox (CUR-4584)", () => {
	it("narrates the wait in the progress block, shows it on the live line, and ends it when the task works again", async () => {
		const frames = [
			frame("state", { state: "working" }),
			frame("state", { task_id: "t1", state: "waiting_sandbox", text: "Waiting for a free sandbox…" }),
			frame("state", { task_id: "t1", state: "working" }),
			frame("done", { state: "COMPLETED", result: "It ran." }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const u = String(url);
				if (u.endsWith("/run"))
					return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
				if (u.includes("/run/t1/events"))
					return { ok: true, status: 200, body: sseStream(frames) } as unknown as Response;
				throw new Error(`unexpected url ${u}`);
			})
		);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({ messages: [{ from: "user", content: "run it" }] } as Parameters<typeof factory>[0]);
		const chunks: { token: { text: string }; sandboxWait?: string; generated_text: string | null }[] = [];
		for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
		expect(chunks.flatMap((c) => (c.sandboxWait ? [c.sandboxWait] : []))).toEqual(["waiting", "ready"]);
		const waitAt = chunks.findIndex((c) => c.sandboxWait === "waiting");
		const readyAt = chunks.findIndex((c) => c.sandboxWait === "ready");
		expect(waitAt).toBeLessThan(readyAt);
		expect(chunks.at(-1)?.generated_text).toContain("→ Waiting for a free sandbox…");
		expect(chunks.at(-1)?.generated_text).toContain("It ran.");
	});
});

describe("a turn that ends before the service's done gives an account of the partial run", () => {
	/** Streams a plan, one finished step, one step in flight and some draft prose, then holds the
	 *  stream open until `abort` ends the turn. Returns the final text and the URLs fetched. */
	async function partialTurnEndedBy(abort: (ctrl: AbortController) => void) {
		const enc = new TextEncoder();
		const ctrl = new AbortController();
		const calls: { url: string; method: string }[] = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			calls.push({ url: u, method: init?.method ?? "GET" });
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events")) {
				const signal = init?.signal as AbortSignal;
				let sent = false;
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (!sent) {
							sent = true;
							controller.enqueue(enc.encode(frame("plan", { steps: ["search", "read", "write"] })));
							controller.enqueue(enc.encode(frame("tool_call", { step: 1, tool: "web_search" })));
							controller.enqueue(
								enc.encode(frame("tool_result", { step: 1, ok: true, summary: "found 4 sources" }))
							);
							controller.enqueue(enc.encode(frame("tool_call", { step: 2, tool: "read_file" })));
							controller.enqueue(enc.encode(frame("token", { delta: "Draft: the hall seats 80.", attempt: 1 })));
							setTimeout(() => abort(ctrl), 0);
							return;
						}
						return new Promise<void>((_resolve, reject) => {
							const fail = () => reject(new DOMException("aborted", "AbortError"));
							if (signal.aborted) fail();
							else signal.addEventListener("abort", fail, { once: true });
						});
					},
				});
				return { ok: true, status: 200, body } as unknown as Response;
			}
			return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "research and write it up" }],
			abortSignal: ctrl.signal,
		} as Parameters<typeof factory>[0]);
		let final = "";
		for await (const c of stream) if ((c as { generated_text?: string | null }).generated_text) final = (c as { generated_text: string }).generated_text;
		return { final, calls };
	}

	it("the watchdog ending a turn says it ran out of time and names what was done, what was not, and the draft", async () => {
		const { final } = await partialTurnEndedBy((ctrl) => ctrl.abort(new GenerationWatchdogAbort()));
		expect(final).toContain("The agent ran out of time before finishing");
		expect(final).not.toContain("stopped before it finished");
		expect(final).toContain("1 step of 3 planned finished");
		expect(final).toContain("- web_search: found 4 sources");
		expect(final).toContain("the step in progress (read_file) did not finish");
		expect(final).toContain("2 planned steps did not run");
		expect(final).toContain("Draft: the hall seats 80.");
	});

	it("the watchdog ending a turn cancels its service task, so a follow-up is not refused as another task running", async () => {
		const { calls } = await partialTurnEndedBy((ctrl) => ctrl.abort(new GenerationWatchdogAbort()));
		expect(calls).toContainEqual({ url: "http://agent.test/run/t1", method: "DELETE" });
	});

	it("a person's Stop still says stopped, gives the same account, and leaves the cancel to the Stop route", async () => {
		const { final, calls } = await partialTurnEndedBy((ctrl) => ctrl.abort());
		expect(final).toContain("The agent run was stopped before it finished.");
		expect(final).toContain("- web_search: found 4 sources");
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("an account with nothing finished says so rather than listing nothing", () => {
		const text = partialRunAnswer("timed-out", { finishedSteps: [], unfinishedTools: [], draft: "" });
		expect(text).toContain("no step had finished yet");
		expect(text).toContain(`about ${Math.round((AGENT_SERVICE_WALL_CLOCK_SECS / 60) * 2) / 2} minutes`);
		expect(text).not.toContain("What it had written so far");
	});
});

describe("an agent run longer than one request is handed off to the page, not cut off (CUR-4410)", () => {
	beforeEach(() => {
		handoffFlag.on = true;
	});
	afterEach(() => {
		handoffFlag.on = false;
	});
	type Chunk = {
		token: { text: string };
		generated_text?: string | null;
		agentHandoff?: boolean;
		agentConfirmResult?: unknown;
	};
	/** Streams a plan, a finished step and an open approval card, then holds the stream open the way a
	 *  still-running task does. Returns every chunk and every call the endpoint made. */
	async function longRun(turnDeadlineAt: number | undefined, ctrl = new AbortController()) {
		const enc = new TextEncoder();
		const calls: { url: string; method: string }[] = [];
		let eventsSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			calls.push({ url: u, method: init?.method ?? "GET" });
			if (u.endsWith("/run"))
				return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
			if (u.includes("/run/t1/events")) {
				eventsSignal = init?.signal as AbortSignal;
				let sent = false;
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent)
							return new Promise<void>((_resolve, reject) => {
								const fail = () => reject(new DOMException("aborted", "AbortError"));
								if (eventsSignal?.aborted) fail();
								else eventsSignal?.addEventListener("abort", fail, { once: true });
							});
						sent = true;
						controller.enqueue(enc.encode(frame("plan", { steps: ["search", "write"] })));
						controller.enqueue(enc.encode(frame("tool_call", { step: 1, tool: "web_search" })));
						controller.enqueue(enc.encode(frame("tool_result", { step: 1, ok: true, summary: "found 4" })));
						controller.enqueue(
							enc.encode(
								frame("awaiting_confirmation", { confirm_id: "c1", kind: "edit", title: "Write deck.md", summary: "deck.md" })
							)
						);
					},
				});
				return { ok: true, status: 200, body } as unknown as Response;
			}
			return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", model: {} });
		const stream = await factory({
			messages: [{ from: "user", content: "build the board pack" }],
			abortSignal: ctrl.signal,
			turnDeadlineAt,
		} as Parameters<typeof factory>[0]);
		const chunks: Chunk[] = [];
		for await (const c of stream) chunks.push(c as Chunk);
		const submit = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/run"));
		const wallClockSecs = JSON.parse(String((submit?.[1] as RequestInit | undefined)?.body ?? "{}")).wall_clock_secs;
		return { chunks, calls, wallClockSecs };
	}

	it("ends the request before its deadline with the run handed off and the answer saying it is still working", async () => {
		const started = Date.now();
		const { chunks, wallClockSecs } = await longRun(Date.now() + 400);
		expect(Date.now() - started).toBeLessThan(400);
		expect(wallClockSecs).toBe(AGENT_HANDOFF_WALL_CLOCK_SECS);
		const terminal = chunks.at(-1);
		expect(terminal?.agentHandoff).toBe(true);
		expect(terminal?.generated_text).toContain("web_search");
		expect(terminal?.generated_text).toContain(AGENT_HANDOFF_TEXT);
		expect(terminal?.generated_text).not.toContain("timed out");
	});

	it("a handed-off run keeps its task and its approval card: no cancel, no canceled card", async () => {
		const { chunks, calls } = await longRun(Date.now() + 400);
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(chunks.some((c) => c.agentConfirmResult)).toBe(false);
	});

	it("a turn with no deadline never hands off (a Stop still ends it as stopped)", async () => {
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 300);
		const { chunks } = await longRun(undefined, ctrl);
		expect(chunks.some((c) => c.agentHandoff)).toBe(false);
		expect(chunks.at(-1)?.generated_text).toContain("stopped before it finished");
	});

	it("with agent-run-handoff off, a turn with a deadline is asked to stop at 150s and never hands off (today's behaviour)", async () => {
		handoffFlag.on = false;
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 600);
		const { chunks, wallClockSecs } = await longRun(Date.now() + 400, ctrl);
		expect(wallClockSecs).toBe(AGENT_SERVICE_WALL_CLOCK_SECS);
		expect(chunks.some((c) => c.agentHandoff)).toBe(false);
		expect(chunks.at(-1)?.generated_text).toContain("stopped before it finished");
	});
});
