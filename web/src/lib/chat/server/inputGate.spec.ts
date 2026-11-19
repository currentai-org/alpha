// Input gate — the flag-threading invariants as TESTS: which source screens is decided by the CARRIED
// policy value, exactly one screening operation runs per turn, the settled bundle keeps the route's
// existing shape, and the Coop branch receives ONLY the current turn's typed text (never file/image
// bytes). (There is no in-app injection classifier alongside either branch, — see inputGate.ts.)
import { describe, it, expect, vi, afterEach } from "vitest";

import { runInputGate, screenedForRecord, type InputGateDeps } from "./inputGate";
import type { GuardGateVerdict, GuardScreenDeps } from "./guardGate";
import type { GuardScreenInput } from "./guardScreenTypes";

const screen = (corpus: string, typed = corpus): GuardScreenInput => ({
	corpus,
	typedTurnText: typed,
	images: [],
	failedUnits: [],
});

function deps(overrides: Partial<InputGateDeps> = {}): InputGateDeps & {
	coop: ReturnType<typeof vi.fn>;
	guard: ReturnType<typeof vi.fn>;
	log: { info: ReturnType<typeof vi.fn> };
} {
	const coop = vi.fn(async () => ({ status: "ok" as const, actions: [] as string[] }));
	const guard = vi.fn(
		async (): Promise<GuardGateVerdict> => ({
			verdict: { status: "ok", actions: [] },
			childSafety: { flagged: false },
			contentPolicy: { action: "allow" },
			guardChunks: 1,
			guardTruncated: false,
			hits: [],
		})
	);
	const log = { info: vi.fn() };
	return {
		coop,
		guard,
		log,
		getCoopVerdict: coop,
		getGuardVerdict: guard,
		checkChildSafety: vi.fn(async () => ({ flagged: false })),
		checkContentPolicy: vi.fn(async () => ({ action: "allow" as const })),
		logger: log,
		...overrides,
	};
}

afterEach(() => vi.unstubAllEnvs());

