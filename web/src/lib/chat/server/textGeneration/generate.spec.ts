/**
 * Direct unit spec for `generate()` (CUR-1377). The route-level integration specs
 * (`server.turn.spec.ts`, `server.prestream.spec.ts`) assert against the persisted `[turn]` outcome log
 * and the DB row, never against individual streamed `MessageUpdate`s, and none of them sends a stream
 * chunk carrying `agentStep`/`writePolicy`/`agentTools`/`agentConfirm`/`agentConfirmResult`/
 * `routerMetadata`/`usage`. The branches that forward those run on every chunk (statement-covered)
 * without being checked for correctness (CUR-1336).
 *
 * Covers those 7 forwarding branches, plus `unrunCode` (same shape), the abort-tracker bracket, and the
 * final-chunk abort/interrupted/stop-token logic. Not covered here: the reasoning-mode branches
 * (regex/summarize/tokens, REASONING_SUMMARY ticks), which need a differently-shaped model fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import {
	HELD_REASONING_STATUS,
	MessageReasoningUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
} from "$lib/chat/types/MessageUpdate";
import type { MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { TextGenerationStreamOutputSimplified } from "$lib/chat/server/endpoints/types";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { ProcessedModel } from "$lib/chat/server/models";
import type { PreparedTurnMedia } from "$lib/chat/server/chat/prepareTurnMedia";

// Real `collections.abortedGenerations.find(...).sort(...).toArray()` would attempt a real Postgres
// connection the moment `generate()`'s abort-tracker bracket calls `beginGeneration()` — this stub
// keeps the test hermetic (no network) and fast, mirroring server.prestream.spec.ts's own pattern for
// this same table.
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		abortedGenerations: {
			find: () => ({ sort: () => ({ toArray: async () => [] }) }),
		},
	},
}));

// Whether this request may send images is the per-visitor flag, so drive that answer here
// rather than through PostHog. Every other textOnly export stays real. (CUR-2725)
const imagesForThisVisitor = vi.hoisted(() => ({ allowed: false }));
vi.mock("$lib/chat/server/textOnly", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/textOnly")>()),
	modelTakesImagesNow: (m: { multimodal?: boolean }) =>
		m.multimodal === true && imagesForThisVisitor.allowed,
}));
// An agent turn's files are stored the way a chat attachment is; the spy shows what generate hands over. (CUR-4398)
const storeChatAttachments = vi.hoisted(() => vi.fn());
vi.mock("$lib/chat/server/storage/attachmentsToCustodial", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/storage/attachmentsToCustodial")>()),
	storeChatAttachments,
}));
import { generate } from "./generate";
import { AbortedGenerations } from "../abortedGenerations";

type TokenChunk = TextGenerationStreamOutputSimplified;

// `agentStep` and `usage` ride the wire (generate.ts reads both via a TS 4.9 `in`-narrowed access,
// which permits the read without the property being declared) but aren't on the declared type the
// way routerMetadata/writePolicy/agentTools/agentConfirm* are — so a fixture chunk needs them named
// explicitly here to survive object-literal excess-property checking.
type TestChunk = Partial<TokenChunk> & {
	agentStep?: { index: number; tool: string; total?: number };
	unrunCode?: { reason: string };
	reasoningHeld?: boolean;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		cachedTokens?: number | null;
	};
};

/** Builds the minimal Endpoint fixture generate() calls: `await endpoint(params)` resolves to an
 *  AsyncGenerator of chunks. */
function endpointYielding(chunks: TestChunk[]) {
	return async () =>
		(async function* () {
			for (const c of chunks) yield c as TokenChunk;
		})();
}

function testModel(overrides: Partial<{ stop: string[] }> = {}): ProcessedModel {
	return {
		id: "test-model",
		multimodal: false,
		parameters: { stop: overrides.stop },
	} as unknown as ProcessedModel;
}

function testCtx(opts: {
	endpoint: ReturnType<typeof endpointYielding>;
	model?: ProcessedModel;
	abortController?: AbortController;
}) {
	return {
		model: opts.model ?? testModel(),
		endpoint: opts.endpoint,
		conv: { _id: new ObjectId() } as Conversation,
		messages: [{ from: "user", content: "hi" }],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		forceMultimodal: false,
		locals: undefined,
		abortController: opts.abortController ?? new AbortController(),
	} as Parameters<typeof generate>[0];
}

async function collect(ctx: Parameters<typeof generate>[0]): Promise<MessageUpdate[]> {
	const out: MessageUpdate[] = [];
	for await (const u of generate(ctx)) out.push(u);
	return out;
}

const specialToken = (text = "") => ({ id: 0, text, logprob: 0, special: true });
const normalToken = (text: string) => ({ id: 0, text, logprob: 0, special: false });

afterEach(() => {
	AbortedGenerations.getInstance()._resetForTest();
	vi.restoreAllMocks();
});

