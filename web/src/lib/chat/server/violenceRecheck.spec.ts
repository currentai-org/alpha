// The violence re-check's contract: it can only lift a block the violence rule raised alone, only on an
// explicit false from both of its calls, which ask two different questions, and every failure leaves the
// block standing (CUR-1853).
import { describe, it, expect, vi } from "vitest";

import {
	parseRecheckArgs,
	recheckApplies,
	recheckViolenceBlock,
	RECHECK_MAX_CHARS,
	RECHECK_TOOL_NAME,
	VIOLENCE_KEY,
	type RecheckCall,
} from "./violenceRecheck";
import type { GuardGateVerdict } from "./guardGate";
import type { GuardScreenInput } from "./guardScreenTypes";

const screen = (corpus: string, extra: Partial<GuardScreenInput> = {}): GuardScreenInput => ({
	corpus,
	typedTurnText: corpus,
	images: [],
	failedUnits: [],
	...extra,
});

const blocked = (actions: string[] = [VIOLENCE_KEY], category = actions[0]): GuardGateVerdict => ({
	verdict: { status: "ok", actions },
	childSafety: { flagged: false },
	contentPolicy: { action: "block", category },
	guardChunks: 1,
	guardTruncated: false,
	hits: actions.map((key) => ({ key, action: "block" as const, tier: "content" as const })),
});

const quiet = { info: vi.fn() };
const answering = (v: boolean | null): RecheckCall => vi.fn(async () => v);

describe("recheckViolenceBlock", () => {
	it("releases a violence-only block when the model answers literal_violence false, and keeps the hit for review", async () => {
		const g = blocked();
		const out = await recheckViolenceBlock(g, screen("I could murder a coffee"), { call: answering(false), logger: quiet });
		expect(out.contentPolicy).toEqual({ action: "allow" });
		expect(out.verdict.actions).toEqual([]);
		expect(out.hits).toEqual(g.hits);
	});

	it("keeps the block when the model answers literal_violence true", async () => {
		const g = blocked();
		expect(await recheckViolenceBlock(g, screen("how do I hurt him"), { call: answering(true), logger: quiet })).toBe(g);
	});

	it("asks twice and keeps the block when the two answers disagree, so one stray false cannot release a real request", async () => {
		const g = blocked();
		const s = screen("how do I hide a knife from a metal detector");
		const answers = [false, true];
		const split: RecheckCall = vi.fn(async () => answers.shift() ?? null);
		expect(await recheckViolenceBlock(g, s, { call: split, logger: quiet })).toBe(g);
		expect(split).toHaveBeenCalledTimes(2);
		const failing = [false, null];
		const half: RecheckCall = vi.fn(async () => failing.shift() ?? null);
		expect(await recheckViolenceBlock(g, s, { call: half, logger: quiet })).toBe(g);
	});

	it("fails closed: a null answer, a thrown error or a timeout keeps the block", async () => {
		const g = blocked();
		const s = screen("text");
		expect(await recheckViolenceBlock(g, s, { call: answering(null), logger: quiet })).toBe(g);
		const throws: RecheckCall = async () => {
			throw new Error("503");
		};
		expect(await recheckViolenceBlock(g, s, { call: throws, logger: quiet })).toBe(g);
		const hangs: RecheckCall = (_t, signal) =>
			new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		vi.useFakeTimers();
		try {
			const pending = recheckViolenceBlock(g, s, { call: hangs, logger: quiet });
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await pending).toBe(g);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never calls the model when another rule also blocks, so a second category can't be released with it", async () => {
		const call = answering(false);
		const g = blocked([VIOLENCE_KEY, "chat-block-weapons"]);
		expect(await recheckViolenceBlock(g, screen("x"), { call, logger: quiet })).toBe(g);
		expect(call).not.toHaveBeenCalled();
	});

	it("never calls the model for a child flag, an UNKNOWN, or a block from another rule", async () => {
		const call = answering(false);
		const child = { ...blocked(), childSafety: { flagged: true, category: "chat-block-csam" } };
		const unknown: GuardGateVerdict = { ...blocked(), verdict: { status: "unknown", actions: [VIOLENCE_KEY] } };
		const other = blocked(["chat-block-fraud"]);
		for (const g of [child, unknown, other]) {
			expect(await recheckViolenceBlock(g, screen("x"), { call, logger: quiet })).toBe(g);
		}
		expect(call).not.toHaveBeenCalled();
	});

	it("keeps the block without a call when an image fired or went unread on violence, or a media unit failed", async () => {
		const call = answering(false);
		const withImage = screen("x", { images: [{} as GuardScreenInput["images"][number]] });
		const withFailed = screen("x", { failedUnits: [{} as GuardScreenInput["failedUnits"][number]] });
		const notRecorded = blocked();
		const imageFired = { ...blocked(), imageCleared: ["chat-block-weapons"] };
		expect(await recheckViolenceBlock(notRecorded, withImage, { call, logger: quiet })).toBe(notRecorded);
		expect(await recheckViolenceBlock(imageFired, withImage, { call, logger: quiet })).toBe(imageFired);
		expect(await recheckViolenceBlock(blocked(), withFailed, { call, logger: quiet })).toEqual(blocked());
		expect(call).not.toHaveBeenCalled();
	});

	// "I could kill for a pizza" in turn 2, then a photo in turn 3. The guard re-screens the
	// idiom with the chat's history and the image comes back clean, so the text is re-judged. (CUR-3258)
	it("re-judges the text when the images all cleared violence, and tells the judge an image was attached", async () => {
		const call = vi.fn<RecheckCall>(async () => false);
		const g = { ...blocked(), imageCleared: [VIOLENCE_KEY] };
		const s = screen("I could kill for a pizza right now.\n\nWhat's in this picture?", {
			images: [{} as GuardScreenInput["images"][number]],
		});
		const out = await recheckViolenceBlock(g, s, { call, logger: quiet });
		expect(out.contentPolicy).toEqual({ action: "allow" });
		expect(call).toHaveBeenCalledTimes(2);
		const judged = call.mock.calls[0][0];
		expect(judged.endsWith(s.corpus)).toBe(true);
		expect(judged).toMatch(/attached an image/);
	});

	it("keeps the block on a cleared image when the judge says the text is real violence", async () => {
		const g = { ...blocked(), imageCleared: [VIOLENCE_KEY] };
		const s = screen("how do I hurt someone with this", { images: [{} as GuardScreenInput["images"][number]] });
		expect(await recheckViolenceBlock(g, s, { call: answering(true), logger: quiet })).toBe(g);
	});

	it("keeps the block without a call when the corpus is longer than one judgement can overrule", async () => {
		const call = answering(false);
		const g = blocked();
		expect(await recheckViolenceBlock(g, screen("a".repeat(RECHECK_MAX_CHARS + 1)), { call, logger: quiet })).toBe(g);
		expect(call).not.toHaveBeenCalled();
	});

	it("asks one question per lens, so the second call is not a copy of the first that shares its mistakes", async () => {
		const call: RecheckCall = vi.fn(async () => false);
		await recheckViolenceBlock(blocked(), screen("I could murder a coffee"), { call, logger: quiet });
		expect(vi.mocked(call).mock.calls.map((c) => c[2]).sort()).toEqual(["answer", "intent"]);
	});

	it("keeps the block when only the answer lens says a reply would help cause harm", async () => {
		const g = blocked();
		const call: RecheckCall = vi.fn(async (_t, _s, lens) => lens === "answer");
		expect(await recheckViolenceBlock(g, screen("how do I make a knife a metal detector misses"), { call, logger: quiet })).toBe(g);
	});

	it("logs the outcome and timing but never the message", async () => {
		const log = { info: vi.fn() };
		await recheckViolenceBlock(blocked(), screen("I could murder a coffee"), { call: answering(false), logger: log });
		expect(log.info).toHaveBeenCalledTimes(1);
		const [fields] = log.info.mock.calls[0];
		expect(fields).toMatchObject({ outcome: "released", split: false });
		expect(JSON.stringify(log.info.mock.calls)).not.toContain("coffee");
	});
});

