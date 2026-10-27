import { describe, it, expect, vi, afterEach } from "vitest";

import {
	classifyWithGuard,
	guardShadowRun,
	launchGuardShadow,
	withGuardShadow,
	type GuardShadowDeps,
} from "./guardShadow";
import { textOnlyGuardInput, type GuardScreenInput } from "./guardScreenTypes";
import { SHIELDSTRAL_MODEL } from "./detectors/shieldstral";
import type { GuardPolicy, GuardRule } from "./guardPolicy";

function spyLogger() {
	return { info: vi.fn(), warn: vi.fn() };
}

// A small injected compose policy so the shadow's verdict is deterministic without the shipped file.
function testPolicy(): GuardPolicy {
	const entries: GuardRule[] = [
		{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
		{ key: "chat-block-violence", query: "VIOLENCE?", action: "block", tier: "content" },
		{ key: "chat-block-self-harm", query: "SELFHARM?", action: "log", tier: "content" },
	];
	return {
		entries,
		byKey: new Map(entries.map((e) => [e.key, e])),
		shield: { instruct: "i", outputInstruct: "o", categoryThreshold: 0.5, concurrency: 6, operationDeadlineMs: 20000 },
	};
}

function chatRes(v: string): Response {
	if (v === "yes") return { ok: true, status: 200, json: async () => ({ model: SHIELDSTRAL_MODEL, choices: [{ message: { content: "" }, logprobs: { content: [{ top_logprobs: [{ token: "yes", logprob: -0.0001 }, { token: "no", logprob: -9.21 }] }] } }] }) } as unknown as Response;
	return { ok: true, status: 200, json: async () => ({ model: SHIELDSTRAL_MODEL, choices: [{ message: { content: "" }, logprobs: { content: [{ top_logprobs: [{ token: "yes", logprob: -9.21 }, { token: "no", logprob: -0.0001 }] }] } }] }) } as unknown as Response;
}
function judgeFetch(map: Record<string, string>): typeof fetch {
	return vi.fn(async (_url: unknown, init: unknown) => {
		const body = JSON.parse((init as RequestInit).body as string);
		const c = body.messages[1].content as string;
		for (const [k, v] of Object.entries(map)) {
			if (k !== "default" && c.includes(k)) return chatRes(v);
		}
		return chatRes(map.default ?? "no");
	}) as unknown as typeof fetch;
}

const IN = (t = "screen me"): GuardScreenInput => textOnlyGuardInput(t);
const ON: GuardShadowDeps = { enabled: true, configured: true, policy: testPolicy() };

afterEach(() => vi.unstubAllEnvs());

describe("guardShadow — classifyWithGuard (delegates to the shared shipping screen, keys as categories)", () => {
	it("returns the verdict on a detection, with the fired rule KEYS as categories", async () => {
		const r = await classifyWithGuard(IN("hi"), {
			...ON,
			endpoint: "http://x/v1/chat/completions",
			fetchImpl: judgeFetch({ "VIOLENCE?": "yes", default: "no" }),
		});
		expect(r).toEqual({ status: "unsafe", categories: ["chat-block-violence"] });
	});
	it("reports `unsafe` for a LOG-action detection too — the shadow measures agreement, not enforcement", async () => {
		const r = await classifyWithGuard(IN("hi"), {
			...ON,
			endpoint: "http://x",
			fetchImpl: judgeFetch({ "SELFHARM?": "yes", default: "no" }),
		});
		expect(r).toEqual({ status: "unsafe", categories: ["chat-block-self-harm"] });
	});
	it("a benign screen → safe, no categories", async () => {
		const r = await classifyWithGuard(IN("hi"), { ...ON, endpoint: "http://x", fetchImpl: judgeFetch({ default: "no" }) });
		expect(r).toEqual({ status: "safe", categories: [] });
	});
	it("maps a non-2xx to `unknown` (never silently clean)", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
		const r = await classifyWithGuard(IN("hi"), { ...ON, endpoint: "http://x", fetchImpl, logger: spyLogger() });
		expect(r.status).toBe("unknown");
	});
	it("no endpoint configured → `unknown`, no fetch", async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const r = await classifyWithGuard(IN("hi"), { ...ON, endpoint: undefined, fetchImpl, logger: spyLogger() });
		expect(r.status).toBe("unknown");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("a 200 with unreadable JSON → `unknown`, not a rejection", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("bad json");
			},
		})) as unknown as typeof fetch;
		await expect(classifyWithGuard(IN("hi"), { ...ON, endpoint: "http://x", fetchImpl })).resolves.toEqual({
			status: "unknown",
			categories: [],
		});
	});
});