describe("generate — abort-tracker bracket", () => {
	it("wraps every call with exactly one begin and one end, even on a clean run", async () => {
		const begin = vi.spyOn(AbortedGenerations.getInstance(), "beginGeneration");
		const end = vi.spyOn(AbortedGenerations.getInstance(), "endGeneration");
		await collect(
			testCtx({ endpoint: endpointYielding([{ token: specialToken(), generated_text: "hi" }]) })
		);
		expect(begin).toHaveBeenCalledTimes(1);
		expect(end).toHaveBeenCalledTimes(1);
	});
});

describe("generate — provenance/agent forwarding branches (all silently blind before this file)", () => {
	it("forwards an agentStep chunk as an AgentStep update, not a FinalAnswer", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						agentStep: { index: 2, tool: "search", total: 5 },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.AgentStep,
			index: 2,
			tool: "search",
			total: 5,
		});
	});

	// The adapter flags the first chunk it holds back as ALIA's untagged reasoning. (CUR-3942)
	it("turns a reasoningHeld chunk into the held-reasoning status, carrying no text", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: normalToken(""), generated_text: null, reasoningHeld: true },
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		const held = updates.filter((u) => u.type === MessageUpdateType.Reasoning);
		expect(held).toEqual([
			{
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Status,
				status: HELD_REASONING_STATUS,
			},
		]);
	});

	it("sends no held-reasoning status when the flag is absent or false", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: normalToken(""), generated_text: null, reasoningHeld: false },
					{ token: normalToken("hi"), generated_text: null },
					{ token: specialToken(), generated_text: "hi" },
				]),
			})
		);
		expect(updates.some((u) => u.type === MessageUpdateType.Reasoning)).toBe(false);
	});

	it("does NOT forward agentStep when the key is present but falsy (kills the || mutant)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: normalToken(""), generated_text: null, agentStep: undefined },
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates.some((u) => u.type === MessageUpdateType.AgentStep)).toBe(false);
	});

	it("forwards a writePolicy chunk as a WritePolicy update", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						writePolicy: { policy: "deny_writes", tier: "new", tasksDone: 1, tasksRequired: 3 },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.WritePolicy,
			policy: "deny_writes",
			tier: "new",
			tasksDone: 1,
			tasksRequired: 3,
		});
	});

	it("forwards an agentTools chunk as an AgentTools update", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						agentTools: { toolKinds: ["write_file"], counts: { write_file: 1 } },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.AgentTools,
			toolKinds: ["write_file"],
			counts: { write_file: 1 },
		});
	});

	it("forwards an unrunCode chunk as an UnrunCode update (CUR-1341 — same blind-branch shape as the rest)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						unrunCode: { reason: "wrote-not-run" },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.UnrunCode,
			reason: "wrote-not-run",
		});
	});

	it("forwards an agentFile chunk as a File update carrying its agent path, and ignores a falsy one (CUR-4398)", async () => {
		const agentFile = { name: "b.py", sha: "a".repeat(64), mime: "text/x-python", agentPath: "sub/b.py" };
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: normalToken(""), generated_text: null, agentFile },
					{ token: normalToken(""), generated_text: null, agentFile: undefined },
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates.filter((u) => u.type === MessageUpdateType.File)).toEqual([
			{ type: MessageUpdateType.File, ...agentFile },
		]);
	});

	it("saves an agent turn's files with the conversation as attachments, never as pastes (CUR-4398)", async () => {
		const saved = [{ type: "hash", value: "a".repeat(64), name: "b.py", mime: "text/x-python" }];
		storeChatAttachments.mockResolvedValueOnce(saved);
		const file = new File(["print(1)"], "b.py");
		let returned: unknown;
		const ctx = testCtx({
			endpoint: (async (params: { saveAgentFiles?: (f: File[]) => Promise<unknown> }) => {
				returned = await params.saveAgentFiles?.([file]);
				return (async function* () {
					yield { token: specialToken(), generated_text: "done" } as TokenChunk;
				})();
			}) as unknown as ReturnType<typeof endpointYielding>,
		});
		await collect(ctx);
		expect(storeChatAttachments).toHaveBeenCalledWith(ctx.conv, [{ file, paste: false }]);
		expect(returned).toBe(saved);
	});

	it("forwards an agentConfirm chunk as an AgentConfirm update, omitting deadlineAt when absent", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						agentConfirm: {
							taskId: "t1",
							confirmId: "c1",
							kind: "terminal",
							title: "Run command",
							summary: "rm -rf tmp/",
						},
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.AgentConfirm,
			taskId: "t1",
			confirmId: "c1",
			kind: "terminal",
			title: "Run command",
			summary: "rm -rf tmp/",
		});
	});

	it("keeps auto mode's plain sentence on a forwarded AgentConfirm update, so the card can lead with it", async () => {
		// `plain` must survive the copy, or every auto-mode card falls back to the raw command title. (CUR-4486)
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						agentConfirm: {
							taskId: "t1",
							confirmId: "c1",
							kind: "execute",
							title: "Approve terminal: rm plan.txt",
							summary: "rm plan.txt",
							plain: "Deletes the file plan.txt.",
						},
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual(
			expect.objectContaining({
				type: MessageUpdateType.AgentConfirm,
				confirmId: "c1",
				plain: "Deletes the file plan.txt.",
			})
		);
	});

	it("forwards an agentConfirmResult chunk as an AgentConfirmResult update", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						agentConfirmResult: { confirmId: "c1", decision: "deny", reason: "user declined" },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.AgentConfirmResult,
			confirmId: "c1",
			decision: "deny",
			reason: "user declined",
		});
	});

	it("keeps an MCP confirmation's channel, so the card answers through the elicitation route (CUR-3026)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						agentConfirm: {
							taskId: "",
							confirmId: "e1",
							kind: "mcp",
							title: "run set_setting on stub",
							summary: '{"value":"orange"}',
							deadlineAt: 1_000,
							channel: "mcp",
						},
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.AgentConfirm,
			taskId: "",
			confirmId: "e1",
			kind: "mcp",
			title: "run set_setting on stub",
			summary: '{"value":"orange"}',
			deadlineAt: 1_000,
			channel: "mcp",
		});
	});

	it("forwards each MCP server call in a round as its own McpCall update, with a shown call's input and output and no empty keys on the rest (CUR-3026, CUR-4232)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						mcpCalls: [
							{ server: "stub", tool: "get_setting", outcome: "ok", ms: 12, input: "print(8)", output: "stdout:\n8" },
							{ server: "stub", tool: "set_setting", outcome: "declined", ms: 0 },
						],
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		// Strict, so a call with no input or output carries no `input: undefined` key either.
		expect(updates.filter((u) => u.type === MessageUpdateType.McpCall)).toStrictEqual([
			{
				type: MessageUpdateType.McpCall,
				server: "stub",
				tool: "get_setting",
				outcome: "ok",
				ms: 12,
				input: "print(8)",
				output: "stdout:\n8",
			},
			{ type: MessageUpdateType.McpCall, server: "stub", tool: "set_setting", outcome: "declined", ms: 0 },
		]);
	});

	it("forwards routerMetadata when only `backend` is present — the only signal on a healthy gateway turn", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						routerMetadata: { backend: "litellm-host-a" },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.RouterMetadata,
			route: "",
			model: "",
			provider: undefined,
			backend: "litellm-host-a",
		});
	});

	it("forwards the lane the request was sent to, since `backend` alone can't tell a router turn from a direct one (CUR-3193)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						routerMetadata: { backend: "litellm-host-a", lane: "router.example.test" },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(updates).toContainEqual(
			expect.objectContaining({
				type: MessageUpdateType.RouterMetadata,
				backend: "litellm-host-a",
				lane: "router.example.test",
			})
		);
	});

	it("stamps the app server's region from VERCEL_REGION on the router report, unset off Vercel (CUR-4580)", async () => {
		const run = () =>
			collect(
				testCtx({
					endpoint: endpointYielding([
						{ token: normalToken(""), generated_text: null, routerMetadata: { backend: "litellm-host-a" } },
						{ token: specialToken(), generated_text: "done" },
					]),
				})
			);
		const report = (updates: Awaited<ReturnType<typeof run>>) =>
			updates.find((u) => u.type === MessageUpdateType.RouterMetadata) as { appRegion?: string } | undefined;
		vi.stubEnv("VERCEL_REGION", "fra1");
		try {
			expect(report(await run())?.appRegion).toBe("fra1");
			vi.stubEnv("VERCEL_REGION", "");
			expect(report(await run())?.appRegion).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("forwards the failover's cause, so the saved turn says why the primary gave up (CUR-3313)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: specialToken(),
						generated_text: null,
						failover: {
							from: "mistral-large-2512",
							to: "mistral-medium-2604",
							reason: "unavailable",
							cause: "no-first-chunk",
						},
					},
					{ token: normalToken("Bern"), generated_text: null },
					{ token: specialToken(), generated_text: "Bern" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.Failover,
			from: "mistral-large-2512",
			to: "mistral-medium-2604",
			reason: "unavailable",
			cause: "no-first-chunk",
		});
	});

	it("forwards routerMetadata.verifyMethod as \"\" (presence, not truthiness — CUR-756)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						routerMetadata: { verifyMethod: "" },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		const rm = updates.find((u) => u.type === MessageUpdateType.RouterMetadata);
		expect(rm).toBeDefined();
		expect(rm).toMatchObject({ verifyMethod: "" });
	});

	it("logs token-usage accounting for a usage chunk (the only observable effect — no MessageUpdate is yielded)", async () => {
		const { logger } = await import("../logger");
		const info = vi.spyOn(logger, "info");
		await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: normalToken(""),
						generated_text: null,
						usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 },
					},
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ promptTokens: 100, cachedTokens: 40, cacheHitPct: 40 }),
			"[usage] token accounting"
		);
	});
});

