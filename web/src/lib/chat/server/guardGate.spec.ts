// Guard gate (v2, Shieldstral compose) — the flat fan-out (every category query runs on every unit,
// no umbrella gate), the operation deadline, the merge precedence, the strict verdict ladder, and the
// two-fixture probe.
// Contract-named tests state the intended fail mode (the repo's test rules): a test on a fail-open /
// fail-closed path names the contract, and each check is proven red-able for the failure it names. All
// screening runs through dependency injection (fetchImpl, endpoint, policy, concurrency) — no network.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	getGuardVerdict,
	runGuardScreen,
	screenOutputWithGuard,
	probeGuardHealth,
	resolveTurnPolicy,
	guardPrimaryConfigured,
	guardChunkCount,
	guardChunkTexts,
	guardOperationDeadlineMs,
	inputJudgeFor,
	ZENTROPI_AFRICAN_FLAG,
	type GuardScreenDeps,
} from "./guardGate";
import { makeShieldstralJudge, SHIELDSTRAL_MODEL } from "./detectors/shieldstral";
import { makeCopeSecondOpinion, makeZentropiJudge } from "./detectors/zentropi";
import {
	GUARD_WINDOW_CHARS,
	GUARD_OVERLAP_CHARS,
	type GuardPolicy,
	type GuardRule,
} from "./guardPolicy";
import {
	GUARD_CORPUS_CAP,
	type GuardScreenInput,
	type JudgeFn,
	type JudgeOutcome,
	type JudgeTarget,
	type PreparedImage,
} from "./guardScreenTypes";
import { CHILD_SAFETY_DECLINE, childSafetyDeclineText } from "./moderation";
import { prepareTurnMedia } from "./chat/prepareTurnMedia";
import { unreachableGuardJudge } from "./textGeneration/faultInjection";
import { ObjectId } from "bson";
import pino from "pino";
import { buildLoggerOptions } from "./loggerOptions";
import { runWithRequestContext } from "./requestContext";
import type { Message } from "$lib/chat/types/Message";

// resolveTurnPolicy must poll the flag snapshot before reading guard-primary when nothing
// pins the value — real flags.ts behavior stays intact (delegated via importOriginal); only
// ensureFlagsPolled is wrapped so a call can be observed without touching PostHog/network mocking. (CUR-1142)
const ensureFlagsPolledSpy = vi.fn();
// A flag a test forces on or off; any other key reads through to the real flags.ts (CUR-4340).
const forcedFlags = vi.hoisted(() => new Map<string, boolean>());
vi.mock("$lib/chat/server/db/guardDailyCounts", () => ({ countGuardHitsSafe: vi.fn() }));

vi.mock("$lib/chat/server/flags", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/flags")>();
	return {
		...actual,
		ensureFlagsPolled: vi.fn(async (...args: Parameters<typeof actual.ensureFlagsPolled>) => {
			ensureFlagsPolledSpy(...args);
			return actual.ensureFlagsPolled(...args);
		}),
		flagEnabledOr: (key: string, fallback: () => boolean) =>
			forcedFlags.has(key) ? forcedFlags.get(key)! : actual.flagEnabledOr(key, fallback),
	};
});

function spyLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ── an injected test policy: two content queries + one child query + one log-action query ────────────
function testPolicy(over: { shield?: Partial<GuardPolicy["shield"]>; entries?: GuardRule[] } = {}): GuardPolicy {
	const shield = {
		instruct: "inst",
		outputInstruct: "out-inst",
		categoryThreshold: 0.5,
		concurrency: 6,
		operationDeadlineMs: 20000,
		...over.shield,
	};
	const entries: GuardRule[] = over.entries ?? [
		{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
		{ key: "chat-block-violence", query: "VIOLENCE?", action: "block", tier: "content" },
		{ key: "chat-block-self-harm", query: "SELFHARM?", action: "log", tier: "content" },
	];
	return { entries, byKey: new Map(entries.map((e) => [e.key, e])), shield };
}

// ── chat/completions response builders ───────────────────────────────────────────────────────────────
type Lp = { yes?: number; no?: number; content?: string; model?: string | null; status?: number };
function chatRes({ yes, no, content, model = SHIELDSTRAL_MODEL, status = 200 }: Lp = {}) {
	const top: Array<{ token: string; logprob: number }> = [];
	if (yes !== undefined) top.push({ token: "yes", logprob: yes });
	if (no !== undefined) top.push({ token: "no", logprob: no });
	const logprobs = top.length ? { content: [{ top_logprobs: top }] } : undefined;
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({ model, choices: [{ message: { content }, logprobs }] }),
	} as unknown as Response;
}
function toRes(v: string): Response {
	if (v === "yes") return chatRes({ yes: -0.0001, no: -9.21 }); // score ~0.9999
	if (v === "no") return chatRes({ yes: -9.21, no: -0.0001 }); // score ~0.0001
	if (v === "tie") return chatRes({ yes: -1, no: -1 }); // score exactly 0.5
	if (v === "tokenYes") return chatRes({ content: "yes" }); // no logprobs → token fallback
	if (v === "garble") return chatRes({ content: "maybe" }); // no logprobs, not yes/no → UNKNOWN
	return chatRes({ yes: -9.21, no: -0.0001 });
}
function userText(body: { messages: Array<{ content: unknown }> }): string {
	const c = body.messages[1].content;
	if (typeof c === "string") return c;
	return (c as Array<{ type: string; text?: string; image_url?: { url: string } }>)
		.map((p) => (p.type === "text" ? p.text : `IMG(${p.image_url?.url})`))
		.join("");
}
/** A fetch that answers per query keyword found in the user message. */
function judgeFetch(map: Record<string, string>): typeof fetch {
	return vi.fn(async (_url: unknown, init: unknown) => {
		const ut = userText(JSON.parse((init as RequestInit).body as string));
		for (const [k, v] of Object.entries(map)) {
			if (k !== "default" && ut.includes(k)) return toRes(v);
		}
		return toRes(map.default ?? "no");
	}) as unknown as typeof fetch;
}
/** A fetch that hangs (until op-abort) unless `immediate(ut)` returns a verdict for the call. */
function hangingFetch(immediate?: (ut: string) => string | undefined): typeof fetch {
	return vi.fn((_url: unknown, init: unknown) => {
		const ri = init as RequestInit;
		const ut = userText(JSON.parse(ri.body as string));
		const quick = immediate?.(ut);
		if (quick !== undefined) return Promise.resolve(toRes(quick));
		return new Promise<Response>((_res, reject) => {
			const sig = ri.signal as AbortSignal;
			if (sig.aborted) return reject(new DOMException("aborted", "AbortError"));
			sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});
	}) as unknown as typeof fetch;
}

// Adapter config (fetchImpl/endpoint) now rides on the injected judge (coop-review-plane Step 5), not on
// GuardScreenDeps — the gate sees only `deps.judge`. `extra` still carries the screening knobs
// (logger/policy/concurrency/timeoutMs).
const DEPS = (fetchImpl: typeof fetch, extra: Partial<GuardScreenDeps> = {}): GuardScreenDeps => ({
	judge: makeShieldstralJudge({ fetchImpl, endpoint: "http://guard.local/v1/chat/completions" }),
	logger: spyLogger(),
	countLogHits: () => {},
	policy: testPolicy(),
	// Hold the deadline at the policy floor, so a test's own operationDeadlineMs is the deadline it gets.
	roundMs: 0,
	...extra,
});

const textIn = (corpus: string, typed = corpus): GuardScreenInput => ({
	corpus,
	typedTurnText: typed,
	images: [],
	failedUnits: [],
});
const img = (over: Partial<PreparedImage> = {}): PreparedImage => ({
	sha: "sha1",
	mime: "image/jpeg",
	source: Buffer.from("x"),
	screenB64: "QUJD",
	sourceMessageId: "m1",
	caption: "a photo of a cat",
	...over,
});

afterEach(() => vi.unstubAllEnvs());

// ── chunk formula (the corpus → text-unit split, boundary-tested) ────────────────────────────────────
describe("guardGate — chunk-count formula (clamped at the corpus cap)", () => {
	it("matches the formula at the named lengths", () => {
		expect(guardChunkCount(0)).toBe(0);
		expect(guardChunkCount(1)).toBe(1);
		expect(guardChunkCount(GUARD_OVERLAP_CHARS)).toBe(1);
		expect(guardChunkCount(GUARD_WINDOW_CHARS)).toBe(1);
		expect(guardChunkCount(GUARD_WINDOW_CHARS + 1)).toBe(2);
		expect(guardChunkCount(GUARD_CORPUS_CAP)).toBe(9);
		expect(guardChunkCount(GUARD_CORPUS_CAP + 1)).toBe(9); // clamps at the cap — no widening
	});
	it("windows cover the screened prefix completely, with the stated overlap", () => {
		const chunks = guardChunkTexts("x".repeat(30000));
		expect(chunks.length).toBe(guardChunkCount(30000));
		const stride = GUARD_WINDOW_CHARS - GUARD_OVERLAP_CHARS;
		let covered = 0;
		for (const [i, c] of chunks.entries()) {
			expect(c.length).toBeLessThanOrEqual(GUARD_WINDOW_CHARS);
			covered = Math.max(covered, i * stride + c.length);
		}
		expect(covered).toBe(30000);
	});
	it("screens the corpus's END when it runs past the cap, so the newest turn is never cut off (CUR-3525)", () => {
		// The corpus joins user messages oldest first; the turn being answered is the tail.
		const corpus = "a".repeat(GUARD_CORPUS_CAP) + "NEWEST-TURN";
		const chunks = guardChunkTexts(corpus);
		expect(chunks.length).toBe(guardChunkCount(GUARD_CORPUS_CAP));
		expect(chunks.at(-1)?.endsWith("NEWEST-TURN")).toBe(true);
	});
});

describe("guardGate — operation deadline sizing (CUR-3749)", () => {
	// 30k characters is 3 chunks × 14 rules on 4 workers: 11 rounds. A loaded guard can run rounds of
	// 3.2 s or more, which a 3 s round would not cover.
	it("gives a 30k paste the whole 100 s screen budget, since a shared guard's rounds can't be predicted", () => {
		const chunks = guardChunkCount(30_000);
		expect(guardOperationDeadlineMs(20_000, chunks * 14, 4, undefined, undefined, chunks)).toBe(100_000);
	});

	it("gives a two-chunk paste the whole budget too, where rounds alone would have allowed 35 s", () => {
		expect(guardOperationDeadlineMs(20_000, 2 * 14, 4, undefined, undefined, 2)).toBe(100_000);
	});

	it("keeps a short photo question sized by its rounds, not the long-input budget", () => {
		// One text chunk plus an image is 26 calls on 4 workers: 7 rounds of 5 s.
		expect(guardOperationDeadlineMs(20_000, 26, 4, undefined, undefined, 1)).toBe(35_000);
	});

	it("still lets the route's lower cap cut a long input short (agent and local turns)", () => {
		expect(guardOperationDeadlineMs(20_000, 3 * 14, 4, undefined, 60_000, 3)).toBe(60_000);
	});

	it("caps a 100k paste at 100 s, the screen time the generation ladder already allows", () => {
		expect(guardOperationDeadlineMs(20_000, guardChunkCount(100_000) * 14, 4)).toBe(100_000);
	});

	it("keeps a one-chunk message at the policy floor", () => {
		expect(guardOperationDeadlineMs(20_000, 14, 6)).toBe(20_000);
	});
});

