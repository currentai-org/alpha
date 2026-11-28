/**
 * resolveFaultInjection is the only thing that can make a live request simulate a named
 * fault. Same shape as betterAuth.otpSendCapCarveOut.spec.ts: every case here is really one
 * assertion repeated. BOTH conditions (env allow-list, correct secret) must hold simultaneously,
 * and any one missing returns null, the same "apply real behavior" default the OTP carve-out uses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.E2E_FAULT_INJECT_TOKEN = "test-secret-value";
	delete process.env.VERCEL_ENV;
	delete process.env.DEPLOY_ENV;
});

async function importSubject() {
	const { resolveFaultInjection } = await import("./faultInjection");
	return resolveFaultInjection;
}

function req({ token, fault }: { token?: string; fault?: string } = {}): Request {
	const headers = new Headers();
	if (token !== undefined) headers.set("x-e2e-fault-inject-token", token);
	if (fault !== undefined) headers.set("x-e2e-fault-inject", fault);
	return new Request("https://example.vercel.app/chat/conversation/abc123", {
		method: "POST",
		headers
	});
}

describe("resolveFaultInjection", () => {
	it("resolves the requested fault when both conditions hold, on preview", async () => {
		process.env.VERCEL_ENV = "preview";
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "no_assistant_reply" }))
		).toBe("no_assistant_reply");
	});

	it("resolves the requested fault when both conditions hold, on development", async () => {
		process.env.DEPLOY_ENV = "development";
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "no_assistant_reply" }))
		).toBe("no_assistant_reply");
	});

	it("returns null on preview with no token header at all", async () => {
		process.env.VERCEL_ENV = "preview";
		const resolveFaultInjection = await importSubject();
		expect(await resolveFaultInjection(req({ fault: "no_assistant_reply" }))).toBeNull();
	});

	it("returns null on preview with a wrong token value", async () => {
		process.env.VERCEL_ENV = "preview";
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "wrong-value", fault: "no_assistant_reply" }))
		).toBeNull();
	});

	it("returns null in production, even with a correct token and a real fault name", async () => {
		process.env.VERCEL_ENV = "production";
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "no_assistant_reply" }))
		).toBeNull();
	});

	// The canned read-aloud clip swaps a third-party call out of a user-visible turn, so it
	// must sit behind the same gate as every other fault.
	it("resolves tts_canned_clip on preview and refuses it in production", async () => {
		const resolveFaultInjection = await importSubject();
		process.env.VERCEL_ENV = "preview";
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "tts_canned_clip" }))
		).toBe("tts_canned_clip");
		process.env.VERCEL_ENV = "production";
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "tts_canned_clip" }))
		).toBeNull();
	});

	// The allow-list ("preview" or "development" only) over a deny-list (`!== "production"`), which
	// would wrongly treat an undeclared/misconfigured environment as safe.
	it("returns null when the environment is undeclared (deployEnv() returns null)", async () => {
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "no_assistant_reply" }))
		).toBeNull();
	});

	it("returns null when E2E_FAULT_INJECT_TOKEN is unset, regardless of the headers sent", async () => {
		process.env.VERCEL_ENV = "preview";
		delete cfg.E2E_FAULT_INJECT_TOKEN;
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "", fault: "no_assistant_reply" }))
		).toBeNull();
	});

	it("returns null for a fault name outside the registered vocabulary, even with a correct token", async () => {
		process.env.VERCEL_ENV = "preview";
		const resolveFaultInjection = await importSubject();
		expect(
			await resolveFaultInjection(req({ token: "test-secret-value", fault: "not_a_real_fault" }))
		).toBeNull();
	});

	it("returns null when the token is correct but no fault name header is sent", async () => {
		process.env.VERCEL_ENV = "preview";
		const resolveFaultInjection = await importSubject();
		expect(await resolveFaultInjection(req({ token: "test-secret-value" }))).toBeNull();
	});
});

// A fixed window shorter than one Coop call may take (8s by default) would trip on a slow
// but healthy screen. The window has to track the per-call bound, whatever COOP_TIMEOUT_MS is set to.
describe("outputScreenWindowFaultMs", () => {
	it("is never shorter than one Coop call's own timeout, at the default or a configured bound", async () => {
		const { outputScreenWindowFaultMs } = await import("./faultInjection");
		const { coopCallTimeoutMs } = await import("$lib/chat/server/moderation");
		delete process.env.COOP_TIMEOUT_MS;
		expect(outputScreenWindowFaultMs()).toBeGreaterThanOrEqual(coopCallTimeoutMs());
		expect(outputScreenWindowFaultMs()).toBeGreaterThanOrEqual(8_000);
		process.env.COOP_TIMEOUT_MS = "12000";
		try {
			expect(outputScreenWindowFaultMs()).toBeGreaterThanOrEqual(12_000);
		} finally {
			delete process.env.COOP_TIMEOUT_MS;
		}
	});
});

// `generation_timeout` uses a shorter watchdog than the real 45s, which reaches the same
// abort path without the wait.
describe("watchdogDeadlineMs", () => {
	const plain = { isAgentTurn: false };
	const agent = { isAgentTurn: true };

	it("keeps the configured deadline when no fault applies, including an agent fault on a plain turn", async () => {
		const { watchdogDeadlineMs } = await import("./faultInjection");
		expect(watchdogDeadlineMs(45_000, null, plain)).toBe(45_000);
		expect(watchdogDeadlineMs(240_000, null, agent)).toBe(240_000);
		expect(watchdogDeadlineMs(45_000, "latency_30s", plain)).toBe(45_000);
		expect(watchdogDeadlineMs(45_000, "agent_turn_deadline_20s", plain)).toBe(45_000);
	});

	it("shortens the watchdog under generation_timeout, but never lengthens a shorter configured one", async () => {
		const { watchdogDeadlineMs } = await import("./faultInjection");
		expect(watchdogDeadlineMs(45_000, "generation_timeout", plain)).toBe(15_000);
		expect(watchdogDeadlineMs(5_000, "generation_timeout", plain)).toBe(5_000);
	});

	it("gives an agent turn the 20s deadline under agent_turn_deadline_20s", async () => {
		const { watchdogDeadlineMs } = await import("./faultInjection");
		expect(watchdogDeadlineMs(240_000, "agent_turn_deadline_20s", agent)).toBe(20_000);
	});

	it("keeps a silent primary's real watchdog, since the backup the silent-lane deadline moves to needs it", async () => {
		const { watchdogDeadlineMs } = await import("./faultInjection");
		expect(watchdogDeadlineMs(45_000, "primary_lane_hangs", plain)).toBe(45_000);
	});

	it("answer_streams_past_cap shortens a plain turn's total cap to 4s, never lengthens a shorter one", async () => {
		const { watchdogDeadlineMs } = await import("./faultInjection");
		expect(watchdogDeadlineMs(45_000, "answer_streams_past_cap", plain)).toBe(4_000);
		expect(watchdogDeadlineMs(2_000, "answer_streams_past_cap", plain)).toBe(2_000);
	});
});

describe("resolveReplayMode", () => {
	const replayReq = (headers: Record<string, string>) =>
		new Request("https://example.vercel.app/chat/conversation/abc123", { method: "POST", headers });
	const token = { "x-e2e-fault-inject-token": "test-secret-value" };

	it("reads its own header, so a spec can replay and inject a named fault on the same send", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveReplayMode, resolveFaultInjection } = await import("./faultInjection");
		const r = replayReq({ ...token, "x-e2e-replay": "new_episodes", "x-e2e-fault-inject": "chat_500" });
		expect(await resolveReplayMode(r)).toBe("new_episodes");
		expect(await resolveFaultInjection(r)).toBe("chat_500");
		expect(await resolveReplayMode(replayReq({ ...token, "x-e2e-replay": "none" }))).toBe("none");
		expect(await resolveReplayMode(replayReq({ ...token, "x-e2e-replay": "all" })), "a retry's live-and-record header (SOL-166)").toBe("all");
		expect(await resolveReplayMode(replayReq({ "x-e2e-replay": "all" })), "all without the token is no replay at all").toBeNull();
	});

	it("still honours the model_replay faults on their own", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveReplayMode } = await import("./faultInjection");
		expect(await resolveReplayMode(replayReq({ ...token, "x-e2e-fault-inject": "model_replay" }))).toBe("new_episodes");
		expect(await resolveReplayMode(replayReq({ ...token, "x-e2e-fault-inject": "model_replay_none" }))).toBe("none");
	});

	it("returns null without the token, on production, or when nothing asks for replay", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveReplayMode } = await import("./faultInjection");
		expect(await resolveReplayMode(replayReq({ "x-e2e-replay": "none" }))).toBeNull();
		expect(await resolveReplayMode(replayReq({ ...token }))).toBeNull();
		process.env.VERCEL_ENV = "production";
		expect(await resolveReplayMode(replayReq({ ...token, "x-e2e-replay": "none" }))).toBeNull();
	});
});

describe("adoptReplayMode — a scenario request's replay mode reaches every route", () => {
	const replayReq = (headers: Record<string, string>) =>
		new Request("https://example.vercel.app/chat/api/any-new-route", { method: "POST", headers });
	const token = { "x-e2e-fault-inject-token": "test-secret-value" };

	it("puts the mode in the request context, where every model call reads it", async () => {
		process.env.VERCEL_ENV = "preview";
		const { adoptReplayMode } = await import("./faultInjection");
		const { runWithRequestContext, getRequestContext } = await import("$lib/chat/server/requestContext");
		const seen = await runWithRequestContext(async () => {
			await adoptReplayMode(replayReq({ ...token, "x-e2e-replay": "mock" }));
			return getRequestContext()?.replayMode;
		});
		expect(seen).toBe("mock");
	});

	it("sets nothing for a request the gate refuses, so production and real visitors stay live", async () => {
		const { adoptReplayMode } = await import("./faultInjection");
		const { runWithRequestContext, getRequestContext } = await import("$lib/chat/server/requestContext");
		process.env.VERCEL_ENV = "production";
		const onProduction = await runWithRequestContext(async () => {
			await adoptReplayMode(replayReq({ ...token, "x-e2e-replay": "mock" }));
			return getRequestContext()?.replayMode;
		});
		process.env.VERCEL_ENV = "preview";
		const withoutToken = await runWithRequestContext(async () => {
			await adoptReplayMode(replayReq({ "x-e2e-replay": "mock" }));
			return getRequestContext()?.replayMode;
		});
		expect(onProduction).toBeUndefined();
		expect(withoutToken).toBeUndefined();
	});
});

describe("input_screen_declines_rule's judge", () => {
	it("says yes to the harassment rule's question and no to every other rule's", async () => {
		const { harassmentRuleJudge } = await import("./faultInjection");
		const RULES = (await import("$lib/chat/server/rules.json")).default as Record<string, { guard?: { query?: string } }>;
		const target = { kind: "text" as const, text: "x" };
		const ctx = { instruct: "", opSignal: new AbortController().signal, timeoutMs: 1, log: { info() {}, warn() {} } };
		const yes: string[] = [];
		for (const [key, rule] of Object.entries(RULES)) {
			if (!rule.guard?.query) continue;
			const out = await harassmentRuleJudge(target, rule.guard.query, 0.5, ctx as never);
			if (out.answer.kind === "token" && out.answer.yes) yes.push(key);
		}
		expect(yes).toEqual(["chat-block-harrasment"]);
	});
});

describe("input_image_sexual_unanswered's judge", () => {
	it("leaves the sexual-content rule unanswered on a picture only, and answers no to everything else", async () => {
		const { imageSexualUnansweredJudge } = await import("./faultInjection");
		const RULES = (await import("$lib/chat/server/rules.json")).default as Record<string, { guard?: { query?: string } }>;
		const ctx = { instruct: "", opSignal: new AbortController().signal, timeoutMs: 1, log: { info() {}, warn() {} } };
		const picture = { kind: "image" as const, image: {} as never };
		const text = { kind: "text" as const, text: "x" };
		const unknownOn: string[] = [];
		for (const [key, rule] of Object.entries(RULES)) {
			if (!rule.guard?.query) continue;
			for (const target of [picture, text]) {
				const out = await imageSexualUnansweredJudge(target, rule.guard.query, 0.5, ctx as never);
				if (out.answer.kind === "unknown") unknownOn.push(`${target.kind}:${key}`);
				else expect(out.answer.yes, `${target.kind}:${key}`).toBe(false);
			}
		}
		expect(unknownOn).toEqual(["image:chat-block-sexual"]);
	});
});

describe("resolveProbeRequest", () => {
	function probeReq(headers: Record<string, string>): Request {
		return new Request("https://example.vercel.app/chat/api/warm", { headers });
	}
	const full = {
		"x-e2e-fault-inject-token": "test-secret-value",
		"x-e2e-busy-scope": "run-1",
		"x-e2e-probe-model": "swiss-ai/apertus-v1.5-70b",
		"x-e2e-fault-inject": "every_lane_rate_limited",
	};

	it("returns the scope, model and refusal on preview with the secret", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveProbeRequest } = await import("./faultInjection");
		expect(await resolveProbeRequest(probeReq(full))).toEqual({
			scope: "run-1",
			model: "swiss-ai/apertus-v1.5-70b",
			refuse: 429,
		});
	});

	it("returns a 402 refusal for every_lane_payment_required and none without a fault name", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveProbeRequest } = await import("./faultInjection");
		const paying = await resolveProbeRequest(probeReq({ ...full, "x-e2e-fault-inject": "every_lane_payment_required" }));
		expect(paying?.refuse).toBe(402);
		const { "x-e2e-fault-inject": _fault, ...healthy } = full;
		expect((await resolveProbeRequest(probeReq(healthy)))?.refuse).toBeNull();
	});

	it("returns null on production even with the right secret, so no visitor can trigger a probe or mark a model", async () => {
		process.env.VERCEL_ENV = "production";
		const { resolveProbeRequest, resolveBusyScope } = await import("./faultInjection");
		expect(await resolveProbeRequest(probeReq(full))).toBeNull();
		expect(await resolveBusyScope(probeReq(full))).toBeNull();
	});

	it("returns null on preview with a wrong secret", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveProbeRequest } = await import("./faultInjection");
		expect(await resolveProbeRequest(probeReq({ ...full, "x-e2e-fault-inject-token": "nope" }))).toBeNull();
	});

	it("refuses a scope that is not a plain token, so it cannot widen the key range it reads", async () => {
		process.env.VERCEL_ENV = "preview";
		const { resolveBusyScope } = await import("./faultInjection");
		expect(await resolveBusyScope(probeReq({ ...full, "x-e2e-busy-scope": "%" }))).toBeNull();
	});
});
