// POST /chat/api/safety/screen — driven THROUGH the real hooks/handle.ts (coop-review-plane Step 4a).
//
// The contract this file protects is NEGATIVE and security-critical: the early return in handle.ts must
// hand this exact path straight to the route, so NOTHING above it runs — no model-registry gate, no
// DB-backed config refresh, no authenticateRequest (which would POST the SAFETY_SCREEN_TOKEN to
// huggingface.co/api/whoami-v2 and 401 the agent), and no AUTOMATIC_LOGIN redirect. So the tripwires are
// the assertions: collections THROWS on any access, authenticateRequest / ensureModelsReady are spies
// that must NEVER be called, and AUTOMATIC_LOGIN is "true" so a missed early return WOULD answer a 302
// to the sign-in page, which every test's own status assertion rules out. The route then owns its own gate — 401 wrong/absent bearer, 503 unset, 413 over
// cap — and is a PURE detector that never reports to Coop.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GUARD_CORPUS_CAP } from "$lib/chat/server/guardScreenTypes";
import type { GuardScreen } from "$lib/chat/server/guardGate";

const h = vi.hoisted(() => ({
	db: { accesses: 0 },
	screen: { current: null as GuardScreen | null },
}));

// DB tripwire: any property read throws, so a single DB touch on this path fails the test loudly.
vi.mock("$lib/chat/server/database", () => ({
	collections: new Proxy(
		{},
		{
			get() {
				h.db.accesses++;
				throw new Error("collections was accessed on the safety/screen path — the hook did not early-return");
			},
		}
	),
}));

// auth: authenticateRequest is the ONLY thing that reaches huggingface.co/whoami — it must never be
// called on this path. loginEnabled()+AUTOMATIC_LOGIN would otherwise redirect an unauthenticated caller.
vi.mock("$lib/chat/server/auth", () => ({
	authenticateRequest: vi.fn(async () => {
		throw new Error("authenticateRequest was called on the safety/screen path");
	}),
	loginEnabled: () => true,
	refreshSessionCookie: vi.fn(),
}));

// The model-registry gate: a call here means the early return was missed.
vi.mock("$lib/chat/server/models", () => ({
	ensureModelsReady: vi.fn(async () => {
		throw new Error("ensureModelsReady was called on the safety/screen path");
	}),
}));

// config: AUTOMATIC_LOGIN="true" arms the redirect branch, so a missed early return is observable.
vi.mock("$lib/chat/server/config", () => ({
	config: {
		checkForUpdates: vi.fn(async () => {}),
		AUTOMATIC_LOGIN: "true",
		PUBLIC_ORIGIN: "https://www.aipotluck.org",
		PUBLIC_GOOGLE_ANALYTICS_ID: "",
	},
	ready: Promise.resolve(),
}));

vi.mock("$lib/chat/server/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("$app/environment", () => ({ dev: false, building: false }));

// The detector itself: real toHits, stubbed runGuardScreen (offline, controllable verdict).
vi.mock("$lib/chat/server/guardGate", async (orig) => {
	const actual = await orig<typeof import("$lib/chat/server/guardGate")>();
	return { ...actual, runGuardScreen: vi.fn(async () => h.screen.current) };
});

const SAFE: GuardScreen = {
	status: "safe",
	childUnknown: false,
	blockHits: [],
	logHits: [],
	chunks: 1,
	truncated: false,
	transportOk: true,
	servedModels: ["mistralai/Shieldstral-1.0-3B"],
	servedModelMissing: false,
};

const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));

beforeEach(() => {
	h.db.accesses = 0;
	h.screen.current = SAFE;
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchSpy);
	vi.stubEnv("SAFETY_SCREEN_TOKEN", "test-screen-token");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

/** Drive the request through the REAL handleRequest, with a resolve that dispatches to the route POST. */
async function throughHook(opts: {
	authorization?: string;
	body?: unknown;
	cookie?: string;
	pathname?: string;
}): Promise<Response> {
	const { handleRequest } = await import("$lib/chat/server/hooks/handle");
	const pathname = opts.pathname ?? "/chat/api/safety/screen";
	const headers = new Headers({ "content-type": "application/json" });
	if (opts.authorization) headers.set("authorization", opts.authorization);
	if (opts.cookie) headers.set("cookie", opts.cookie);
	const request = new Request(`https://www.aipotluck.org${pathname}`, {
		method: "POST",
		headers,
		body: opts.body === undefined ? "{}" : JSON.stringify(opts.body),
	});
	const event = { url: new URL(`https://www.aipotluck.org${pathname}`), request, locals: {} };
	const resolve = async (ev: { request: Request; url: URL }) => {
		const { POST } = await import("./+server");
		return (await POST({ request: ev.request, url: ev.url } as never)) as Response;
	};
	return handleRequest({ event, resolve } as never);
}

/** The three tripwires — asserted after every request that must reach the route. */
async function assertBypassedTheHook() {
	const auth = await import("$lib/chat/server/auth");
	const models = await import("$lib/chat/server/models");
	expect(h.db.accesses).toBe(0); // zero DB calls
	expect(auth.authenticateRequest).not.toHaveBeenCalled(); // zero HF whoami POSTs
	expect(models.ensureModelsReady).not.toHaveBeenCalled(); // model gate skipped
	const hfCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("huggingface.co"));
	expect(hfCalls).toHaveLength(0);
}

