/**
 * Pre-stream overlap (TTFT plan §A) — the reviewer-critical control-flow properties, fully mocked
 * (no DB / no network):
 *
 *  1. Claim-lost → 409 fires ZERO moved-leg launches (a duplicate POST that loses the idempotency claim
 *     must not submit the turn to Coop, run embeds/engines, READ settings, or write the
 *     conversation) — invariant 2/9. A `settings.findOne` spy is included precisely because settings now
 *     launches post-claim: an early settings launch must fail this suite.
 *  2. A settings rejection surfaces as a TURN ERROR (finishGeneration('error'), no model call) — never a
 *     silent default-settings turn (invariant 6).
 *  3. A user-msg persist link rejection is the SECOND join (invariant 5): the stream emits Status=Error
 *     and textGeneration is NEVER called (the turn errors before any model run), while settings — the
 *     first join — already passed.
 *  4. Terminal-flush ordering (invariant 4): on a normal turn the final `persistConversation` write is
 *     flushed (its `conversations.updateOne` awaited) BEFORE `finishGeneration`, so the generation record
 *     never says "complete" ahead of the durable conversation state.
 *  5. saveTitle later-link semantics (chain contract, plan r11 errata): a rejecting title write PROPAGATES
 *     to the stream catch (the turn errors — today's behavior, NOT catch-and-logged), yet the chain TAIL
 *     still advances so a subsequent `persistConversation` link runs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import { error } from "@sveltejs/kit";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import {
	MessageUpdateType,
	MessageUpdateStatus,
	PRESTREAM_ACCEPTED_PHASE,
	PRESTREAM_EVENTS_HEADER,
	type MessageUpdate,
} from "$lib/chat/types/MessageUpdate";

// ── hoisted spies (referenced by both the vi.mock factories and the tests) ──────────────────────────
const h = vi.hoisted(() => {
	const settingsFindOne = vi.fn(async () => null);
	// Typed params so tests can (a) discriminate the title-only write ($set without `messages`) from the
	// message writes and (b) let mockImplementation take (filter, update) without a signature clash.
	const conversationsUpdateOne = vi.fn(
		async (_filter?: unknown, _update?: { $set?: Record<string, unknown> }) => ({ acknowledged: true })
	);
	const getCoopVerdict = vi.fn(async () => ({ status: "ok" }));
	const checkChildSafety = vi.fn(async () => ({ flagged: false }));
	const checkContentPolicy = vi.fn(async () => ({ action: "allow" }));
	const maybeRagGrounding = vi.fn(async () => null);
	const ragWillSearch = vi.fn((_q?: string) => true);
	const runWebRetrieval = vi.fn(async () => undefined);
	const runWebSearch = vi.fn(async () => undefined);
	const decideWebSearch = vi.fn(async () => ({ search: false }));
	const claimGeneration = vi.fn(async () => true);
	const readGeneration = vi.fn(async () => ({ status: "in_flight", messageId: "asst-1" }));
	const finishGeneration = vi.fn(async () => {});
	const textGeneration = vi.fn(() => (async function* (): AsyncGenerator<MessageUpdate> {})());
	// One shape, overridable: a case needs both "an agent turn" and "webSearchMode: always" at once (CUR-574),
	// which the plain module-level default (both "off") can't express on its own.
	const baseParsedRequest = (
		overrides: Partial<{
			webSearchMode: "off" | "auto" | "always";
			agentMode: "off" | "auto" | "on";
		}> = {}
	) => ({
		newPrompt: "hi",
		messageId: undefined,
		isRetry: false,
		generationId: "gen-123",
		searchContext: undefined,
		webSearchMode: "off" as "off" | "auto" | "always",
		speakAll: false,
		speakMode: undefined,
		agentMode: "off" as "off" | "auto" | "on",
		uploadedFiles: [],
		leftOutFiles: [],
		...overrides,
	});
	const parseChatRequest = vi.fn(async () => baseParsedRequest());
	const resolveAgentRoute = vi.fn(
		async (): Promise<{ route: string; reason?: string; model?: unknown }> => ({ route: "selected" })
	);
	return {
		settingsFindOne,
		conversationsUpdateOne,
		getCoopVerdict,
		checkChildSafety,
		checkContentPolicy,
		maybeRagGrounding,
		ragWillSearch,
		runWebRetrieval,
		runWebSearch,
		decideWebSearch,
		claimGeneration,
		readGeneration,
		finishGeneration,
		textGeneration,
		baseParsedRequest,
		parseChatRequest,
		resolveAgentRoute,
	};
});

vi.mock("$lib/chat/server/config", () => {
	const config = new Proxy(
		{ isHuggingChat: false },
		{ get: (t, p) => (p in t ? Reflect.get(t, p) : "") }
	);
	return { config, ready: Promise.resolve() };
});

vi.mock("$lib/chat/server/models", () => ({
	models: [{ id: "test-model", name: "test-model", getEndpoint: vi.fn() }],
	validModelIdSchema: { safeParse: () => ({ success: true }), optional: () => ({}) },
	defaultModel: { id: "test-model" },
	taskModel: { id: "test-model" },
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: {
		settings: { findOne: h.settingsFindOne },
		conversations: {
			updateOne: h.conversationsUpdateOne,
			// Message saves merge under a row lock. Here the merge runs against an empty
			// stored conversation and its update goes to the same spy, so the write-order checks still hold. (CUR-2806)
			modifyOne: (
				filter: unknown,
				change: (current: { messages: [] }) => { $set?: Record<string, unknown> } | null
			) =>
				h.conversationsUpdateOne(filter, change({ messages: [] }) ?? undefined),
		},
		abortedGenerations: {
			deleteOne: vi.fn(async () => ({})),
			findOne: vi.fn(async () => null),
		},
	},
}));

vi.mock("$lib/chat/server/auth", () => ({ authCondition: () => ({}) }));

vi.mock("$lib/chat/server/generations", () => ({
	claimGeneration: h.claimGeneration,
	readGeneration: h.readGeneration,
	finishGeneration: h.finishGeneration,
	answersInFlight: async () => false,
}));

vi.mock("$lib/chat/server/chat/loadConversation", () => ({
	loadAuthorizedConversation: vi.fn(async () => ({
		_id: new ObjectId(),
		model: "test-model",
		title: "t",
		sessionId: "s",
		messages: [{ id: "asst-1", from: "assistant", content: "", updates: [] }],
	})),
}));

vi.mock("$lib/chat/server/chat/rateLimit", () => ({
	enforceRequestRateLimits: vi.fn(async () => {}),
}));

vi.mock("$lib/chat/server/chat/parseRequest", () => ({
	parseChatRequest: h.parseChatRequest,
}));

vi.mock("$lib/chat/server/chat/resolveAgentRoute", () => ({
	// Re-exported because the route imports it to pick this turn's generation deadline (CUR-144).
	// Omitting it fails loudly here; the danger is a mock that DEFINES it as something else, which
	// would make agent turns look ordinary and silently assert the wrong deadline.
	AGENT_MODEL_ID: "potluck-agent",
	resolveAgentRoute: h.resolveAgentRoute,
}));

vi.mock("$lib/chat/server/chat/messageTree", () => ({
	appendTurnMessages: vi.fn(() => ({
		messageToWriteToId: "asst-1",
		messagesForPrompt: [{ id: "u-1", from: "user", content: "hi" }],
	})),
}));

vi.mock("$lib/chat/server/moderation", () => ({
	getCoopVerdict: h.getCoopVerdict,
	checkChildSafety: h.checkChildSafety,
	checkContentPolicy: h.checkContentPolicy,
	checkAdvisory: vi.fn(async () => ({ notice: false })),
	CHILD_SAFETY_DECLINE: "child-decline",
	// Mirrors moderation.childSafetyDeclineText with this mock's copy strings (the real one is unit-tested
	// in guardGate.spec.ts).
	childSafetyDeclineText: (r: { unscreened?: boolean }, ruleMessage?: string | null) =>
		r.unscreened ? "unscreened-decline" : (ruleMessage ?? "child-decline"),
	CONTENT_POLICY_DECLINE: "content-decline",
	outputModerationEnabled: () => false,
	isCoopConfigured: () => false,
}));

vi.mock("$lib/chat/server/rag", () => ({
	maybeRagGrounding: h.maybeRagGrounding,
	ragWillSearch: h.ragWillSearch,
}));

vi.mock("$lib/chat/server/search/runSearch", () => ({
	runWebSearch: h.runWebSearch,
	runWebRetrieval: h.runWebRetrieval,
	decideWebSearch: h.decideWebSearch,
}));

vi.mock("$lib/chat/server/usageLimits", () => ({ usageLimits: undefined }));
vi.mock("$lib/chat/server/metrics", () => ({
	MetricsServer: { isEnabled: () => false, getMetrics: () => undefined },
}));
vi.mock("$lib/chat/server/abortRegistry", () => ({
	AbortRegistry: { getInstance: () => ({ register: vi.fn(), unregister: vi.fn() }) },
}));
vi.mock("$lib/chat/server/textGeneration", () => ({ textGeneration: h.textGeneration }));

import { POST } from "./+server";

const CONV_ID = new ObjectId().toHexString();

function makePost(headers: Record<string, string> = {}): Promise<Response> {
	const request = new Request(`http://localhost/chat/conversation/${CONV_ID}`, {
		method: "POST",
		headers,
	});
	return POST({
		request,
		locals: { user: { _id: new ObjectId(), username: "u" }, sessionId: "s" },
		params: { id: CONV_ID },
		getClientAddress: () => "127.0.0.1",
	} as never);
}

// Drain the stream via the raw reader so start() runs to its terminal tail (controller.close()).
// Not res.text(): the route enqueues STRING chunks (the SvelteKit adapter encodes them in prod),
// which the byte-oriented Response.text() rejects.
async function drain(res: Response): Promise<void> {
	const reader = res.body!.getReader();

	while (true) {
		const { done } = await reader.read();
		if (done) break;
	}
}

/** Drain the stream and return the live phase markers it sent, in order. */
async function drainPhases(res: Response): Promise<string[]> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += typeof value === "string" ? value : decoder.decode(value);
	}
	return [...text.matchAll(/"message":"phase:([a-z-]+)"/g)].map((m) => m[1]);
}