describe("generate — final-chunk abort / interrupted / stop-token handling", () => {
	it("breaks without yielding a FinalAnswer when the controller is already aborted", async () => {
		const abortController = new AbortController();
		abortController.abort();
		const updates = await collect(
			testCtx({
				abortController,
				endpoint: endpointYielding([{ token: specialToken(), generated_text: "should not appear" }]),
			})
		);
		expect(updates.some((u) => u.type === MessageUpdateType.FinalAnswer)).toBe(false);
	});

	it("reports interrupted:true for a non-special final token with no configured stop sequence", async () => {
		const updates = await collect(
			testCtx({
				model: testModel({ stop: undefined }),
				endpoint: endpointYielding([
					{ token: normalToken("partial"), generated_text: "partial answer" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.FinalAnswer,
			text: "partial answer",
			interrupted: true,
		});
	});

	it("reports interrupted:false and strips the matched stop token from the answer text", async () => {
		const updates = await collect(
			testCtx({
				model: testModel({ stop: ["<eos>"] }),
				endpoint: endpointYielding([
					{ token: normalToken(""), generated_text: "the answer<eos>" },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.FinalAnswer,
			text: "the answer",
			interrupted: false,
		});
	});

	it("reports interrupted:false for a special final token even with no stop sequence configured", async () => {
		const updates = await collect(
			testCtx({
				model: testModel({ stop: [] }),
				endpoint: endpointYielding([{ token: specialToken(), generated_text: "clean finish" }]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.FinalAnswer,
			text: "clean finish",
			interrupted: false,
		});
	});

	it("stores an agent run handed off to the page as interrupted, even on a special final token (CUR-4410)", async () => {
		const updates = await collect(
			testCtx({
				model: testModel({ stop: [] }),
				endpoint: endpointYielding([
					{ token: specialToken(), generated_text: "still working", agentHandoff: true },
				]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.FinalAnswer,
			text: "still working",
			interrupted: true,
		});
	});

	it("trims trailing whitespace off the final answer without touching a leading space (kills a trimStart mutant)", async () => {
		const updates = await collect(
			testCtx({
				model: testModel({ stop: [] }),
				endpoint: endpointYielding([{ token: specialToken(), generated_text: " hello there  " }]),
			})
		);
		expect(updates).toContainEqual({
			type: MessageUpdateType.FinalAnswer,
			text: " hello there",
			interrupted: false,
		});
	});
});

// CUR-2081. Output screening rebuilds the answer from Stream updates alone (screenStream.ts), so any
// text that reaches FinalAnswer without first streaming is text the visitor never gets. A provider
// that sends its last content delta in the same chunk as `finish_reason` puts that delta on the
// final chunk, which generate() turns into FinalAnswer without streaming it. The tail of the answer
// (" = 391.") would be lost this way.
describe("generate — every character of the answer streams before FinalAnswer (CUR-2081)", () => {
	async function streamedAndFinal(
		deltas: { content: string; finish_reason: string | null }[]
	): Promise<{ streamed: string; final: string | undefined }> {
		const { openAIChatToTextGenerationStream } = await import(
			"../endpoints/openai/openAIChatToTextGenerationStream"
		);
		async function* completion() {
			for (const d of deltas) {
				yield { model: "zai-org/GLM-5.3", choices: [{ delta: { content: d.content }, finish_reason: d.finish_reason }] };
			}
		}
		const endpoint = async () =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			openAIChatToTextGenerationStream(completion() as any) as AsyncGenerator<TokenChunk>;
		const updates = await collect(testCtx({ endpoint }));
		let streamed = "";
		let final: string | undefined;
		for (const u of updates) {
			if (u.type === MessageUpdateType.Stream) streamed += u.token;
			if (u.type === MessageUpdateType.FinalAnswer) final = u.text;
		}
		return { streamed, final };
	}

	it("streams the tail a provider sends together with its finish_reason", async () => {
		const r = await streamedAndFinal([
			{ content: "17 × 23", finish_reason: null },
			{ content: " = 391.", finish_reason: "stop" },
		]);
		expect(r.final).toBe("17 × 23 = 391.");
		expect(r.streamed, "the final chunk's text reached FinalAnswer without streaming").toBe(r.final);
	});

	it("streams the whole answer when a provider sends it in one finishing chunk", async () => {
		const r = await streamedAndFinal([{ content: "All done.", finish_reason: "stop" }]);
		expect(r.streamed).toBe("All done.");
		expect(r.final).toBe("All done.");
	});

	it("releases the whole answer through output screening, the path that lost it", async () => {
		const { openAIChatToTextGenerationStream } = await import(
			"../endpoints/openai/openAIChatToTextGenerationStream"
		);
		const { screenOutputStream } = await import("./screenStream");
		async function* completion() {
			yield { model: "zai-org/GLM-5.3", choices: [{ delta: { content: "17 × 23" }, finish_reason: null }] };
			yield { model: "zai-org/GLM-5.3", choices: [{ delta: { content: " = 391." }, finish_reason: "stop" }] };
		}
		const endpoint = async () =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			openAIChatToTextGenerationStream(completion() as any) as AsyncGenerator<TokenChunk>;
		const screen = async () => ({ blocked: false, kind: null }) as const;
		let released: string | undefined;
		for await (const u of screenOutputStream(generate(testCtx({ endpoint })), { screen })) {
			if (u.type === MessageUpdateType.FinalAnswer) released = u.text;
		}
		expect(released, "the screen released the answer without its tail").toBe("17 × 23 = 391.");
	});

	it("still streams everything when the finish arrives on an empty chunk of its own", async () => {
		const r = await streamedAndFinal([
			{ content: "17 × 23 = 391.", finish_reason: null },
			{ content: "", finish_reason: "stop" },
		]);
		expect(r.streamed).toBe("17 × 23 = 391.");
		expect(r.final).toBe("17 × 23 = 391.");
	});
});

describe("generate — the native calculate tool (CUR-2273)", () => {
	it("forwards each evaluated call as a Calculation update, expression and result or error", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{
						token: specialToken(),
						generated_text: null,
						calculations: [
							{ expression: "3 * 14 * 18", result: "756", counts: "boxes: 3" },
							{ expression: "3 apples", error: "could not evaluate this" },
						],
					},
					{ token: specialToken(), generated_text: "756." },
				]),
			})
		);
		expect(updates.filter((u) => u.type === MessageUpdateType.Calculation)).toStrictEqual([
			{ type: MessageUpdateType.Calculation, expression: "3 * 14 * 18", result: "756", counts: "boxes: 3" },
			{ type: MessageUpdateType.Calculation, expression: "3 apples", error: "could not evaluate this" },
		]);
	});

	it("says a native web search did not finish with one ungrounded, unsearched SearchAttempt naming why (CUR-4091)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: specialToken(), generated_text: null, toolSources: { searchFailed: "timeout" } },
					{ token: specialToken(), generated_text: "Answer." },
				]),
			})
		);
		expect(updates.filter((u) => u.type === MessageUpdateType.SearchAttempt)).toEqual([
			{ type: MessageUpdateType.SearchAttempt, grounded: false, searched: false, failed: "timeout" },
		]);
	});

	it("sends no SearchAttempt for a tool round whose search finished (CUR-4091)", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: specialToken(), generated_text: null, toolSources: {} },
					{ token: specialToken(), generated_text: "Answer." },
				]),
			})
		);
		expect(updates.some((u) => u.type === MessageUpdateType.SearchAttempt)).toBe(false);
	});

	it("sums each tool round's cost into the turn's timings", async () => {
		const ctx = testCtx({
			endpoint: endpointYielding([
				{ token: specialToken(), generated_text: null, calculateToolMs: 400 },
				{ token: specialToken(), generated_text: null, calculateToolMs: 250 },
				{ token: specialToken(), generated_text: "done" },
			]),
		});
		const timings: NonNullable<Parameters<typeof generate>[0]["timings"]> = {};
		await collect({ ...ctx, timings });
		expect(timings).toEqual({ calculateToolMs: 650, calculateToolRounds: 2 });
	});

	it("sums the tool-run share of each round into timings.toolRunMs, absent when no round reports it (CUR-4282)", async () => {
		const ctx = testCtx({
			endpoint: endpointYielding([
				{ token: specialToken(), generated_text: null, calculateToolMs: 400, toolRunMs: 300 },
				{ token: specialToken(), generated_text: null, calculateToolMs: 250, toolRunMs: 50 },
				{ token: specialToken(), generated_text: "done" },
			]),
		});
		const timings: NonNullable<Parameters<typeof generate>[0]["timings"]> = {};
		await collect({ ...ctx, timings });
		expect(timings).toEqual({ calculateToolMs: 650, calculateToolRounds: 2, toolRunMs: 350 });
	});

	it("asks the endpoint for the tool only when the turn offers it", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const endpoint = async (params: Record<string, unknown>) => {
			seen.push(params);
			return (async function* () {
				yield { token: specialToken(), generated_text: "hi" } as TokenChunk;
			})();
		};
		const asFixture = endpoint as unknown as ReturnType<typeof endpointYielding>;
		await collect(testCtx({ endpoint: asFixture }));
		await collect({ ...testCtx({ endpoint: asFixture }), calculateTool: true });
		expect(seen[0]).not.toHaveProperty("calculateTool");
		expect(seen[1].calculateTool).toBe(true);
	});

	// The planner's forced first call only means something when the tool is on the turn. (CUR-4191)
	it("passes calculateFirst to the endpoint only alongside the calculate tool", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const endpoint = async (params: Record<string, unknown>) => {
			seen.push(params);
			return (async function* () {
				yield { token: specialToken(), generated_text: "hi" } as TokenChunk;
			})();
		};
		const asFixture = endpoint as unknown as ReturnType<typeof endpointYielding>;
		await collect({ ...testCtx({ endpoint: asFixture }), calculateTool: true, calculateFirst: true });
		await collect({ ...testCtx({ endpoint: asFixture }), calculateFirst: true });
		await collect({ ...testCtx({ endpoint: asFixture }), calculateTool: true });
		expect(seen[0].calculateFirst).toBe(true);
		expect(seen[1]).not.toHaveProperty("calculateFirst");
		expect(seen[2]).not.toHaveProperty("calculateFirst");
	});

	// The endpoint fits the history once the stream starts, so the report arrives after the call
	// returns and before the first chunk. It reaches the client once, ahead of the answer. (CUR-2893)
	const fittingEndpoint = (leftOut: number) =>
		(async (params: { onHistoryFitted?: (n: number) => void }) =>
			(async function* () {
				params.onHistoryFitted?.(leftOut);
				yield { token: normalToken("a"), generated_text: null } as TokenChunk;
				yield { token: specialToken(), generated_text: "ab" } as TokenChunk;
			})()) as unknown as ReturnType<typeof endpointYielding>;

	it("sends one HistoryNotice, before the answer, when the endpoint left older exchanges out", async () => {
		const updates = await collect(testCtx({ endpoint: fittingEndpoint(3) }));
		const notices = updates.filter((u) => u.type === MessageUpdateType.HistoryNotice);
		expect(notices).toEqual([{ type: MessageUpdateType.HistoryNotice, leftOut: 3 }]);
		const final = updates.findIndex((u) => u.type === MessageUpdateType.FinalAnswer);
		expect(updates.indexOf(notices[0])).toBeLessThan(final);
	});

	it("sends no HistoryNotice when the whole chat fit", async () => {
		const updates = await collect(testCtx({ endpoint: fittingEndpoint(0) }));
		expect(updates.some((u) => u.type === MessageUpdateType.HistoryNotice)).toBe(false);
	});

	// The corpus budget can empty an older paste before the endpoint sees it, so the history then fits
	// with nothing left out. The model still never read that paste, and the answer has to say so.
	it("sends a HistoryNotice when the corpus budget cut an older paste, even though the history fit", async () => {
		const ctx = {
			...testCtx({ endpoint: fittingEndpoint(0) }),
			preparedMedia: { olderMessagesCut: 1 } as PreparedTurnMedia,
		};
		const updates = await collect(ctx);
		const notices = updates.filter((u) => u.type === MessageUpdateType.HistoryNotice);
		expect(notices).toEqual([{ type: MessageUpdateType.HistoryNotice, leftOut: 1 }]);
	});

	// An attached file the bucket could not read was dropped from the prompt with no word to the person. (CUR-3291)
	it("sends an AttachmentNotice naming a file the turn could not read, before the answer", async () => {
		const ctx = {
			...testCtx({ endpoint: fittingEndpoint(0) }),
			preparedMedia: { olderMessagesCut: 0, unreadFiles: [{ name: "minutes.pdf", reason: "unreadable" }] } as PreparedTurnMedia,
		};
		const updates = await collect(ctx);
		const notices = updates.filter((u) => u.type === MessageUpdateType.AttachmentNotice);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ kind: "unread", message: expect.stringContaining('"minutes.pdf"') });
		const final = updates.findIndex((u) => u.type === MessageUpdateType.FinalAnswer);
		expect(updates.indexOf(notices[0])).toBeLessThan(final);
	});

	it("sends no AttachmentNotice when the turn read every file", async () => {
		const ctx = {
			...testCtx({ endpoint: fittingEndpoint(0) }),
			preparedMedia: { olderMessagesCut: 0, unreadFiles: [] } as unknown as PreparedTurnMedia,
		};
		const updates = await collect(ctx);
		expect(updates.some((u) => u.type === MessageUpdateType.AttachmentNotice)).toBe(false);
	});

	it("asks the endpoint to replay model calls only on a model_replay turn, in the mode the fault names (SOL-92, SOL-148)", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const endpoint = async (params: Record<string, unknown>) => {
			seen.push(params);
			return (async function* () {
				yield { token: specialToken(), generated_text: "hi" } as TokenChunk;
			})();
		};
		const asFixture = endpoint as unknown as ReturnType<typeof endpointYielding>;
		await collect(testCtx({ endpoint: asFixture }));
		await collect({ ...testCtx({ endpoint: asFixture }), faultInjection: "canned_reply" as const });
		await collect({ ...testCtx({ endpoint: asFixture }), faultInjection: "model_replay" as const });
		await collect({ ...testCtx({ endpoint: asFixture }), faultInjection: "model_replay_none" as const });
		expect(seen[0]).not.toHaveProperty("replayModelCalls");
		expect(seen[1]).not.toHaveProperty("replayModelCalls");
		expect(seen[2].replayModelCalls).toBe("new_episodes");
		expect(seen[3].replayModelCalls).toBe("none");
	});
});