describe("inputGate — one screening operation, source selected by the carried policy", () => {
	it("flag ON → one guard screening operation (on the prepared input) and zero Coop /content calls", async () => {
		const d = deps();
		const input = screen("screen me");
		const bundle = await runInputGate({ input, useGuardPrimary: true }, d);
		expect(d.guard).toHaveBeenCalledTimes(1);
		expect(d.guard).toHaveBeenCalledWith(input);
		expect(d.coop).not.toHaveBeenCalled();
		expect(bundle.gateSource).toBe("guard");
	});

	it("flag OFF → one Coop screening operation on the TYPED text and zero guard calls", async () => {
		const d = deps();
		const bundle = await runInputGate(
			{ input: screen("corpus with FILEBYTES", "just typed"), userId: "u1", useGuardPrimary: false },
			d
		);
		expect(d.coop).toHaveBeenCalledTimes(1);
		expect(d.coop).toHaveBeenCalledWith("just typed", "u1");
		expect(d.guard).not.toHaveBeenCalled();
		expect(bundle.gateSource).toBe("coop");
	});

	it("Coop branch body never contains file/image bytes — only the current turn's typed text (plan r3 #3)", async () => {
		const child = vi.fn(async (_t: string, _u?: string, _v?: unknown) => ({ flagged: false }));
		const content = vi.fn(async (_t: string, _u?: string, _v?: unknown) => ({ action: "allow" as const }));
		const coop = vi.fn(async (_t: string, _u?: string) => ({ status: "ok" as const, actions: [] as string[] }));
		const d = deps({ getCoopVerdict: coop, checkChildSafety: child, checkContentPolicy: content });
		await runInputGate(
			{ input: screen("TYPED hello\n<document>SECRET_FILE_BYTES</document>", "TYPED hello"), userId: "u", useGuardPrimary: false },
			d
		);
		// The vendor (sync AND its owner-points) sees the typed text, and no file byte.
		for (const call of [...coop.mock.calls, ...child.mock.calls, ...content.mock.calls]) {
			expect(String(call[0])).toBe("TYPED hello");
			expect(String(call[0])).not.toContain("SECRET_FILE_BYTES");
		}
	});

	it("guard branch settles the route's EXISTING bundle shape — every consumer field present", async () => {
		const d = deps({
			getGuardVerdict: vi.fn(
				async (): Promise<GuardGateVerdict> => ({
					verdict: { status: "ok", actions: ["chat-block-violence"] },
					childSafety: { flagged: false },
					contentPolicy: { action: "block", category: "chat-block-violence" },
					guardChunks: 2,
					guardTruncated: false,
					hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
				})
			),
		});
		const bundle = await runInputGate({ input: screen("t"), useGuardPrimary: true }, d);
		expect(bundle.verdict.status).toBe("ok");
		expect(bundle.contentPolicy).toEqual({ action: "block", category: "chat-block-violence" });
		expect(bundle.childSafety).toEqual({ flagged: false });
		expect(typeof bundle.gateMs).toBe("number");
		// The guard branch carries the fired rules to the review plane.
		expect(bundle.hits).toEqual([{ key: "chat-block-violence", action: "block", tier: "content" }]);
	});

	it("coop branch leaves hits UNDEFINED — Coop already holds the turn (it ran sync)", async () => {
		const verdict = { status: "ok" as const, actions: [] as string[] };
		const d = deps({ getCoopVerdict: vi.fn(async () => verdict) });
		const bundle = await runInputGate({ input: screen("t"), userId: "u", useGuardPrimary: false }, d);
		expect(bundle.gateSource).toBe("coop");
		expect(bundle.hits).toBeUndefined();
	});

	it("coop branch reuses the fetched verdict for the child/content owner-points (no re-fetch)", async () => {
		const verdict = { status: "ok" as const, actions: ["chat-block-violence"] };
		const child = vi.fn(async () => ({ flagged: false }));
		const content = vi.fn(async () => ({ action: "block" as const, category: "chat-block-violence" }));
		const d = deps({ getCoopVerdict: vi.fn(async () => verdict), checkChildSafety: child, checkContentPolicy: content });
		const bundle = await runInputGate({ input: screen("t"), userId: "u", useGuardPrimary: false }, d);
		expect(child).toHaveBeenCalledWith("t", "u", verdict);
		expect(content).toHaveBeenCalledWith("t", "u", verdict);
		expect(bundle.contentPolicy.action).toBe("block");
	});

	it("[moderation] timing line carries gateSource + guard fields on the guard branch", async () => {
		const d = deps();
		await runInputGate({ input: screen("screen me"), useGuardPrimary: true }, d);
		const [fields, msg] = d.log.info.mock.calls[0];
		expect(msg).toContain("[moderation]");
		expect(fields).toMatchObject({ gateSource: "guard", guardStatus: "ok", guardChunks: 1, guardTruncated: false });
		expect(typeof (fields as { guardMs: unknown }).guardMs).toBe("number");
	});

	it("[moderation] timing line keeps the coop fields + gains gateSource on the coop branch", async () => {
		const d = deps();
		await runInputGate({ input: screen("screen me"), useGuardPrimary: false }, d);
		const [fields] = d.log.info.mock.calls[0];
		expect(fields).toMatchObject({ gateSource: "coop", coopStatus: "ok" });
	});
});

describe("inputGate — screenedForRecord derives from the SELECTED source", () => {
	it("an allowed guard-screened turn records screened:true without Coop configured", () => {
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local");
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(screenedForRecord("guard", "ok")).toBe(true);
	});
	it("a guard UNKNOWN records screened:false (fail loud in the trace, never 'screened, clear')", () => {
		vi.stubEnv("GUARD_SHADOW_URL", "http://guard.local");
		expect(screenedForRecord("guard", "unknown")).toBe(false);
	});
	it("guard source with no URL records screened:false (misconfigured is not screened)", () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		expect(screenedForRecord("guard", "ok")).toBe(false);
	});
	it("coop source keeps today's derivation: configured AND status ok", () => {
		vi.stubEnv("COOP_URL", "http://coop.local");
		vi.stubEnv("COOP_API_KEY", "k");
		expect(screenedForRecord("coop", "ok")).toBe(true);
		expect(screenedForRecord("coop", "unknown")).toBe(false);
		vi.stubEnv("COOP_URL", "");
		vi.stubEnv("COOP_API_KEY", "");
		expect(screenedForRecord("coop", "ok")).toBe(false);
	});
});