describe("a long conversation cannot push the newest turn out of the screen (CUR-3525)", () => {
	it("blocks a hazard in turn ten after nine maximum-length turns of history", async () => {
		// 12,000 characters is prd's per-message limit; nine of them fill more than the 100,000 cap.
		const history = Array.from({ length: 9 }, (_, i) => `turn ${i} ` + "b".repeat(12000));
		const messages = [...history, "ZZHAZARD please"].map((content, i) => ({ id: `m${i}`, from: "user" as const, content }));
		const media = await prepareTurnMedia(messages as unknown as Message[], new ObjectId());
		expect(media.screen.corpus.length).toBeGreaterThan(GUARD_CORPUS_CAP);
		const screen = await runGuardScreen(media.screen, DEPS(judgeFetch({ ZZHAZARD: "yes", default: "no" })));
		expect(screen.blockHits.length).toBeGreaterThan(0);
		expect(screen.status).not.toBe("safe");
	});
});

// The media step records a file it could not read as a failed unit; this end of the chain is what makes
// that record matter. Real prepareTurnMedia into real getGuardVerdict, with a judge that clears every
// query, so the only thing that can flag the turn is the failed file. CUR-3486 pins the media half.
describe("a file the media step could not read flags child safety, even when the judge clears everything", () => {
	const failing: Record<string, { mime: string; value: string } | "throw"> = {
		missing: "throw",
		garbled: { mime: "text/plain", value: Buffer.from([0xff, 0xfe, 0x80]).toString("base64") },
		"image-bad": { mime: "image/png", value: Buffer.from("PNG").toString("base64") },
		"pdf-crash": { mime: "application/pdf", value: Buffer.from("%PDF").toString("base64") },
	};
	const media = (typed: string, entry: { mime: string; value: string } | "throw") =>
		prepareTurnMedia(
			[{ id: "m1", from: "user", content: typed, files: [{ type: "hash", value: "f1", mime: "x", name: "f.bin" }] }] as Message[],
			new ObjectId(),
			{
				downloadFile: (async () => {
					if (entry === "throw") throw new Error("File not found: f1");
					return { type: "base64", name: "c-f1", ...entry };
				}) as never,
				sharpImpl: (() => ({
					resize: () => ({ jpeg: () => ({ toBuffer: async () => { throw new Error("sharp boom"); } }) }),
				})) as never,
				readDocuments: true,
				extractDocument: (async () => {
					throw new Error("worker crashed");
				}) as never,
			}
		);

	for (const [outcome, entry] of Object.entries(failing)) {
		for (const typed of ["what does this say?", ""]) {
			it(`${outcome}, typed ${typed ? "text" : "nothing"}: the turn is flagged unscreened, never safe`, async () => {
				const m = await media(typed, entry);
				expect(m.screen.failedUnits.length, `${outcome} produced no failed unit`).toBe(1);
				const v = await getGuardVerdict(m.screen, DEPS(judgeFetch({ default: "no" })));
				expect(v.childSafety, `${outcome} reached the model's turn without a child-safety flag`).toEqual(
					expect.objectContaining({ flagged: true, unscreened: true })
				);
				expect(v.verdict.status).not.toBe("ok");
			});
		}
	}

	it("the control: a file that reads cleanly under the same judge is not flagged", async () => {
		const m = await media("what does this say?", { mime: "text/plain", value: Buffer.from("notes").toString("base64") });
		const v = await getGuardVerdict(m.screen, DEPS(judgeFetch({ default: "no" })));
		expect(v.childSafety.flagged).toBe(false);
	});
});