describe("generate — CUR-1614 fault simulations", () => {
	const answer = Array.from({ length: 20 }, (_, i) => ({ token: normalToken(`w${i} `), generated_text: null }));

	it("stream_truncates_midway: streams 12 tokens, then throws undici's mid-stream 'terminated' with no FinalAnswer", async () => {
		const updates: MessageUpdate[] = [];
		const ctx = {
			...testCtx({ endpoint: endpointYielding([...answer, { token: specialToken(), generated_text: "full" }]) }),
			faultInjection: "stream_truncates_midway" as const,
		};
		await expect(
			(async () => {
				for await (const u of generate(ctx)) updates.push(u);
			})()
		).rejects.toThrow("terminated");
		expect(updates.filter((u) => u.type === MessageUpdateType.Stream)).toHaveLength(12);
		expect(updates.some((u) => u.type === MessageUpdateType.FinalAnswer)).toBe(false);
	});

	it("provenance_header_stripped: drops the routerMetadata report and still delivers the answer", async () => {
		const chunks = [
			{ token: normalToken(""), generated_text: null, routerMetadata: { route: "", model: "m", backend: "host-a" } },
			{ token: normalToken("hi"), generated_text: null },
			{ token: specialToken(), generated_text: "hi" },
		];
		const stripped = await collect({
			...testCtx({ endpoint: endpointYielding(chunks) }),
			faultInjection: "provenance_header_stripped" as const,
		});
		expect(stripped.some((u) => u.type === MessageUpdateType.RouterMetadata)).toBe(false);
		expect(stripped).toContainEqual(expect.objectContaining({ type: MessageUpdateType.FinalAnswer, text: "hi" }));
		// The same chunks without the fault do report it, so the drop above is the fault's doing.
		const healthy = await collect(testCtx({ endpoint: endpointYielding(chunks) }));
		expect(healthy.some((u) => u.type === MessageUpdateType.RouterMetadata)).toBe(true);
	});

	it("lane_not_found (CUR-4629): throws the router's 404, status attached, before the endpoint is called", async () => {
		let called = false;
		const endpoint = (async () => {
			called = true;
			return (async function* () {
				yield { token: specialToken(), generated_text: "ok" } as TokenChunk;
			})();
		}) as unknown as ReturnType<typeof endpointYielding>;
		const err = await collect({ ...testCtx({ endpoint }), faultInjection: "lane_not_found" as const }).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("404 litellm.NotFoundError: OpenAIException - Not Found");
		expect((err as { status?: number }).status).toBe(404);
		expect(called).toBe(false);
	});

	it("lane_server_error (CUR-2829): throws the SDK's 500, status attached, before the endpoint is called", async () => {
		let called = false;
		const endpoint = (async () => {
			called = true;
			return (async function* () {
				yield { token: specialToken(), generated_text: "ok" } as TokenChunk;
			})();
		}) as unknown as ReturnType<typeof endpointYielding>;
		const err = await collect({ ...testCtx({ endpoint }), faultInjection: "lane_server_error" as const }).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("500 Internal Server Error");
		expect((err as { status?: number }).status).toBe(500);
		expect(called).toBe(false);
		// Without the fault the same endpoint answers, so the throw above is the fault's doing.
		const healthy = await collect(testCtx({ endpoint }));
		expect(healthy).toContainEqual(expect.objectContaining({ type: MessageUpdateType.FinalAnswer, text: "ok" }));
	});
});

