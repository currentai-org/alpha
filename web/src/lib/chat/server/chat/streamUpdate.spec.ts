import { describe, it, expect, vi } from "vitest";
import {
	applyMessageUpdate,
	createStreamState,
	type ApplyUpdateContext,
	type MetricsContext,
} from "./streamUpdate";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	MessageReasoningUpdateType,
	type MessageUpdate,
} from "$lib/chat/types/MessageUpdate";
import type { Message } from "$lib/chat/types/Message";

function emptyMessage(content = ""): Message {
	return { from: "assistant", id: "msg-1", content, updates: [] };
}

function makeCtx(overrides: Partial<ApplyUpdateContext> = {}): ApplyUpdateContext {
	return {
		message: emptyMessage(),
		initialMessageContent: "",
		model: { isRouter: false },
		state: createStreamState(),
		metrics: undefined,
		saveTitle: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

const stream = (token: string): MessageUpdate => ({ type: MessageUpdateType.Stream, token });

describe("applyMessageUpdate — agent confirmation gate (CUR-218)", () => {
	it("opens a confirmation onto message.agentConfirmations", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{
				type: MessageUpdateType.AgentConfirm,
				taskId: "t1",
				confirmId: "c1",
				kind: "edit",
				title: "write_file: notes.txt",
				summary: "notes.txt: hello",
			},
			ctx
		);
		expect(ctx.message.agentConfirmations).toEqual([
			{ taskId: "t1", confirmId: "c1", kind: "edit", title: "write_file: notes.txt", summary: "notes.txt: hello" },
		]);
	});

	it("resolves an open confirmation in place, then audits both updates in order", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{ type: MessageUpdateType.AgentConfirm, taskId: "t1", confirmId: "c1", kind: "edit", title: "x", summary: "" },
			ctx
		);
		await applyMessageUpdate(
			{ type: MessageUpdateType.AgentConfirmResult, confirmId: "c1", decision: "deny", reason: "human" },
			ctx
		);
		expect(ctx.message.agentConfirmations?.[0]).toMatchObject({ decision: "deny", reason: "human" });
		// Unlike AgentStep (a pure animation beat, explicitly excluded from the audit log), both of
		// these are security-relevant events and must survive to message.updates.
		expect(ctx.message.updates?.map((u) => u.type)).toEqual([
			MessageUpdateType.AgentConfirm,
			MessageUpdateType.AgentConfirmResult,
		]);
	});

	// The route's silence watchdog reads state.awaitingConfirmation (deadlineLadder.ts's
	// isSilentStall) so an open card isn't mistaken for a stalled generation. These pin the reducer's
	// half of that fix; isSilentStall's own spec covers the watchdog's decision logic. (CUR-1085)
	it("arms awaitingConfirmation on AgentConfirm and disarms it on AgentConfirmResult", async () => {
		const ctx = makeCtx();
		expect(ctx.state.awaitingConfirmation).toBe(false);

		await applyMessageUpdate(
			{ type: MessageUpdateType.AgentConfirm, taskId: "t1", confirmId: "c1", kind: "edit", title: "x", summary: "" },
			ctx
		);
		expect(ctx.state.awaitingConfirmation).toBe(true);

		await applyMessageUpdate(
			{ type: MessageUpdateType.AgentConfirmResult, confirmId: "c1", decision: "allow", reason: "" },
			ctx
		);
		expect(ctx.state.awaitingConfirmation).toBe(false);
	});

	it("disarms on every resolution kind — deny, timeout, and canceled all clear it, not just allow", async () => {
		for (const decision of ["deny", "canceled"] as const) {
			const ctx = makeCtx();
			await applyMessageUpdate(
				{ type: MessageUpdateType.AgentConfirm, taskId: "t1", confirmId: "c1", kind: "edit", title: "x", summary: "" },
				ctx
			);
			await applyMessageUpdate(
				{ type: MessageUpdateType.AgentConfirmResult, confirmId: "c1", decision, reason: "timeout" },
				ctx
			);
			expect(ctx.state.awaitingConfirmation, `decision=${decision}`).toBe(false);
		}
	});
});

