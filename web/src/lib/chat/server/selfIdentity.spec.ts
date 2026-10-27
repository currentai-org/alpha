import { describe, it, expect, vi, beforeEach } from "vitest";
import SELF_EXAMPLES from "$lib/chat/server/data/selfIdentityExamples.json";
import NOT_SELF_EXAMPLES from "$lib/chat/server/data/notSelfIdentityExamples.json";

// vi.mock factories are hoisted above this module's own top level, so their state is too.
const { calls, ragModel, slow } = vi.hoisted(() => ({
	calls: [] as { fn: string; model: string | undefined }[],
	ragModel: { id: "sentence-transformers/all-MiniLM-L6-v2" },
	// Milliseconds every embedding call takes; 0 answers at once.
	slow: { ms: 0 }
}));
const later = <T,>(value: T) =>
	slow.ms ? new Promise<T>((resolve) => setTimeout(() => resolve(value), slow.ms)) : value;

// CUR-2135. Only the network is stubbed. Exemplars about the assistant sit on one axis and near misses
// on the other, so a query placed on an axis has a known margin and the real threshold decides.
const SELF_AXIS = [1, 0, 0];
const NOT_SELF_AXIS = [0, 1, 0];
const queryVectors: Record<string, number[]> = {
	"Who runs you?": SELF_AXIS,
	"Who holds the world chess championship title?": NOT_SELF_AXIS,
	// SI-001's shape on the multilingual sheet: near neither side, a little nearer the assistant (cosine 0.45 to
	// it, 0.2 to the near misses, margin 0.25).
	"Where is this answer being computed?": [0.45, 0.2, Math.sqrt(1 - 0.45 ** 2 - 0.2 ** 2)]
};

vi.mock("$lib/chat/server/rag/embed", async () => {
	const actual = await vi.importActual<typeof import("$lib/chat/server/rag/embed")>(
		"$lib/chat/server/rag/embed"
	);
	return {
		...actual,
		embedText: async (t: string, _timeout?: number, model?: string) => {
			calls.push({ fn: "embedText", model });
			return later(queryVectors[t] ?? null);
		},
		embedTexts: async (texts: string[], _timeout?: number, model?: string) => {
			calls.push({ fn: "embedTexts", model });
			return later(texts.map((_, i) => (i < SELF_EXAMPLES.length ? SELF_AXIS : NOT_SELF_AXIS)));
		}
	};
});
vi.mock("$lib/chat/server/rag/env", async () => {
	const actual = await vi.importActual<typeof import("$lib/chat/server/rag/env")>(
		"$lib/chat/server/rag/env"
	);
	return { ...actual, embeddingModel: () => ragModel.id };
});

const { startSelfIdentityVerdict, readIdentityWithin } = await import("./selfIdentity");
const { logger } = await import("$lib/chat/server/logger");
/** Start and read at once, so the budget runs from the start. */
const isSelfIdentityQuestion = (text: string) => startSelfIdentityVerdict(text)();

/** The model the threshold was measured in (CUR-2135). */
const PINNED = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";