describe("generate — images reach the endpoint only for a visitor allowed to send them (CUR-2725)", () => {
	async function isMultimodalSent(opts: { modelReadsImages: boolean; visitorAllowed: boolean; force?: boolean }) {
		imagesForThisVisitor.allowed = opts.visitorAllowed;
		let seen: unknown;
		const endpoint = async (params: { isMultimodal?: boolean }) => {
			seen = params.isMultimodal;
			return (async function* () {
				yield { token: specialToken(), generated_text: "ok" } as TokenChunk;
			})();
		};
		const ctx = testCtx({
			endpoint: endpoint as unknown as ReturnType<typeof endpointYielding>,
			model: { ...testModel(), multimodal: opts.modelReadsImages } as ProcessedModel,
		});
		await collect({ ...ctx, forceMultimodal: opts.force });
		return seen;
	}

	it("a model that reads images gets none from a visitor the flag does not select (a guest on preview, who has no override)", async () => {
		expect(await isMultimodalSent({ modelReadsImages: true, visitorAllowed: false })).toBe(false);
	});

	it("the same model gets images from a visitor the flag selects", async () => {
		expect(await isMultimodalSent({ modelReadsImages: true, visitorAllowed: true, force: false })).toBe(true);
	});

	it("a text-only model gets no images, whoever the visitor is", async () => {
		expect(await isMultimodalSent({ modelReadsImages: false, visitorAllowed: true, force: false })).toBe(false);
	});

	it("the per-user override still forces images on", async () => {
		expect(await isMultimodalSent({ modelReadsImages: false, visitorAllowed: false, force: true })).toBe(true);
	});
});