describe("POST /chat/api/safety/screen — through the hook (zero HF, zero DB, zero redirects)", () => {
	it("a valid bearer returns { status, hits } and NEVER reports to Coop", async () => {
		h.screen.current = {
			...SAFE,
			status: "unsafe",
			blockHits: [{ key: "chat-block-violence", action: "block", tier: "content" } as never],
			logHits: [{ key: "chat-block-self-harm", action: "log", tier: "content" } as never],
		};
		const res = await throughHook({
			authorization: "Bearer test-screen-token",
			body: { text: "screen me", surface: "agent-output" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "unsafe",
			hits: [
				{ key: "chat-block-violence", action: "block", tier: "content" },
				{ key: "chat-block-self-harm", action: "log", tier: "content" },
			],
		});
		await assertBypassedTheHook();
		// Pure detector: no /report and no /content fetch anywhere.
		const reviewCalls = fetchSpy.mock.calls.filter((c) => /\/api\/v1\/(report|content)/.test(String(c[0])));
		expect(reviewCalls).toHaveLength(0);
	});

	it("a wrong bearer → 401, still bypassing the hook (no DB, no HF, no redirect)", async () => {
		const res = await throughHook({
			authorization: "Bearer wrong-token",
			body: { text: "x", surface: "agent-input" },
		});
		expect(res.status).toBe(401);
		await assertBypassedTheHook();
	});

	it("an absent bearer → 401", async () => {
		const res = await throughHook({ body: { text: "x", surface: "agent-input" } });
		expect(res.status).toBe(401);
		await assertBypassedTheHook();
	});

	it("a wrong bearer WITH a session cookie still → 401 and never touches the DB", async () => {
		const res = await throughHook({
			authorization: "Bearer wrong-token",
			cookie: "session=abc123",
			body: { text: "x", surface: "agent-input" },
		});
		expect(res.status).toBe(401);
		await assertBypassedTheHook();
	});

	it("an UNSET token → 503 (config missing is not an open door), with a loud log", async () => {
		vi.stubEnv("SAFETY_SCREEN_TOKEN", "");
		const res = await throughHook({
			authorization: "Bearer anything",
			body: { text: "x", surface: "agent-input" },
		});
		expect(res.status).toBe(503);
		const { logger } = await import("$lib/chat/server/logger");
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("SAFETY_SCREEN_TOKEN is unset"));
		await assertBypassedTheHook();
	});

	it("text over the corpus cap → 413 (the caller truncates head+tail first)", async () => {
		const res = await throughHook({
			authorization: "Bearer test-screen-token",
			body: { text: "x".repeat(GUARD_CORPUS_CAP + 1), surface: "agent-output" },
		});
		expect(res.status).toBe(413);
		await assertBypassedTheHook();
	});

	it("a malformed body (missing surface) → 400", async () => {
		const res = await throughHook({
			authorization: "Bearer test-screen-token",
			body: { text: "x" },
		});
		expect(res.status).toBe(400);
		await assertBypassedTheHook();
	});

	it("output-shaped surfaces screen with the OUTPUT instruct; input-shaped use the default", async () => {
		const { runGuardScreen } = await import("$lib/chat/server/guardGate");
		const { loadGuardPolicy } = await import("$lib/chat/server/guardPolicy");
		const outputInstruct = loadGuardPolicy()?.shield.outputInstruct;
		await throughHook({
			authorization: "Bearer test-screen-token",
			body: { text: "answer text", surface: "agent-output" },
		});
		expect(runGuardScreen).toHaveBeenLastCalledWith(expect.anything(), { instruct: outputInstruct });

		await throughHook({
			authorization: "Bearer test-screen-token",
			body: { text: "prompt text", surface: "agent-input" },
		});
		// input-shaped → deps.instruct undefined → runGuardScreen falls back to shield.instruct.
		expect(runGuardScreen).toHaveBeenLastCalledWith(expect.anything(), { instruct: undefined });
	});
});