describe("inputGate — violence re-check", () => {
	it("hands the re-check the screen's verdict and the prepared input, and settles the bundle on what it returns", async () => {
		const blockedVerdict: GuardGateVerdict = {
			verdict: { status: "ok", actions: ["chat-block-violence"] },
			childSafety: { flagged: false },
			contentPolicy: { action: "block", category: "chat-block-violence" },
			guardChunks: 1,
			guardTruncated: false,
			hits: [{ key: "chat-block-violence", action: "block", tier: "content" }],
		};
		const releasedVerdict: GuardGateVerdict = { ...blockedVerdict, verdict: { status: "ok", actions: [] }, contentPolicy: { action: "allow" } };
		const recheckViolence = vi.fn(async () => releasedVerdict);
		const d = deps({ getGuardVerdict: vi.fn(async () => blockedVerdict), recheckViolence });
		const input = screen("I could murder a coffee");
		const bundle = await runInputGate({ input, useGuardPrimary: true }, d);
		expect(recheckViolence).toHaveBeenCalledWith(blockedVerdict, input);
		expect(bundle.contentPolicy).toEqual({ action: "allow" });
		expect(bundle.hits).toEqual(blockedVerdict.hits);
	});

	it("never re-checks on the Coop branch", async () => {
		const recheckViolence = vi.fn();
		await runInputGate({ input: screen("x"), useGuardPrimary: false }, deps({ recheckViolence }));
		expect(recheckViolence).not.toHaveBeenCalled();
	});
});