// A native tool round says what it retrieves, and the live line reads the phase marker. The
// marker must name only what runs: a documents-only round never reads as a web search. (CUR-2275)
describe("generate — a native tool round's retrieval becomes the live phase", () => {
	it("sends searching, searching-documents and searching-documents-web for web, documents and both", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: specialToken(), generated_text: null, toolRetrieval: "web" },
					{ token: specialToken(), generated_text: null, toolRetrieval: "documents" },
					{ token: specialToken(), generated_text: null, toolRetrieval: "documents-web" },
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		const phases = updates.flatMap((u) =>
			u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.KeepAlive && u.message
				? [u.message]
				: []
		);
		expect(phases).toEqual([
			"phase:searching",
			"phase:searching-documents",
			"phase:searching-documents-web",
		]);
	});
});

// A code call waiting for a free sandbox, and the end of that wait, become the live phase. (CUR-4584)
describe("generate — a sandbox wait becomes the live phase", () => {
	it("sends waiting-sandbox when the wait starts and sandbox-ready when it ends", async () => {
		const updates = await collect(
			testCtx({
				endpoint: endpointYielding([
					{ token: specialToken(), generated_text: null, sandboxWait: "waiting" },
					{ token: specialToken(), generated_text: null, sandboxWait: "ready" },
					{ token: specialToken(), generated_text: "done" },
				]),
			})
		);
		const phases = updates.flatMap((u) =>
			u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.KeepAlive && u.message
				? [u.message]
				: []
		);
		expect(phases).toEqual(["phase:waiting-sandbox", "phase:sandbox-ready"]);
	});
});