describe("POST /conversation/[id] — pre-stream overlap", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		h.settingsFindOne.mockResolvedValue(null);
		h.claimGeneration.mockResolvedValue(true);
		// Reset the two mocks the ordering/rejection tests re-implement, back to their defaults so test
		// order never matters (clearAllMocks resets calls, not implementations).
		h.conversationsUpdateOne.mockReset();
		h.conversationsUpdateOne.mockResolvedValue({ acknowledged: true });
		h.textGeneration.mockReset();
		h.textGeneration.mockImplementation(() => (async function* (): AsyncGenerator<MessageUpdate> {})());
		h.parseChatRequest.mockResolvedValue(h.baseParsedRequest());
		h.resolveAgentRoute.mockResolvedValue({ route: "selected" });
		h.ragWillSearch.mockReturnValue(true);
	});

	it("claim-lost → 409 with ZERO moved-leg launches and zero post-claim conversation writes", async () => {
		h.claimGeneration.mockResolvedValue(false);

		const res = await makePost();

		expect(res.status).toBe(409);
		// none of the moved legs launched — including the settings read (must be post-claim)
		expect(h.settingsFindOne).not.toHaveBeenCalled();
		expect(h.getCoopVerdict).not.toHaveBeenCalled();
		expect(h.maybeRagGrounding).not.toHaveBeenCalled();
		expect(h.runWebRetrieval).not.toHaveBeenCalled();
		expect(h.runWebSearch).not.toHaveBeenCalled();
		// zero post-claim conversation-chain writes (the user-msg persist is never enqueued)
		expect(h.conversationsUpdateOne).not.toHaveBeenCalled();
	});

	it("a settings rejection surfaces as a turn error (finishGeneration 'error', no model call)", async () => {
		h.settingsFindOne.mockRejectedValue(new Error("settings DB blip"));

		const res = await makePost();
		await drain(res);

		// the turn errored — not a silent default-settings turn, and the model never ran
		expect(h.finishGeneration).toHaveBeenCalledWith("gen-123", "error");
		expect(h.textGeneration).not.toHaveBeenCalled();
		// claim won, so the user-msg persist WAS enqueued (it just doesn't gate the error here)
		expect(h.claimGeneration).toHaveReturned();
	});

	it("a user-msg persist rejection errors the turn at the SECOND join (Status=Error, no model call)", async () => {
		// Settings (the FIRST join) resolves; the user-msg persist link — the chain's first link and the
		// first conversations.updateOne — rejects. Its rejection propagates to the persist join inside
		// start() (invariant 5), so the stream emits Status=Error and stops BEFORE any generation.
		h.conversationsUpdateOne.mockRejectedValueOnce(new Error("user-msg persist blip"));

		const res = await makePost();
		await drain(res);

		// got PAST the settings join (settings resolved) — the error is the persist, not settings
		expect(h.settingsFindOne).toHaveBeenCalled();
		// the turn errored before any model run
		expect(h.finishGeneration).toHaveBeenCalledWith("gen-123", "error");
		expect(h.textGeneration).not.toHaveBeenCalled();
	});

	// The edit box holds Send for the wait this update names; the client half is edit-refused.spec.ts's
	// first test. This is the server half: the 429's wait reaches the stream (CUR-3410, SOL-195).
	// e2e-moved: scenarios/edit-refused.spec.ts › an edit refused by the server's own message limit holds the edit box Send for the wait the server sent (CUR-3410)
	it("a message-limit refusal streams Status=Error 429 carrying the server's wait, and runs no model", async () => {
		vi.mocked(enforceRequestRateLimits).mockImplementationOnce(async () => {
			error(429, { message: "You've sent a lot of messages. Try again shortly.", retryAfterSeconds: 30 });
		});

		const res = await makePost({ [PRESTREAM_EVENTS_HEADER]: "1" });
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			text += typeof value === "string" ? value : decoder.decode(value);
		}
		const updates = text
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as Record<string, unknown>);

		expect(updates).toContainEqual(
			expect.objectContaining({ type: MessageUpdateType.Status, statusCode: 429, retryAfterSeconds: 30 })
		);
		expect(h.textGeneration).not.toHaveBeenCalled();
	});

	it.each(["settings", "question save"])(
		"an accepted turn keeps heartbeating below the client silence deadline while %s waits",
		async (join) => {
			vi.useFakeTimers();
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			if (join === "settings")
				h.settingsFindOne.mockImplementationOnce(async () => {
					await held;
					return null;
				});
			else
				h.conversationsUpdateOne.mockImplementationOnce(async () => {
					await held;
					return { acknowledged: true };
				});
			const updates: { update: MessageUpdate; at: number }[] = [];
			let reading: Promise<void> | undefined;
			try {
				const res = await makePost({ [PRESTREAM_EVENTS_HEADER]: "1" });
				reading = (async () => {
					const reader = res.body!.getReader();
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						updates.push({ update: JSON.parse(String(value)), at: Date.now() });
					}
				})();
				await vi.waitFor(() =>
					expect(
						updates.some(
							({ update }) =>
								update.type === MessageUpdateType.Status && update.message === PRESTREAM_ACCEPTED_PHASE
						)
					).toBe(true)
				);
				const acceptedAt = updates.find(
					({ update }) =>
						update.type === MessageUpdateType.Status && update.message === PRESTREAM_ACCEPTED_PHASE
				)!.at;
				await vi.advanceTimersByTimeAsync(10_000);
				const pulses = updates.filter(
					({ update, at }) =>
						at > acceptedAt &&
						update.type === MessageUpdateType.Status &&
						update.status === MessageUpdateStatus.KeepAlive
				);
				expect(pulses.some(({ at }) => at >= acceptedAt + 8_000)).toBe(true);
				const times = [acceptedAt, ...pulses.map(({ at }) => at)];
				expect(Math.max(...times.slice(1).map((at, i) => at - times[i]))).toBeLessThan(8_000);
				expect(h.textGeneration).not.toHaveBeenCalled();
			} finally {
				release();
				await reading;
				vi.useRealTimers();
			}
		}
	);

	it("flushes the final persist BEFORE finishGeneration on a normal turn (invariant 4)", async () => {
		// A minimal successful generation (one Stream token + FinalAnswer) so the turn reaches the shared
		// terminal tail: persistConversation() (its updateOne awaited) then finishGeneration('complete').
		h.textGeneration.mockImplementation(() =>
			(async function* (): AsyncGenerator<MessageUpdate> {
				yield { type: MessageUpdateType.Stream, token: "Hello" };
				yield { type: MessageUpdateType.FinalAnswer, text: "Hello", interrupted: false };
			})()
		);

		const res = await makePost();
		await drain(res);

		expect(h.textGeneration).toHaveBeenCalled();
		expect(h.finishGeneration).toHaveBeenCalledWith("gen-123", "complete");

		// The LAST conversations.updateOne (the terminal persistConversation) is invoked BEFORE
		// finishGeneration — the chain is flushed ahead of marking the generation record complete.
		const updateOrders = h.conversationsUpdateOne.mock.invocationCallOrder;
		const lastUpdateOrder = updateOrders[updateOrders.length - 1];
		const finishOrder = h.finishGeneration.mock.invocationCallOrder[0];
		expect(updateOrders.length).toBeGreaterThan(0);
		expect(lastUpdateOrder).toBeLessThan(finishOrder);
	});

	it("a Stop before the question is saved still saves it, with the answer marked stopped (CUR-3018)", async () => {
		// On Vercel a hung-up request keeps running only while something is registered with waitUntil.
		const kept: Promise<unknown>[] = [];
		const contextKey = Symbol.for("@vercel/request-context");
		(globalThis as Record<symbol, unknown>)[contextKey] = {
			get: () => ({ waitUntil: (p: Promise<unknown>) => void kept.push(p) }),
		};
		// The claim is the chain's step just before the question is saved; hold it until Stop.
		let releaseClaim: (() => void) | undefined;
		h.claimGeneration.mockImplementationOnce(
			() => new Promise((resolve) => (releaseClaim = () => resolve(true)))
		);
		try {
			const res = await makePost({ [PRESTREAM_EVENTS_HEADER]: "1" });
			await vi.waitFor(() => expect(releaseClaim).toBeTypeOf("function"));
			await res.body!.cancel();
			releaseClaim!();
			await Promise.all(kept);
		} finally {
			delete (globalThis as Record<symbol, unknown>)[contextKey];
		}

		const saved = h.conversationsUpdateOne.mock.calls.map(([, update]) => update?.$set?.messages);
		const stopped = saved
			.flat()
			.findLast((m) => (m as { id?: string } | undefined)?.id === "asst-1") as
			| { interrupted?: boolean }
			| undefined;
		expect(saved.some((messages) => Array.isArray(messages))).toBe(true);
		expect(stopped?.interrupted).toBe(true);
		expect(h.textGeneration).not.toHaveBeenCalled();
	});

	it("a rejecting saveTitle propagates to the stream catch, yet the chain tail still advances (r11)", async () => {
		// Generation emits a Title, so applyMessageUpdate invokes saveTitle → a title-only conversations
		// .updateOne ($set WITHOUT `messages`). Reject exactly that write; the message writes resolve.
		h.conversationsUpdateOne.mockImplementation(async (_filter, update) => {
			if (update?.$set && !("messages" in update.$set)) throw new Error("title write blip");
			return { acknowledged: true };
		});
		h.textGeneration.mockImplementation(() =>
			(async function* (): AsyncGenerator<MessageUpdate> {
				yield { type: MessageUpdateType.Title, title: "My Title", source: "model" };
			})()
		);

		const res = await makePost();
		await drain(res);

		// Current semantics: the title-write rejection is NOT catch-and-logged — it
		// propagates to the stream catch and errors the turn.
		expect(h.textGeneration).toHaveBeenCalled();
		expect(h.finishGeneration).toHaveBeenCalledWith("gen-123", "error");

		// ...but the chain TAIL advanced past the failed title link: a later persist (a `messages` write —
		// the terminal persistConversation) still ran.
		const calls = h.conversationsUpdateOne.mock.calls;
		const titleIdx = calls.findIndex(([, u]) => !!u?.$set && !("messages" in u.$set));
		expect(titleIdx).toBeGreaterThanOrEqual(0);
		const persistedAfterTitle = calls
			.slice(titleIdx + 1)
			.some(([, u]) => !!u?.$set && "messages" in u.$set);
		expect(persistedAfterTitle).toBe(true);
	});

	// ── retrieval is skipped on an agent turn (CUR-574) ───────────────────────────────────────────────
	// endpointAgent's returned function destructures only {messages, abortSignal, locals, conversationId}
	// off its call — `preprompt` (where the evidence these legs produce gets injected, see
	// textGeneration/index.ts) is dropped. Retrieval on an agent turn would pay for a round-trip
	// nobody uses and stamp `message.webSearch`/`.rag`, so the client's provenance trace would read
	// "searched the web · N sources" on a turn that never used a single one.

	it("an agent turn launches ZERO retrieval legs, even with webSearchMode: always", async () => {
		h.parseChatRequest.mockResolvedValue(h.baseParsedRequest({ webSearchMode: "always", agentMode: "on" }));
		h.resolveAgentRoute.mockResolvedValue({
			route: "agent",
			reason: "test",
			// getEndpoint: the route calls it unconditionally while building the generation ctx (before
			// textGeneration, which IS mocked, ever runs) — omitting it here errors the turn with a
			// harmless-but-noisy TypeError that has nothing to do with what this test asserts.
			model: { id: "potluck-agent", name: "potluck-agent", getEndpoint: vi.fn() },
		});

		const res = await makePost();
		await drain(res);

		expect(h.maybeRagGrounding).not.toHaveBeenCalled();
		expect(h.runWebRetrieval).not.toHaveBeenCalled();
		expect(h.runWebSearch).not.toHaveBeenCalled();
		expect(h.decideWebSearch).not.toHaveBeenCalled();
	});

	it("control: an ORDINARY turn with webSearchMode: always still launches retrieval — the gate is agent-specific", async () => {
		h.parseChatRequest.mockResolvedValue(h.baseParsedRequest({ webSearchMode: "always" }));
		// resolveAgentRoute stays "selected" (the beforeEach default) — an ordinary turn.

		const res = await makePost();
		await drain(res);

		// "always" mode's no-history pre-launch retrieval (webRetrievalPromise) is what actually fires
		// here — without the CUR-574 fix's gate, this is the SAME code path an agent turn would also hit.
		expect(h.runWebRetrieval).toHaveBeenCalled();
	});

	// CUR-2223. The screening marker names the retrieval that is really running beside the safety
	// screen, so a turn that looks only in our own documents never reads as a web search.
	describe("the screening marker names what is being searched", () => {
		it("search off, documents on: says our documents, and never sends the web marker", async () => {
			const phases = await drainPhases(await makePost());
			expect(phases).toContain("screening-documents");
			expect(phases.filter((p) => /web|searching/.test(p))).toEqual([]);
		});

		it("search always, documents on: says our documents and the web", async () => {
			h.parseChatRequest.mockResolvedValue(h.baseParsedRequest({ webSearchMode: "always" }));
			const phases = await drainPhases(await makePost());
			expect(phases).toContain("screening-documents-web");
			expect(phases).not.toContain("screening-documents");
		});

		it("documents off and search off: names neither", async () => {
			h.ragWillSearch.mockReturnValue(false);
			const phases = await drainPhases(await makePost());
			expect(phases).toContain("screening");
			expect(phases.filter((p) => p.startsWith("screening-"))).toEqual([]);
		});
	});
});
