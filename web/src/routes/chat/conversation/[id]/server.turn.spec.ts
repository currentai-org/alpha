/**
 * The streaming chat turn, end-to-end at the boundary (CUR-62).
 *
 * `server.prestream.spec.ts` is fully mocked (no DB / no network) and stops before the stream starts.
 * This suite covers the hole it names: a turn from POST → streamed tokens → a PERSISTED, re-loadable
 * conversation, against REAL Postgres (the `server-stateful` project), with only the model endpoint and
 * the external-network legs (moderation / RAG / search) stubbed.
 *
 * What stays REAL — the point of the test: the route handler, `textGeneration`/`generate`, the message
 * tree, the conversation write chain + `persistConversation`, `claimGeneration`/`finishGeneration`,
 * `loadAuthorizedConversation`, auth, and the DB itself. Only the LLM call is faked (a canned token
 * script through the real `Endpoint` contract), so the assertions exercise the real persistence and the
 * real `[turn] outcome` terminal log (CUR-57's turnTotalMs / genElapsedMs / outcome fields).
 *
 * Covers the CUR-62 asserts: POST → streamed updates → terminal state persisted + re-loadable, and the
 * `outcome` branches beyond success — here `complete`, `error`, and `aborted` (a deterministic in-process
 * user stop). `timedOut` / `shed` need the watchdog clock / admission gate and are left as follow-ups.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "bson";
import type { TextGenerationStreamOutputSimplified } from "$lib/chat/server/endpoints/types";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { DEGENERATE_REPETITION_FALLBACK_MESSAGE } from "$lib/chat/server/textGeneration/repetitionGuard";
import { WINDOW_WORDS } from "$lib/chat/server/textGeneration/loopCut";

// ── the swappable fake endpoint ─────────────────────────────────────────────────────────────────────
// A per-test token script drives the real generate() loop through the real Endpoint contract. `getEndpoint`
// (mocked on the model below) returns whatever `h.endpoint.current` yields for the active test.
const h = vi.hoisted(() => ({
	endpoint: { current: null as null | (() => AsyncGenerator<TextGenerationStreamOutputSimplified>) },
	// Which way resolveAgentRoute answers for the active test. Default "selected" (an ordinary turn);
	// a test flips it to "agent" to exercise the agent branch of the generation-deadline split.
	agentRoute: { route: "selected" as "selected" | "agent", failed: false },
	forceDeadline: false,
	deadlineCalls: 0,
	screenStarted: undefined as Promise<void> | undefined,
}));

// Trigger the real hard-deadline cleanup only after an output screen exists. Shorten only its emergency
// wait so the lifetime test does not need five seconds.
vi.mock("$lib/chat/server/chat/generationDeadline", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/chat/generationDeadline")>();
	return {
		...actual,
		raceGenerationDeadline: async <T>(work: Promise<T>, ms: number): Promise<T> => {
			if (h.forceDeadline && ++h.deadlineCalls === 2) {
				await h.screenStarted;
				throw new actual.GenerationDeadlineExceeded(ms);
			}
			return actual.raceGenerationDeadline(work, ms);
		},
		boundedSettle: <T>(work: Promise<T>, ms: number) =>
			actual.boundedSettle(work, h.forceDeadline ? 5 : ms),
	};
});

type TokenChunk = TextGenerationStreamOutputSimplified;

/** A clean successful generation: stream `tokens`, then a terminal chunk carrying the full text. */
function completingEndpoint(tokens: string[], finalText?: string) {
	return async function* (): AsyncGenerator<TokenChunk> {
		let id = 0;
		for (const t of tokens) {
			yield {
				token: { id: id++, text: t, logprob: 0, special: false },
				generated_text: null,
			} as TokenChunk;
		}
		// Terminal chunk: special token → generate() marks it not-interrupted → clean FinalAnswer.
		yield {
			token: { id, text: "", logprob: 0, special: true },
			generated_text: finalText ?? tokens.join(""),
		} as TokenChunk;
	};
}

/**
 * Opens the stream and closes it having emitted NO text at all. Note what this does NOT do: `generate`
 * gates the FinalAnswer on `if (output.generated_text)`, and "" is falsy, so no FinalAnswer is emitted
 * and the honesty guard never sees this turn. That is the `error` path, and this fixture exists to pin
 * it — a zero-token generation is not the guard-replaced-answer case that CUR-445 covers.
 */
function emptyEndpoint() {
	return async function* (): AsyncGenerator<TokenChunk> {
		yield {
			token: { id: 0, text: "", logprob: 0, special: true },
			generated_text: "",
		} as TokenChunk;
	};
}

/** Yields a couple of tokens, then throws — the turn must surface `outcome: "error"`. */
function throwingEndpoint(tokens: string[]) {
	return async function* (): AsyncGenerator<TokenChunk> {
		let id = 0;
		for (const t of tokens) {
			yield {
				token: { id: id++, text: t, logprob: 0, special: false },
				generated_text: null,
			} as TokenChunk;
		}
		throw new Error("simulated upstream model failure");
	};
}

/**
 * Simulates a user stop mid-stream: emit a token, then abort THIS conversation's live controller via the
 * in-process registry (exactly what the stop endpoint does when the request lands on the same pod), then
 * throw the SDK's abort error — the message the handler's isAbortError check matches. Deterministic: no
 * timers, no 300ms marker poll. The turn must surface `outcome: "aborted"`, distinct from `error`.
 */
function abortingEndpoint(conversationKey: string) {
	return async function* (): AsyncGenerator<TokenChunk> {
		yield {
			token: { id: 0, text: "partial", logprob: 0, special: false },
			generated_text: null,
		} as TokenChunk;
		AbortRegistry.getInstance().abort(conversationKey);
		throw new Error("Request was aborted.");
	};
}

// ── mocks: ONLY the model endpoint + the external-network legs. Everything else is real. ──────────────
vi.mock("$lib/chat/server/models", () => {
	const testModel = {
		id: "test-model",
		name: "test-model",
		displayName: "test-model",
		description: "test model",
		parameters: { stop: [] as string[] },
		multimodal: false,
		isRouter: false,
		supportsReasoning: false,
		messagesTotal: 0,
		// getEndpoint returns the Endpoint FUNCTION ((params) => AsyncGenerator); generate() invokes it.
		getEndpoint: async () => h.endpoint.current,
	};
	// The agent is a second registered model, served by the same fake endpoint — the deadline split
	// keys off the RESOLVED model id, so the only thing that has to be real here is the id.
	const agentModel = { ...testModel, id: "potluck-agent", name: "potluck-agent" };
	// A third, LOCAL model (CUR-1194), same fake endpoint — its own deadline split keys off `model.id`
	// starting with LOCAL_MODEL_ID_PREFIX (+server.ts's `isLocalModel`), so again the id is all that has
	// to be real. Placed directly in the static registry rather than routed through the real
	// resolveLocalModelsForUser/DB/discovery path — that path has its own thorough coverage in
	// localModels.spec.ts; this suite only needs to prove the ROUTE reacts to the id correctly.
	// "local:" is LOCAL_MODEL_ID_PREFIX's literal value, hardcoded rather than imported — a vi.mock
	// factory can't reference an outer module import (same reason AGENT_MODEL_ID is re-hardcoded as a
	// literal in the resolveAgentRoute mock below instead of imported from the real module).
	const localModel = { ...testModel, id: "local:test-local", name: "test-local" };
	return {
		models: [testModel, agentModel, localModel],
		defaultModel: testModel,
		taskModel: testModel,
		smallModel: testModel,
		validModelIdSchema: { safeParse: () => ({ success: true, data: "test-model" }), optional: () => ({}) },
		publishRegistry: () => {},
		applyLiveRegistry: () => {},
		ensureModelsReady: async () => {},
		bootModels: async () => {},
		validateModel: () => {},
	};
});

vi.mock("$lib/chat/server/moderation", () => ({
	getCoopVerdict: vi.fn(async () => ({ status: "ok" })),
	checkChildSafety: vi.fn(async () => ({ flagged: false })),
	checkContentPolicy: vi.fn(async () => ({ action: "allow" })),
	checkAdvisory: vi.fn(async () => ({ notice: false })),
	CHILD_SAFETY_DECLINE: "child-decline",
	// Mirrors moderation.childSafetyDeclineText with this mock's copy strings (the real one is unit-tested
	// in guardGate.spec.ts).
	childSafetyDeclineText: (r: { unscreened?: boolean }, ruleMessage?: string | null) =>
		r.unscreened ? "unscreened-decline" : (ruleMessage ?? "child-decline"),
	CONTENT_POLICY_DECLINE: "content-decline",
	// Output-screen decline/truncate copy — screenStream composes the withheld answer from these.
	OUTPUT_CONTENT_DECLINE: "output-content-decline",
	OUTPUT_CHILD_SAFETY_DECLINE: "output-child-decline",
	OUTPUT_CONTENT_TRUNCATE: "_[output content truncated]_",
	OUTPUT_CHILD_SAFETY_TRUNCATE: "_[output child truncated]_",
	OUTPUT_UNSCREENED_DECLINE: "output-unscreened-decline",
	OUTPUT_UNSCREENED_TRUNCATE: "_[output unscreened truncated]_",
	screenModelOutput: vi.fn(async () => ({ blocked: false, kind: null })),
	outputModerationEnabled: () => false,
	outputModerationRequested: () => false,
	isCoopConfigured: () => false,
	// coop-review-plane Step 1c: the review-plane reporter, spied so the guard-branch tests can assert
	// exactly-one (or zero) /report per turn. Never rejects.
	reportHitToCoop: vi.fn(async () => {}),
}));

