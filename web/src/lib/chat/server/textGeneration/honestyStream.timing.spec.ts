import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

// Every synchronous guard over the answer runs through timedPass under its own name, so a
// guard that blocks the event loop is logged as itself. (CUR-3749)
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
vi.mock("$lib/chat/server/rag/embed", () => ({
	embedTexts: vi.fn((texts: string[]) => Promise.resolve(texts.map(() => [0, 1, 0]))),
	cosine: () => 0,
}));
vi.mock("./repetitionGuard", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./repetitionGuard")>();
	return { ...actual, repetitionGuardEnabled: vi.fn(() => false) };
});
const spin = { on: false };
vi.mock("./degeneration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./degeneration")>();
	const { SLOW_PASS_MS } = await import("./passTiming");
	return {
		...actual,
		measureDegeneration: vi.fn((text: string) => {
			const until = performance.now() + SLOW_PASS_MS + 50;
			while (spin.on && performance.now() < until) {
				// spin: a synchronous pass that holds the event loop
			}
			return actual.measureDegeneration(text);
		}),
	};
});
vi.mock("./passTiming", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./passTiming")>();
	return { ...actual, timedPass: vi.fn(actual.timedPass), noteLongAnswer: vi.fn(actual.noteLongAnswer) };
});

const { logger } = await import("$lib/chat/server/logger");
const { repetitionGuardEnabled } = await import("./repetitionGuard");
const { timedPass, noteLongAnswer } = await import("./passTiming");
const { honestyScreenStream } = await import("./honestyStream");

const ANSWER = "Lima is the capital of Peru.";
const SOURCES = [{ n: 1, title: "Peru – Wikipedia", url: "https://en.wikipedia.org/wiki/Peru" }];

async function run(grounded: boolean) {
	async function* src(): AsyncGenerator<MessageUpdate> {
		yield { type: MessageUpdateType.Stream, token: ANSWER };
		yield { type: MessageUpdateType.FinalAnswer, text: ANSWER, interrupted: false };
	}
	const opts = grounded
		? { grounded: true, sources: SOURCES, allowedUrls: SOURCES.map((s) => s.url) }
		: { grounded: false, sources: [], allowedUrls: [] };
	for await (const _ of honestyScreenStream(src(), opts)) {
		// drain
	}
	return new Set(vi.mocked(timedPass).mock.calls.map(([pass]) => pass));
}

const EVERY_TURN = [
	"sourceGuardCleanPrefix",
	"markupRunawayStart",
	"detectFabricatedSources",
	"stripTrailingCloserRun",
	"stripEchoedWrapperTail",
	"stripMarkupRunaway",
	"measureDegeneration",
];

beforeEach(() => {
	vi.clearAllMocks();
	spin.on = false;
});

describe("honestyScreenStream pass timing (CUR-3749)", () => {
	it("times every guard of an ungrounded turn under its own name", async () => {
		expect(await run(false)).toEqual(new Set([...EVERY_TURN, "stripUnbackedSourceClaims"]));
	});

	it("times every guard of a grounded turn under its own name", async () => {
		expect(await run(true)).toEqual(
			new Set([...EVERY_TURN, "stripRawSourceUrls", "stripTrailingSourceList", "stripTrailingTitleDump"])
		);
	});

	it("times the repetition guard by name when it is on", async () => {
		vi.mocked(repetitionGuardEnabled).mockReturnValue(true);
		try {
			expect(await run(false)).toContain("detectDegenerateRepetition");
		} finally {
			vi.mocked(repetitionGuardEnabled).mockReturnValue(false);
		}
	});

	it("notes the answer's length before its end-of-stream passes", async () => {
		await run(false);
		expect(noteLongAnswer).toHaveBeenCalledWith(ANSWER);
	});

	it("a timed pass still hands its result on: a grounded answer's trailing title dump is cut", async () => {
		const head =
			"Meta is developing advanced brain-computer interfaces that could revolutionize accessibility and communication technology.";
		const text = `${head} [1] FIFA World Cup 2026 – Wikipedia  IPCC Sixth Assessment Report – Intergovernmental Panel on Climate Change`;
		const sources = [
			{ n: 1, title: "FIFA World Cup 2026", url: "https://example.org/fifa" },
			{ n: 2, title: "IPCC Sixth Assessment Report", url: "https://example.org/ipcc" },
		];
		async function* src(): AsyncGenerator<MessageUpdate> {
			yield { type: MessageUpdateType.Stream, token: text };
			yield { type: MessageUpdateType.FinalAnswer, text, interrupted: false };
		}
		let final: string | undefined;
		for await (const u of honestyScreenStream(src(), {
			grounded: true,
			sources,
			allowedUrls: sources.map((s) => s.url),
		})) {
			if (u.type === MessageUpdateType.FinalAnswer) final = u.text;
		}
		expect(final?.trimEnd()).toBe(head);
	});

	it("logs the end-of-stream guard that held the event loop past SLOW_PASS_MS, by name", async () => {
		spin.on = true;
		await run(false);
		const slow = vi
			.mocked(logger.warn)
			.mock.calls.filter(([, msg]) => msg === "[honesty] slow pass over the answer")
			.map(([fields]) => (fields as { pass: string }).pass);
		expect(slow).toEqual(["measureDegeneration"]);
	});
});