// ── compose: flat fan-out — every category query runs on every unit, no umbrella gate ────────────────
describe("guardGate — compose (every category query runs unconditionally on every unit)", () => {
	it("every category query (child AND content) runs on every unit — a content block fires even when the others score no", async () => {
		// No umbrella gate: the violence content query alone says yes; nothing else does. The block fires,
		// and EVERY category query was still asked on the one text unit (units × rules calls).
		const fetchImpl = judgeFetch({ "VIOLENCE?": "yes", default: "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(v.verdict.status).toBe("ok");
		const asked = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
			userText(JSON.parse((c[1] as RequestInit).body as string))
		);
		expect(asked.length).toBe(3); // 1 text unit × 3 rules — a flat fan-out, no gating
		expect(asked.some((t) => t.includes("CHILD?"))).toBe(true);
		expect(asked.some((t) => t.includes("VIOLENCE?"))).toBe(true);
		expect(asked.some((t) => t.includes("SELFHARM?"))).toBe(true);
	});

	it("a block survives a sibling call failure (block survives, UNKNOWN cannot mask it)", async () => {
		// The violence content query blocks; a sibling content query garbles.
		const fetchImpl = judgeFetch({ "VIOLENCE?": "yes", "SELFHARM?": "garble", "CHILD?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(v.verdict.status).toBe("ok");
	});

	it("tie at threshold blocks (score ≥ threshold, not >)", async () => {
		const fetchImpl = judgeFetch({ "VIOLENCE?": "tie", "CHILD?": "no", "SELFHARM?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
	});

	it("logprob-less response → strict token fallback, scoreSource=token (block still fires)", async () => {
		const log = spyLogger();
		const fetchImpl = judgeFetch({ "VIOLENCE?": "tokenYes", "CHILD?": "no", "SELFHARM?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl, { logger: log }));
		expect(v.contentPolicy.action).toBe("block");
		expect(log.info.mock.calls.some((c) => (c[0] as { scoreSource?: string })?.scoreSource === "token")).toBe(true);
	});

	it("a child hit AND a content hit → child flagged AND content blocked, both keys in actions", async () => {
		const fetchImpl = judgeFetch({ "CHILD?": "yes", "VIOLENCE?": "yes", "SELFHARM?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.childSafety).toEqual({ flagged: true, category: "chat-block-child-sexual-content" });
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(v.verdict.actions.sort()).toEqual(["chat-block-child-sexual-content", "chat-block-violence"]);
	});

	it("self-harm co-firing with another content block shows the self-harm supportive copy — deterministic precedence even when self-harm resolves LAST (coop-review-plane Step 2)", async () => {
		const entries: GuardRule[] = [
			{ key: "chat-block-violence", query: "VIOLENCE?", action: "block", tier: "content" },
			{ key: "chat-block-self-harm", query: "SELFHARM?", action: "block", tier: "content" },
			{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
		];
		// Violence resolves immediately; self-harm resolves LAST. Without explicit precedence the merge
		// order puts violence first and a person in crisis sees the generic content decline — this test
		// goes red on that regression.
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			const ut = userText(JSON.parse((init as RequestInit).body as string));
			if (ut.includes("SELFHARM?")) {
				await new Promise((r) => setTimeout(r, 20));
				return toRes("yes");
			}
			if (ut.includes("VIOLENCE?")) return toRes("yes");
			return toRes("no");
		}) as unknown as typeof fetch;
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl, { policy: testPolicy({ entries }) }));
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-self-harm" });
		// Both keys still recorded — the review report carries every fired rule, not just the shown one.
		expect(v.verdict.actions.sort()).toEqual(["chat-block-self-harm", "chat-block-violence"]);
	});

	it("the passive self-harm rule co-firing with another content block also shows the supportive copy, not the generic decline (CUR-1840)", async () => {
		const entries: GuardRule[] = [
			{ key: "chat-block-violence", query: "VIOLENCE?", action: "block", tier: "content" },
			{ key: "chat-block-self-harm-passive", query: "PASSIVE?", action: "block", tier: "content" },
		];
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			const ut = userText(JSON.parse((init as RequestInit).body as string));
			if (ut.includes("PASSIVE?")) {
				await new Promise((r) => setTimeout(r, 20));
				return toRes("yes");
			}
			if (ut.includes("VIOLENCE?")) return toRes("yes");
			return toRes("no");
		}) as unknown as typeof fetch;
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl, { policy: testPolicy({ entries }) }));
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-self-harm-passive" });
	});

	it("all queries say no → allow (one screening operation, no block, no unknown)", async () => {
		const fetchImpl = judgeFetch({ default: "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.verdict.status).toBe("ok");
		expect(v.childSafety.flagged).toBe(false);
		expect(v.contentPolicy).toEqual({ action: "allow" });
	});

	it("empty input → allow with zero calls (nothing to screen)", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const v = await getGuardVerdict(textIn("   "), DEPS(fetchImpl));
		expect(v.verdict.status).toBe("ok");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

// ── the operation deadline ───────────────────────────────────────────────────────────────────────────
describe("guardGate — operation deadline (block survives; SAFE after abort is impossible)", () => {
	it("deadline expiry with a discovered block still blocks", async () => {
		// The child query answers yes immediately (block); every other call hangs until the op deadline.
		const fetchImpl = hangingFetch((ut) => (ut.includes("CHILD?") ? "yes" : undefined));
		const v = await getGuardVerdict(
			textIn("screen me"),
			DEPS(fetchImpl, { policy: testPolicy({ shield: { operationDeadlineMs: 40 } }) })
		);
		expect(v.childSafety).toEqual({ flagged: true, category: "chat-block-child-sexual-content" });
		expect(v.verdict.status).toBe("ok");
	});

	it("deadline expiry, no hits → UNKNOWN and NO request starts after expiry (fetch spy)", async () => {
		// Concurrency 1: the first category query starts and hangs; the sibling queries are still queued
		// when the deadline aborts. Each queued job must resolve UNKNOWN WITHOUT fetching.
		const fetchImpl = hangingFetch();
		const v = await getGuardVerdict(
			textIn("screen me"),
			DEPS(fetchImpl, { policy: testPolicy({ shield: { operationDeadlineMs: 40 } }), concurrency: 1 })
		);
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety.flagged).toBe(true);
		expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
	});
});

// ── CUR-2301: a long paste, and what an unfinished screen is allowed to say ──────────────────────────
describe("guardGate — an unfinished screen closes child only on a CHILD query, and says it couldn't check (CUR-2301)", () => {
	it("a content query left unanswered does not flag child safety — content fails open, the turn is allowed", async () => {
		const fetchImpl = judgeFetch({ "CHILD?": "no", "VIOLENCE?": "garble", "SELFHARM?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: false });
		expect(v.contentPolicy.action).toBe("allow");
	});

	it("an unanswered child query fails closed as UNSCREENED, never as a detection with a category", async () => {
		const fetchImpl = judgeFetch({ "CHILD?": "garble", default: "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
	});

	it("a real child hit keeps its category and is NOT marked unscreened", async () => {
		const fetchImpl = judgeFetch({ "CHILD?": "yes", default: "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.childSafety).toEqual({ flagged: true, category: "chat-block-child-sexual-content" });
	});

	it("on a 100k-char paste every chunk's child query answers inside the deadline, even when every content query hangs", async () => {
		// Nine chunks. Content queries hang until the operation deadline; child queries answer at once.
		// With two workers, file-order scheduling would park both on chunk 0's content queries and leave
		// chunks 1-8 without a child verdict, so a benign paste would decline as child safety.
		const fetchImpl = hangingFetch((ut) => (ut.includes("CHILD?") ? "no" : undefined));
		const corpus = "It is a truth universally acknowledged. ".repeat(Math.ceil(GUARD_CORPUS_CAP / 40)).slice(0, GUARD_CORPUS_CAP);
		expect(guardChunkCount(corpus.length)).toBeGreaterThan(1);
		const screen = await runGuardScreen(
			textIn(corpus, "Summarize this story"),
			DEPS(fetchImpl, { policy: testPolicy({ shield: { operationDeadlineMs: 60 } }), concurrency: 2 })
		);
		expect(screen.childUnknown).toBe(false);
		expect(screen.status).toBe("unknown");
	});

	it("a transport failure (503 on every call) produces the couldn't-check copy, not the child-safety copy", async () => {
		const fetchImpl = vi.fn(async () => chatRes({ status: 503 })) as unknown as typeof fetch;
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		const copy = childSafetyDeclineText(v.childSafety);
		expect(copy).toMatch(/couldn't finish the safety check/);
		expect(copy).toMatch(/Nothing in it was flagged/);
		expect(copy).not.toContain("child-safety classifier");
	});

	it("a real child-safety verdict still produces the child-safety copy", async () => {
		const v = await getGuardVerdict(textIn("screen me"), DEPS(judgeFetch({ "CHILD?": "yes", default: "no" })));
		expect(childSafetyDeclineText(v.childSafety)).toBe(CHILD_SAFETY_DECLINE);
	});
});

// ── CUR-3531: our own deadline must not decide that a padded paste is allowed ─────────────────────────
describe("guardGate — a content rule our deadline left unasked on a long paste closes the turn as couldn't-check (CUR-3531)", () => {
	// The block rule is queued LAST, the position chat-block-hate holds in rules.json. Each call takes
	// 10 ms, so with two workers the 9-chunk paste needs ~140 ms and the 60 ms deadline cuts the tail.
	const lastQueuedBlock = (): GuardRule[] => [
		{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
		{ key: "chat-block-self-harm", query: "SELFHARM?", action: "log", tier: "content" },
		{ key: "chat-block-hate", query: "HATE?", action: "block", tier: "content" },
	];
	const slowFetch = (yesWhen: (ut: string) => boolean): typeof fetch =>
		vi.fn(
			(_url: unknown, init: unknown) =>
				new Promise<Response>((res) => {
					const ut = userText(JSON.parse((init as RequestInit).body as string));
					setTimeout(() => res(toRes(yesWhen(ut) ? "yes" : "no")), 10);
				})
		) as unknown as typeof fetch;
	const MARKER = "zz-hate-marker-zz";
	const padded = "It is a truth universally acknowledged. ".repeat(2500).slice(0, GUARD_CORPUS_CAP - 200) + ` ${MARKER}`;

	it("a 99k paste ending in a hate marker, judge slower than the deadline: declined as couldn't-check, never allowed", async () => {
		expect(guardChunkCount(padded.length)).toBeGreaterThan(1);
		const fetchImpl = slowFetch((ut) => ut.includes("HATE?") && ut.includes(MARKER));
		const v = await getGuardVerdict(
			textIn(padded),
			DEPS(fetchImpl, {
				policy: testPolicy({ shield: { operationDeadlineMs: 60 }, entries: lastQueuedBlock() }),
				concurrency: 2,
			})
		);
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
		expect(childSafetyDeclineText(v.childSafety)).toMatch(/couldn't finish the safety check/);
	});

	it("the same paste with a judge fast enough to finish is blocked by the hate rule itself", async () => {
		const fetchImpl = slowFetch((ut) => ut.includes("HATE?") && ut.includes(MARKER));
		const v = await getGuardVerdict(
			textIn(padded),
			DEPS(fetchImpl, {
				policy: testPolicy({ shield: { operationDeadlineMs: 5000 }, entries: lastQueuedBlock() }),
				concurrency: 6,
			})
		);
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-hate" });
	});

	it("a judge that keeps pace finishes a long paste: the deadline grows per round of calls, so the hate rule blocks instead of a decline", async () => {
		// 3 rules × 9 chunks = 27 calls, 14 rounds at concurrency 2. At 40 ms a round the deadline is 560 ms,
		// past the ~140 ms the 10 ms judge needs; the 60 ms floor alone would cut the tail (test above).
		const fetchImpl = slowFetch((ut) => ut.includes("HATE?") && ut.includes(MARKER));
		const v = await getGuardVerdict(
			textIn(padded),
			DEPS(fetchImpl, {
				policy: testPolicy({ shield: { operationDeadlineMs: 60 }, entries: lastQueuedBlock() }),
				concurrency: 2,
				roundMs: 40,
			})
		);
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-hate" });
	});

	it("deadlineCapMs stops the grown deadline: the same keeping-pace judge is cut short and declined (CUR-3749)", async () => {
		// The test above grows to 560 ms. A 100 ms cap, the way an agent turn gets the old cap, cuts the
		// tail the ~140 ms judge needs, so the paste is declined instead of reaching the hate rule.
		const fetchImpl = slowFetch((ut) => ut.includes("HATE?") && ut.includes(MARKER));
		const v = await getGuardVerdict(
			textIn(padded),
			DEPS(fetchImpl, {
				policy: testPolicy({ shield: { operationDeadlineMs: 60 }, entries: lastQueuedBlock() }),
				concurrency: 2,
				roundMs: 40,
				deadlineCapMs: 100,
			})
		);
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
	});

	it("a one-unit message whose content query outlives the deadline still fails content open (CUR-2301's trade kept)", async () => {
		const fetchImpl = hangingFetch((ut) => (ut.includes("CHILD?") ? "no" : undefined));
		const v = await getGuardVerdict(
			textIn("a short message"),
			DEPS(fetchImpl, { policy: testPolicy({ shield: { operationDeadlineMs: 40 } }) })
		);
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: false });
		expect(v.contentPolicy).toEqual({ action: "allow" });
	});

	it("the input_screen_unfinished seam ends the screen after the child tier: child answered, content unasked, declined as couldn't-check", async () => {
		const fetchImpl = slowFetch(() => false);
		const deps = DEPS(fetchImpl, { policy: testPolicy({ entries: lastQueuedBlock() }), concurrency: 2, abortAfterChildTier: true });
		const screen = await runGuardScreen(textIn(padded), deps);
		expect(screen.childUnknown).toBe(false);
		expect(screen.contentDeadlineUnasked).toBe(true);
		const v = await getGuardVerdict(textIn(padded), deps);
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
	});

	it("CUR-4101: the input_guard_unreachable judge closes the input screen as couldn't-check, never as allowed", async () => {
		const v = await getGuardVerdict(textIn("Taxis are reimbursed up to 37 EUR after 22:00."), DEPS(judgeFetch({ default: "no" }), { judge: unreachableGuardJudge }));
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
		expect(childSafetyDeclineText(v.childSafety)).toMatch(/couldn't finish the safety check/);
	});

	it("the output screen keeps content fail-open when the deadline cuts a long answer", async () => {
		// The seam ends the screen once the child tier has answered, so the content rules come back unasked
		// on every runner. A deadline as short as 60 ms races the child tier itself and reads blocked on a loaded runner.
		const fetchImpl = slowFetch(() => false);
		const r = await screenOutputWithGuard(
			padded,
			undefined,
			DEPS(fetchImpl, { policy: testPolicy({ entries: lastQueuedBlock() }), concurrency: 2, abortAfterChildTier: true })
		);
		expect(r.blocked).toBe(false);
	});
});

// ── failed media units + images ──────────────────────────────────────────────────────────────────────
describe("guardGate — media units (failed units UNKNOWN, image units screened)", () => {
	it("failedUnits non-empty ⇒ verdict is never safe — the failed unit is UNKNOWN (child closes)", async () => {
		const fetchImpl = judgeFetch({ default: "no" }); // the text says nothing hazardous
		const input: GuardScreenInput = {
			corpus: "totally benign text",
			typedTurnText: "totally benign text",
			images: [],
			failedUnits: [{ kind: "image-encode", sha: "sX" }],
		};
		const v = await getGuardVerdict(input, DEPS(fetchImpl));
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety.flagged).toBe(true);
	});

	it("empty corpus + one image runs image units (the empty-input fast path does NOT fire)", async () => {
		const fetchImpl = judgeFetch({ default: "no" }); // every query no → safe
		const input: GuardScreenInput = { corpus: "", typedTurnText: "", images: [img()], failedUnits: [] };
		const v = await getGuardVerdict(input, DEPS(fetchImpl));
		expect(v.verdict.status).toBe("ok");
		// Proof the screen ran (not fast-pathed): a request was made, and it carried an image part with
		// the caption BEFORE the image.
		const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const body = JSON.parse((calls[0][1] as RequestInit).body as string);
		const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
		expect(parts[0].type).toBe("text");
		expect(parts[0].text).toContain("a photo of a cat"); // caption first
		expect(parts[1].type).toBe("image_url");
		expect(parts[1].image_url?.url).toBe("data:image/jpeg;base64,QUJD");
	});

	it("a flagged image blocks the turn — no media part reaches the model without passing the gate (CUR-160)", async () => {
		const fetchImpl = judgeFetch({ "VIOLENCE?": "yes", "CHILD?": "no", "SELFHARM?": "no" });
		const input: GuardScreenInput = { corpus: "", typedTurnText: "", images: [img()], failedUnits: [] };
		const v = await getGuardVerdict(input, DEPS(fetchImpl));
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(v.imageCleared).not.toContain("chat-block-violence");
	});

	// The violence re-check may re-judge the text only when no image is behind the block. (CUR-3258)
	it("lists a block rule as image-cleared only when every image answered it a clear no, never when one went unanswered", async () => {
		const judge = vi.fn(async (target: JudgeTarget, query: string) => {
			if (target.kind === "text") return { answer: { kind: "token" as const, yes: query === "VIOLENCE?" }, httpOk: true, servedModel: "m" };
			if (query === "CHILD?") return { answer: { kind: "unknown" as const }, httpOk: true, servedModel: "m" };
			return { answer: { kind: "token" as const, yes: false }, httpOk: true, servedModel: "m" };
		});
		const input: GuardScreenInput = { corpus: "I could kill for a pizza", typedTurnText: "x", images: [img()], failedUnits: [] };
		const v = await getGuardVerdict(input, { judge, logger: spyLogger(), policy: testPolicy() });
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(v.imageCleared).toContain("chat-block-violence");
		expect(v.imageCleared).not.toContain("chat-block-child-sexual-content");
	});

	it("does not list a rule as image-cleared when one of two images left it unanswered", async () => {
		let violenceImages = 0;
		const judge = vi.fn(async (target: JudgeTarget, query: string) => {
			if (target.kind === "text") return { answer: { kind: "token" as const, yes: query === "VIOLENCE?" }, httpOk: true, servedModel: "m" };
			if (query === "VIOLENCE?" && ++violenceImages === 2) return { answer: { kind: "unknown" as const }, httpOk: true, servedModel: "m" };
			return { answer: { kind: "token" as const, yes: false }, httpOk: true, servedModel: "m" };
		});
		const input: GuardScreenInput = { corpus: "I could kill for a pizza", typedTurnText: "x", images: [img(), img()], failedUnits: [] };
		const v = await getGuardVerdict(input, { judge, logger: spyLogger(), policy: testPolicy() });
		expect(v.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(v.imageCleared).not.toContain("chat-block-violence");
	});
});

// ── loud misconfiguration + lazy-init failure ────────────────────────────────────────────────────────
describe("guardGate — loud misconfiguration and lazy-init failure (flags gate features; env is config)", () => {
	it("guard-primary with no URL is UNKNOWN and logs an error (never a silent off)", async () => {
		const log = spyLogger();
		const fetchSpy = vi.fn() as unknown as typeof fetch;
		vi.stubGlobal("fetch", fetchSpy);
		vi.stubEnv("GUARD_SHADOW_URL", "");
		// NO injected judge → the DEFAULT (env-configured) Shieldstral detector; the unset endpoint is the
		// loud-misconfig UNKNOWN. An injected judge would OWN its reachability and skip this branch.
		const v = await getGuardVerdict(textIn("screen me"), { logger: log, policy: testPolicy() });
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety.flagged).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(String(log.error.mock.calls[0][1])).toContain("GUARD_SHADOW_URL");
		vi.unstubAllGlobals();
	});

	it("a policy that failed to load (lazy init) is the documented loud UNKNOWN", async () => {
		const log = spyLogger();
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl, { logger: log, policy: null }));
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety.flagged).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledTimes(1);
	});
});

// ── probe: two fixtures, three assertions ────────────────────────────────────────────────────────────
function probeFetch({ violenceModel = SHIELDSTRAL_MODEL, omitModel = false, status = 0 } = {}): typeof fetch {
	return vi.fn(async (_url: unknown, init: unknown) => {
		if (status) return chatRes({ status });
		const ut = userText(JSON.parse((init as RequestInit).body as string));
		const violative = ut.includes("pipe bomb");
		const model = omitModel ? null : SHIELDSTRAL_MODEL;
		// No umbrella gate: every query runs on both fixtures. The violence query says yes ONLY on the
		// violative fixture (so the benign fixture screens safe); every other query → no.
		if (ut.includes("VIOLENCE?") && violative) {
			return chatRes({ yes: -0.0001, no: -9.21, model: omitModel ? null : violenceModel });
		}
		return chatRes({ yes: -9.21, no: -0.0001, model }); // every other (query, fixture) → no
	}) as unknown as typeof fetch;
}
const PROBE_DEPS = (fetchImpl: typeof fetch, extra: Partial<GuardScreenDeps> = {}): GuardScreenDeps => ({
	judge: makeShieldstralJudge({ fetchImpl, endpoint: "http://guard.local/v1/chat/completions" }),
	logger: spyLogger(),
	policy: testPolicy(),
	...extra,
});

describe("guardGate — probeGuardHealth (benign safe + violative blocks; identity on EVERY call)", () => {
	it("healthy: transport + parse (benign safe, violative blocks violence) + identity all hold", async () => {
		const p = await probeGuardHealth(PROBE_DEPS(probeFetch()));
		expect(p).toMatchObject({ healthy: true, transportOk: true, parseOk: true, identityOk: true, identityAsserted: true });
	});

	it("a wrong served model on a CATEGORY call is unhealthy (identity per call, CUR-113)", async () => {
		const p = await probeGuardHealth(PROBE_DEPS(probeFetch({ violenceModel: "zai-org/GLM-5.2" })));
		expect(p).toMatchObject({ healthy: false, transportOk: true, parseOk: true, identityOk: false });
	});

	it("503 → red for TRANSPORT", async () => {
		const p = await probeGuardHealth(PROBE_DEPS(probeFetch({ status: 503 })));
		expect(p).toMatchObject({ healthy: false, transportOk: false });
	});

	it("an endpoint that reports NO model id on any call is UNHEALTHY (identityAsserted:false names the reason)", async () => {
		const p = await probeGuardHealth(PROBE_DEPS(probeFetch({ omitModel: true })));
		expect(p).toMatchObject({ healthy: false, parseOk: true, identityOk: false, identityAsserted: false });
		expect(p?.servedModels).toEqual([]);
	});

	it("no endpoint configured → null (the warm leg owns the loud-misconfig alert)", async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		// No injected judge + unset endpoint ⇒ nothing to probe.
		expect(await probeGuardHealth({ policy: testPolicy() })).toBeNull();
	});
});

// ── resolveTurnPolicy (one immutable per-turn policy value) ───────────────────────────────────────────
describe("guardGate — resolveTurnPolicy", () => {
	beforeEach(() => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		vi.stubEnv("OUTPUT_MODERATION", "");
		vi.stubEnv("INJECTION_ENABLED", "");
	});

	it("guard-primary ON: screening facts track the GUARD's config — guard configured + Coop absent ⇒ content:true", async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local");
		expect((await resolveTurnPolicy({ useGuardPrimary: true })).screeningFacts.content).toBe(true);
	});
	it("guard-primary ON: Coop configured but guard MISCONFIGURED ⇒ content:false (no inverse lie)", async () => {
		vi.stubEnv("COOP_URL", "http://coop.local");
		vi.stubEnv("COOP_API_KEY", "k");
		expect((await resolveTurnPolicy({ useGuardPrimary: true })).screeningFacts.content).toBe(false);
	});
	it("guard-primary OFF: screening facts track Coop exactly as before the swap", async () => {
		vi.stubEnv("COOP_URL", "http://coop.local");
		vi.stubEnv("COOP_API_KEY", "k");
		expect((await resolveTurnPolicy({ useGuardPrimary: false })).screeningFacts.content).toBe(true);
	});
	it("output under guard-primary tracks OUTPUT_MODERATION alone — requested-ON is enough even with GUARD_SHADOW_URL unset (the guard screen's own UNKNOWN withholds; coop-review-plane Step 3a)", async () => {
		vi.stubEnv("OUTPUT_MODERATION", "true");
		vi.stubEnv("GUARD_SHADOW_URL", ""); // unconfigured, yet enablement stays ON (never a silent off)
		expect((await resolveTurnPolicy({ useGuardPrimary: true })).outputModerationEnabled).toBe(true);
		expect((await resolveTurnPolicy({ useGuardPrimary: true })).screeningFacts.output).toBe(true);
	});
	it("OUTPUT_MODERATION unset → no output screen on EITHER source (no silent screen)", async () => {
		// beforeEach leaves OUTPUT_MODERATION="" — off regardless of source.
		expect((await resolveTurnPolicy({ useGuardPrimary: true })).outputModerationEnabled).toBe(false);
		expect((await resolveTurnPolicy({ useGuardPrimary: false })).outputModerationEnabled).toBe(false);
	});
	it("flag-OFF output keeps the Coop AND: requested-ON withheld until Coop is configured", async () => {
		vi.stubEnv("OUTPUT_MODERATION", "true");
		expect((await resolveTurnPolicy({ useGuardPrimary: false })).outputModerationEnabled).toBe(false); // Coop unset
		vi.stubEnv("COOP_URL", "http://coop.local");
		vi.stubEnv("COOP_API_KEY", "k");
		expect((await resolveTurnPolicy({ useGuardPrimary: false })).outputModerationEnabled).toBe(true);
	});
	it("the resolved policy is frozen — a consumer cannot re-evaluate or mutate it mid-turn", async () => {
		const p = await resolveTurnPolicy({ useGuardPrimary: true });
		expect(Object.isFrozen(p)).toBe(true);
		expect(Object.isFrozen(p.screeningFacts)).toBe(true);
	});
	it("the route reads ONLY the threaded value — no live outputModerationEnabled() import survives in the route", () => {
		const src = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), "../../../routes/chat/conversation/[id]/+server.ts"),
			"utf8"
		);
		expect(src).not.toMatch(/import[^;]*\boutputModerationEnabled\b[^;]*from/s);
		expect(src.match(/turnPolicy\.outputModerationEnabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(src).toContain("suppressed: turnPolicy.useGuardPrimary");
		expect(src).toContain("useGuardPrimary: turnPolicy.useGuardPrimary");
	});
	it("guardPrimaryConfigured is the URL's presence only — config, never a toggle", () => {
		expect(guardPrimaryConfigured()).toBe(false);
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local/");
		expect(guardPrimaryConfigured()).toBe(true);
	});
});

// Vercel Cron (the warm leg that refreshes the flag snapshot) runs on Production only —
// never on Preview — so a Preview instance that never hits one of the OTHER gated paths
// (resolveRegistryGates, the arithmetic-fact gate) first reads guardPrimaryEnabled as its permanent
// false fallback forever. resolveTurnPolicy must poll on demand, same as those two, whenever it's
// actually about to read the live flag. (CUR-1142)
describe("guardGate — resolveTurnPolicy polls the flag snapshot on demand (CUR-1142)", () => {
	beforeEach(() => {
		ensureFlagsPolledSpy.mockClear();
	});
	it("polls before reading guard-primary when nothing pins useGuardPrimary — the cold-preview-instance path", async () => {
		await resolveTurnPolicy();
		expect(ensureFlagsPolledSpy).toHaveBeenCalledTimes(1);
	});
	it("does NOT poll when useGuardPrimary is explicitly pinned — every test and the guard-shadow probe never touch PostHog for this", async () => {
		await resolveTurnPolicy({ useGuardPrimary: true });
		await resolveTurnPolicy({ useGuardPrimary: false });
		expect(ensureFlagsPolledSpy).not.toHaveBeenCalled();
	});
});

// ── hits carried on every status (coop-review-plane Step 1a) ─────────────────────────────────────────
describe("guardGate — hits carried on every status (the review-plane payload)", () => {
	it("UNKNOWN screen WITH a log hit: child closes AND the log hit is carried (report iff hits>0)", async () => {
		// self-harm (log) fires; the child query garbles → the unit is UNKNOWN. No block ⇒ status unknown,
		// but the fired log rule still rides along to the review plane.
		const fetchImpl = judgeFetch({ "SELFHARM?": "yes", "CHILD?": "garble", "VIOLENCE?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety.flagged).toBe(true);
		expect(v.hits).toEqual([{ key: "chat-block-self-harm", action: "log", tier: "content" }]);
	});
	it("UNKNOWN screen with NO hits carries an EMPTY hit list (an outage, not a detection → reports nothing)", async () => {
		const fetchImpl = judgeFetch({ default: "garble" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.verdict.status).toBe("unknown");
		expect(v.hits).toEqual([]);
	});
	it("safe-with-log-hit carries the log hit (the turn allows, the detection is still reviewable)", async () => {
		const fetchImpl = judgeFetch({ "SELFHARM?": "yes", default: "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.verdict.status).toBe("ok");
		expect(v.childSafety.flagged).toBe(false);
		expect(v.contentPolicy).toEqual({ action: "allow" });
		expect(v.hits).toEqual([{ key: "chat-block-self-harm", action: "log", tier: "content" }]);
	});
	it("a block carries the UNION of block AND log hits — keys/action/tier only", async () => {
		const fetchImpl = judgeFetch({ "VIOLENCE?": "yes", "SELFHARM?": "yes", "CHILD?": "no" });
		const v = await getGuardVerdict(textIn("screen me"), DEPS(fetchImpl));
		expect(v.contentPolicy.action).toBe("block");
		expect(v.hits.map((h) => h.key).sort()).toEqual(["chat-block-self-harm", "chat-block-violence"]);
		expect(v.hits.find((h) => h.key === "chat-block-violence")).toEqual({
			key: "chat-block-violence",
			action: "block",
			tier: "content",
		});
	});
	it("empty-input fast path carries no hits", async () => {
		const v = await getGuardVerdict(textIn("   "), DEPS(vi.fn() as unknown as typeof fetch));
		expect(v.hits).toEqual([]);
	});
});

// ── output screen through the same detector (coop-review-plane Step 3b) ──────────────────────────────
describe("guardGate — screenOutputWithGuard (the output ScreenFn)", () => {
	it("a content hit → blocked content_policy with the category and hits", async () => {
		const r = await screenOutputWithGuard("some answer", undefined, DEPS(judgeFetch({ "VIOLENCE?": "yes", default: "no" })));
		expect(r).toEqual({
			blocked: true,
			kind: "content_policy",
			category: "chat-block-violence",
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		});
	});
	it("a child hit → blocked child_safety with the category and hits", async () => {
		const r = await screenOutputWithGuard("some answer", undefined, DEPS(judgeFetch({ "CHILD?": "yes", default: "no" })));
		expect(r.blocked).toBe(true);
		expect(r.kind).toBe("child_safety");
		expect(r.category).toBe("chat-block-child-sexual-content");
	});
	it("UNKNOWN → WITHHELD child-closed (fail-closed), NO category, marked unscreened so the decline never claims a hit (CUR-3891), any log hits carried — never a silent release", async () => {
		const r = await screenOutputWithGuard(
			"some answer",
			undefined,
			DEPS(judgeFetch({ "SELFHARM?": "yes", "CHILD?": "garble", "VIOLENCE?": "no" }))
		);
		expect(r).toEqual({
			blocked: true,
			kind: "child_safety",
			category: undefined,
			unscreened: true,
			hits: [{ key: "chat-block-self-harm", action: "log", tier: "content" }],
		});
	});
	it("safe → released; a log hit rides along but does NOT block a clean answer", async () => {
		const r = await screenOutputWithGuard("some answer", undefined, DEPS(judgeFetch({ "SELFHARM?": "yes", default: "no" })));
		expect(r).toEqual({
			blocked: false,
			kind: null,
			hits: [{ key: "chat-block-self-harm", action: "log", tier: "content" }],
		});
	});
	it("uses the OUTPUT instruct, not the input instruct", async () => {
		const fetchImpl = judgeFetch({ default: "no" });
		await screenOutputWithGuard(
			"answer text",
			undefined,
			DEPS(fetchImpl, { policy: testPolicy({ shield: { instruct: "INPUT_MARK", outputInstruct: "OUTPUT_MARK" } }) })
		);
		const body = JSON.parse(
			((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit).body as string
		);
		const userMsg = body.messages[1].content as string;
		expect(userMsg).toContain("OUTPUT_MARK");
		expect(userMsg).not.toContain("INPUT_MARK");
	});
	it("policy failed to load → WITHHELD child-closed (loud UNKNOWN), never a silent release", async () => {
		const r = await screenOutputWithGuard("answer", undefined, DEPS(vi.fn() as unknown as typeof fetch, { policy: null }));
		expect(r.blocked).toBe(true);
		expect(r.kind).toBe("child_safety");
	});
});

// The deterministic test-only override. Two things must hold no matter how it's misused —
// it can never report child_safety, and it can never carry a hit into Coop's real review queue. (CUR-1139)
describe("guardGate — the output privacy rule reads the person's own message; no other rule does (CUR-1837)", () => {
	const withPrivacy = () =>
		testPolicy({
			entries: [
				{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
				{ key: "chat-block-violence", query: "VIOLENCE?", action: "block", tier: "content" },
				{ key: "chat-block-privacy", query: "PRIVACY?", action: "block", tier: "content" },
			],
		});
	const asked = "Here are my own details, Sam Rivera, 12 Elm Road, sam@example.org. Format them as a CV header.";
	const answer = "**Sam Rivera**\n12 Elm Road\nsam@example.org";
	/** Every judged user text, by the query it carried. */
	function recordingFetch(verdicts: Record<string, string> = {}) {
		const seen: Record<string, string[]> = {};
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			const ut = userText(JSON.parse((init as RequestInit).body as string));
			const q = ["CHILD?", "VIOLENCE?", "PRIVACY?"].find((k) => ut.includes(k))!;
			(seen[q] ??= []).push(ut);
			return toRes(verdicts[q] ?? "no");
		}) as unknown as typeof fetch;
		return { seen, fetchImpl };
	}

	it("privacy judges the answer with the person's message in front of it; child and violence judge the answer alone", async () => {
		const { seen, fetchImpl } = recordingFetch();
		const r = await screenOutputWithGuard(answer, undefined, { ...DEPS(fetchImpl, { policy: withPrivacy() }), askerText: asked });
		expect(r.blocked).toBe(false);
		expect(seen["PRIVACY?"]!.every((t) => t.includes("The person asked:") && t.includes(asked))).toBe(true);
		expect(seen["CHILD?"]!.some((t) => t.includes(asked))).toBe(false);
		expect(seen["VIOLENCE?"]!.some((t) => t.includes(asked))).toBe(false);
	});

	it("a privacy hit with the context still withholds the answer as content policy", async () => {
		const { fetchImpl } = recordingFetch({ "PRIVACY?": "yes" });
		const r = await screenOutputWithGuard(answer, undefined, { ...DEPS(fetchImpl, { policy: withPrivacy() }), askerText: asked });
		expect(r).toMatchObject({ blocked: true, kind: "content_policy", category: "chat-block-privacy" });
	});

	it("a child hit in the answer withholds as child safety even with the context on the privacy rule", async () => {
		const { fetchImpl } = recordingFetch({ "CHILD?": "yes" });
		const r = await screenOutputWithGuard(answer, undefined, { ...DEPS(fetchImpl, { policy: withPrivacy() }), askerText: asked });
		expect(r).toMatchObject({ blocked: true, kind: "child_safety", category: "chat-block-child-sexual-content" });
	});

	it("with no asker text, privacy judges the answer alone, as before", async () => {
		const { seen, fetchImpl } = recordingFetch();
		await screenOutputWithGuard(answer, undefined, DEPS(fetchImpl, { policy: withPrivacy() }));
		expect(seen["PRIVACY?"]!.some((t) => t.includes("The person asked:"))).toBe(false);
	});

});

describe("guardGate — the output fraud rule reads the person's own message too (CUR-2422)", () => {
	const withFraud = () =>
		testPolicy({
			entries: [
				{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
				{ key: "chat-block-violence", query: "VIOLENCE?", action: "block", tier: "content" },
				{ key: "chat-block-fraud", query: "FRAUD?", action: "block", tier: "content" },
			],
		});
	const asked = "Como faço para tirar o CPF no Brasil sendo estrangeiro?";
	const answer = "Você pode tirar o CPF no Brasil como estrangeiro independentemente do seu status de residência, inclusive como turista.";
	/** A judge that answers "yes" to FRAUD? only when the answer arrives without the question, the way the
	 *  real endpoint scored this sentence (0.500 alone, 0.020 with the question). */
	function contextSensitiveFetch() {
		const seen: Record<string, string[]> = {};
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			const ut = userText(JSON.parse((init as RequestInit).body as string));
			const q = ["CHILD?", "VIOLENCE?", "FRAUD?"].find((k) => ut.includes(k))!;
			(seen[q] ??= []).push(ut);
			return toRes(q === "FRAUD?" && !ut.includes("The person asked:") ? "yes" : "no");
		}) as unknown as typeof fetch;
		return { seen, fetchImpl };
	}

	it("releases an ordinary civic answer that only reads as fraud without its question", async () => {
		const { seen, fetchImpl } = contextSensitiveFetch();
		const r = await screenOutputWithGuard(answer, undefined, { ...DEPS(fetchImpl, { policy: withFraud() }), askerText: asked });
		expect(r.blocked).toBe(false);
		expect(seen["FRAUD?"]!.every((t) => t.includes("The person asked:") && t.includes(asked))).toBe(true);
		expect(seen["VIOLENCE?"]!.some((t) => t.includes(asked))).toBe(false);
	});

	it("a fraud hit with the question in front still withholds the answer as content policy", async () => {
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) =>
			toRes(userText(JSON.parse((init as RequestInit).body as string)).includes("FRAUD?") ? "yes" : "no")
		) as unknown as typeof fetch;
		const r = await screenOutputWithGuard(answer, undefined, { ...DEPS(fetchImpl, { policy: withFraud() }), askerText: asked });
		expect(r).toMatchObject({ blocked: true, kind: "content_policy", category: "chat-block-fraud" });
	});
});

describe("guardGate — an input-only, flagged rule is asked only on the input screen and only with its flag on (CUR-2111)", () => {
	const hedged = () =>
		testPolicy({
			entries: [
				{ key: "chat-block-child-sexual-content", query: "CHILD?", action: "block", tier: "child" },
				{ key: "chat-block-self-harm-passive", query: "PASSIVE?", action: "block", tier: "content" },
				{
					key: "chat-block-self-harm-hedged",
					query: "HEDGED?",
					action: "block",
					tier: "content",
					screens: ["input"],
					flag: "self-harm-hedged-rule",
				},
			],
		});
	const text = "some days I feel hopeless and wonder what the point is";
	/** The queries the judge was asked, with every judged text answering yes to HEDGED?. */
	function askedFetch() {
		const asked: string[] = [];
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			const ut = userText(JSON.parse((init as RequestInit).body as string));
			const q = ["CHILD?", "PASSIVE?", "HEDGED?"].find((k) => ut.includes(k))!;
			asked.push(q);
			return toRes(q === "HEDGED?" ? "yes" : "no");
		}) as unknown as typeof fetch;
		return { asked, fetchImpl };
	}

	it("with the flag on, the input screen asks the hedged question and declines with the self-harm rule", async () => {
		const { asked, fetchImpl } = askedFetch();
		const g = await getGuardVerdict(
			textIn(text),
			DEPS(fetchImpl, { policy: hedged(), enabledFlags: new Set(["self-harm-hedged-rule"]) })
		);
		expect(asked).toContain("HEDGED?");
		expect(g.contentPolicy).toEqual({ action: "block", category: "chat-block-self-harm-hedged" });
	});

	it("with the flag off, the input screen never asks the hedged question and the turn is allowed", async () => {
		const { asked, fetchImpl } = askedFetch();
		const g = await getGuardVerdict(textIn(text), DEPS(fetchImpl, { policy: hedged(), enabledFlags: new Set() }));
		expect(asked).not.toContain("HEDGED?");
		expect(g.contentPolicy).toEqual({ action: "allow" });
	});

	it("a caller that evaluated no flags (uploads, grounding, probes) never asks a flagged rule", async () => {
		const { asked, fetchImpl } = askedFetch();
		await getGuardVerdict(textIn(text), DEPS(fetchImpl, { policy: hedged() }));
		expect(asked).not.toContain("HEDGED?");
		expect(asked).toEqual(expect.arrayContaining(["CHILD?", "PASSIVE?"]));
	});

	it("the output screen never asks an input-only rule, even with its flag on, so a supportive reply is not cut", async () => {
		const { asked, fetchImpl } = askedFetch();
		const r = await screenOutputWithGuard(
			"I'm sorry you're feeling hopeless. You don't have to carry this alone.",
			undefined,
			DEPS(fetchImpl, { policy: hedged(), enabledFlags: new Set(["self-harm-hedged-rule"]) })
		);
		expect(asked).not.toContain("HEDGED?");
		expect(r.blocked).toBe(false);
	});
});

describe("guardGate — CUR-1139 test override (deterministic content-policy block on demand)", () => {
	const SENTINEL = "__CUR1139_FORCE_CONTENT_BLOCK__";

	it("fires on the sentinel when enabled, WITHOUT calling the real judge at all", async () => {
		vi.stubEnv("DEPLOY_ENV", "preview");
		vi.stubEnv("COOP_TEST_OVERRIDE_ENABLED", "true");
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const r = await screenOutputWithGuard(`some answer ${SENTINEL}`, undefined, DEPS(fetchImpl));
		expect(r).toEqual({ blocked: true, kind: "content_policy", category: "cur-1139-test-override", hits: [] });
		expect(fetchImpl).not.toHaveBeenCalled(); // short-circuits before any real screening
	});

	it("never fires without the sentinel, even when enabled — real screening runs as normal", async () => {
		vi.stubEnv("DEPLOY_ENV", "preview");
		vi.stubEnv("COOP_TEST_OVERRIDE_ENABLED", "true");
		const r = await screenOutputWithGuard("an ordinary answer", undefined, DEPS(judgeFetch({ default: "no" })));
		expect(r.blocked).toBe(false);
	});

	it("never fires with the sentinel when the env var is unset — real screening runs as normal", async () => {
		vi.stubEnv("DEPLOY_ENV", "preview");
		const r = await screenOutputWithGuard(`answer ${SENTINEL}`, undefined, DEPS(judgeFetch({ default: "no" })));
		expect(r.blocked).toBe(false);
	});

	it("refuses in production even with the env var true and the sentinel present (never simulate anything there)", async () => {
		vi.stubEnv("DEPLOY_ENV", "production");
		vi.stubEnv("COOP_TEST_OVERRIDE_ENABLED", "true");
		const fetchImpl = judgeFetch({ default: "no" });
		const r = await screenOutputWithGuard(`answer ${SENTINEL}`, undefined, DEPS(fetchImpl));
		expect(r.blocked).toBe(false); // fell through to real screening, which the fixture says is clean
		expect(fetchImpl).toHaveBeenCalled(); // proves the override did NOT short-circuit
	});

	it("refuses on a deployment that declares no environment, even with the env var true and the sentinel present (CUR-1881)", async () => {
		vi.stubEnv("DEPLOY_ENV", "");
		vi.stubEnv("VERCEL_ENV", "");
		vi.stubEnv("COOP_TEST_OVERRIDE_ENABLED", "true");
		const fetchImpl = judgeFetch({ default: "no" });
		const r = await screenOutputWithGuard(`answer ${SENTINEL}`, undefined, DEPS(fetchImpl));
		expect(r.blocked).toBe(false);
		expect(fetchImpl).toHaveBeenCalled(); // the override did not short-circuit real screening
	});

	it("the returned verdict can never carry kind child_safety or a non-empty hits array", async () => {
		vi.stubEnv("DEPLOY_ENV", "preview");
		vi.stubEnv("COOP_TEST_OVERRIDE_ENABLED", "true");
		const r = await screenOutputWithGuard(SENTINEL, undefined, DEPS(vi.fn() as unknown as typeof fetch));
		expect(r.kind).not.toBe("child_safety");
		expect(r.hits).toEqual([]); // makeOutputFinalizer only reports when hits.length > 0
	});
});

// runGuardScreen is exported for the shadow/probe; a direct smoke check on the merged shape.
describe("guardGate — runGuardScreen merged shape", () => {
	it("reports chunk count and served models on a clean text screen", async () => {
		const screen = await runGuardScreen(textIn("hello world"), DEPS(judgeFetch({ default: "no" })));
		expect(screen.status).toBe("safe");
		expect(screen.chunks).toBe(1);
		expect(screen.servedModels).toEqual([SHIELDSTRAL_MODEL]);
		expect(screen.servedModelMissing).toBe(false);
	});
});

// UNKNOWN is where content screening falls through to allow, so it is the guard's departure.
// A clean screen must record nothing. (CUR-68)
describe("getGuardVerdict fail-open departures", () => {
	const departures = (log: ReturnType<typeof spyLogger>) =>
		log.warn.mock.calls
			.map((c) => c[0] as Record<string, unknown>)
			.filter((o) => o && typeof o === "object" && "failopen" in o)
			.map((o) => `${String(o.failopen)}:${String(o.reason)}`);

	it("records nothing on a clean screen", async () => {
		const log = spyLogger();
		const v = await getGuardVerdict(textIn("screen me"), DEPS(judgeFetch({ default: "no" }), { logger: log }));
		expect(v.verdict.status).toBe("ok");
		expect(departures(log)).toEqual([]);
	});

	it("records a guard departure when a unit cannot answer", async () => {
		const log = spyLogger();
		const v = await getGuardVerdict(textIn("screen me"), DEPS(judgeFetch({ default: "garble" }), { logger: log }));
		expect(v.verdict.status).toBe("unknown");
		expect(departures(log)).toEqual(["guard:unit-unknown"]);
	});

	it("records a transport departure when the screen could not run at all", async () => {
		const log = spyLogger();
		const v = await getGuardVerdict(textIn("screen me"), DEPS(vi.fn() as unknown as typeof fetch, { logger: log, policy: null }));
		expect(v.verdict.status).toBe("unknown");
		expect(departures(log)).toEqual(["guard:transport"]);
	});
});

// ── CUR-3563: the screen's receipt comes from its own response, never the configured endpoint ────────
describe("the safety screen records where it ran from the response it got (CUR-3563)", () => {
	const answered = (over: { url?: string; provider?: string } = {}): typeof fetch =>
		vi.fn(async () => ({
			...chatRes({ yes: -9.21, no: -0.0001, model: "Shieldstral-served" }),
			url: over.url ?? "",
			headers: new Headers(over.provider ? { "x-inference-provider": over.provider } : {}),
		})) as unknown as typeof fetch;

	it("carries the served model, the URL the response came from and the router's provider header", async () => {
		const v = await getGuardVerdict(
			textIn("screen me"),
			DEPS(answered({ url: "https://router.example.org/v1/chat/completions", provider: "nebius" }))
		);
		expect(v.served).toEqual({
			model: "Shieldstral-served",
			backend: "https://router.example.org/v1/chat/completions",
			provider: "nebius",
		});
	});

	it("names no host when the response carries none, rather than the endpoint it was configured to call", async () => {
		const v = await getGuardVerdict(textIn("screen me"), DEPS(answered()));
		expect(v.served).toEqual({ model: "Shieldstral-served", backend: undefined, provider: undefined });
		expect(JSON.stringify(v.served)).not.toContain("guard.local");
	});

	it("has no receipt when no call reported a model", async () => {
		// chatRes defaults the model, so this body is built without one.
		const noModel = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: {}, logprobs: { content: [{ top_logprobs: [{ token: "no", logprob: -0.0001 }] }] } }] }),
		})) as unknown as typeof fetch;
		const v = await getGuardVerdict(textIn("screen me"), DEPS(noModel));
		expect(v.served).toBeUndefined();
	});
});