// guardGate delegates to the real module (screenOutputWithGuard etc. must be real to test the route
// wiring), but resolveTurnPolicy can be overridden so a test can force guard-primary + output on.
const turnPolicyOverride: { current?: Partial<import("$lib/chat/server/guardGate").TurnPolicy> } = {};
// Controllable output screen so the finalizeOutput report path can be driven with real hits without a
// live Shieldstral endpoint (the real screenOutputWithGuard needs GUARD_SHADOW_URL).
const outputScreenOverride: {
	current?: (
		text: string,
		userId?: string
	) => Promise<import("$lib/chat/server/moderation").OutputScreenResult>;
} = {};
vi.mock("$lib/chat/server/guardGate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/guardGate")>();
	return {
		...actual,
		resolveTurnPolicy: vi.fn(async (o?: { useGuardPrimary?: boolean }) =>
			turnPolicyOverride.current
				? { ...(await actual.resolveTurnPolicy(o)), ...turnPolicyOverride.current }
				: actual.resolveTurnPolicy(o)
		),
		screenOutputWithGuard: vi.fn((text: string, userId?: string, deps?: unknown) =>
			(outputScreenOverride.current ?? actual.screenOutputWithGuard)(text, userId, deps as never)
		),
	};
});

// inputGate delegates to the REAL module by default (the Coop-branch tests below rely on it), but the
// guard-branch report-hook tests override `gateOverride.fn` to return a canned guard bundle — so the
// route's report hook can be driven without standing up a live Shieldstral endpoint.
const gateOverride: { fn?: typeof import("$lib/chat/server/inputGate").runInputGate } = {};
vi.mock("$lib/chat/server/inputGate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/inputGate")>();
	return {
		...actual,
		runInputGate: vi.fn((input: unknown, deps: unknown) =>
			(gateOverride.fn ?? actual.runInputGate)(input as never, deps as never)
		),
	};
});

// Toggleable flag + controllable regen output. Default OFF
// / undefined so every existing test keeps today's always-pointer behavior unless a test opts in. (CUR-192)
const groundedBailOverride = { on: false, regenText: undefined as string | undefined };
vi.mock("$lib/chat/server/textGeneration/groundedBailRegen", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/chat/server/textGeneration/groundedBailRegen")>();
	return {
		...actual,
		groundedBailRegenEnabled: () => groundedBailOverride.on,
		runGroundedBailRegen: vi.fn(async () => groundedBailOverride.regenText),
	};
});

// A planned turn needs the flag, the plan call and a registered plan model (CUR-2125, CUR-2198). The plan
// call is a spy so a test can assert it was never sent. With a ledger set it answers a math plan; with none
// it answers `outcome`, the call's exit, and no plan.
const mathOverride = {
	on: false,
	ledger: null as import("$lib/chat/server/textGeneration/mathRouting").Ledger | null,
	outcome: "ok" as import("$lib/chat/server/textGeneration/mathRouting").PlanCallOutcome,
	notAsked: false,
	// The follow-up call's standalone reading, or null for a message that stands on its own. (CUR-1957)
	followUp: null as string | null,
};
const followUpRead = () =>
	mathOverride.followUp
		? { outcome: "resolved" as const, standalone: mathOverride.followUp }
		: { outcome: "standalone" as const, standalone: null };
vi.mock("$lib/chat/server/textGeneration/mathRouting", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/textGeneration/mathRouting")>();
	return {
		...actual,
		mathRoutingEnabled: () => mathOverride.on,
		planTurn: vi.fn(async () =>
			mathOverride.notAsked
				? { plan: { math: { outcome: "not-asked" as const, ledger: null } }, followUp: followUpRead(), outcome: "ok" as const, ms: 4321 }
				: mathOverride.ledger
					? { plan: { math: { outcome: "ok" as const, ledger: mathOverride.ledger } }, followUp: followUpRead(), outcome: "ok" as const, ms: 4321 }
					: { plan: null, followUp: followUpRead(), outcome: mathOverride.outcome, ms: 4321 }
		),
	};
});

vi.mock("$lib/chat/server/rag", () => ({
	maybeRagGrounding: vi.fn(async () => null),
	ragWillSearch: vi.fn(() => true),
}));

vi.mock("$lib/chat/server/search/runSearch", () => ({
	runWebSearch: vi.fn(async () => undefined),
	runWebRetrieval: vi.fn(async () => undefined),
	decideWebSearch: vi.fn(async () => ({ search: false })),
}));

// Canned request parse (the boundary under test is streaming + persistence, not multipart parsing). A
// fresh generationId per call so the real claim/finish writes don't collide across tests.
const parsed: {
	generationId: string;
	uploadedFiles: import("$lib/chat/types/Message").MessageFile[];
	leftOutFiles: { name: string; mime: string }[];
	attachmentNotice?: string;
	newPrompt?: string;
	webSearchMode?: "off" | "auto" | "always";
} = {
	generationId: new ObjectId().toHexString(),
	uploadedFiles: [],
	leftOutFiles: [],
};
vi.mock("$lib/chat/server/chat/parseRequest", () => ({
	parseChatRequest: vi.fn(async () => ({
		newPrompt: parsed.newPrompt ?? "hi",
		messageId: undefined,
		isRetry: false,
		generationId: parsed.generationId,
		searchContext: undefined,
		webSearchMode: parsed.webSearchMode ?? "off",
		speakAll: false,
		speakMode: undefined,
		agentMode: "off",
		uploadedFiles: parsed.uploadedFiles,
		leftOutFiles: parsed.leftOutFiles,
		attachmentNotice: parsed.attachmentNotice,
	})),
}));

vi.mock("$lib/chat/server/chat/resolveAgentRoute", () => ({
	// AGENT_MODEL_ID must be re-exported: the route imports it to decide which generation deadline
	// this turn gets. A mock that omits it makes every turn look ordinary — including agent ones.
	AGENT_MODEL_ID: "potluck-agent",
	resolveAgentRoute: vi.fn(async ({ models }: { models: Array<{ id: string }> }) =>
		h.agentRoute.route === "agent"
			? { route: "agent", reason: "test", model: models.find((m) => m.id === "potluck-agent") }
			: { route: "selected", ...(h.agentRoute.failed ? { failed: true } : {}) }
	),
}));

// Real modules (DB, generations, textGeneration, persistence, auth, logger) load unmocked.
import { POST } from "./+server";
import { logger } from "$lib/chat/server/logger";
import * as moderation from "$lib/chat/server/moderation";
import * as guardGate from "$lib/chat/server/guardGate";
import { maybeRagGrounding } from "$lib/chat/server/rag";
import { config } from "$lib/chat/server/config";
import { planTurn } from "$lib/chat/server/textGeneration/mathRouting";
import { AbortRegistry } from "$lib/chat/server/abortRegistry";
import { collections } from "$lib/chat/server/database";
import {
	createTestUser,
	createTestConversation,
	createTestLocals,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import { searchConversations } from "$lib/chat/server/db/searchConversations";

// The Vercel Node request-context symbol the background bridge reads (see vercelBackground.ts). Stubbing
// its waitUntil lets a test prove the report is registered on the request context rather than left to
// freeze; deleting it reproduces the no-context path where runInBackground awaits inline under VERCEL.
const REQ_CTX = Symbol.for("@vercel/request-context");
import {
	DEFAULT_AGENT_GENERATION_TIMEOUT_MS,
	DEFAULT_GENERATION_TIMEOUT_MS,
	DEFAULT_LOCAL_GENERATION_TIMEOUT_MS,
	DEFAULT_SILENCE_TIMEOUT_MS,
} from "$lib/chat/utils/deadlineLadder";
// Real constant, real module (localModels.ts is not mocked in this file) — safe to import here at the
// test-body level, unlike inside the vi.mock("$lib/chat/server/models", ...) factory above, where a
// literal "local:" stands in for it instead (see that mock's own comment for why).
import { LOCAL_MODEL_ID_PREFIX } from "$lib/chat/server/localModels";

async function drain(res: Response): Promise<void> {
	const reader = res.body!.getReader();

	while (true) {
		const { done } = await reader.read();
		if (done) break;
	}
}

// Collect the newline-delimited JSON updates the route streams to the client. Padding lines (the 4096
// spaces after a FinalAnswer, the \0-padded Stream tokens) fail JSON.parse and are skipped. Lets a test
// assert on the streamed FinalAnswer line itself (CUR-946: its text, and that no carrier field leaks).
async function collectUpdates(res: Response): Promise<MessageUpdate[]> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		// The route enqueues strings; a byte stream would arrive as Uint8Array — handle both.
		if (value !== undefined)
			buf += typeof value === "string" ? value : decoder.decode(value, { stream: true });
		if (done) break;
	}
	const out: MessageUpdate[] = [];
	for (const line of buf.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as MessageUpdate);
		} catch {
			/* padding line, not a JSON update */
		}
	}
	return out;
}
const finalAnswerLine = (ups: MessageUpdate[]) =>
	ups.find(
		(u): u is Extract<MessageUpdate, { type: MessageUpdateType.FinalAnswer }> =>
			u.type === MessageUpdateType.FinalAnswer
	);

/** Find the terminal `[turn] outcome` log record (CUR-57's emit) among the logger.info spy calls. */
function turnOutcomeRecord(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
	// `c` needs an annotation as of vitest 4: `ReturnType<typeof vi.spyOn>` no longer carries
	// argument types through to mock.calls, so the callback parameter is an implicit any.
	const call = spy.mock.calls.find((c: unknown[]) => c[1] === "[turn] outcome");
	return call?.[0] as Record<string, unknown> | undefined;
}