describe("applyMessageUpdate", () => {
	it("appends a stream token to content, audits a copy, and returns the null-padded event", async () => {
		const ctx = makeCtx();
		const out = await applyMessageUpdate(stream("Hi"), ctx);

		expect(ctx.message.content).toBe("Hi");
		// audit entry is a copy with the ORIGINAL (unpadded) token, preserving ordering
		expect(ctx.message.updates).toHaveLength(1);
		expect(ctx.message.updates?.[0]).toEqual({ type: MessageUpdateType.Stream, token: "Hi" });
		// the enqueued event is padded to a fixed width (side-channel defense)
		expect(out).not.toBeNull();
		expect(out?.type).toBe(MessageUpdateType.Stream);
		expect((out as { token: string }).token).toBe("Hi".padEnd(16, "\0"));
		expect(ctx.state.lastTokenTimestamp).toBeInstanceOf(Date);
	});

	it("drops an empty stream token entirely (null result, no content/audit change)", async () => {
		const ctx = makeCtx();
		const out = await applyMessageUpdate(stream(""), ctx);

		expect(out).toBeNull();
		expect(ctx.message.content).toBe("");
		expect(ctx.message.updates).toHaveLength(0);
	});

	it("appends reasoning stream tokens to message.reasoning", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Stream,
				token: "think ",
			},
			ctx
		);
		await applyMessageUpdate(
			{
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Stream,
				token: "more",
			},
			ctx
		);

		expect(ctx.message.reasoning).toBe("think more");
		expect(ctx.message.content).toBe("");
	});

	it("strips <think> markers from a title and persists via saveTitle", async () => {
		const saveTitle = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ saveTitle });
		await applyMessageUpdate(
			{ type: MessageUpdateType.Title, title: "<think>plan</think> A Real Title ", source: "model" },
			ctx
		);

		expect(saveTitle).toHaveBeenCalledExactlyOnceWith("plan A Real Title");
	});

	it("replaces content with initial + final text and flips finalAnswerReceived", async () => {
		const ctx = makeCtx({
			message: emptyMessage("partial stream"),
			initialMessageContent: "",
		});
		const out = await applyMessageUpdate(
			{ type: MessageUpdateType.FinalAnswer, text: "the final answer", interrupted: false },
			ctx
		);

		expect(ctx.message.content).toBe("the final answer");
		expect(ctx.message.interrupted).toBe(false);
		expect(ctx.state.finalAnswerReceived).toBe(true);
		// FinalAnswer is returned verbatim (not padded) so the handler can detect it
		expect(out).toEqual({
			type: MessageUpdateType.FinalAnswer,
			text: "the final answer",
			interrupted: false,
		});
	});

	it("preserves the pre-turn content prefix when splicing the final answer", async () => {
		const ctx = makeCtx({
			message: emptyMessage("EARLIER. partial"),
			initialMessageContent: "EARLIER. ",
		});
		await applyMessageUpdate(
			{ type: MessageUpdateType.FinalAnswer, text: "done", interrupted: true },
			ctx
		);

		expect(ctx.message.content).toBe("EARLIER. done");
		expect(ctx.message.interrupted).toBe(true);
	});

	it("appends a hash file entry", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{ type: MessageUpdateType.File, name: "a.png", sha: "abc123", mime: "image/png" },
			ctx
		);

		expect(ctx.message.files).toEqual([
			{ type: "hash", name: "a.png", value: "abc123", mime: "image/png" },
		]);
	});

	it("keeps one reference per agent file, so a replayed done adds none and two same-bytes files keep both paths (CUR-4398)", async () => {
		const ctx = makeCtx();
		const file = (agentPath: string): MessageUpdate => ({
			type: MessageUpdateType.File,
			name: "__init__.py",
			sha: "e3b0",
			mime: "text/x-python",
			agentPath,
		});
		for (const u of [file("a/__init__.py"), file("b/__init__.py"), file("a/__init__.py")])
			await applyMessageUpdate(u, ctx);

		expect(ctx.message.files?.map((f) => f.agentPath)).toEqual(["a/__init__.py", "b/__init__.py"]);
	});

	it("still appends every non-agent file, identical bytes included (CUR-4398)", async () => {
		const ctx = makeCtx();
		const png: MessageUpdate = { type: MessageUpdateType.File, name: "a.png", sha: "abc123", mime: "image/png" };
		await applyMessageUpdate(png, ctx);
		await applyMessageUpdate(png, ctx);
		expect(ctx.message.files).toHaveLength(2);
	});

	it("persists a fixed-reply marker, so a reload still says no model wrote the notice (CUR-1872)", async () => {
		const ctx = makeCtx();
		const out = await applyMessageUpdate({ type: MessageUpdateType.FixedReply, kind: "capacity" }, ctx);

		expect(ctx.message.fixedReply).toEqual({ kind: "capacity" });
		// Forwarded too: the live client stamps its own copy from this event before the FinalAnswer lands.
		expect(out).toEqual({ type: MessageUpdateType.FixedReply, kind: "capacity" });
	});

	it("persists a failover, so a reload's receipt still names the model the backup replaced (CUR-2239)", async () => {
		const ctx = makeCtx();
		const event = {
			type: MessageUpdateType.Failover,
			from: "swiss-ai/apertus-v1.5-70b",
			to: "zai-org/GLM-5.3",
			reason: "unavailable",
		} as const;
		const out = await applyMessageUpdate(event, ctx);

		expect(ctx.message.failover).toEqual({
			from: "swiss-ai/apertus-v1.5-70b",
			to: "zai-org/GLM-5.3",
			reason: "unavailable",
		});
		expect(out).toEqual(event);
	});

	it("persists the failover's cause with it, so a reload still says why the primary gave up (CUR-3313)", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{
				type: MessageUpdateType.Failover,
				from: "mistral-large-2512",
				to: "mistral-medium-2604",
				reason: "unavailable",
				cause: "rate-limited",
			},
			ctx
		);
		expect(ctx.message.failover).toEqual({
			from: "mistral-large-2512",
			to: "mistral-medium-2604",
			reason: "unavailable",
			cause: "rate-limited",
		});
	});

	it("persists how many older exchanges were left out, so the note under the answer survives reload (CUR-2893)", async () => {
		const ctx = makeCtx();
		const event = { type: MessageUpdateType.HistoryNotice, leftOut: 4 } as const;
		const out = await applyMessageUpdate(event, ctx);

		expect(ctx.message.historyLeftOut).toBe(4);
		expect(out).toEqual(event);
	});

	it("persists the files a turn could not read, so the note survives reload (CUR-3291)", async () => {
		const ctx = makeCtx();
		ctx.message.attachmentNotice = { message: "Refused." };
		await applyMessageUpdate({ type: MessageUpdateType.AttachmentNotice, kind: "unread", message: "Couldn't read it." }, ctx);
		expect(ctx.message.unreadFilesNotice).toBe("Couldn't read it.");
		expect(ctx.message.attachmentNotice).toEqual({ message: "Refused." });
	});

	it("persists the agent task and its machine, so a later visit can find a run the tab no longer watches (CUR-993)", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate({ type: MessageUpdateType.AgentRun, taskId: "t1", machineId: "m1" }, ctx);
		expect(ctx.message.agentRun).toEqual({ taskId: "t1", machineId: "m1" });
	});

	it("persists every calculate call in order, so the expressions stay under the answer after reload (CUR-2273)", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{ type: MessageUpdateType.Calculation, expression: "3 * 14 * 18", result: "756", counts: "boxes: 3" },
			ctx
		);
		await applyMessageUpdate(
			{ type: MessageUpdateType.Calculation, expression: "3 apples", error: "could not evaluate" },
			ctx
		);
		expect(ctx.message.calculations).toEqual([
			{ expression: "3 * 14 * 18", result: "756", counts: "boxes: 3" },
			{ expression: "3 apples", error: "could not evaluate" },
		]);
	});

	it("records a helper-model frame on a non-router model, which carries no model of its own (CUR-984)", async () => {
		const ctx = makeCtx({ model: { isRouter: false } });
		await applyMessageUpdate(
			{
				type: MessageUpdateType.RouterMetadata,
				route: "",
				model: "",
				assistedBy: [{ role: "math-route", model: "mistral-small-2603", backend: "api.mistral.ai" }],
			},
			ctx
		);
		expect(ctx.message.routerMetadata?.assistedBy).toEqual([
			{ role: "math-route", model: "mistral-small-2603", backend: "api.mistral.ai" },
		]);
	});

	it("merges full router metadata for a router model", async () => {
		const ctx = makeCtx({ model: { isRouter: true } });
		// route/model arrive first…
		await applyMessageUpdate(
			{ type: MessageUpdateType.RouterMetadata, route: "code", model: "big", provider: undefined },
			ctx
		);
		// …provider arrives later and must not clobber route/model
		await applyMessageUpdate(
			{ type: MessageUpdateType.RouterMetadata, route: "", model: "", provider: "hf-inference" },
			ctx
		);

		expect(ctx.message.routerMetadata).toEqual({
			route: "code",
			model: "big",
			provider: "hf-inference",
		});
	});

	it("records a differing served model/route for a non-router model (agent executor), non-empty-wins", async () => {
		const ctx = makeCtx({ model: { isRouter: false } });
		// The agent selects "potluck-agent" but serves a different executor — its done.model
		// correction carries route+model (no provider yet).
		await applyMessageUpdate(
			{
				type: MessageUpdateType.RouterMetadata,
				route: "agent",
				model: "swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO",
				provider: undefined,
			},
			ctx
		);
		// A later provider-only finalize frame (model:"") must NOT wipe the recorded executor.
		await applyMessageUpdate(
			{ type: MessageUpdateType.RouterMetadata, route: "", model: "", provider: "hf-inference" },
			ctx
		);

		expect(ctx.message.routerMetadata).toEqual({
			route: "agent",
			model: "swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO",
			provider: "hf-inference",
		});
	});

	it("persists the served backend on a healthy gateway turn — the ONLY provenance such a turn carries (CUR-114/115)", async () => {
		const ctx = makeCtx({ model: { isRouter: false } });
		// A healthy LiteLLM-gateway turn sends no route/model/provider — the body echoes the group and no
		// X-Router-Model header is set — so the backend host is the SOLE signal. A gate on
		// (isRouter || route || model || provider) would drop this frame and leave the served
		// lane unassertable, with a GLM substitution invisible.
		await applyMessageUpdate(
			{
				type: MessageUpdateType.RouterMetadata,
				route: "",
				model: "",
				provider: undefined,
				backend: "https://api.infomaniak.com/2/ai/106744/openai/v1",
			},
			ctx
		);

		expect(ctx.message.routerMetadata?.backend).toBe(
			"https://api.infomaniak.com/2/ai/106744/openai/v1"
		);
	});

	it("sets finishedStatusSent on a Status:Finished event", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
			ctx
		);
		expect(ctx.state.finishedStatusSent).toBe(true);
	});

	it("does NOT audit KeepAlive or AgentStep events (transient), but still returns them", async () => {
		const ctx = makeCtx();
		const keepAlive = await applyMessageUpdate(
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.KeepAlive },
			ctx
		);
		const agentStep = await applyMessageUpdate(
			{ type: MessageUpdateType.AgentStep, index: 0, tool: "search" },
			ctx
		);

		expect(ctx.message.updates).toHaveLength(0);
		expect(keepAlive).not.toBeNull();
		expect(agentStep).not.toBeNull();
	});

	it("records time-to-first-token exactly once across two tokens", async () => {
		const metrics: MetricsContext = {
			promptedAt: new Date(),
			labels: { model: "test" },
			model: {
				tokenCountTotal: { inc: vi.fn() },
				timeToFirstToken: { observe: vi.fn() },
				timePerOutputToken: { observe: vi.fn() },
				latency: { observe: vi.fn() },
			} as unknown as MetricsContext["model"],
		};
		const ctx = makeCtx({ metrics });

		await applyMessageUpdate(stream("a"), ctx);
		await applyMessageUpdate(stream("b"), ctx);

		expect(metrics.model.tokenCountTotal.inc).toHaveBeenCalledTimes(2);
		expect(metrics.model.timeToFirstToken.observe).toHaveBeenCalledTimes(1);
		expect(metrics.model.timePerOutputToken.observe).toHaveBeenCalledTimes(2);
		expect(ctx.state.firstTokenObserved).toBe(true);
	});
});