// ── CUR-3749: a long paste shares the guard, and says how far it has got ────────────────────────────────
describe("guardGate — a long paste runs on fewer workers and reports its progress (CUR-3749)", () => {
	const longPaste = "It is a truth universally acknowledged. ".repeat(2500).slice(0, GUARD_CORPUS_CAP);
	// Answers "no" after 5 ms and records the most calls it ever had open at once.
	const countingFetch = () => {
		let open = 0;
		const seen = { peak: 0 };
		const fetchImpl = vi.fn(
			() =>
				new Promise<Response>((res) => {
					open++;
					seen.peak = Math.max(seen.peak, open);
					setTimeout(() => {
						open--;
						res(toRes("no"));
					}, 5);
				})
		) as unknown as typeof fetch;
		return { fetchImpl, seen };
	};

	it("a 100k paste never has more than 4 judge calls open at once, though the policy allows 6", async () => {
		const { fetchImpl, seen } = countingFetch();
		const screen = await runGuardScreen(
			textIn(longPaste, "Summarize this"),
			DEPS(fetchImpl, { policy: testPolicy({ shield: { operationDeadlineMs: 5000 } }), concurrency: 6 })
		);
		expect(screen.status).toBe("safe");
		expect(seen.peak).toBe(4);
	});

	it("a one-chunk message keeps all 6 workers", async () => {
		const { fetchImpl, seen } = countingFetch();
		await runGuardScreen(
			textIn("a short message"),
			DEPS(fetchImpl, {
				policy: testPolicy({
					shield: { operationDeadlineMs: 5000 },
					entries: Array.from({ length: 8 }, (_, i) => ({
						key: `chat-block-r${i}`,
						query: `R${i}?`,
						action: "log" as const,
						tier: "content" as const,
					})),
				}),
				concurrency: 6,
			})
		);
		expect(seen.peak).toBe(6);
	});

	it("reports each part of a long paste once, in order, ending on the last", async () => {
		const parts: Array<[number, number]> = [];
		const { fetchImpl } = countingFetch();
		const chunks = guardChunkCount(longPaste.length);
		await runGuardScreen(
			textIn(longPaste, "Summarize this"),
			DEPS(fetchImpl, {
				policy: testPolicy({ shield: { operationDeadlineMs: 5000 } }),
				onProgress: (part, n) => parts.push([part, n]),
			})
		);
		expect(parts.map(([p]) => p)).toEqual(Array.from({ length: chunks }, (_, i) => i + 1));
		expect(parts.every(([, n]) => n === chunks)).toBe(true);
	});

	it("a one-chunk message never reports progress", async () => {
		const onProgress = vi.fn();
		await runGuardScreen(textIn("a short message"), DEPS(countingFetch().fetchImpl, { onProgress }));
		expect(onProgress).not.toHaveBeenCalled();
	});
});