// the screen reads every user message together, so a distress log hit from an earlier message
// must not stamp the support card on an unrelated follow-up.
describe("inputGate — a support log hit stamps the card only when this turn's own message fires it", () => {
	const intent = { key: "chat-block-self-harm-intent", action: "log" as const, tier: "content" as const };
	const verdictWith = (hits: GuardGateVerdict["hits"], status: "ok" | "unknown" = "ok"): GuardGateVerdict => ({
		verdict: { status, actions: [] },
		childSafety: { flagged: false },
		contentPolicy: { action: "allow" },
		guardChunks: 1,
		guardTruncated: false,
		hits,
	});
	const history = screen("Mi sento così sola che penso di farla finita.\n\nmi consigli un libro?", "mi consigli un libro?");

	it("an unrelated follow-up after a distress message → supportOnLatest false, from a screen of the follow-up alone", async () => {
		const guard = vi.fn(async (input: GuardScreenInput) =>
			verdictWith(input.corpus.includes("farla finita") ? [intent] : [])
		);
		const bundle = await runInputGate(
			{ input: history, useGuardPrimary: true, latest: screen("mi consigli un libro?") },
			deps({ getGuardVerdict: guard })
		);
		expect(guard).toHaveBeenCalledTimes(2);
		expect(guard.mock.calls[1][0].corpus).toBe("mi consigli un libro?");
		expect(bundle.supportOnLatest).toBe(false);
		// The review plane still gets the whole screen's hits.
		expect(bundle.hits).toEqual([intent]);
	});

	it("a distress message as the follow-up → supportOnLatest true", async () => {
		const guard = vi.fn(async () => verdictWith([intent]));
		const bundle = await runInputGate(
			{ input: screen("ciao\n\npenso di farla finita", "penso di farla finita"), useGuardPrimary: true, latest: screen("penso di farla finita") },
			deps({ getGuardVerdict: guard })
		);
		expect(bundle.supportOnLatest).toBe(true);
	});

	it("a first message (the screen read only it) → no second screen, supportOnLatest absent", async () => {
		const guard = vi.fn(async () => verdictWith([intent]));
		const bundle = await runInputGate(
			{ input: screen("penso di farla finita"), useGuardPrimary: true, latest: screen("penso di farla finita") },
			deps({ getGuardVerdict: guard })
		);
		expect(guard).toHaveBeenCalledTimes(1);
		expect(bundle).not.toHaveProperty("supportOnLatest");
	});

	it("no support log hit → no second screen", async () => {
		const guard = vi.fn(async () => verdictWith([]));
		const bundle = await runInputGate({ input: history, useGuardPrimary: true, latest: screen("mi consigli un libro?") }, deps({ getGuardVerdict: guard }));
		expect(guard).toHaveBeenCalledTimes(1);
		expect(bundle).not.toHaveProperty("supportOnLatest");
	});

	it("the second screen cannot answer (unknown or throws) → keeps the card (fails toward support)", async () => {
		let call = 0;
		const unknownGuard = vi.fn(async () => (++call === 1 ? verdictWith([intent]) : verdictWith([], "unknown")));
		const a = await runInputGate({ input: history, useGuardPrimary: true, latest: screen("mi consigli un libro?") }, deps({ getGuardVerdict: unknownGuard }));
		expect(a.supportOnLatest).toBe(true);
		let n = 0;
		const throwingGuard = vi.fn(async () => {
			if (++n === 1) return verdictWith([intent]);
			throw new Error("guard down");
		});
		const b = await runInputGate({ input: history, useGuardPrimary: true, latest: screen("mi consigli un libro?") }, deps({ getGuardVerdict: throwingGuard }));
		expect(b.supportOnLatest).toBe(true);
	});

	it("the second screen counts no distress hit and reports no progress", async () => {
		const countLogHits = vi.fn();
		const onProgress = vi.fn();
		const guard = vi.fn(async (input: GuardScreenInput) => verdictWith(input.corpus.includes("farla finita") ? [intent] : []));
		await runInputGate(
			{ input: history, useGuardPrimary: true, latest: screen("mi consigli un libro?") },
			deps({ getGuardVerdict: guard, guardDeps: { countLogHits, onProgress } })
		);
		expect((guard.mock.calls[0] as unknown[])[1]).toMatchObject({ countLogHits, onProgress });
		expect((guard.mock.calls[1] as unknown[])[1]).toMatchObject({ countLogHits: undefined, onProgress: undefined });
	});

	it("this turn's image fired the hit → the second screen reads that image too and keeps the card", async () => {
		const image = { sha: "a", mime: "image/jpeg", source: Buffer.from(""), screenB64: "", sourceMessageId: "m2" } as GuardScreenInput["images"][number];
		const guard = vi.fn(async (input: GuardScreenInput) => verdictWith(input.images.length > 0 ? [intent] : []));
		const withImage = { ...history, images: [image] };
		const bundle = await runInputGate(
			{ input: withImage, useGuardPrimary: true, latest: { ...screen("leggi questo"), images: [image] } },
			deps({ getGuardVerdict: guard })
		);
		expect(guard).toHaveBeenCalledTimes(2);
		expect(guard.mock.calls[1][0].images).toEqual([image]);
		expect(bundle.supportOnLatest).toBe(true);
	});

	it("no latest message (a caller that does not pass it) → behavior unchanged", async () => {
		const guard = vi.fn(async () => verdictWith([intent]));
		const bundle = await runInputGate({ input: history, useGuardPrimary: true }, deps({ getGuardVerdict: guard }));
		expect(guard).toHaveBeenCalledTimes(1);
		expect(bundle).not.toHaveProperty("supportOnLatest");
	});
});

