// One groundcheck stage for every harness, after the output screen. The contract: a claim no
// source supports is deleted from the answer that SHIPS, including when the output screen composed that
// answer from the tokens it released; an answer with nothing supported points at the sources; every
// outcome is reported, a failed check included; and the check stands down where the answer must ship
// as written (flag off, nothing retrieved, code-rendered numbers, a decline, a cut-off answer). (CUR-2765)
import { describe, it, expect, vi } from "vitest";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { OutputScreenResult } from "$lib/chat/server/moderation";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

const { groundcheckStage } = await import("./groundcheckStage");
const { screenOutputStream } = await import("./screenStream");

const ANSWER = "Lima is the capital of Peru [1]. It was founded by Martians.";
const REVISED = "Lima is the capital of Peru [1].";
const SOURCES = [{ n: 1, title: "Peru – Wikipedia" }];

async function* src(events: MessageUpdate[]): AsyncGenerator<MessageUpdate> {
	for (const e of events) yield e;
}
const tok = (token: string): MessageUpdate => ({ type: MessageUpdateType.Stream, token });
const fin = (text = ANSWER, extra: Record<string, unknown> = {}): MessageUpdate =>
	({ type: MessageUpdateType.FinalAnswer, text, interrupted: false, ...extra }) as MessageUpdate;
async function finalText(gen: AsyncIterable<MessageUpdate>) {
	let text: string | undefined;
	for await (const e of gen) if (e.type === MessageUpdateType.FinalAnswer) text = e.text;
	return text;
}

function stage(source: AsyncIterable<MessageUpdate>, over: Partial<Parameters<typeof groundcheckStage>[1]> = {}) {
	const outcomes: Array<[string, number | undefined]> = [];
	const check = vi.fn(async () => ({ text: REVISED, outcome: "revised" as const }));
	const gen = groundcheckStage(source, {
		enabled: true,
		question: "What is the capital of Peru?",
		standDown: () => false,
		evidence: async () => ["Lima is the capital of Peru."],
		sources: () => SOURCES,
		onOutcome: (o, before) => outcomes.push([o, before]),
		check,
		...over,
	});
	return { gen, outcomes, check };
}

describe("groundcheckStage", () => {
	it("ships the revision when the output screen composed the answer from the tokens it released", async () => {
		const clear = async (): Promise<OutputScreenResult> => ({ blocked: false, kind: null });
		const screened = screenOutputStream(src([tok(ANSWER), fin()]), { screen: clear });
		const { gen, outcomes } = stage(screened);
		expect(await finalText(gen)).toBe(REVISED);
		expect(outcomes).toEqual([["revised", ANSWER.length]]);
	});

	it("hands the removed-claim count to onOutcome with a revision, for X-ray's Fact check row (CUR-2927)", async () => {
		const seen: unknown[][] = [];
		const { gen } = stage(src([tok(ANSWER), fin()]), {
			check: async () => ({ text: REVISED, outcome: "revised" as const, removed: 2 }),
			onOutcome: (...args) => seen.push(args),
		});
		await finalText(gen);
		expect(seen).toEqual([["revised", ANSWER.length, 2]]);
	});

	it("says under the answer how many list items went, in the answer's language (CUR-4489)", async () => {
		const languageOf = vi.fn(async () => "fr" as const);
		const { gen } = stage(src([fin()]), {
			check: async () => ({ text: REVISED, outcome: "revised" as const, removed: 2, items: 2 }),
			languageOf,
		});
		expect(await finalText(gen)).toBe(`${REVISED}\n\n_2 éléments ont été retirés car aucune source ne les confirmait._`);
		expect(languageOf).toHaveBeenCalledWith(REVISED);
	});

	it("writes the items-removed line in English when the language read fails, never losing the revision", async () => {
		const { gen } = stage(src([fin()]), {
			check: async () => ({ text: REVISED, outcome: "revised" as const, removed: 1, items: 1 }),
			languageOf: async () => {
				throw new Error("detectors unavailable");
			},
		});
		expect(await finalText(gen)).toBe(`${REVISED}\n\n_1 item was removed because no source supported it._`);
	});

	it("adds no line when the revision dropped no list item", async () => {
		const languageOf = vi.fn(async () => "fr" as const);
		const { gen } = stage(src([fin()]), {
			check: async () => ({ text: REVISED, outcome: "revised" as const, removed: 1 }),
			languageOf,
		});
		expect(await finalText(gen)).toBe(REVISED);
		expect(languageOf).not.toHaveBeenCalled();
	});

	it("loses the revision when it checks before the output screen, the native harness's old order", async () => {
		const clear = async (): Promise<OutputScreenResult> => ({ blocked: false, kind: null });
		const { gen } = stage(src([tok(ANSWER), fin()]));
		expect(await finalText(screenOutputStream(gen, { screen: clear }))).toBe(ANSWER);
	});

	it("checks the answer against the evidence and the person's question", async () => {
		const { gen, check } = stage(src([fin()]));
		await finalText(gen);
		expect(check).toHaveBeenCalledWith({
			answer: ANSWER,
			context: ["Lima is the capital of Peru."],
			question: "What is the capital of Peru?",
		});
	});

	it("points at the sources when nothing in the answer was supported, never an empty answer", async () => {
		const { gen } = stage(src([fin()]), { check: vi.fn(async () => ({ text: "", outcome: "emptied" as const })) });
		const text = (await finalText(gen)) ?? "";
		expect(text).toMatch(/don't support what I wrote/);
		expect(text).toContain("Peru – Wikipedia");
	});

	it("reports a check that never finished, and ships the answer as written", async () => {
		for (const outcome of ["detect-failed", "truncated", "too-many", "revise-failed", "clean"] as const) {
			const { gen, outcomes } = stage(src([fin()]), { check: vi.fn(async () => ({ text: "x", outcome })) });
			expect(await finalText(gen)).toBe(ANSWER);
			expect(outcomes).toEqual([[outcome, undefined]]);
		}
	});

	it("stamps a sourced answer that stands down, so it never reads as a turn with nothing to check", async () => {
		const { gen, outcomes, check } = stage(src([fin()]), { standDown: () => true });
		expect(await finalText(gen)).toBe(ANSWER);
		expect(check).not.toHaveBeenCalled();
		expect(outcomes).toEqual([["stood-down", undefined]]);
	});

	it("reports nothing with the flag off, nothing retrieved, a decline or a cut-off answer, even when it would stand down", async () => {
		const cases: Array<[MessageUpdate, Partial<Parameters<typeof groundcheckStage>[1]>]> = [
			[fin(), { enabled: false, standDown: () => true }],
			[fin(), { evidence: async () => [], standDown: () => true }],
			[fin("Declined.", { declineText: "Declined." }), {}],
			[fin(ANSWER, { declineNotice: "Withheld." }), {}],
			[fin(ANSWER, { interrupted: true }), {}],
		];
		for (const [event, over] of cases) {
			const { gen, outcomes, check } = stage(src([event]), over);
			expect(await finalText(gen)).toBe((event as { text: string }).text);
			expect(check).not.toHaveBeenCalled();
			expect(outcomes).toEqual([]);
		}
	});

	it("passes every other event through untouched", async () => {
		const { gen } = stage(src([tok("Lima"), fin()]));
		const out: MessageUpdate[] = [];
		for await (const e of gen) out.push(e);
		expect(out[0]).toEqual(tok("Lima"));
	});
});