// A native turn's failed web_search is written only here, so the note survives reload. (CUR-4091)
describe("applyMessageUpdate — a web search that didn't finish", () => {
	it("stores the failure on the message, and a later grounded search replaces it", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(
			{ type: MessageUpdateType.SearchAttempt, grounded: false, searched: false, failed: "timeout" },
			ctx
		);
		expect(ctx.message.searchAttempt).toEqual({ grounded: false, searched: false, failed: "timeout" });
		await applyMessageUpdate(
			{
				type: MessageUpdateType.WebSearch,
				query: "q",
				sources: [{ n: 1, title: "t", url: "https://w/1", snippet: "s", engine: "Wikipedia" }],
				asOf: "2026-10-16",
			},
			ctx
		);
		expect(ctx.message.webSearch?.sources).toHaveLength(1);
		expect(ctx.message.searchAttempt).toBeUndefined();
	});
});

describe("applyMessageUpdate — a code call waiting for a free sandbox (CUR-4584)", () => {
	const phase = (name: string): MessageUpdate => ({
		type: MessageUpdateType.Status,
		status: MessageUpdateStatus.KeepAlive,
		message: `phase:${name}`,
	});

	it("holds from the waiting-sandbox marker until the next phase marker, and a heartbeat does not end it", async () => {
		const ctx = makeCtx();
		await applyMessageUpdate(phase("waiting-sandbox"), ctx);
		expect(ctx.state.waitingForSandbox).toBe(true);
		await applyMessageUpdate({ type: MessageUpdateType.Status, status: MessageUpdateStatus.KeepAlive }, ctx);
		await applyMessageUpdate(stream("still "), ctx);
		expect(ctx.state.waitingForSandbox).toBe(true);
		await applyMessageUpdate(phase("sandbox-ready"), ctx);
		expect(ctx.state.waitingForSandbox).toBe(false);
	});
});