describe("isSelfIdentityQuestion", () => {
	beforeEach(() => {
		calls.length = 0;
		ragModel.id = "sentence-transformers/all-MiniLM-L6-v2";
	});

	// Runs first, while the per-process exemplar cache is still empty. HF loads this model on demand,
	// and a cold deployment's first identity turns can give up at 6 s while it loads.
	it("gives no opinion once its budget runs out on a cold embedder, and the late answer warms the next turn", async () => {
		vi.useFakeTimers();
		try {
			slow.ms = 20_000;
			const first = isSelfIdentityQuestion("Who runs you?");
			await vi.advanceTimersByTimeAsync(6_000);
			// Settled by now, or the turn would still be waiting on the embedder.
			const settled = await Promise.race([first, Promise.resolve("still waiting" as const)]);
			expect(settled).toMatchObject({ ok: false, reason: "over-budget" });
			// The requests outlive the turn's budget and land 14 s later.
			const info = vi.spyOn(logger, "info");
			await vi.advanceTimersByTimeAsync(14_000);
			// The late answer is logged with how late it was and which half was slow, so the budget can be
			// sized from data and a model cold at HF told apart from a new process.
			expect(info).toHaveBeenCalledWith(
				expect.objectContaining({
					lateMs: 20_000,
					queryMs: 20_000,
					exemplarsMs: 20_000,
					hadExemplars: false
				}),
				expect.stringContaining("settled after the turn gave up")
			);
			info.mockRestore();
			slow.ms = 0;
			expect(await isSelfIdentityQuestion("Who runs you?")).toMatchObject({ ok: true, isSelf: true });
			expect(calls.filter((c) => c.fn === "embedTexts")).toHaveLength(1);
		} finally {
			slow.ms = 0;
			vi.useRealTimers();
		}
	});

	// An 18 s turn whose embedder takes longer than 6 s to load must still be stamped:
	// the budget clock starts with the wait, not with the turn.
	it("stamps a turn whose embedder loaded while the answer was still being written", async () => {
		vi.useFakeTimers();
		try {
			slow.ms = 10_000;
			const read = startSelfIdentityVerdict("Who runs you?");
			// Generation takes 12 s, past the budget measured from the start.
			await vi.advanceTimersByTimeAsync(12_000);
			const verdict = read();
			// Microtasks only: the clock does not move, so a verdict here came inside the budget.
			await vi.advanceTimersByTimeAsync(0);
			const settled = await Promise.race([verdict, Promise.resolve("still waiting" as const)]);
			expect(settled).toMatchObject({ ok: true, isSelf: true });
		} finally {
			slow.ms = 0;
			vi.useRealTimers();
		}
	});

	it("has both exemplar sets to compare against", () => {
		expect(SELF_EXAMPLES.length).toBeGreaterThan(0);
		expect(NOT_SELF_EXAMPLES.length).toBeGreaterThan(0);
	});

	it("says yes to a question about the assistant itself", async () => {
		const v = await isSelfIdentityQuestion("Who runs you?");
		expect(v).toMatchObject({ isSelf: true, ok: true });
		expect(v.margin).toBeGreaterThan(0);
	});

	it("says no to a near miss about someone else who holds a title", async () => {
		const v = await isSelfIdentityQuestion("Who holds the world chess championship title?");
		expect(v).toMatchObject({ isSelf: false, ok: true });
		expect(v.margin).toBeLessThan(0);
	});

	it("says no to a factual question that sits nearer the assistant than the near misses but close to neither", async () => {
		const v = await isSelfIdentityQuestion("Where is this answer being computed?");
		expect(v.margin).toBeGreaterThan(0.04);
		expect(v).toMatchObject({ isSelf: false, ok: true });
	});

	it("embeds the question and its exemplars in its own multilingual model, whatever the RAG embedder is", async () => {
		ragModel.id = "BAAI/bge-small-en-v1.5";
		await isSelfIdentityQuestion("Who runs you?");
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) expect(c.model).toBe(PINNED);
	});

	it("gives no opinion, so nothing is stamped, when the query cannot be embedded", async () => {
		expect(await isSelfIdentityQuestion("an unembeddable question")).toMatchObject({
			isSelf: false,
			ok: false,
			reason: "no-vector"
		});
	});

	it("gives no opinion on an empty turn", async () => {
		expect(await isSelfIdentityQuestion("   ")).toMatchObject({ ok: false, reason: "empty-query" });
	});
});

describe("readIdentityWithin names why a search decision got no veto (CUR-2135)", () => {
	const verdict = (v: Partial<import("./selfIdentity").SelfIdentityVerdict>) => async () => ({
		isSelf: false,
		ok: true,
		margin: 0,
		...v,
	});

	it("reads not-run when no reader was built", async () => {
		expect((await readIdentityWithin(undefined, 50, "t")).reading).toEqual({ identity: "not-run" });
	});

	it("reads self and not-self with the margin that decided it", async () => {
		const self = await readIdentityWithin(verdict({ isSelf: true, margin: 0.3, selfScore: 0.6 }), 50, "t");
		expect(self.reading).toEqual({ identity: "self", identityMargin: 0.3, selfScore: 0.6 });
		expect(self.verdict?.isSelf).toBe(true);
		const notSelf = await readIdentityWithin(verdict({ margin: -0.2, selfScore: 0.4 }), 50, "t");
		expect(notSelf.reading).toEqual({ identity: "not-self", identityMargin: -0.2, selfScore: 0.4 });
	});

	it("reads no-opinion with the verdict's reason, and threw for a reader that rejects", async () => {
		const none = await readIdentityWithin(verdict({ ok: false, reason: "no-vector" }), 50, "t");
		expect(none.reading).toEqual({ identity: "no-opinion", identityReason: "no-vector" });
		const threw = await readIdentityWithin(() => Promise.reject(new Error("down")), 50, "t");
		expect(threw.reading).toEqual({ identity: "no-opinion", identityReason: "threw" });
	});

	it("reads missed-budget past the budget, then logs what the late verdict said", async () => {
		const info = vi.spyOn(logger, "info");
		const slow = () =>
			new Promise<import("./selfIdentity").SelfIdentityVerdict>((r) =>
				setTimeout(() => r({ isSelf: true, ok: true, margin: 0.3, selfScore: 0.6 }), 40)
			);
		const got = await readIdentityWithin(slow, 10, "t");
		expect(got).toEqual({ reading: { identity: "missed-budget", identityBudgetMs: 10 } });
		await vi.waitFor(() =>
			expect(info).toHaveBeenCalledWith(
				expect.objectContaining({ late: { identity: "self", identityMargin: 0.3, selfScore: 0.6 } }),
				"[self-identity] verdict arrived after the search decision"
			)
		);
		info.mockRestore();
	});
});