// ── CUR-3915: a log hit is counted, never logged ─────────────────────────────────────────────────────
describe("guardGate — a log hit adds to its rule's daily count and writes no log line (CUR-3915)", () => {
	it("a self-harm log hit screened inside a request is counted by rule key, and no log line names the rule or carries the hit", async () => {
		const lines: Record<string, unknown>[] = [];
		const stream: pino.DestinationStream = { write: (l: string) => void lines.push(JSON.parse(l)) };
		const logger = pino(buildLoggerOptions({ dev: false, level: "debug" }), stream);
		const countLogHits = vi.fn();
		const fetchImpl = judgeFetch({ "SELFHARM?": "yes", default: "no" });

		await runWithRequestContext(
			async () => {
				logger.info("a line from the same request");
				await runGuardScreen(textIn("screen me"), DEPS(fetchImpl, { logger, countLogHits }));
			},
			{ requestId: "req-distress", url: "/chat/conversation/abc123", user: "someone@example.org" }
		);

		expect(countLogHits).toHaveBeenCalledTimes(1);
		expect(countLogHits).toHaveBeenCalledWith(["chat-block-self-harm"]);
		const ordinary = lines.find((l) => l.message === "a line from the same request");
		expect(ordinary?.request_id, "the capture sees the request's lines").toBe("req-distress");
		const perHit = lines.filter((l) => JSON.stringify(l).includes("chat-block-self-harm") || "logKeys" in l);
		expect(perHit, "a per-hit line is back: it can be joined to the request by time and instance").toEqual([]);
	});

	it("a screen not handed countLogHits (shadow, agent endpoint, recheck) counts nothing, so one message adds one", async () => {
		const { countGuardHitsSafe } = await import("$lib/chat/server/db/guardDailyCounts");
		const fetchImpl = judgeFetch({ "SELFHARM?": "yes", default: "no" });
		const screen = await runGuardScreen(textIn("screen me"), DEPS(fetchImpl, { countLogHits: undefined }));
		expect(screen.logHits.map((r) => r.key)).toEqual(["chat-block-self-harm"]);
		expect(countGuardHitsSafe).not.toHaveBeenCalled();
	});

	it("a screen with no log hit counts nothing", async () => {
		const countLogHits = vi.fn();
		await runGuardScreen(textIn("screen me"), DEPS(judgeFetch({ default: "no" }), { countLogHits }));
		expect(countLogHits).not.toHaveBeenCalled();
	});
});