describe("POST /conversation/[id] — real streaming turn (stateful)", () => {
	let locals: App.Locals;
	let convId: string;
	let infoSpy: ReturnType<typeof vi.spyOn>;
	let configSpy: ReturnType<typeof vi.spyOn> | undefined;

	beforeEach(async () => {
		await cleanupTestData();
		const created = await createTestUser();
		locals = created.locals;
		const conv = await createTestConversation(locals, { model: "test-model", messages: [] });
		convId = conv._id.toString();
		parsed.generationId = new ObjectId().toHexString();
		parsed.uploadedFiles = [];
		parsed.newPrompt = undefined;
		infoSpy = vi.spyOn(logger, "info");
	});

	afterEach(async () => {
		infoSpy.mockRestore();
		h.agentRoute.route = "selected";
		h.agentRoute.failed = false;
		h.forceDeadline = false;
		h.deadlineCalls = 0;
		h.screenStarted = undefined;
		gateOverride.fn = undefined; // don't leak a guard-branch override into the Coop-branch tests
		groundedBailOverride.on = false;
		groundedBailOverride.regenText = undefined;
		mathOverride.on = false;
		mathOverride.ledger = null;
		mathOverride.outcome = "ok";
		mathOverride.notAsked = false;
		mathOverride.followUp = null;
		vi.mocked(planTurn).mockClear();
		configSpy?.mockRestore();
		configSpy = undefined;
		turnPolicyOverride.current = undefined;
		outputScreenOverride.current = undefined;
		delete (globalThis as Record<symbol, unknown>)[REQ_CTX];
		vi.mocked(moderation.reportHitToCoop).mockReset();
		vi.mocked(moderation.reportHitToCoop).mockResolvedValue(undefined);
		vi.unstubAllEnvs(); // a failed assertion must not leak VERCEL=1 into a later test
		await cleanupTestData();
	});

	function makePost(): Promise<Response> {
		const request = new Request(`http://localhost/chat/conversation/${convId}`, { method: "POST" });
		return POST({
			request,
			locals,
			params: { id: convId },
			getClientAddress: () => "127.0.0.1",
		} as never);
	}

	it("POST → streamed tokens → assistant answer PERSISTED and re-loadable (outcome: complete)", async () => {
		h.endpoint.current = completingEndpoint(["Hello", ", ", "world"], "Hello, world");

		const res = await makePost();
		await drain(res);

		// The turn reached its terminal record as a success.
		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		expect(outcome!.outcome).toBe("complete");
		expect(outcome!.model).toBe("test-model");
		expect(outcome!.firstTokenReached).toBe(true);
		// The decline fields stay null on an ordinary turn — otherwise an alert filtering on
		// declineKind would count every successful answer (CUR-89).
		expect(outcome!.declineKind).toBeNull();
		expect(outcome!.declinedAt).toBeNull();
		expect(typeof outcome!.turnTotalMs).toBe("number");
		expect(typeof outcome!.genElapsedMs).toBe("number");

		// Persisted + re-loadable: a fresh read from the DB carries the streamed answer.
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded).not.toBeNull();
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant, "an assistant message was persisted").toBeDefined();
		expect(assistant!.content).toContain("Hello, world");
	});

	// searchConversations.spec.ts seeds its messages straight into the table; this is the other half,
	// that a turn stores the person's words where search reads them(SOL-195).
	// e2e-moved: scenarios/chat-search.spec.ts › search chats finds a past chat by a word said in it, and opens it
	it("a word the person said in a turn finds that chat in search, by the stored message rather than the title", async () => {
		parsed.newPrompt = "My code word is zephyrine. Now tell me one short fact about cats.";
		h.endpoint.current = completingEndpoint(["Cats ", "purr."], "Cats purr.");

		await drain(await makePost());

		const hits = await searchConversations({ userId: locals.user!._id.toString() }, "zephyrine");
		expect(hits.map((hit) => hit.id), "the chat that said the code word did not come back").toEqual([convId]);
		expect(hits[0].snippet).toContain("zephyrine");
	});

	it("a file the server left out stays on the sent message by name, so it doesn't vanish when the answer lands (CUR-3405)", async () => {
		h.endpoint.current = completingEndpoint(["Paris"], "Paris");
		parsed.leftOutFiles = [{ name: "long-report.pdf", mime: "application/pdf" }];
		parsed.attachmentNotice = "This PDF has more than 1,000 pages, so it wasn't added.";
		let updates: MessageUpdate[];
		try {
			updates = await collectUpdates(await makePost());
		} finally {
			parsed.leftOutFiles = [];
			parsed.attachmentNotice = undefined;
		}

		// Streamed with the note, so the open page marks the bubble before the post-turn reload.
		const notice = updates.find((u) => u.type === MessageUpdateType.AttachmentNotice);
		expect(notice).toMatchObject({ leftOutFiles: [{ name: "long-report.pdf", mime: "application/pdf" }] });

		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const question = reloaded!.messages.find((m) => m.from === "user" && m.content === "hi");
		expect(question?.leftOutFiles).toEqual([{ name: "long-report.pdf", mime: "application/pdf" }]);
		expect(reloaded!.messages.find((m) => m.from === "assistant")?.leftOutFiles).toBeUndefined();
	});

	// Auto's route check failed, so the selected model answers. The note is streamed and
	// stored on the answer, so a reload keeps it.
	// e2e-moved: scenarios/agent-route-unreachable.spec.ts › on Auto, a failed route check puts the agent-unreachable note on the answer, and it survives a reload (CUR-2830)
	it("a failed route check streams the agent-unreachable note and stores it on the answer (CUR-2830)", async () => {
		h.endpoint.current = completingEndpoint(["Lisbon"], "Lisbon");
		h.agentRoute.failed = true;
		const updates = await collectUpdates(await makePost());
		expect(updates.filter((u) => u.type === MessageUpdateType.AgentRouteNotice)).toHaveLength(1);
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded!.messages.find((m) => m.from === "assistant")?.agentRouteFailed).toBe(true);
	});

	it("a route check that answers puts no agent-unreachable note on the answer (CUR-2830)", async () => {
		h.endpoint.current = completingEndpoint(["Lisbon"], "Lisbon");
		const updates = await collectUpdates(await makePost());
		expect(updates.some((u) => u.type === MessageUpdateType.AgentRouteNotice)).toBe(false);
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded!.messages.find((m) => m.from === "assistant")?.agentRouteFailed).toBeUndefined();
	});

	// Server-authoritative backstop (CUR-770). `createTestConversation` writes straight to the DB, the way a
	// stale or legacy row (or any future write path that misses the models.ts schema exclusion) would arrive
	// here, bypassing every validated write endpoint on purpose, to prove the turn-resolution check catches it
	// independently of them. `agentMode.ts` is intentionally unmocked in this file, so this exercises the REAL
	// agentModeEnabledForUser: this run's deployEnv() isn't preview or production, so it returns false
	// deterministically, with no network call (CUR-771).
	it("a conversation whose model is the agent, from a non-cleared caller, is served on the default instead (CUR-770)", async () => {
		await collections.conversations.updateOne(
			{ _id: new ObjectId(convId) },
			{ $set: { model: "potluck-agent" } }
		);
		h.endpoint.current = completingEndpoint(["ok"], "ok");

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		expect(
			outcome!.model,
			"a non-cleared caller must never be served by the agent, however conv.model got set"
		).toBe("test-model");
	});

	it("a mid-stream model failure surfaces as a terminal error, not a silent success (outcome: error)", async () => {
		h.endpoint.current = throwingEndpoint(["partial"]);

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		expect(outcome!.outcome).toBe("error");
		expect(outcome!.model).toBe("test-model");

		// The conversation still persists (the turn record is durable even on the error path).
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded).not.toBeNull();
	});

	// A turn the safety gate REFUSED must be distinguishable in `[turn] outcome`. It aborts nothing, is
	// admitted, does not time out and does not error, so without its own outcome it computes `complete`. The
	// failure the alerting (CUR-35) exists to catch is Coop returning no verdict, checkChildSafety failing
	// CLOSED and every turn declining: that presents as the assistant refusing users rather than as a failure,
	// and moves a non-`complete` rate alert by exactly zero.
	//
	// `{ flagged: true }` is not a stand-in for "pretend it flagged": it is verbatim what the real
	// `checkChildSafety` returns on an UNKNOWN verdict (moderation.ts:278, the fail-CLOSED path), so this
	// reproduces that failure's own return value rather than approximating it.
	it("a child-safety decline records outcome=declined with its kind, not complete (CUR-89)", async () => {
		// Clear FIRST, then queue: nothing resets mocks between tests in this file, so the call history
		// is cumulative across the suite and the count assertion below would otherwise read the earlier
		// turns' calls rather than this one's.
		vi.mocked(moderation.checkChildSafety).mockClear();
		vi.mocked(moderation.checkChildSafety).mockResolvedValueOnce({ flagged: true });
		// Set even though the decline short-circuits before generation: it keeps this test independent
		// of whatever endpoint a previously-run test left on the shared harness.
		h.endpoint.current = completingEndpoint(["unused"], "unused");

		const res = await makePost();
		await drain(res);

		// Pins the one-call-per-turn assumption that makes `…Once` safe here: a future extra call (or
		// none) would otherwise leave the queued value unconsumed and decline the NEXT test's turn,
		// failing it there instead of here.
		expect(moderation.checkChildSafety).toHaveBeenCalledTimes(1);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		// The refusal is now visible as its own terminal outcome.
		expect(outcome!.outcome).toBe("declined");
		// And the KIND rides along, so the fail-closed signature is greppable on its own instead of being averaged
		// into an aggregate non-`complete` rate alongside ordinary moderation.
		expect(outcome!.declineKind).toBe("child_safety");
		// Refused BEFORE the model ran — distinct from an output-screen block, where it did run.
		expect(outcome!.declinedAt).toBe("input");
		expect(outcome!.firstTokenReached).toBe(false);

		// The decline really happened — otherwise the assertions above would just be describing an
		// ordinary successful turn.
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded).not.toBeNull();
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant, "an assistant message was persisted").toBeDefined();
		expect(assistant!.content).toContain("child-decline");
	});

	// The fail-closed path at the ROUTE level. moderation.spec.ts proves getCoopVerdict maps a bad/absent
	// verdict to UNKNOWN and that checkChildSafety fails CLOSED on it; this proves the whole pipeline HONOURS
	// that. The catastrophic regression is not "declines too much": it is a refactor that lets an unverifiable
	// verdict through, serving unscreened content while every test stays green.
	//
	// Deliberately pins the CURRENT contract, limitation included: a fail-closed decline is recorded with the
	// same declineKind ("child_safety") as a genuine policy block, so the log line cannot tell a verdict
	// failure from real abuse. That is why warmDeclineRate alerts on the RATE: a spike is the only available
	// signal (CUR-89).
	it("fails CLOSED when child-safety cannot be verified — declines rather than serving unscreened", async () => {
		vi.mocked(moderation.checkChildSafety).mockClear();
		// What a Coop failure produces: not "flagged", but "could not determine". The gate must refuse on that,
		// never allow.
		vi.mocked(moderation.checkChildSafety).mockRejectedValueOnce(new Error("Coop unreachable"));
		h.endpoint.current = completingEndpoint(["should-never-be-sent"], "should-never-be-sent");

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		// NOT "complete". A turn that completed here would mean unscreened content reached a user.
		expect(outcome!.outcome).not.toBe("complete");
		expect(outcome!.firstTokenReached, "the model must not have produced user-visible tokens").toBe(
			false
		);
	});

	it("a user stop mid-stream surfaces as aborted, distinct from error (outcome: aborted)", async () => {
		h.endpoint.current = abortingEndpoint(convId);

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		// The key distinction: a user stop is NOT an error — the outcome branch must read "aborted".
		expect(outcome!.outcome).toBe("aborted");
		expect(outcome!.model).toBe("test-model");

		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded).not.toBeNull();
	});

	// ── the empty rung (CUR-445) ──────────────────────────────────────────────────────────────────
	// outcomeLadder.spec.ts proves the PRECEDENCE. These two prove the ROUTE reaches it, and they are
	// the pair that matters: the same zero-token generation has to land on a different rung depending
	// on whether a guard covered for it, and only one of those two was ever visible.

	it("a grounded turn whose answer the guard threw away reports empty, not complete (CUR-445)", async () => {
		// `[1] [2]`: the rung is keyed on the substitution rather than on a length, since these are seven
		// characters, none of them an answer. Grounding is load-bearing here rather than scenery: without
		// `message.rag` the hedge replacement never arms and this test quietly becomes an ordinary `complete`.
		vi.mocked(maybeRagGrounding).mockResolvedValueOnce({
			query: "hi",
			sources: [{ n: 1, title: "Cloud Compute", snippet: "GPU.", engine: "Potluck" }],
			asOf: "2026-08-07T00:00:00.000Z",
			evidence: "[1] Cloud Compute (Potluck)",
		} as never);
		h.endpoint.current = completingEndpoint(["[1] ", "[2]"], "[1] [2]");

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		// The outcome is "empty" rather than "complete" (CUR-445). The guard has already replaced the
		// answer, so the route's `content === initialMessageContent` check sees changed content and cannot detect it.
		expect(outcome!.outcome).toBe("empty");
		// The pair that makes the case legible, and the reason logging one length was not enough: the
		// user received a few hundred characters, and the model wrote none of them.
		expect(outcome!.answerChars).toBeGreaterThan(outcome!.modelChars as number);
		// Not an error and not a timeout — the pipeline worked.
		expect(outcome!.firstTokenReached).toBe(true);
		expect(outcome!.declineKind).toBeNull();

		// The user was not left with a blank bubble: the guard's sources pointer persisted, which is
		// the behaviour CUR-113 argues for and the reason `hasError` could not be the fix here.
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toContain("Cloud Compute");
	});

	it("a grounded bail that RECOVERS via regen reports complete, not empty (CUR-192)", async () => {
		// Same setup as the test above -- grounding armed, the model's first attempt is pure hedge --
		// except this time grounded-bail-regen is on and the regen succeeds with a real, if
		// ungrounded, answer. A real turn of this shape must not report `empty` with `modelChars: 0`
		// when the user received a correct answer: classifyTurnOutcome cannot tell "the regen saved
		// this turn" from "nothing survived" if both feed it the same beforeChars: 0.
		vi.mocked(maybeRagGrounding).mockResolvedValueOnce({
			query: "hi",
			sources: [{ n: 1, title: "Cloud Compute", snippet: "GPU.", engine: "Potluck" }],
			asOf: "2026-08-07T00:00:00.000Z",
			evidence: "[1] Cloud Compute (Potluck)",
		} as never);
		h.endpoint.current = completingEndpoint(["[1] ", "[2]"], "[1] [2]");
		groundedBailOverride.on = true;
		groundedBailOverride.regenText = "I'm a machine that generates text from patterns.";

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		// The whole point: this must NOT land on the empty rung just because the first attempt bailed.
		expect(outcome!.outcome).toBe("complete");
		// The regen's own length, not the failed first attempt's zero -- the user got real content.
		expect(outcome!.modelChars).toBe(groundedBailOverride.regenText.length);
		expect(outcome!.answerChars).toBe(groundedBailOverride.regenText.length);

		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toBe(groundedBailOverride.regenText);
		expect(assistant!.groundedHedgeNotice?.kind).toBe("regen");
	});

	it("a turn that emitted NO text at all still reports error — nothing covered for it (CUR-445)", async () => {
		// The path CUR-445 does not cover, distinct from the case above. `generate` never yields a
		// FinalAnswer for an empty `generated_text`, so the guard never
		// runs, the content really is unchanged, and the route's own empty-output check fires. If this
		// ever flips to `empty`, a turn that showed the user a blank bubble stopped emitting the error
		// status that tells them so.
		h.endpoint.current = emptyEndpoint();

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome).toBeDefined();
		expect(outcome!.outcome).toBe("error");
		expect(outcome!.answerChars).toBe(0);
		expect(outcome!.modelChars).toBe(0);
	});

	// ── the generation-deadline split (CUR-144) ───────────────────────────────────────────────────
	// deadlineLadder.spec.ts proves the RESOLVER honours a per-kind fallback. These two prove the
	// ROUTE asks it the right question — that `isAgentTurn` is read after agent routing reassigns
	// `model`, and that each branch reaches the watchdog. Asserted through the real `[turn] outcome`
	// log, which carries the genTimeoutMs the watchdog was actually armed with.

	it("an ordinary turn is armed with the ORDINARY deadline, not the agent's longer one", async () => {
		// The widening direction, and the one that fails silently: a longer deadline never breaks a
		// test, it just holds hung ordinary turns open ~3x longer in production.
		h.endpoint.current = completingEndpoint(["ok"], "ok");

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome!.model).toBe("test-model");
		expect(outcome!.genTimeoutMs).toBe(DEFAULT_GENERATION_TIMEOUT_MS);
		expect(outcome!.genTimeoutMs).not.toBe(DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
		// For an ordinary turn the two coincide by design (CUR-58): the split is a no-op here, since every
		// real watchdog firing on this path is silence from the first token, never a slow-but-streaming
		// turn caught mid-flight.
		expect(outcome!.silenceTimeoutMs).toBe(DEFAULT_SILENCE_TIMEOUT_MS);
		expect(outcome!.silenceTimeoutMs).toBe(outcome!.genTimeoutMs);
	});

	it("an agent turn is armed with the AGENT deadline with no env var set anywhere", async () => {
		// The narrowing direction. AGENT_GENERATION_TIMEOUT_MS is unset in this process, so this also pins the
		// claim that agent turns are correct WITHOUT config: if the fallback ever stops being wired, agent work
		// that is already finished and verified gets killed at 45s (CUR-144) and nothing else in the suite would
		// notice.
		h.agentRoute.route = "agent";
		h.endpoint.current = completingEndpoint(["ok"], "ok");

		const res = await makePost();
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome!.model, "agent routing must have reassigned the model").toBe("potluck-agent");
		expect(outcome!.genTimeoutMs).toBe(DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
		// CUR-58's actual point, made assertable: on an agent turn the silence window stays at the
		// ordinary 45s default while the total backstop sits at up to 155s — the two genuinely diverge
		// here, which is what lets a stuck agent turn be caught long before the total ceiling.
		expect(outcome!.silenceTimeoutMs).toBe(DEFAULT_SILENCE_TIMEOUT_MS);
		expect(outcome!.silenceTimeoutMs as number).toBeLessThan(outcome!.genTimeoutMs as number);
	});

	it("a local-model turn is armed with the LOCAL deadline (CUR-1194) — a cold Ollama-style load is not a hang", async () => {
		// Own conversation (not the shared `convId`/"test-model" one from beforeEach) so the model id
		// itself — not agent routing — is what puts this turn on the local branch.
		const localConv = await createTestConversation(locals, {
			model: `${LOCAL_MODEL_ID_PREFIX}test-local`,
			messages: [],
		});
		h.endpoint.current = completingEndpoint(["ok"], "ok");

		const request = new Request(`http://localhost/chat/conversation/${localConv._id.toString()}`, {
			method: "POST",
		});
		const res = await POST({
			request,
			locals,
			params: { id: localConv._id.toString() },
			getClientAddress: () => "127.0.0.1",
		} as never);
		await drain(res);

		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome!.model).toBe(`${LOCAL_MODEL_ID_PREFIX}test-local`);
		expect(outcome!.genTimeoutMs).toBe(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS);
		expect(outcome!.genTimeoutMs).not.toBe(DEFAULT_GENERATION_TIMEOUT_MS);
		// The silence default is deliberately UNCHANGED for local turns (see deadlineLadder.ts's own
		// comment on DEFAULT_LOCAL_GENERATION_TIMEOUT_MS — the keepAlive-driven activity clock already
		// makes the silence trigger a practical no-op) — only the TOTAL backstop gets more patient.
		expect(outcome!.silenceTimeoutMs).toBe(DEFAULT_SILENCE_TIMEOUT_MS);
		expect(outcome!.silenceTimeoutMs as number).toBeLessThan(outcome!.genTimeoutMs as number);
	});

	// ── Coop as the hit-only REVIEW plane ────────────────────────────────────────────
	// The GUARD branch is driven by overriding runInputGate with a canned bundle, so the route's report
	// hook runs without a live Shieldstral endpoint. reportHitToCoop is the mocked spy above. The hook
	// fires on the SETTLED gate bundle, so one assertion covers the allowed path here; the
	// aborted / language-fallback paths reach the same settled bundle by construction.
	const guardBundle =
		(over: Partial<import("$lib/chat/server/inputGate").GateBundle> = {}) =>
		async (): Promise<import("$lib/chat/server/inputGate").GateBundle> => ({
			verdict: { status: "ok", actions: [] },
			childSafety: { flagged: false },
			contentPolicy: { action: "allow" },
			gateMs: 1,
			gateSource: "guard",
			hits: [],
			...over,
		});
	// Let the backgrounded gate->report .then flush before asserting on the spy.
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it("guard branch: a CLEAN turn (no hits) makes ZERO /report calls", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		gateOverride.fn = guardBundle({ hits: [] });
		h.endpoint.current = completingEndpoint(["ok"], "ok");
		await drain(await makePost());
		await flush();
		expect(moderation.reportHitToCoop).not.toHaveBeenCalled();
	});

	it("guard branch: a block hit DECLINES and reports exactly one /report with the exact message, text, hits, and subject", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		gateOverride.fn = guardBundle({
			contentPolicy: { action: "block", category: "chat-block-violence" },
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		await drain(await makePost());
		await flush();
		expect(moderation.reportHitToCoop).toHaveBeenCalledTimes(1);
		const arg = vi.mocked(moderation.reportHitToCoop).mock.calls[0][0];
		expect(arg.surface).toBe("chat-input");
		expect(arg.hits).toEqual([{ key: "chat-block-violence", action: "block", tier: "content" }]);
		// text is THIS turn's typed prompt (parseChatRequest mock returns "hi"); a wrong-text report fails.
		expect(arg.text).toBe("hi");
		// subject is the logged-in user's id (userId else sessionId).
		expect(arg.subjectId).toBe(String(locals.user!._id));
		// messageId is the persisted user message of this turn — not the assistant id, not empty.
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const userMsg = reloaded!.messages.find((m) => m.from === "user");
		expect(arg.messageId).toBe(userMsg!.id);
		expect(turnOutcomeRecord(infoSpy)!.declineKind).toBe("content_policy");
	});

	it("guard branch: a GUEST turn reports with the SESSION id as subject (subjectId fallback)", async () => {
		const guestLocals = createTestLocals(); // user: undefined, sessionId: "test-session-id"
		const guestConv = await createTestConversation(guestLocals, { model: "test-model", messages: [] });
		parsed.generationId = new ObjectId().toHexString();
		vi.mocked(moderation.reportHitToCoop).mockClear();
		gateOverride.fn = guardBundle({
			contentPolicy: { action: "block", category: "chat-block-violence" },
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		const request = new Request(`http://localhost/chat/conversation/${guestConv._id}`, { method: "POST" });
		const res = await POST({
			request,
			locals: guestLocals,
			params: { id: guestConv._id.toString() },
			getClientAddress: () => "127.0.0.1",
		} as never);
		await drain(res);
		await flush();
		expect(moderation.reportHitToCoop).toHaveBeenCalledTimes(1);
		expect(vi.mocked(moderation.reportHitToCoop).mock.calls[0][0].subjectId).toBe("test-session-id");
	});

	it("the gate->report registration is AWAITED, not voided: with VERCEL set and NO waitUntil, the response does not finish before the (delayed) report", async () => {
		// The legacy path awaits runPrestream before building the Response, so an inline-awaited report
		// holds the whole POST open. With `void runInBackground(...)` instead of `await`, the response
		// would finish immediately and this test goes red.
		vi.stubEnv("VERCEL", "1");
		delete (globalThis as Record<symbol, unknown>)[REQ_CTX]; // no waitUntil → runInBackground awaits inline
		// A handshake, not a fixed timer: reportStarted resolves the instant the report block is entered,
		// so the response check does not race a slow DB (which would otherwise leave `responded` false for
		// the wrong reason, with releaseReport still undefined).
		let releaseReport!: () => void;
		let reportEntered!: () => void;
		const reportStarted = new Promise<void>((r) => (reportEntered = r));
		vi.mocked(moderation.reportHitToCoop).mockClear();
		vi.mocked(moderation.reportHitToCoop).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					reportEntered();
					releaseReport = resolve;
				})
		);
		gateOverride.fn = guardBundle({
			contentPolicy: { action: "block", category: "chat-block-violence" },
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		let responded = false;
		const postP = makePost().then((r) => {
			responded = true;
			return r;
		});
		await reportStarted; // the awaited report is now in flight (releaseReport is defined)
		await new Promise((r) => setTimeout(r, 0)); // let a VOIDED registration finish the response, if it would
		expect(responded, "POST must not resolve while the awaited report is still pending").toBe(false);
		releaseReport();
		const res = await postP;
		await drain(res);
		expect(moderation.reportHitToCoop).toHaveBeenCalledTimes(1);
	});

	it("guard branch: a LOG-only hit ALLOWS the turn and still reports it", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		gateOverride.fn = guardBundle({ hits: [{ key: "chat-block-self-harm", action: "log", tier: "content" }] });
		h.endpoint.current = completingEndpoint(["Hello"], "Hello");
		await drain(await makePost());
		await flush();
		expect(moderation.reportHitToCoop).toHaveBeenCalledTimes(1);
		expect(turnOutcomeRecord(infoSpy)!.outcome).toBe("complete");
	});

	it("guard branch: an UNKNOWN screen with NO hits declines child-closed and reports NOTHING", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		gateOverride.fn = guardBundle({
			verdict: { status: "unknown", actions: [] },
			childSafety: { flagged: true },
			hits: [],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		await drain(await makePost());
		await flush();
		expect(moderation.reportHitToCoop).not.toHaveBeenCalled();
		expect(turnOutcomeRecord(infoSpy)!.declineKind).toBe("child_safety");
	});

	it("guard branch: an UNSCREENED UNKNOWN tells the person the check couldn't run, and stays counted as a child-safety fail-closed decline (CUR-2301)", async () => {
		gateOverride.fn = guardBundle({
			verdict: { status: "unknown", actions: [] },
			childSafety: { flagged: true, unscreened: true },
			hits: [],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		await drain(await makePost());
		await flush();
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toBe("unscreened-decline");
		expect(assistant!.moderation).toMatchObject({ kind: "child_safety", label: "child_safety", unscreened: true });
		expect(turnOutcomeRecord(infoSpy)!.declineKind).toBe("child_safety");
	});

	it("guard branch: a real child hit keeps the child-safety copy and is never marked unscreened (CUR-2301)", async () => {
		gateOverride.fn = guardBundle({
			verdict: { status: "ok", actions: ["chat-block-child-sexual-content"] },
			childSafety: { flagged: true, category: "chat-block-child-sexual-content" },
			hits: [{ key: "chat-block-child-sexual-content", action: "block", tier: "child" }],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		await drain(await makePost());
		await flush();
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).not.toBe("unscreened-decline");
		expect(assistant!.moderation?.unscreened).toBeUndefined();
	});

	it("guard branch: an UNKNOWN screen WITH a log hit declines child-closed AND reports that hit", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		gateOverride.fn = guardBundle({
			verdict: { status: "unknown", actions: [] },
			childSafety: { flagged: true },
			hits: [{ key: "chat-block-self-harm", action: "log", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");
		await drain(await makePost());
		await flush();
		expect(moderation.reportHitToCoop).toHaveBeenCalledTimes(1);
		expect(turnOutcomeRecord(infoSpy)!.declineKind).toBe("child_safety");
	});

	it("output under guard-primary with OUTPUT_MODERATION on and GUARD_SHADOW_URL unset WITHHOLDS the answer (fail-closed, coop-review-plane Step 3)", async () => {
		// Force the guard-primary output path on; the real screenOutputWithGuard then screens through the
		// real guard gate, which — with no GUARD_SHADOW_URL — returns UNKNOWN and fails child-closed. The
		// model's tokens must NEVER reach the user; the withheld state is carried by the outputModeration
		// marker AND the bubble shows the couldn't-check copy, since nothing judged the answer (CUR-3891;
		// a full withhold must not leave the message content empty, CUR-946).
		vi.stubEnv("GUARD_SHADOW_URL", "");
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		// The INPUT gate must ALLOW (else it fails child-closed on the same missing URL and we never reach
		// output). Override it to a clean guard bundle; the OUTPUT screen is the real screenOutputWithGuard.
		gateOverride.fn = guardBundle({ hits: [] });
		h.endpoint.current = completingEndpoint(["SECRET-MODEL-TEXT"], "SECRET-MODEL-TEXT");
		const res = await makePost();
		await drain(res);
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		// No unscreened model text reaches the user, and the bubble says the check could not finish rather
		// than that a child-safety classifier flagged it (CUR-3891). The block stays kind child_safety, so
		// the failure alert still counts it.
		expect(assistant!.content).not.toContain("SECRET-MODEL-TEXT");
		expect(assistant!.content).toBe(moderation.OUTPUT_UNSCREENED_DECLINE);
		expect(assistant!.outputModeration?.flagged).toBe(true);
		expect(assistant!.outputModeration?.kind).toBe("child_safety");
		expect(assistant!.outputModeration?.unscreened).toBe(true);
		const outcome = turnOutcomeRecord(infoSpy);
		expect(outcome!.declineKind).toBe("child_safety");
		expect(outcome!.declinedAt).toBe("output");
		// UNKNOWN is a screening failure, not a detection → it carries NO hits → NO output report (report iff hits>0).
		await flush();
		expect(
			vi.mocked(moderation.reportHitToCoop).mock.calls.filter((c) => c[0].surface === "chat-output").length
		).toBe(0);
	});

	it("output block: reports exactly ONE chat-output /report with the fired rule (finalizeOutput)", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] }); // input allows
		outputScreenOverride.current = async () => ({
			blocked: true,
			kind: "content_policy",
			category: "chat-block-violence",
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["some answer text"], "some answer text");
		await drain(await makePost());
		await flush();
		const outReports = vi
			.mocked(moderation.reportHitToCoop)
			.mock.calls.filter((c) => c[0].surface === "chat-output");
		expect(outReports.length).toBe(1);
		expect(outReports[0][0].hits).toEqual([{ key: "chat-block-violence", action: "block", tier: "content" }]);
		expect(typeof outReports[0][0].messageId).toBe("string");
	});

	it("a looping answer is cut before the output screen reads it, so a screen that declines a wall of repeats never fires (CUR-3318)", async () => {
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] });
		// Stands in for a screen that reads a run of "crushing" as violence once there is enough of it. The
		// count is over every text screened, and each one carries the previous chunk's tail as context, so
		// a streamed repeat can count twice: the cut lets about 11 through, the uncut loop 120.
		let crushingSeen = 0;
		outputScreenOverride.current = async (text: string) => {
			crushingSeen += text.match(/crushing/g)?.length ?? 0;
			return crushingSeen > 30
				? {
						blocked: true,
						kind: "content_policy",
						category: "chat-block-violence",
						hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
					}
				: { blocked: false, kind: null, hits: [] };
		};
		const loop = Array.from({ length: 120 }, () => "No crushing. No smashing. No breaking. ");
		h.endpoint.current = completingEndpoint(["The reading room closes at 19:40. ", ...loop]);
		await drain(await makePost());
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.outputModeration?.flagged ?? false).toBe(false);
		expect(assistant!.content).toContain("19:40");
		expect(assistant!.content).toContain(DEGENERATE_REPETITION_FALLBACK_MESSAGE);
		// One "crushing" in every six words, cut within a window of the loop starting.
		expect(assistant!.content.match(/crushing/g)?.length ?? 0).toBeLessThanOrEqual(Math.ceil(WINDOW_WORDS / 6) + 1);
	});

	it("a stream setup error settles the registered output lifetime without a report", async () => {
		turnPolicyOverride.current = { useGuardPrimary: true, outputModerationEnabled: true };
		gateOverride.fn = guardBundle({ hits: [] });
		const pending: Promise<unknown>[] = [];
		(globalThis as Record<symbol, unknown>)[REQ_CTX] = {
			get: () => ({ waitUntil: (p: Promise<unknown>) => pending.push(p) }),
		};
		const setupError = new Error("stream setup failed");
		const spy = vi.spyOn(AbortRegistry.getInstance(), "register").mockImplementation(() => { throw setupError; });
		h.endpoint.current = completingEndpoint(["never generated"]);
		try {
			const response = await makePost();
			await expect(drain(response)).rejects.toThrow("stream setup failed");
			let settled = false;
			void Promise.all(pending).then(() => { settled = true; });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(settled).toBe(true);
			expect(moderation.reportHitToCoop).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("hard deadline without waitUntil awaits the one output report before the response ends", async () => {
		vi.stubEnv("VERCEL", "1");
		h.forceDeadline = true;
		let screenStarted!: () => void;
		h.screenStarted = new Promise<void>((resolve) => (screenStarted = resolve));
		turnPolicyOverride.current = { useGuardPrimary: true, outputModerationEnabled: true };
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async () => {
			screenStarted();
			return { blocked: false, kind: null, hits: [{ key: "review", action: "log", tier: "content" }] };
		};
		let finishReport!: () => void;
		let reportDone = false;
		vi.mocked(moderation.reportHitToCoop).mockImplementation(async () => {
			await new Promise<void>((resolve) => (finishReport = resolve));
			reportDone = true;
		});
		h.endpoint.current = completingEndpoint(["A complete sentence. "], "A complete sentence. ");
		const response = await makePost();
		let responseEnded = false;
		const drained = drain(response).then(() => { responseEnded = true; });
		try {
			await vi.waitFor(() => expect(finishReport).toBeTypeOf("function"));
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(responseEnded).toBe(false);
		} finally {
			finishReport?.();
			await drained;
		}
		expect(reportDone).toBe(true);
		expect(moderation.reportHitToCoop).toHaveBeenCalledTimes(1);
	});

	it("a delayed speculative output hit reaches the single report after an earlier batch blocks", async () => {
		turnPolicyOverride.current = { useGuardPrimary: true, outputModerationEnabled: true };
		gateOverride.fn = guardBundle({ hits: [] });
		let calls = 0;
		outputScreenOverride.current = async () => {
			const n = calls++;
			if (n > 0) await new Promise((resolve) => setTimeout(resolve, 40));
			return {
				blocked: n === 0,
				kind: n === 0 ? "content_policy" : null,
				hits: [{ key: n === 0 ? "first-block" : "late-log", action: n === 0 ? "block" : "log", tier: "content" }],
			};
		};
		h.endpoint.current = completingEndpoint(["First sentence. " + "Later content. ".repeat(50)]);
		await drain(await makePost());
		expect(calls).toBeGreaterThan(1);
		const reports = vi.mocked(moderation.reportHitToCoop).mock.calls.filter(([r]) => r.surface === "chat-output");
		expect(reports).toHaveLength(1);
		expect(reports[0][0].hits.map((hit) => hit.key)).toEqual(["first-block", "late-log"]);
		const saved = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(saved!.messages.find((m) => m.from === "assistant")!.content).not.toContain("Later content");
	});

	it("the output screen is handed the person's own message, so the privacy rule can tell their details from someone else's (CUR-1837)", async () => {
		vi.mocked(guardGate.screenOutputWithGuard).mockClear();
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async () => ({ blocked: false, kind: null, hits: [] });
		h.endpoint.current = completingEndpoint(["a clean answer."], "a clean answer.");
		await drain(await makePost());
		await flush();
		// parseRequest is mocked to newPrompt "hi" above: that is the person's message this turn.
		const calls = vi.mocked(guardGate.screenOutputWithGuard).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => (c[2] as { askerText?: string } | undefined)?.askerText === "hi")).toBe(true);
	});

	it("output log-only hit: the answer is RELEASED and ONE chat-output /report fires", async () => {
		vi.mocked(moderation.reportHitToCoop).mockClear();
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async () => ({
			blocked: false,
			kind: null,
			hits: [{ key: "chat-block-self-harm", action: "log", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["a perfectly clean answer."], "a perfectly clean answer.");
		await drain(await makePost());
		await flush();
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toContain("a perfectly clean answer"); // log hit does NOT block — released
		const outReports = vi
			.mocked(moderation.reportHitToCoop)
			.mock.calls.filter((c) => c[0].surface === "chat-output");
		expect(outReports.length).toBe(1);
		expect(outReports[0][0].hits).toEqual([{ key: "chat-block-self-harm", action: "log", tier: "content" }]);
	});

	// ── CUR-946: the withheld bubble carries the reviewed decline/notice, not an empty string ──────────
	// End-to-end through the REAL pipeline (screenOutputStream → honestyScreenStream
	// → update()): the decline/notice reaches both the streamed FinalAnswer line and the persisted message,
	// and the out-of-band carrier never leaks onto the wire.
	it("a full output block renders the decline text, not an empty bubble (content policy)", async () => {
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] }); // input allows
		let screenCalls = 0;
		outputScreenOverride.current = async () => {
			screenCalls++;
			return {
				blocked: true,
				kind: "content_policy",
				category: "x",
				hits: [{ key: "x", action: "block", tier: "content" }],
			};
		};
		h.endpoint.current = completingEndpoint(
			["I will reveal the SECRET now."],
			"I will reveal the SECRET now."
		);

		const updates = await collectUpdates(await makePost());

		// Streamed to the client: the decline copy, with NO out-of-band carrier leaking onto the wire.
		const finalLine = finalAnswerLine(updates);
		expect(finalLine?.text).toBe(moderation.OUTPUT_CONTENT_DECLINE);
		expect(finalLine).not.toHaveProperty("declineText");
		expect(finalLine).not.toHaveProperty("declineNotice");

		// Persisted + re-loadable: the bubble is the decline copy, not empty, and never the model text.
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toBe(moderation.OUTPUT_CONTENT_DECLINE);
		expect(assistant!.content).not.toContain("SECRET");

		// The persisted audit trail (message.updates) also carries no out-of-band carrier — the delete()
		// at the chokepoint strips it from the SAME event object that update() pushes there.
		const persistedFinal = assistant!.updates?.find((u) => u.type === MessageUpdateType.FinalAnswer);
		expect(persistedFinal).toBeDefined();
		expect(persistedFinal).not.toHaveProperty("declineText");
		expect(persistedFinal).not.toHaveProperty("declineNotice");

		// One screen call → no regeneration / second output screen on a moderation-terminated turn.
		expect(screenCalls).toBe(1);
	});

	it("a full output block on the COOP path (not guard-primary) also renders the decline text", async () => {
		// The ticket requires BOTH paths. screenOutputStream shares one block branch, but only the guard
		// path is exercised above — this drives the default Coop screen (screenModelOutput) instead.
		turnPolicyOverride.current = {
			useGuardPrimary: false, // → screenOutputStream falls back to screenModelOutput (the Coop screen)
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		vi.mocked(moderation.screenModelOutput).mockResolvedValueOnce({
			blocked: true,
			kind: "content_policy",
			category: "x",
		});
		h.endpoint.current = completingEndpoint(["A withheld answer."], "A withheld answer.");

		await drain(await makePost());
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toBe(moderation.OUTPUT_CONTENT_DECLINE);
	});

	it("a full output block renders the child-safety decline copy", async () => {
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async () => ({
			blocked: true,
			kind: "child_safety",
			hits: [{ key: "chat-block-child", action: "block", tier: "child" }],
		});
		h.endpoint.current = completingEndpoint(["Some withheld answer."], "Some withheld answer.");

		await drain(await makePost());
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toBe(moderation.OUTPUT_CHILD_SAFETY_DECLINE);
	});

	it("a mid-stream output block appends the notice to the cleared prefix (no unexplained cut answer)", async () => {
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async (text: string) =>
			text.includes("BLOCKED")
				? {
						blocked: true,
						kind: "content_policy",
						category: "x",
						hits: [{ key: "x", action: "block", tier: "content" }],
					}
				: { blocked: false, kind: null, hits: [] };
		h.endpoint.current = completingEndpoint(
			["A clean opening sentence. ", "A BLOCKED second sentence."],
			"A clean opening sentence. A BLOCKED second sentence."
		);

		const expected = `A clean opening sentence.\n\n${moderation.OUTPUT_CONTENT_TRUNCATE}`;
		const updates = await collectUpdates(await makePost());
		const finalLine = finalAnswerLine(updates);
		expect(finalLine?.text).toBe(expected);
		expect(finalLine).not.toHaveProperty("declineNotice"); // carrier stripped at the chokepoint

		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).toBe(expected);
		expect(assistant!.content).not.toContain("BLOCKED"); // the flagged sentence is never persisted
	});

	it("a mid-stream block whose cleared prefix reduces to nothing renders JUST the notice (no stray leading blank lines)", async () => {
		// The cleared prefix is a bare `<response>` wrapper, the Apertus framing the route strips from a
		// screened prefix (`stripResponseTags`), so the processed prefix is empty. The route must join
		// without a "\n\n" prefix.
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async (text: string) =>
			text.includes("BLOCKED")
				? {
						blocked: true,
						kind: "content_policy",
						category: "x",
						hits: [{ key: "x", action: "block", tier: "content" }],
					}
				: { blocked: false, kind: null, hits: [] };
		h.endpoint.current = completingEndpoint(
			["<response>\n\n", "This must be BLOCKED."],
			"<response>\n\nThis must be BLOCKED."
		);

		await drain(await makePost());
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		// Exactly the notice — no leading "\n\n" carried over from the empty prefix.
		expect(assistant!.content).toBe(moderation.OUTPUT_CONTENT_TRUNCATE);
	});

	// ── CUR-2125: the math ledger is model-written text (GLM writes the labels) ────────────────────────
	// With `math-routing` on, the ledger rows reach the reader through the same screened, held source as
	// the answer, and GLM sees nothing of a turn the input screen declines.
	function armMathTurn(label: string) {
		mathOverride.on = true;
		mathOverride.ledger = { lines: [{ factors: [3, 4], label }] };
		const realGet = config.get.bind(config);
		configSpy = vi
			.spyOn(config, "get")
			// A string compare: the key's type comes from the env files svelte-kit reads, which vary by checkout.
			.mockImplementation((key) => ((key as string) === "ARITHMETIC_ROUTE_MODEL" ? "test-model" : realGet(key)));
	}
	const ledgerRow = (label: string) => `- ${label}: 3 × 4 = 12`;

	it("math routing on: an allowed turn shows the code-rendered ledger ahead of the answer", async () => {
		armMathTurn("widgets");
		gateOverride.fn = guardBundle({ hits: [] });
		h.endpoint.current = completingEndpoint(["That comes to 12."], "That comes to 12.");

		await drain(await makePost());

		expect(planTurn).toHaveBeenCalledTimes(1);
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content.startsWith(ledgerRow("widgets"))).toBe(true);
		expect(assistant!.content).toContain("That comes to 12.");
	});

	it.each(["off", "auto"] as const)(
		"persists the request's web-search mode on the turn's timings: a %s request records %s (CUR-4274)",
		async (mode) => {
			parsed.webSearchMode = mode;
			gateOverride.fn = guardBundle({ hits: [] });
			h.endpoint.current = completingEndpoint(["Hello."], "Hello.");
			try {
				await drain(await makePost());
			} finally {
				parsed.webSearchMode = undefined;
			}
			const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
			expect(reloaded!.messages.find((m) => m.from === "assistant")!.timings?.webSearchMode).toBe(mode);
		}
	);

	it("math routing on: the plan call's wall persists as timings.turnPlanMs, and a turn with routing off carries none (CUR-2137)", async () => {
		gateOverride.fn = guardBundle({ hits: [] });
		h.endpoint.current = completingEndpoint(["Hello."], "Hello.");
		await drain(await makePost());
		const plain = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const plainTimings = plain!.messages.find((m) => m.from === "assistant")!.timings;
		expect(plainTimings).toBeDefined();
		expect(plainTimings).not.toHaveProperty("turnPlanMs");

		const conv = await createTestConversation(locals, { model: "test-model", messages: [] });
		convId = conv._id.toString();
		parsed.generationId = new ObjectId().toHexString();
		armMathTurn("widgets");
		h.endpoint.current = completingEndpoint(["That comes to 12."], "That comes to 12.");
		await drain(await makePost());
		const routed = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = routed!.messages.find((m) => m.from === "assistant")!;
		expect(assistant.timings?.turnPlanMs).toBe(4321);
		expect(assistant.rungs?.find((r) => r.rung === "math-route")?.toolMs).toBe(4321);
	});

	it("math routing on, output screening on: a ledger row the output screen blocks never reaches the client or the database", async () => {
		turnPolicyOverride.current = {
			useGuardPrimary: true,
			outputModerationEnabled: true,
			screeningFacts: { content: true, output: true },
		};
		armMathTurn("FORBIDDEN widgets");
		gateOverride.fn = guardBundle({ hits: [] });
		outputScreenOverride.current = async (text: string) =>
			text.includes("FORBIDDEN")
				? {
						blocked: true,
						kind: "content_policy",
						category: "x",
						hits: [{ key: "x", action: "block", tier: "content" }],
					}
				: { blocked: false, kind: null, hits: [] };
		h.endpoint.current = completingEndpoint(["That comes to 12."], "That comes to 12.");

		const updates = await collectUpdates(await makePost());

		expect(JSON.stringify(updates)).not.toContain("FORBIDDEN");
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant");
		expect(assistant!.content).not.toContain("FORBIDDEN");
	});

	it("math routing on: a turn the input screen declines sends no ledger request and streams no ledger row", async () => {
		armMathTurn("widgets");
		gateOverride.fn = guardBundle({
			contentPolicy: { action: "block", category: "chat-block-violence" },
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		});
		h.endpoint.current = completingEndpoint(["unused"], "unused");

		const updates = await collectUpdates(await makePost());

		expect(planTurn).not.toHaveBeenCalled();
		expect(JSON.stringify(updates)).not.toContain(ledgerRow("widgets"));
		expect(turnOutcomeRecord(infoSpy)!.declineKind).toBe("content_policy");
	});

	// The plan transcript is text only, so a plan over a paste would stamp "Total: 1 characters
	// (arithmetic checked by code)" for a paste of 100,000 characters (CUR-3011).
	it("math routing on: a turn whose message carries a paste chip makes no plan call and shows no ledger", async () => {
		armMathTurn("characters in pasted text");
		gateOverride.fn = guardBundle({ hits: [] });
		parsed.uploadedFiles = [
			{
				type: "base64",
				name: "Pasted Content",
				mime: "application/vnd.chatui.clipboard",
				value: Buffer.from("one two three").toString("base64"),
			},
		];
		h.endpoint.current = completingEndpoint(["It has 13 characters."], "It has 13 characters.");

		const updates = await collectUpdates(await makePost());

		expect(planTurn).not.toHaveBeenCalled();
		expect(JSON.stringify(updates)).not.toContain(ledgerRow("characters in pasted text"));
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded!.messages.find((m) => m.from === "assistant")!.content).toContain("It has 13 characters.");
	});

	// A failed ledger gets no ```calc fence fallback, which would stamp a wrong setup as checked
	// (CUR-2134). A fence in the answer here stands for a model that writes one anyway: it must not
	// become a "checked by code" total.
	it("math routing on, ledger failed: no \"checked by code\" total reaches the reader, even from a calc fence in the answer, and the prompt asks for no fence", async () => {
		armMathTurn("widgets");
		mathOverride.ledger = null;
		mathOverride.outcome = "failed";
		gateOverride.fn = guardBundle({ hits: [] });
		const answer = "Here it is.\n\n```calc\n9 * 1 # full-time\n3 * 0.5 # part-time\n```\n";
		const inner = completingEndpoint([answer], answer);
		let preprompt: string | undefined;
		h.endpoint.current = async function* (params?: { preprompt?: string }) {
			preprompt = params?.preprompt;
			yield* inner();
		};

		const updates = await collectUpdates(await makePost());

		expect(planTurn).toHaveBeenCalledTimes(1);
		expect(finalAnswerLine(updates)?.text).not.toContain("checked by code");
		expect(JSON.stringify(updates)).not.toContain("checked by code");
		expect(preprompt ?? "").not.toMatch(/tagged calc/);
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant")!;
		expect(assistant.content).not.toContain("checked by code");
		expect(assistant.rungs?.find((r) => r.rung === "math-route")?.outcome).toBe("failed");
	});

	// The planner runs on every turn the screen allows, not only on turns a regex picked out. (CUR-2198)
	it("math routing on: a turn the planner reads as asking for no calculation gets no ledger, and its rung says not-asked", async () => {
		armMathTurn("widgets");
		mathOverride.notAsked = true;
		gateOverride.fn = guardBundle({ hits: [] });
		h.endpoint.current = completingEndpoint(["Here is the summary."], "Here is the summary.");

		await drain(await makePost());

		expect(planTurn).toHaveBeenCalledTimes(1);
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant")!;
		expect(assistant.content).toBe("Here is the summary.");
		const rung = assistant.rungs?.find((r) => r.rung === "math-route");
		expect(rung).toMatchObject({ gate: "no", outcome: "not-asked", toolMs: 4321 });
	});

	// A follow-up such as "Which ones do you recommend?" after the assistant's own list of options
	// needs the earlier turn to resolve (CUR-1957). The plan's standalone reading reaches the answer model beside the message, which stays the person's own.
	it("math routing on: a follow-up the planner resolves reaches the answer prompt as a quoted reading, and the person's message is unchanged", async () => {
		armMathTurn("widgets");
		mathOverride.notAsked = true;
		mathOverride.followUp = "Which of the three laptops listed earlier do you recommend?";
		gateOverride.fn = guardBundle({ hits: [] });
		const inner = completingEndpoint(["The second one."], "The second one.");
		let preprompt: string | undefined;
		let sentMessages: unknown;
		h.endpoint.current = async function* (params?: { preprompt?: string; messages?: unknown }) {
			preprompt = params?.preprompt;
			sentMessages = params?.messages;
			yield* inner();
		};

		await drain(await makePost());

		expect(preprompt ?? "").toContain('"Which of the three laptops listed earlier do you recommend?"');
		expect(JSON.stringify(sentMessages)).not.toContain("three laptops listed earlier");
	});

	it("math routing on: a follow-up reading still reaches the prompt when the math plan call failed, since the two calls are separate", async () => {
		armMathTurn("widgets");
		mathOverride.ledger = null;
		mathOverride.outcome = "timeout";
		mathOverride.followUp = "Which of the three laptops listed earlier do you recommend?";
		gateOverride.fn = guardBundle({ hits: [] });
		const inner = completingEndpoint(["The second one."], "The second one.");
		let preprompt: string | undefined;
		h.endpoint.current = async function* (params?: { preprompt?: string }) {
			preprompt = params?.preprompt;
			yield* inner();
		};

		await drain(await makePost());

		expect(preprompt ?? "").toContain('"Which of the three laptops listed earlier do you recommend?"');
	});

	it("math routing on: a message that stands on its own adds no follow-up reading to the prompt", async () => {
		armMathTurn("widgets");
		mathOverride.notAsked = true;
		gateOverride.fn = guardBundle({ hits: [] });
		const inner = completingEndpoint(["Here is the summary."], "Here is the summary.");
		let preprompt: string | undefined;
		h.endpoint.current = async function* (params?: { preprompt?: string }) {
			preprompt = params?.preprompt;
			yield* inner();
		};

		await drain(await makePost());

		expect(preprompt ?? "").not.toContain("refers back to earlier");
	});

	// The FinalAnswer persist (CUR-2078) writes the answer, and the rungs arrive with the terminal
	// persist after it, so a reader of the stored row once the client hears "final" would find no
	// rung (CUR-2161). Anything that reads the row at that point must see the rung.
	it("math routing on: the math-route rung is stored before the client hears the answer is final", async () => {
		armMathTurn("widgets");
		mathOverride.notAsked = true;
		gateOverride.fn = guardBundle({ hits: [] });
		h.endpoint.current = completingEndpoint(["Here is the summary."], "Here is the summary.");

		const reader = (await makePost()).body!.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		let rungAtFinal: unknown = "stream ended with no FinalAnswer line";
		for (;;) {
			const { done, value } = await reader.read();
			if (value !== undefined) buf += typeof value === "string" ? value : decoder.decode(value, { stream: true });
			if (buf.includes(`"type":"${MessageUpdateType.FinalAnswer}"`)) {
				const stored = await collections.conversations.findOne({ _id: new ObjectId(convId) });
				rungAtFinal = stored!.messages
					.find((m) => m.from === "assistant")
					?.rungs?.find((r) => r.rung === "math-route")?.outcome;
				break;
			}
			if (done) break;
		}
		await reader.cancel();
		expect(rungAtFinal).toBe("not-asked");
	});

	// The answer model copies the stamp from an earlier rendered ledger onto its own total. With
	// the plan call timed out there is no real ledger, so no stamp may reach the reader at all. (CUR-2199)
	it("math routing on, plan timed out: a stamp the answer model forges never reaches the client or the database", async () => {
		armMathTurn("widgets");
		mathOverride.ledger = null;
		mathOverride.outcome = "timeout";
		gateOverride.fn = guardBundle({ hits: [] });
		const answer = "One resigned, so:\n\nTotal: **16** FTE _(arithmetic checked by code)_";
		h.endpoint.current = completingEndpoint(["One resigned, so:\n\nTotal: **16** FTE _(arith", "metic checked by code)_"], answer);

		const updates = await collectUpdates(await makePost());

		expect(JSON.stringify(updates)).not.toContain("checked by code");
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant")!;
		expect(assistant.content).toBe("One resigned, so:\n\nTotal: **16** FTE");
		expect(assistant.rungs?.find((r) => r.rung === "math-route")).toMatchObject({ gate: "failed", outcome: "timeout" });
	});

	// The ledger carries no label, so the next turn's planner finds it on the message instead. (CUR-3663)
	it("math routing on: the ledger is stored on the answer, carries no \"checked by code\" label, and the answer's copied one is removed", async () => {
		armMathTurn("widgets");
		gateOverride.fn = guardBundle({ hits: [] });
		const answer = "So: Total: **12** _(arithmetic checked by code)_";
		h.endpoint.current = completingEndpoint([answer], answer);

		await drain(await makePost());

		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant")!;
		expect(assistant.content).toBe(`${ledgerRow("widgets")}\n\nTotal: **12**\n\nSo: Total: **12**`);
		expect(assistant.mathLedger).toEqual({ lines: [{ factors: [3, 4], label: "widgets" }] });
	});

	// The strip is a base guard on every turn, so a stamp copied from history comes off with
	// math routing off too. (CUR-2697)
	it("math routing off: a stamp the answer model copies never reaches the client or the database", async () => {
		gateOverride.fn = guardBundle({ hits: [] });
		const answer = "One resigned, so:\n\nTotal: **16** FTE _(arithmetic checked by code)_";
		h.endpoint.current = completingEndpoint(["One resigned, so:\n\nTotal: **16** FTE _(arith", "metic checked by code)_"], answer);

		const updates = await collectUpdates(await makePost());

		expect(JSON.stringify(updates)).not.toContain("checked by code");
		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		expect(reloaded!.messages.find((m) => m.from === "assistant")!.content).toBe("One resigned, so:\n\nTotal: **16** FTE");
	});

	// The grounded-bail regen replaces the whole answer after the stream, outside stripForgedStamp. With
	// the plan timed out there is no ledger in front, so a hedged grounded answer can bail and the regen
	// can copy a stamp from history (CUR-2198).
	it("math routing on, plan timed out, grounded answer bails to a regen: the regen's forged stamp never persists", async () => {
		armMathTurn("widgets");
		mathOverride.ledger = null;
		mathOverride.outcome = "timeout";
		gateOverride.fn = guardBundle({ hits: [] });
		vi.mocked(maybeRagGrounding).mockResolvedValueOnce({
			query: "hi",
			sources: [{ n: 1, title: "Cloud Compute", snippet: "GPU.", engine: "Potluck" }],
			asOf: "2026-08-07T00:00:00.000Z",
			evidence: "[1] Cloud Compute (Potluck)",
		} as never);
		h.endpoint.current = completingEndpoint(["[1] ", "[2]"], "[1] [2]");
		groundedBailOverride.on = true;
		groundedBailOverride.regenText = "- widgets: now 3 × 4 = 12\n\nTotal: **12** _(arithmetic checked by code)_";

		await drain(await makePost());

		const reloaded = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		const assistant = reloaded!.messages.find((m) => m.from === "assistant")!;
		expect(assistant.groundedHedgeNotice?.kind).toBe("regen");
		expect(assistant.content).not.toMatch(/checked by code/);
		expect(assistant.content).toContain("Total: **12**");
	});
});
