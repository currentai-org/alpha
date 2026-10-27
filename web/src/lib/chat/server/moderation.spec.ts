/**
 * Unit coverage for the moderation seam's security contracts:
 *   • content (Coop) fails OPEN — a Coop blip must not break chat.
 *   • child-safety (Coop) fails CLOSED — a silent pass while Coop is unreachable is worse than no check.
 * Network is mocked so these are deterministic and offline.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
	getCoopVerdict,
	probeCoopHealth,
	warmModeration,
	checkChildSafety,
	checkContentPolicy,
	checkAdvisory,
	screenModelOutput,
	outputModerationRequested,
	outputModerationEnabled,
	reportToCoop,
	reportHitToCoop,
	reportCsamMatchToCoop,
	__resetReportWarningsForTest,
	CHILD_SAFETY_DECLINE,
	CONTENT_POLICY_DECLINE,
	OUTPUT_CONTENT_DECLINE,
	OUTPUT_CHILD_SAFETY_DECLINE,
} from "$lib/chat/server/moderation";
import type { GuardHit } from "$lib/chat/server/guardScreenTypes";
import coopReportFixture from "./fixtures/coop-report.json";

// moderation.ts logs through pino, so the Axiom error alert (which counts pino level error) sees a
// Coop refusal (CUR-2598). The mock keeps each call's (fields, message) for the assertions below.
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({ logger: log }));
// The message of a pino call: the string argument, whether or not a fields object came first.
const messages = (fn: typeof log.error) =>
	fn.mock.calls.map((c) => String(typeof c[0] === "string" ? c[0] : c[1]));

const fetchMock = vi.fn();

// Coop /content response carrying the given triggered action names.
function coopActions(names: string[], status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({ actionsTriggered: names.map((name) => ({ name })) }),
	} as Response;
}

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	// Coop configured by default (so fail-closed/open semantics apply, not "disabled → allow").
	vi.stubEnv("COOP_URL", "http://coop.local:8080");
	vi.stubEnv("COOP_API_KEY", "test-key");
	vi.stubEnv("COOP_ITEM_TYPE", "ChatMessage");
	vi.stubEnv("COOP_USER_TYPE_ID", ""); // no author submit → exactly one fetch per verdict
	vi.stubEnv("COOP_BLOCK_ACTIONS", "");
	vi.stubEnv("COOP_CHILD_BLOCK_ACTIONS", "");
	vi.stubEnv("COOP_REDACT_ACTIONS", "");
	// Off a deployment unless a test says otherwise: the unconfigured seam only allows-all locally.
	vi.stubEnv("DEPLOY_ENV", "");
	vi.stubEnv("VERCEL_ENV", "");
	fetchMock.mockReset();
	for (const fn of Object.values(log)) fn.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("getCoopVerdict", () => {
	it("under the coop_report_rate_limited fault a user flag sends nothing to Coop and logs the 429 at error level (CUR-2598)", async () => {
		vi.stubEnv("COOP_USER_TYPE_ID", "user-type");
		vi.stubEnv("COOP_ITEM_TYPE_ID", "item-type");
		await reportToCoop({ messageId: "m1", text: "an answer", reason: "inaccurate", reporterId: "s1", injectedStatus: 429 });
		expect(fetchMock).not.toHaveBeenCalled();
		const call = log.error.mock.calls.find((c) => String(c[1]).includes("Coop report HTTP 429"));
		expect(call?.[0]).toMatchObject({ status: 429, itemId: "m1" });
	});

	it("a Coop /content 503 is logged at pino error level with its status as a field (CUR-2598)", async () => {
		fetchMock.mockResolvedValue(coopActions([], 503));
		expect(await getCoopVerdict("hello")).toEqual({ status: "unknown", actions: [] });
		const call = log.error.mock.calls.find((c) => String(c[1]).includes("Coop HTTP 503"));
		expect(call?.[0]).toMatchObject({ status: 503 });
	});

	it("is disabled (ok/[]) and makes no network call when Coop is unconfigured off a deployment", async () => {
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(await getCoopVerdict("anything")).toEqual({ status: "ok", actions: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns ok/[] without a network call for empty text", async () => {
		expect(await getCoopVerdict("   ")).toEqual({ status: "ok", actions: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps a 200 with actionsTriggered[] to ok + the action names", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block", "strike-escalation"]));
		expect(await getCoopVerdict("hi")).toEqual({
			status: "ok",
			actions: ["chat-block", "strike-escalation"],
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://coop.local:8080/api/v1/content");
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.sync).toBe(true);
		expect(body.contentType).toBe("ChatMessage");
	});

	it("treats a 200 WITHOUT actionsTriggered[] as UNKNOWN (never silently clean)", async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
		expect(await getCoopVerdict("hi")).toEqual({ status: "unknown", actions: [] });
	});

	it("treats an action entry without a string name as UNKNOWN (garbled response)", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ actionsTriggered: [{ name: "chat-block" }, {}] }),
		} as Response);
		expect(await getCoopVerdict("hi")).toEqual({ status: "unknown", actions: [] });
	});

	it("treats a non-2xx response as UNKNOWN", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
		expect(await getCoopVerdict("hi")).toEqual({ status: "unknown", actions: [] });
	});

	it("treats a network error as UNKNOWN", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		expect(await getCoopVerdict("hi")).toEqual({ status: "unknown", actions: [] });
	});

	it("warms Coop with a RULE-FREE GET (never /content) and gives the warm ping a generous abort", async () => {
		// The warm ping's whole job is to absorb a COLD backend wake; an abort before a
		// cold Coop origin finishes waking makes the first real turn pay the full cold screen. This
		// drives warmModeration END-TO-END. AbortSignal.timeout's ms isn't readable off the signal → spy
		// the factory. warmModeration is per-instance throttled, so this must be the file's ONLY
		// warmModeration() call.
		fetchMock.mockImplementation((url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/v1/content")) return Promise.resolve(coopActions([]));
			return Promise.resolve({
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(0),
			} as unknown as Response);
		});
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

		// A real turn keeps its per-turn default (8000) — the UNKNOWN↔CLEAN guard.
		await getCoopVerdict("hi");
		const realDelays = timeoutSpy.mock.calls.map((c) => c[0]);
		expect(realDelays).toContain(8000);
		expect(realDelays).not.toContain(60000);

		timeoutSpy.mockClear();
		const realCallCount = fetchMock.mock.calls.length;
		// The warm ping wires a generous 60s abort — Coop's origin cold-boot runs longer than the 20s per-turn abort.
		await warmModeration();
		const warmDelays = timeoutSpy.mock.calls.map((c) => c[0]);
		expect(warmDelays).toContain(60000);
		expect(warmDelays).not.toContain(8000);

		// The Coop leg is a rule-free GET on the origin — a warm cycle must trigger ZERO rule
		// evaluations (no /api/v1/content submit, which would run the full Zentropi rule set
		// every cycle for a discarded verdict).
		const warmCalls = fetchMock.mock.calls.slice(realCallCount);
		const warmUrls = warmCalls.map(([u]) => String(u));
		expect(warmUrls).toContain("http://coop.local:8080/health");
		expect(warmUrls.some((u) => u.includes("/api/v1/content"))).toBe(false);
		const coopWarmInit = warmCalls[
			warmUrls.indexOf("http://coop.local:8080/health")
		][1] as RequestInit;
		expect(coopWarmInit.method).toBe("GET");

		timeoutSpy.mockRestore();
	});
});

describe("checkContentPolicy (Coop, fail OPEN)", () => {
	it("maps a content block action to action:block with the action as category", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block"]));
		expect(await checkContentPolicy("bad")).toEqual({ action: "block", category: "chat-block" });
	});

	it("does NOT treat a child action as a content block (child is its own owner-point)", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-child"]));
		// default COOP_BLOCK_ACTIONS includes chat-block-child, but it's subtracted as a child action.
		expect(await checkContentPolicy("bad")).toEqual({ action: "allow" });
	});

	it("maps a configured redact action to action:redact with reviewed LOCAL notice copy", async () => {
		vi.stubEnv("COOP_REDACT_ACTIONS", "chat-redact");
		fetchMock.mockResolvedValue(coopActions(["chat-redact"]));
		const r = await checkContentPolicy("borderline");
		expect(r.action).toBe("redact");
		expect(r.category).toBe("chat-redact");
		expect(typeof r.message).toBe("string");
		expect(r.message && r.message.length).toBeGreaterThan(0);
	});

	it("returns allow when no relevant action fired", async () => {
		fetchMock.mockResolvedValue(coopActions([]));
		expect(await checkContentPolicy("fine")).toEqual({ action: "allow" });
	});

	it("fails OPEN (allow) on UNKNOWN", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
		expect(await checkContentPolicy("bad")).toEqual({ action: "allow" });
	});

	it("uses a pre-fetched verdict without a second network call", async () => {
		const verdict = { status: "ok" as const, actions: ["chat-block"] };
		expect(await checkContentPolicy("bad", undefined, verdict)).toEqual({
			action: "block",
			category: "chat-block",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("checkChildSafety (Coop, fail CLOSED)", () => {
	it("flags when a child block action fired, returning it as the category (rule identity)", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-child"]));
		expect(await checkChildSafety("bad")).toEqual({
			flagged: true,
			category: "chat-block-child",
		});
	});

	it("returns the SPECIFIC child action as category (de-flattened, not just 'child_safety')", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-child-csae"]));
		expect(await checkChildSafety("bad")).toEqual({
			flagged: true,
			category: "chat-block-child-csae",
		});
	});

	it("does not flag a non-child block action", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block"]));
		expect(await checkChildSafety("bad")).toEqual({ flagged: false });
	});

	it("fails CLOSED (flagged) on UNKNOWN, marked unscreened so the decline says it couldn't check (CUR-2301)", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
		expect(await checkChildSafety("bad")).toEqual({ flagged: true, unscreened: true });
	});

	it("is disabled (not flagged) when Coop is unconfigured", async () => {
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(await checkChildSafety("bad")).toEqual({ flagged: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shares ONE verdict across both owner-points (no duplicate Coop submit)", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-child"]));
		const verdict = await getCoopVerdict("bad");
		const child = await checkChildSafety("bad", undefined, verdict);
		const content = await checkContentPolicy("bad", undefined, verdict);
		expect(child).toEqual({ flagged: true, category: "chat-block-child" });
		expect(content).toEqual({ action: "allow" });
		expect(fetchMock).toHaveBeenCalledTimes(1); // the single getCoopVerdict submit
	});
});

describe("block-detection convention (chat-block-* prefix auto-inherit)", () => {
	it("a chat-block-<x> action NOT in any env set blocks as CONTENT (prefix auto-inherit)", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-violence"]));
		expect(await checkContentPolicy("bad")).toEqual({
			action: "block",
			category: "chat-block-violence",
		});
		expect(await checkChildSafety("bad")).toEqual({ flagged: false });
	});

	it("a chat-block-child-<x> action blocks as CHILD, taking precedence over the content prefix", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-child-csae"]));
		// child prefix is a sub-namespace of the content prefix → must classify as child, never content
		expect(await checkChildSafety("bad")).toEqual({
			flagged: true,
			category: "chat-block-child-csae",
		});
		expect(await checkContentPolicy("bad")).toEqual({ action: "allow" });
	});

	it("a non-conventional name blocks ONLY when it's in the env set (prefix can't reach it)", async () => {
		// not in the set, doesn't match the prefix → not a block
		fetchMock.mockResolvedValue(coopActions(["ban-hammer"]));
		expect(await checkContentPolicy("bad")).toEqual({ action: "allow" });

		// same name, now authorized via the exact-set override → blocks
		vi.stubEnv("COOP_BLOCK_ACTIONS", "ban-hammer");
		fetchMock.mockResolvedValue(coopActions(["ban-hammer"]));
		expect(await checkContentPolicy("bad")).toEqual({ action: "block", category: "ban-hammer" });
	});

	it("empty prefix disables the convention → exact-set membership only (pre-convention regression)", async () => {
		vi.stubEnv("COOP_BLOCK_ACTION_PREFIX", "");
		vi.stubEnv("COOP_CHILD_BLOCK_ACTION_PREFIX", "");
		// chat-block-violence is NOT in the default exact set, and the prefix is off → no block
		fetchMock.mockResolvedValue(coopActions(["chat-block-violence"]));
		expect(await checkContentPolicy("bad")).toEqual({ action: "allow" });
		// the exact default "chat-block" still blocks (exact-set membership)
		fetchMock.mockResolvedValue(coopActions(["chat-block"]));
		expect(await checkContentPolicy("bad")).toEqual({ action: "block", category: "chat-block" });
	});

	it("a similarly-named action without the '-' delimiter is NOT swept in (no false-positive block)", async () => {
		// chat-blocklist shares the leading "chat-block" string but isn't "chat-block" or "chat-block-<x>"
		fetchMock.mockResolvedValue(coopActions(["chat-blocklist"]));
		expect(await checkContentPolicy("bad")).toEqual({ action: "allow" });
		// chat-block-childish shares the child prefix's leading string but isn't a child action; the child
		// check must NOT claim it (it falls to the content namespace via the chat-block- delimiter instead)
		fetchMock.mockResolvedValue(coopActions(["chat-block-childish"]));
		expect(await checkChildSafety("bad")).toEqual({ flagged: false });
		expect(await checkContentPolicy("bad")).toEqual({
			action: "block",
			category: "chat-block-childish",
		});
	});

	it("a redact action named OUTSIDE the prefix is NOT misclassified as a block", async () => {
		vi.stubEnv("COOP_REDACT_ACTIONS", "chat-redact");
		fetchMock.mockResolvedValue(coopActions(["chat-redact"]));
		const r = await checkContentPolicy("borderline");
		expect(r.action).toBe("redact");
		expect(r.category).toBe("chat-redact");
	});
});

describe("screenModelOutput (output moderation — content + child on the model's answer)", () => {
	it("blocks on a content action (kind=content_policy, category=the action)", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block"]));
		expect(await screenModelOutput("the answer")).toEqual({
			blocked: true,
			kind: "content_policy",
			category: "chat-block",
		});
	});

	it("blocks on a child action (kind=child_safety, category=the action), taking precedence", async () => {
		fetchMock.mockResolvedValue(coopActions(["chat-block-child"]));
		expect(await screenModelOutput("the answer")).toEqual({
			blocked: true,
			kind: "child_safety",
			category: "chat-block-child",
		});
	});

	// NAME STATES THE CONTRACT, NOT THE HAPPY PATH (CUR-77). `actionsTriggered: []` is NOT proof of
	// clean: Coop returns the same empty
	// array when a detector leaf ERRORED while the origin stayed up, and on its own 24s cap. So what
	// this test actually guarantees is the weaker, riskier statement below, and CUR-83 argues that
	// guarantee is wrong for the child class. Naming it "clean" would hide that: green looks like
	// endorsement.
	it("treats an empty action list as not-blocked — which is also what an ERRORED detector returns (CUR-83)", async () => {
		fetchMock.mockResolvedValue(coopActions([]));
		expect(await screenModelOutput("the answer")).toEqual({ blocked: false, kind: null });
	});

	it("fails CLOSED (blocks as child) on UNKNOWN — an unscreened answer is withheld", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
		expect(await screenModelOutput("the answer")).toEqual({ blocked: true, kind: "child_safety" });
	});

	it("makes exactly ONE Coop submit (child + content reuse the verdict)", async () => {
		fetchMock.mockResolvedValue(coopActions([]));
		await screenModelOutput("the answer");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("is a no-op (not blocked, no network) for empty text", async () => {
		expect(await screenModelOutput("   ")).toEqual({ blocked: false, kind: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is disabled (not blocked, no network) when Coop is unconfigured off a deployment", async () => {
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(await screenModelOutput("anything, even a flagged-looking answer")).toEqual({
			blocked: false,
			kind: null,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("output declines are distinct from the input declines (name the post-generation hold)", () => {
		for (const copy of [OUTPUT_CONTENT_DECLINE, OUTPUT_CHILD_SAFETY_DECLINE]) {
			expect(copy).toMatch(/held it back|before it was shown/i);
			expect(copy).not.toEqual(CHILD_SAFETY_DECLINE);
			expect(copy).not.toEqual(CONTENT_POLICY_DECLINE);
		}
	});
});

describe("checkAdvisory", () => {
	it("is inert (no notice) — the redact path feeds the notice chip instead", async () => {
		expect(await checkAdvisory("any text")).toEqual({ notice: false });
	});
});

describe("decline copy", () => {
	it("exposes distinct child / content strings, none naming toxic-bert", () => {
		const all = [CHILD_SAFETY_DECLINE, CONTENT_POLICY_DECLINE];
		expect(new Set(all).size).toBe(2); // all distinct
		for (const s of all) {
			expect(s).not.toMatch(/toxic-?bert/i);
		}
		// Child is firm — no "rephrase" invitation.
		expect(CHILD_SAFETY_DECLINE).not.toMatch(/rephrase/i);
	});
});

// ── coop-review-plane Step 3a: output moderation enablement split ────────────────────────────────────
describe("output moderation enablement (requested vs enabled)", () => {
	it("outputModerationRequested is the ENV parse only; outputModerationEnabled ANDs Coop configured", () => {
		// beforeEach configures Coop (COOP_URL + COOP_API_KEY).
		vi.stubEnv("OUTPUT_MODERATION", "true");
		expect(outputModerationRequested()).toBe(true);
		expect(outputModerationEnabled()).toBe(true);
		// Env still ON, but Coop unconfigured → enabled is false; requested stays true.
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(outputModerationRequested()).toBe(true);
		expect(outputModerationEnabled()).toBe(false);
	});
	it("OUTPUT_MODERATION unset → requested false", () => {
		vi.stubEnv("OUTPUT_MODERATION", "");
		expect(outputModerationRequested()).toBe(false);
		expect(outputModerationEnabled()).toBe(false);
	});
});

// ── coop-review-plane Step 1b: the review-plane reporters (/api/v1/report) ───────────────────────────
describe("reportHitToCoop + reportToCoop (Coop = review plane, /report)", () => {
	const BLOCK: GuardHit = { key: "chat-block-violence", action: "block", tier: "content" };
	beforeEach(() => {
		__resetReportWarningsForTest();
		vi.stubEnv("COOP_USER_TYPE_ID", "user-type");
		vi.stubEnv("COOP_ITEM_TYPE_ID", "item-type");
	});

	it("reportHitToCoop skips loudly (exactly one error line per process) when COOP_SYSTEM_REPORTER_ID is unset", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "");
		const errSpy = log.error;
		const call = () =>
			reportHitToCoop({ surface: "chat-input", messageId: "m", text: "hi", hits: [BLOCK], subjectId: "u1" });
		await call();
		await call();
		expect(fetchMock).not.toHaveBeenCalled();
		const reporterErrors = errSpy.mock.calls.filter((c) => String(c[0]).includes("COOP_SYSTEM_REPORTER_ID"));
		expect(reporterErrors.length).toBe(1); // one per process — the second call is silent
		errSpy.mockRestore();
	});

	it.each(["COOP_URL", "COOP_API_KEY", "COOP_USER_TYPE_ID", "COOP_ITEM_TYPE_ID"])(
		"a missing %s logs the lost review path once instead of silently dropping hits",
		async (key) => {
			vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "shieldstral-gate");
			vi.stubEnv(key, "");
			const spy = log.error;
			try {
				for (let n = 0; n < 2; n++) {
					await reportHitToCoop({ surface: "chat-input", messageId: "m", text: "hi", hits: [BLOCK], subjectId: "u" });
				}
				expect(fetchMock).not.toHaveBeenCalled();
				expect(spy).toHaveBeenCalledTimes(1);
				expect(String(spy.mock.calls[0][0])).toContain(key);
			} finally {
				spy.mockRestore();
			}
		}
	);

	it("image-only hit reports with EMPTY text and the hits — the /report payload carries no bytes", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "shieldstral-gate");
		fetchMock.mockResolvedValue({ status: 201 } as Response);
		await reportHitToCoop({ surface: "chat-input", messageId: "m1", text: "", hits: [BLOCK], subjectId: "sess-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/v1/report");
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.reporter).toEqual({ kind: "user", typeId: "user-type", id: "shieldstral-gate" });
		expect(body.reportedForReason).toEqual({ reason: "shieldstral:chat-block-violence" });
		expect(body.reportedItem.id).toBe("m1");
		expect(body.reportedItem.typeId).toBe("item-type");
		expect(body.reportedItem.data.text).toBe("");
		expect(body.reportedItem.data.detection).toEqual({
			source: "shieldstral",
			surface: "chat-input",
			hits: [BLOCK],
			subjectId: "sess-1",
			scope: "typed-text-only",
		});
	});

	it("the report reason is the BLOCK key when a block and a log hit co-fire; data carries BOTH", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "shieldstral-gate");
		fetchMock.mockResolvedValue({ status: 201 } as Response);
		const hits: GuardHit[] = [
			{ key: "chat-block-self-harm", action: "log", tier: "content" },
			BLOCK,
		];
		await reportHitToCoop({ surface: "chat-output", messageId: "a1", text: "answer", hits, subjectId: "u1" });
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.reportedForReason.reason).toBe("shieldstral:chat-block-violence");
		expect(body.reportedItem.data.detection.hits).toEqual(hits);
		expect(body.reportedItem.data.detection.scope).toBe("assistant-output");
	});

	it("reportToCoop returns a Promise that AWAITS the fetch chain (not a discarded void) — runInBackground can keep it alive", async () => {
		let resolveFetch!: (r: Response) => void;
		fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
		const p = reportToCoop({ messageId: "m1", text: "hello", reason: "harmful", reporterId: "u1" });
		expect(p).toBeInstanceOf(Promise);
		let settled = false;
		void p.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false); // the returned promise is still awaiting the fetch
		resolveFetch({ status: 201 } as Response);
		await p;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reportToCoop skips (resolved, no fetch) when text is empty — user reports require content", async () => {
		await reportToCoop({ messageId: "m1", text: "  ", reason: "harmful", reporterId: "u1" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("reportCsamMatchToCoop (CUR-986: a hash match is a severe verdict too, not just a Slack page)", () => {
	beforeEach(() => {
		__resetReportWarningsForTest();
		vi.stubEnv("COOP_USER_TYPE_ID", "user-type");
		vi.stubEnv("COOP_ITEM_TYPE_ID", "item-type");
	});

	it("skips loudly (exactly one error line per process) when COOP_SYSTEM_REPORTER_ID is unset", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "");
		const errSpy = log.error;
		const call = () =>
			reportCsamMatchToCoop({ reportedItemId: "m", bankName: "test-bank", bankContentId: 1, distance: "0" });
		await call();
		await call();
		expect(fetchMock).not.toHaveBeenCalled();
		const reporterErrors = errSpy.mock.calls.filter((c) => String(c[0]).includes("COOP_SYSTEM_REPORTER_ID"));
		expect(reporterErrors.length).toBe(1); // one per process — the second call is silent
		errSpy.mockRestore();
	});

	it("builds the /report body with the hash-match verdict and no image bytes", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "csam-hash-guard");
		fetchMock.mockResolvedValue({ status: 201 } as Response);
		await reportCsamMatchToCoop({
			reportedItemId: "m1",
			bankName: "test-bank",
			bankContentId: 42,
			distance: "0",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/v1/report");
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.reporter).toEqual({ kind: "user", typeId: "user-type", id: "csam-hash-guard" });
		expect(body.reportedForReason).toEqual({ reason: "csam-hash-match:test-bank" });
		expect(body.reportedItem.id).toBe("m1");
		expect(body.reportedItem.typeId).toBe("item-type");
		expect(body.reportedItem.data).toEqual({
			text: expect.stringContaining("test-bank"),
			detection: { source: "hma-pdq", bankName: "test-bank", bankContentId: 42, distance: "0" },
		});
	});

	it("carries the non-empty `text` Coop's ChatMessage type requires, or Coop refuses the report with 400", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "csam-hash-guard");
		fetchMock.mockResolvedValue({ status: 201 } as Response);
		await reportCsamMatchToCoop({ reportedItemId: "m1", bankName: "test-bank", bankContentId: 42, distance: "0" });
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(typeof body.reportedItem.data.text).toBe("string");
		expect(body.reportedItem.data.text.trim()).not.toBe("");
	});

	it("logs Coop's refusal body with the status, so a 400 names what it refused", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "csam-hash-guard");
		fetchMock.mockResolvedValue({ status: 400, text: async () => "reportedItem.data.text is required" } as Response);
		const errSpy = log.error;
		await reportCsamMatchToCoop({ reportedItemId: "m1", bankName: "test-bank", bankContentId: 42, distance: "0" });
		const line = messages(errSpy).find((s) => s.includes("Coop report HTTP 400"));
		expect(line).toContain("reportedItem.data.text is required");
		errSpy.mockRestore();
	});

	it("a Coop /report 429 is logged at pino error level with its status as a field, so the error alert counts it (CUR-2598)", async () => {
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", "csam-hash-guard");
		fetchMock.mockResolvedValue({ status: 429, text: async () => "rate limited" } as Response);
		await reportCsamMatchToCoop({ reportedItemId: "m1", bankName: "test-bank", bankContentId: 42, distance: "0" });
		const call = log.error.mock.calls.find((c) => String(c[1]).includes("Coop report HTTP 429"));
		expect(call?.[0]).toMatchObject({ status: 429, itemId: "m1" });
	});
});

// coop-review-plane Step 4c: the ONE shared /report wire fixture. Web's reportHitToCoop → postReport and
// the agent service's _report_hit_to_coop MUST produce the same body (modulo ids/timestamps), so the two
// reporters cannot drift on the review-plane contract. This asserts the WEB half against the fixture;
// agent-service/api/test_agent_service.py asserts the Python half against the same JSON file.
describe("shared Coop /report fixture — web parity (fixtures/coop-report.json)", () => {
	beforeEach(() => {
		__resetReportWarningsForTest();
		vi.stubEnv("COOP_USER_TYPE_ID", coopReportFixture.reporter.typeId);
		vi.stubEnv("COOP_ITEM_TYPE_ID", coopReportFixture.reportedItem.typeId);
		vi.stubEnv("COOP_SYSTEM_REPORTER_ID", coopReportFixture.reporter.id);
	});

	it("reportHitToCoop builds the fixture body exactly, modulo the reportedAt timestamp", async () => {
		fetchMock.mockResolvedValue({ status: 201 } as Response);
		const det = coopReportFixture.reportedItem.data.detection;
		await reportHitToCoop({
			surface: det.surface as "chat-input" | "chat-output",
			messageId: coopReportFixture.reportedItem.id,
			text: coopReportFixture.reportedItem.data.text,
			hits: det.hits as GuardHit[],
			subjectId: det.subjectId,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/v1/report");
		const body = JSON.parse((init as RequestInit).body as string);
		// reportedAt is `new Date().toISOString()` — assert it is a real instant, then normalize it out so
		// the rest of the body is pinned byte-for-byte against the fixture (parsed-object deep equality, so
		// key order across the two serializers is not part of the contract).
		expect(typeof body.reportedAt).toBe("string");
		expect(Number.isNaN(Date.parse(body.reportedAt))).toBe(false);
		body.reportedAt = coopReportFixture.reportedAt;
		expect(body).toEqual(coopReportFixture);
	});
});

// The warn that says moderation is OFF. Its condition must not be a strict XOR
// (`Boolean(url) !== Boolean(key)`), which fires only on a HALF-set pair. With neither set —
// the local default, since COOP_URL and COOP_API_KEY are set in the deployed environments but not in
// dev — content and child moderation are allow-all and the warn has to say so.
//
// resetModules per case because the warn is latched to once per process, which is the behaviour
// under test as much as the message is.
describe("isCoopConfigured — the warn must fire when moderation is OFF, not only when config is half-done", () => {
	const withCoop = async (url: string, key: string) => {
		vi.resetModules();
		const warn = log.warn;
		vi.stubEnv("COOP_URL", url);
		vi.stubEnv("COOP_API_KEY", key);
		const mod = await import("$lib/chat/server/moderation");
		await mod.getCoopVerdict("anything");
		const calls = warn.mock.calls.map((c) => String(c[0]));
		warn.mockRestore();
		return calls;
	};

	it("warns when BOTH are unset — the case that used to be silent", async () => {
		const calls = await withCoop("", "");
		expect(calls.join("\n")).toMatch(/both unset/i);
		expect(calls.join("\n")).toMatch(/allow-all/i);
	});

	it("still warns on a half-set pair, and says PARTIAL so the fix differs", async () => {
		const calls = await withCoop("http://coop.local:8080", "");
		expect(calls.join("\n")).toMatch(/partial/i);
	});

	it("says nothing when Coop is fully configured", async () => {
		const calls = await withCoop("http://coop.local:8080", "test-key");
		expect(calls.filter((c) => c.includes("[moderation]"))).toEqual([]);
	});

	it("warns once, not once per call — it is a config fact, not a per-turn event", async () => {
		vi.resetModules();
		const warn = log.warn;
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		const mod = await import("$lib/chat/server/moderation");
		await mod.getCoopVerdict("a");
		await mod.getCoopVerdict("b");
		await mod.getCoopVerdict("c");
		const moderationWarns = warn.mock.calls.filter((c) => String(c[0]).includes("[moderation]"));
		warn.mockRestore();
		expect(moderationWarns).toHaveLength(1);
	});
});

// ── unconfigured Coop on a deployment fails CLOSED, never allow-all ──────────────────────────────────
// A deployment that loses COOP_URL/COOP_API_KEY (a Doppler cleanup, a new instance config) must not
// quietly stop screening. guard-primary is the per-turn screen today, but its PostHog read falls back
// to OFF, which routes the turn here.
describe("Coop unconfigured on a deployment (fails closed, never allow-all)", () => {
	for (const [name, value] of [
		["VERCEL_ENV", "production"],
		["VERCEL_ENV", "preview"],
		["DEPLOY_ENV", "production"],
	] as const) {
		it(`${name}=${value}: the verdict is UNKNOWN, so child safety declines the turn`, async () => {
			vi.stubEnv(name, value);
			vi.stubEnv("COOP_URL", "");
			vi.stubEnv("COOP_API_KEY", "");
			const verdict = await getCoopVerdict("hello");
			expect(verdict).toEqual({ status: "unknown", actions: [] });
			expect(await checkChildSafety("hello", undefined, verdict)).toEqual({ flagged: true, unscreened: true });
			expect(fetchMock).not.toHaveBeenCalled();
		});
	}

	it("a half-set pair (URL without key) also fails closed on a deployment", async () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("COOP_API_KEY", "");
		expect(await getCoopVerdict("hello")).toEqual({ status: "unknown", actions: [] });
	});

	it("says so at error level, not a warning", async () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		const error = log.error;
		await getCoopVerdict("hello");
		expect(error.mock.calls.flat().join(" ")).toMatch(/Coop unconfigured on a deployment/);
	});

	it("the output screen withholds the answer instead of passing it unscreened", async () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		vi.stubEnv("OUTPUT_MODERATION", "true");
		expect(outputModerationEnabled()).toBe(true);
		expect(await screenModelOutput("an answer")).toMatchObject({ blocked: true, kind: "child_safety" });
	});

	it("the health probe reports unhealthy (so the alert fires) rather than null (nothing to watch)", async () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(await probeCoopHealth()).toBe(false);
	});

	it("off a deployment the probe still skips (null) — local dev has no Coop by design", async () => {
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(await probeCoopHealth()).toBeNull();
	});
});