// ── CUR-4340: Zentropi judges the input screen for Amharic, Yoruba, Hausa and Kiswahili turns ─────────
describe("guardGate — the input screen's judge for a routed-language turn (CUR-4340)", () => {
	const SW = "Kila mtu ana haki ya kuishi, haki ya uhuru, na haki ya kulindwa nafsi yake.";
	const EN = "Everyone has the right to life, liberty and security of person.";
	const GUARD = "http://guard.local";
	const ZT = "https://cope.local/v1/chat/completions";
	const ztLabel = (l: string, status = 200) =>
		({
			ok: status >= 200 && status < 300,
			status,
			url: ZT,
			json: async () => ({ model: "zentropi-ai/cope-b-a4b", choices: [{ message: { content: l } }] }),
		}) as unknown as Response;
	/** A CoPE endpoint double that answers "1" when the prompt's POLICY holds a key in `yesFor`, "0" otherwise. */
	const ztFetch = (yesFor: string[] = [], status = 200) =>
		vi.fn(async (_url: unknown, init: unknown) => {
			const body = JSON.parse((init as RequestInit).body as string) as { messages: Array<{ content: string }> };
			const policy = body.messages[0].content.split("POLICY\n======\n\n")[1]?.split("\n\n\nCONTENT")[0] ?? "";
			return ztLabel(yesFor.some((k) => policy.includes(k)) ? "1" : "0", status);
		}) as unknown as typeof fetch;

	beforeEach(() => {
		forcedFlags.clear();
		vi.stubEnv("GUARD_SHADOW_URL", GUARD);
		vi.stubEnv("HF_TOKEN", "hf_test");
	});
	afterEach(() => forcedFlags.clear());

	it("picks the Zentropi judge only when the flag is on, the key is set, Shieldstral is addressed, and the typed text is one of the four languages", () => {
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, true);
		const log = spyLogger();
		expect(inputJudgeFor(SW, log)).toMatchObject({ lang: "sw", judge: expect.any(Function) });
		expect(log.info).toHaveBeenCalledWith({ gateSource: "guard", judge: "zentropi", lang: "sw" }, expect.any(String));
		expect(inputJudgeFor(EN, log)).toBeUndefined();
		vi.stubEnv("GUARD_SHADOW_URL", "");
		expect(inputJudgeFor(SW, log)).toBeUndefined();
		vi.stubEnv("GUARD_SHADOW_URL", GUARD);
		vi.stubEnv("HF_TOKEN", "");
		expect(inputJudgeFor(SW, log)).toBeUndefined();
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, false);
		vi.stubEnv("HF_TOKEN", "hf_test");
		expect(inputJudgeFor(SW, log)).toBeUndefined();
	});

	it("returns no judge with the flag off, so the gate runs Shieldstral exactly as before", async () => {
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, false);
		const fetchSpy = judgeFetch({ VIOLENCE: "yes", default: "no" });
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const routed = inputJudgeFor(SW, spyLogger());
			expect(routed).toBeUndefined();
			const base = { logger: spyLogger(), countLogHits: () => {}, policy: testPolicy(), roundMs: 0 };
			// The route's own spread, with and without the routing step.
			const withRouting = await getGuardVerdict(textIn(SW), {
				...base,
				...(routed && "judge" in routed ? { judge: routed.judge } : {}),
				...(routed && "alsoJudge" in routed ? { alsoJudge: routed.alsoJudge } : {}),
			});
			const without = await getGuardVerdict(textIn(SW), base);
			expect(withRouting).toEqual(without);
			expect(withRouting.served?.model).toBe(SHIELDSTRAL_MODEL);
			const urls = vi.mocked(fetchSpy).mock.calls.map((c) => String(c[0]));
			expect(urls.every((u) => u.startsWith(GUARD))).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("logs a loud error and keeps Shieldstral when the flag is on and the CoPE endpoint's HF_TOKEN is unset", () => {
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, true);
		vi.stubEnv("HF_TOKEN", "");
		const log = spyLogger();
		expect(inputJudgeFor(SW, log)).toBeUndefined();
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(String(log.error.mock.calls[0][1])).toContain("HF_TOKEN is unset");
	});

	it("a CoPE block fires the rule and the verdict names zentropi-ai/cope-b-a4b", async () => {
		const guardFetch = judgeFetch({ default: "no" });
		const judge = makeZentropiJudge({
			fetchImpl: ztFetch(["VIOLENCE"]),
			endpoint: ZT,
			key: "hf_test",
			fallback: makeShieldstralJudge({ fetchImpl: guardFetch, endpoint: `${GUARD}/v1/chat/completions` }),
		});
		const g = await getGuardVerdict(textIn(SW), { judge, logger: spyLogger(), countLogHits: () => {}, policy: testPolicy(), roundMs: 0 });
		expect(g.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(g.childSafety).toEqual({ flagged: false });
		expect(g.served?.model).toBe("zentropi-ai/cope-b-a4b");
		expect(guardFetch).not.toHaveBeenCalled();
	});

	it("a Zentropi outage on a child query is answered by Shieldstral, so child safety still gets a real answer", async () => {
		const guardFetch = judgeFetch({ default: "no" });
		const judge = makeZentropiJudge({
			fetchImpl: ztFetch([], 500),
			endpoint: ZT,
			key: "hf_test",
			fallback: makeShieldstralJudge({ fetchImpl: guardFetch, endpoint: `${GUARD}/v1/chat/completions` }),
		});
		const policy = testPolicy();
		const screen = await runGuardScreen(textIn(SW), { judge, logger: spyLogger(), countLogHits: () => {}, policy, roundMs: 0 });
		expect(screen.status).toBe("safe");
		expect(screen.childUnknown).toBe(false);
		expect(screen.served?.model).toBe(SHIELDSTRAL_MODEL);
		expect(guardFetch).toHaveBeenCalledTimes(policy.entries.length);
	});
});