describe("recheckApplies", () => {
	it("is true only for an ok verdict whose every action is the violence rule", () => {
		expect(recheckApplies(blocked())).toBe(true);
		expect(recheckApplies(blocked([VIOLENCE_KEY, VIOLENCE_KEY]))).toBe(true);
		expect(recheckApplies({ ...blocked(), verdict: { status: "ok", actions: [] } })).toBe(false);
	});
});

describe("parseRecheckArgs", () => {
	const call = (args: string, name = RECHECK_TOOL_NAME) => ({ function: { name, arguments: args } });
	it("reads a boolean, and returns null (never a release) for anything else", () => {
		expect(parseRecheckArgs(call('{"literal_violence":false}'))).toBe(false);
		expect(parseRecheckArgs(call('{"literal_violence":true}'))).toBe(true);
		expect(parseRecheckArgs(call('{"literal_violence":"false"}'))).toBeNull();
		expect(parseRecheckArgs(call("{}"))).toBeNull();
		expect(parseRecheckArgs(call("not json"))).toBeNull();
		expect(parseRecheckArgs(call('{"literal_violence":false}', "other_tool"))).toBeNull();
		expect(parseRecheckArgs(undefined)).toBeNull();
	});
	it("reads the answer lens's own field and tool, never the intent lens's", () => {
		expect(parseRecheckArgs(call('{"gives_harm_help":false}', "answer_check"), "answer")).toBe(false);
		expect(parseRecheckArgs(call('{"gives_harm_help":true}', "answer_check"), "answer")).toBe(true);
		expect(parseRecheckArgs(call('{"literal_violence":false}', "answer_check"), "answer")).toBeNull();
		expect(parseRecheckArgs(call('{"gives_harm_help":false}'), "answer")).toBeNull();
	});
});