describe("generate — the sustained tool-round 429 fault reaches the endpoint (CUR-2307)", () => {
	async function paramsFor(faultInjection: string | undefined) {
		let seen: Record<string, unknown> | undefined;
		const yielding = endpointYielding([{ token: specialToken(), generated_text: "ok" }]);
		const endpoint = (async (params: Record<string, unknown>) => {
			seen = params;
			return yielding();
		}) as unknown as ReturnType<typeof endpointYielding>;
		await collect({ ...testCtx({ endpoint }), faultInjection } as Parameters<typeof generate>[0]);
		return seen ?? {};
	}

	it("sets rateLimitToolRoundSustained only for tool_round_rate_limited_sustained", async () => {
		expect((await paramsFor("tool_round_rate_limited_sustained")).rateLimitToolRoundSustained).toBe(true);
		expect(await paramsFor("tool_round_rate_limited")).not.toHaveProperty("rateLimitToolRoundSustained");
		expect(await paramsFor(undefined)).not.toHaveProperty("rateLimitToolRoundSustained");
	});

	// The silent re-pick scenario hangs every lane, so the endpoint has to be told. (CUR-4384)
	it("sets hangEveryLane only for every_lane_hangs", async () => {
		expect((await paramsFor("every_lane_hangs")).hangEveryLane).toBe(true);
		expect(await paramsFor("primary_lane_hangs")).not.toHaveProperty("hangEveryLane");
		expect(await paramsFor(undefined)).not.toHaveProperty("hangEveryLane");
	});

	// The busy spec makes every lane of one model refuse, so the endpoint has to be told. (CUR-4042)
	it("sets rateLimitEveryLane only for every_lane_rate_limited", async () => {
		expect((await paramsFor("every_lane_rate_limited")).rateLimitEveryLane).toBe(true);
		expect(await paramsFor("primary_lane_rate_limited")).not.toHaveProperty("rateLimitEveryLane");
		expect(await paramsFor(undefined)).not.toHaveProperty("rateLimitEveryLane");
	});
});

// The agent endpoint reads the visitor's own system text from this field; dropped here, an
// agent turn ignores their system prompt and Personalization. (CUR-4088)
describe("generate — visitor instructions reach the endpoint", () => {
	it("passes clientInstructions to the endpoint when the turn has some, and omits the key when not", async () => {
		const seen: Record<string, unknown>[] = [];
		const endpoint = async (params: Record<string, unknown>) => {
			seen.push(params);
			return endpointYielding([{ token: specialToken(), generated_text: "ok" }])();
		};
		await collect({
			...testCtx({ endpoint: endpoint as unknown as ReturnType<typeof endpointYielding> }),
			clientInstructions: "Answer with emoji.",
		});
		await collect(testCtx({ endpoint: endpoint as unknown as ReturnType<typeof endpointYielding> }));
		expect(seen[0].clientInstructions).toBe("Answer with emoji.");
		expect("clientInstructions" in seen[1]).toBe(false);
	});
});