// ── CUR-4423: a near-miss routed-language turn keeps Shieldstral and gets CoPE as a second opinion ─────
describe("guardGate — a near-miss routed-language turn: Shieldstral's screen plus CoPE's hits (CUR-4423)", () => {
	const SURE_SW = "Kila mtu ana haki ya kuishi, haki ya uhuru, na haki ya kulindwa nafsi yake.";
	const NEAR_HA = "Ina son siyan miyagun kwayoyi. A ina zan same su?";
	const EN = "Everyone has the right to life, liberty and security of person.";
	const SHIELD = SHIELDSTRAL_MODEL;
	const COPE = "zentropi-ai/cope-b-a4b";
	const says = (yes: boolean, model: string): JudgeOutcome => ({ answer: { kind: "token", yes }, httpOk: true, servedModel: model });
	/** A judge that says yes to the queries named in `yesFor` and no to the rest, reporting `model`. Like a real
	 *  adapter, a call that starts after its operation's deadline answers unknown without asking (JudgeFn). */
	const judgeBy =
		(yesFor: string[], model: string): JudgeFn =>
		async (_t, q, _th, ctx) =>
			ctx.opSignal.aborted ? { answer: { kind: "unknown" }, httpOk: false } : says(yesFor.some((k) => q.includes(k)), model);
	/** A judge that answers nothing until its own operation deadline aborts it. */
	const hangsUntilAbort: JudgeFn = (_t, _q, _th, ctx) =>
		new Promise((res) => {
			const done = () => res({ answer: { kind: "unknown" }, httpOk: false });
			if (ctx.opSignal.aborted) done();
			else ctx.opSignal.addEventListener("abort", done);
		});
	const deps = (own: JudgeFn, also: JudgeFn, extra: Partial<GuardScreenDeps> = {}): GuardScreenDeps => ({
		judge: own,
		alsoJudge: also,
		logger: spyLogger(),
		countLogHits: () => {},
		policy: testPolicy(),
		roundMs: 0,
		...extra,
	});

	beforeEach(() => {
		forcedFlags.clear();
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local");
		vi.stubEnv("HF_TOKEN", "hf_test");
	});
	afterEach(() => forcedFlags.clear());

	it("inputJudgeFor gives a sure routed text CoPE as the judge, already built on the module's first call", async () => {
		vi.resetModules();
		const fresh = await import("./guardGate");
		forcedFlags.set(fresh.ZENTROPI_AFRICAN_FLAG, true);
		const routed = fresh.inputJudgeFor(SURE_SW, spyLogger());
		expect(routed).toEqual({ judge: expect.any(Function), lang: "sw" });
	});

	it("inputJudgeFor gives a near-miss routed text CoPE as a second opinion and keeps Shieldstral as the judge", () => {
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, true);
		const log = spyLogger();
		expect(inputJudgeFor(NEAR_HA, log)).toEqual({ alsoJudge: expect.any(Function), lang: "ha" });
		expect(log.info).toHaveBeenCalledWith({ gateSource: "guard", judge: "shieldstral+zentropi", lang: "ha" }, expect.any(String));
	});

	it("inputJudgeFor gives English nothing, and a near-miss text nothing with the flag off or the key unset", () => {
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, true);
		expect(inputJudgeFor(EN, spyLogger())).toBeUndefined();
		vi.stubEnv("HF_TOKEN", "");
		expect(inputJudgeFor(NEAR_HA, spyLogger())).toBeUndefined();
		vi.stubEnv("HF_TOKEN", "hf_test");
		forcedFlags.set(ZENTROPI_AFRICAN_FLAG, false);
		expect(inputJudgeFor(NEAR_HA, spyLogger())).toBeUndefined();
	});

	it("a second-opinion block hit declines a turn the own screen allows, and served names the second opinion", async () => {
		const screen = await runGuardScreen(textIn(NEAR_HA), deps(judgeBy([], SHIELD), judgeBy(["VIOLENCE"], COPE)));
		expect(screen.status).toBe("unsafe");
		expect(screen.blockHits.map((r) => r.key)).toEqual(["chat-block-violence"]);
		expect(screen.served?.model).toBe(COPE);
		expect(screen.servedModels.sort()).toEqual([COPE, SHIELD].sort());
	});

	it("an own-screen block stays a block when the second opinion says no to everything", async () => {
		const screen = await runGuardScreen(textIn(NEAR_HA), deps(judgeBy(["VIOLENCE"], SHIELD), judgeBy([], COPE)));
		expect(screen.status).toBe("unsafe");
		expect(screen.blockHits.map((r) => r.key)).toEqual(["chat-block-violence"]);
	});

	it("a second opinion that answers nothing never makes the screen unknown, and served falls back to the own screen", async () => {
		const unanswered: JudgeFn = async () => ({ answer: { kind: "unknown" }, httpOk: false });
		const screen = await runGuardScreen(textIn(NEAR_HA), deps(judgeBy([], SHIELD), unanswered));
		expect(screen.status).toBe("safe");
		expect(screen.childUnknown).toBe(false);
		expect(screen.transportOk).toBe(true);
		expect(screen.served?.model).toBe(SHIELD);
	});

	it("a stalled second opinion cannot hold up the own screen: with one worker each, own's block still lands inside its deadline", async () => {
		const policy = testPolicy({ shield: { operationDeadlineMs: 60, concurrency: 1 } });
		const screen = await runGuardScreen(textIn(NEAR_HA), deps(judgeBy(["VIOLENCE"], SHIELD), hangsUntilAbort, { policy }));
		expect(screen.status).toBe("unsafe");
		expect(screen.childUnknown).toBe(false);
		expect(screen.blockHits.map((r) => r.key)).toEqual(["chat-block-violence"]);
	});

	it("a second-opinion log hit does not hide the own screen's deadline unknown on a long paste: still declined as couldn't-check", async () => {
		const MARK = "zz-marker-zz";
		const padded = "It is a truth universally acknowledged. ".repeat(2500).slice(0, GUARD_CORPUS_CAP - 200) + ` ${MARK}`;
		expect(guardChunkCount(padded.length)).toBeGreaterThan(1);
		// Own answers child queries at once and leaves every content query to its deadline.
		const ownChildOnly: JudgeFn = (t, q, th, ctx) => (q.includes("CHILD") ? Promise.resolve(says(false, SHIELD)) : hangsUntilAbort(t, q, th, ctx));
		const policy = testPolicy({ shield: { operationDeadlineMs: 60 } });
		const d = deps(ownChildOnly, judgeBy(["SELFHARM"], COPE), { policy });
		const screen = await runGuardScreen(textIn(padded, NEAR_HA), d);
		expect(screen.status).toBe("unknown");
		expect(screen.contentDeadlineUnasked).toBe(true);
		const v = await getGuardVerdict(textIn(padded, NEAR_HA), d);
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
	});

	it("a second-opinion violence hit does not replace the own screen's couldn't-check decline on an unanswered child query", async () => {
		const ownChildUnknown: JudgeFn = async (_t, q) => (q.includes("CHILD") ? { answer: { kind: "unknown" }, httpOk: false } : says(false, SHIELD));
		const d = deps(ownChildUnknown, judgeBy(["VIOLENCE"], COPE));
		const screen = await runGuardScreen(textIn(NEAR_HA), d);
		expect(screen.status).toBe("unknown");
		expect(screen.blockHits).toEqual([]);
		const v = await getGuardVerdict(textIn(NEAR_HA), d);
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
		expect(v.contentPolicy).toEqual({ action: "allow" });
	});

	it("counts a log hit once per message when both screens fire it", async () => {
		const countLogHits = vi.fn();
		await runGuardScreen(textIn(NEAR_HA), deps(judgeBy(["SELFHARM"], SHIELD), judgeBy(["SELFHARM"], COPE), { countLogHits }));
		expect(countLogHits).toHaveBeenCalledTimes(1);
		expect(countLogHits).toHaveBeenCalledWith(["chat-block-self-harm"]);
	});

	it("never shows the second opinion an image unit; the own screen still judges it", async () => {
		const seenBySecond: JudgeTarget["kind"][] = [];
		const seenByOwn: JudgeTarget["kind"][] = [];
		const second: JudgeFn = async (t) => (seenBySecond.push(t.kind), says(false, COPE));
		const own: JudgeFn = async (t) => (seenByOwn.push(t.kind), says(false, SHIELD));
		await runGuardScreen({ ...textIn(NEAR_HA), images: [img()] }, deps(own, second));
		expect(seenBySecond).not.toContain("image");
		expect(seenByOwn).toContain("image");
	});

	it("through the real adapters, CoPE's yes declines a turn Shieldstral allows, Shieldstral's yes declines a turn CoPE allows, and both no allows", async () => {
		const ZT = "https://cope.local/v1/chat/completions";
		const ztFetch = (yesFor: string[]) =>
			vi.fn(async (_url: unknown, init: unknown) => {
				const body = JSON.parse((init as RequestInit).body as string) as { messages: Array<{ content: string }> };
				const policy = body.messages[0].content.split("POLICY\n======\n\n")[1]?.split("\n\n\nCONTENT")[0] ?? "";
				const l = yesFor.some((k) => policy.includes(k)) ? "1" : "0";
				return { ok: true, status: 200, url: ZT, json: async () => ({ model: COPE, choices: [{ message: { content: l } }] }) } as unknown as Response;
			}) as unknown as typeof fetch;
		const shield = (map: Record<string, string>) => makeShieldstralJudge({ fetchImpl: judgeFetch(map), endpoint: "http://guard.local/v1/chat/completions" });
		const cope = (yesFor: string[]) => makeCopeSecondOpinion({ fetchImpl: ztFetch(yesFor), endpoint: ZT, key: "hf_test" });

		const copeOnly = await getGuardVerdict(textIn(NEAR_HA), deps(shield({ default: "no" }), cope(["VIOLENCE"])));
		expect(copeOnly.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		const shieldOnly = await getGuardVerdict(textIn(NEAR_HA), deps(shield({ "VIOLENCE?": "yes", default: "no" }), cope([])));
		expect(shieldOnly.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		const neither = await getGuardVerdict(textIn(NEAR_HA), deps(shield({ default: "no" }), cope([])));
		expect(neither.verdict).toEqual({ status: "ok", actions: [] });
		expect(neither.contentPolicy).toEqual({ action: "allow" });
		expect(neither.served?.model).toBe(COPE);
	});

	it("without a second opinion the screen is the single screen: the same result with alsoJudge absent", async () => {
		const own = judgeBy(["VIOLENCE"], SHIELD);
		const base = { judge: own, logger: spyLogger(), countLogHits: () => {}, policy: testPolicy(), roundMs: 0 };
		expect(await runGuardScreen(textIn(NEAR_HA), base)).toEqual(await runGuardScreen(textIn(NEAR_HA), { ...base, alsoJudge: undefined }));
	});
});