// ── The safety-contract tests: prove this is TRULY shadow ────────────────────────────────────────────
describe("guardShadow — safety contract (shadow-only)", () => {
	it("1. flag OFF → no guard call is made", () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		launchGuardShadow(IN(), { enabled: false, configured: true, fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("1b. enabled but NOT configured (no endpoint) → no guard call", () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		launchGuardShadow(IN(), { enabled: true, configured: false, fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("2. guard SUCCESS → run resolves and logs [guard-shadow]; launch is fire-and-forget (returns undefined)", async () => {
		const logger = spyLogger();
		await guardShadowRun(IN(), {
			...ON,
			endpoint: "http://x",
			fetchImpl: judgeFetch({ "VIOLENCE?": "yes", default: "no" }),
			logger,
			now: (() => {
				let t = 0;
				return () => (t += 5);
			})(),
		});
		expect(logger.info).toHaveBeenCalledTimes(1);
		const [fields, msg] = logger.info.mock.calls[0];
		expect(msg).toContain("[guard-shadow]");
		expect(fields).toMatchObject({ guardStatus: "unsafe", guardCategories: ["chat-block-violence"] });
		const ret = launchGuardShadow(IN(), { ...ON, endpoint: "http://x", fetchImpl: judgeFetch({ default: "no" }), logger });
		expect(ret).toBeUndefined();
	});
	it("3. guard REJECTION → run RESOLVES; the failure surfaces as a logged `unknown` screen; launch does not throw", async () => {
		const logger = spyLogger();
		const rejecting = vi.fn(async () => {
			throw new Error("network boom");
		}) as unknown as typeof fetch;
		await expect(
			guardShadowRun(IN(), { ...ON, endpoint: "http://x", fetchImpl: rejecting, logger })
		).resolves.toBeUndefined();
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info.mock.calls[0][1]).toContain("[guard-shadow]");
		expect(logger.info.mock.calls[0][0]).toMatchObject({ guardStatus: "unknown" });
		expect(() => launchGuardShadow(IN(), { ...ON, endpoint: "http://x", fetchImpl: rejecting, logger })).not.toThrow();
	});
	it("3b. run RESOLVES even if the clock AND the logger themselves throw (inner guard proved red)", async () => {
		const throwingLogger = {
			info: () => {
				throw new Error("info boom");
			},
			warn: () => {
				throw new Error("warn boom");
			},
		};
		const throwingNow = () => {
			throw new Error("clock boom");
		};
		await expect(
			guardShadowRun(IN(), {
				...ON,
				endpoint: "http://x",
				fetchImpl: judgeFetch({ default: "no" }),
				logger: throwingLogger,
				now: throwingNow,
			})
		).resolves.toBeUndefined();
	});
	it("4. guard NEVER settles → launch returns synchronously (cannot delay the turn)", () => {
		const logger = spyLogger();
		const neverSettles = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
		let returned = false;
		const ret = launchGuardShadow(IN(), { ...ON, endpoint: "http://x", fetchImpl: neverSettles, logger });
		returned = true;
		expect(ret).toBeUndefined();
		expect(returned).toBe(true);
	});
	it("empty input → no guard call", () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		launchGuardShadow(textOnlyGuardInput("   "), { ...ON, fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("5. suppressed:true → no guard call even with flag ON and configured (one screening operation)", () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		launchGuardShadow(IN(), { ...ON, suppressed: true, fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
		void withGuardShadow(Promise.resolve("bundle"), IN(), { ...ON, suppressed: true, fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

// ── Gate isolation: drive the SAME seam the route uses (withGuardShadow) ──────────────────────────────
describe("guardShadow — gate isolation via withGuardShadow (the seam the route calls)", () => {
	const BUNDLE = { childSafety: { flagged: false }, contentPolicy: { action: "allow" as const } };
	const shadow = (fetchImpl: typeof fetch): GuardShadowDeps => ({ ...ON, endpoint: "http://x", fetchImpl, logger: spyLogger() });

	it("returns the gate result UNCHANGED when the shadow SUCCEEDS", async () => {
		const r = await withGuardShadow(Promise.resolve(BUNDLE), IN(), shadow(judgeFetch({ default: "no" })));
		expect(r).toEqual(BUNDLE);
	});
	it("returns the gate result and does NOT reject when the shadow REJECTS", async () => {
		const rejecting = vi.fn(async () => {
			throw new Error("network boom");
		}) as unknown as typeof fetch;
		await expect(withGuardShadow(Promise.resolve(BUNDLE), IN(), shadow(rejecting))).resolves.toEqual(BUNDLE);
		await new Promise((r) => setTimeout(r, 0));
	});
	it("resolves on the GATE's timing even when the shadow NEVER settles (would hang if joined → red)", async () => {
		const neverSettles = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
		await expect(withGuardShadow(Promise.resolve(BUNDLE), IN(), shadow(neverSettles))).resolves.toEqual(BUNDLE);
	});
	it("propagates a real GATE rejection — the shadow can never mask a gate error", async () => {
		await expect(
			withGuardShadow(Promise.reject(new Error("gate failed")), IN(), shadow(judgeFetch({ default: "no" })))
		).rejects.toThrow("gate failed");
	});
});