describe("inputGate — a capped screen's content block stands only if the whole history also blocks (guard-history-cap)", () => {
	const allow: GuardGateVerdict = {
		verdict: { status: "ok", actions: [] },
		childSafety: { flagged: false },
		contentPolicy: { action: "allow" },
		guardChunks: 1,
		guardTruncated: false,
		hits: [],
	};
	const block: GuardGateVerdict = {
		...allow,
		verdict: { status: "ok", actions: ["privacy"] },
		contentPolicy: { action: "block", category: "privacy" },
		hits: [{ key: "privacy", action: "block", tier: "content" }],
	};
	const memo = "filler ".repeat(500) + "The meeting room door code is 4417. " + "filler ".repeat(500);
	const followUp = "What is the door code in the memo I pasted?";
	const capped: GuardScreenInput = { ...screen(`filler filler\n\n${followUp}`, followUp), historyCorpus: `${memo}\n\n${followUp}` };
	const guardBy = (decide: (input: GuardScreenInput) => GuardGateVerdict | Promise<GuardGateVerdict>) =>
		vi.fn(async (input: GuardScreenInput, _deps?: GuardScreenDeps) => decide(input));

	it("a follow-up blocked only because the cap hid the paste is allowed when the whole history passes", async () => {
		const guard = guardBy((input) => (input.corpus.includes("4417") ? allow : block));
		const bundle = await runInputGate({ input: capped, useGuardPrimary: true }, deps({ getGuardVerdict: guard }));
		expect(guard).toHaveBeenCalledTimes(2);
		expect(guard.mock.calls[1][0].corpus).toBe(capped.historyCorpus);
		expect(bundle.contentPolicy.action).toBe("allow");
	});

	it("a block the whole history also reaches stands, decided on the whole history", async () => {
		const guard = guardBy(() => block);
		const bundle = await runInputGate({ input: capped, useGuardPrimary: true }, deps({ getGuardVerdict: guard }));
		expect(guard).toHaveBeenCalledTimes(2);
		expect(bundle.contentPolicy).toEqual({ action: "block", category: "privacy" });
	});

	it("the whole-history read cannot answer (unknown or throws) → the capped block stands (fails closed)", async () => {
		for (const second of [() => ({ ...allow, verdict: { status: "unknown" as const, actions: [] } }), () => Promise.reject(new Error("down"))]) {
			let n = 0;
			const guard = guardBy(() => (n++ === 0 ? block : second()));
			const bundle = await runInputGate({ input: capped, useGuardPrimary: true }, deps({ getGuardVerdict: guard }));
			expect(bundle.contentPolicy.action).toBe("block");
		}
	});

	it("a capped child-safety flag is never re-read away", async () => {
		const child: GuardGateVerdict = { ...block, childSafety: { flagged: true, category: "child" } };
		const guard = guardBy(() => child);
		const bundle = await runInputGate({ input: capped, useGuardPrimary: true }, deps({ getGuardVerdict: guard }));
		expect(guard).toHaveBeenCalledTimes(1);
		expect(bundle.childSafety.flagged).toBe(true);
	});

	it("an allowed capped turn, or a screen with no historyCorpus (flag off), runs one screen only", async () => {
		const pass = guardBy(() => allow);
		await runInputGate({ input: capped, useGuardPrimary: true }, deps({ getGuardVerdict: pass }));
		expect(pass).toHaveBeenCalledTimes(1);
		const blocked = guardBy(() => block);
		const bundle = await runInputGate({ input: screen(followUp), useGuardPrimary: true }, deps({ getGuardVerdict: blocked }));
		expect(blocked).toHaveBeenCalledTimes(1);
		expect(bundle.contentPolicy.action).toBe("block");
	});

	it("the whole-history read counts no distress hit and reports no progress (the capped read did)", async () => {
		const guard = guardBy((input) => (input.corpus.includes("4417") ? allow : block));
		const countLogHits = vi.fn();
		const onProgress = vi.fn();
		await runInputGate(
			{ input: capped, useGuardPrimary: true },
			deps({ getGuardVerdict: guard, guardDeps: { countLogHits, onProgress } as unknown as GuardScreenDeps })
		);
		expect(guard.mock.calls[1][1]).toMatchObject({ countLogHits: undefined, onProgress: undefined });
	});
});
