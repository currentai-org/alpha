// The child-safety screen on stored pictures. The judge is injected, so these tests pin the
// contract around the model (which rules run, how many calls, how a failure lands) and never what
// Shieldstral answers; the live probe on the PR preview covers that. (CUR-3201)
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { childRules, loadGuardPolicy } from "$lib/chat/server/guardPolicy";
import type { JudgeFn, JudgeOutcome } from "$lib/chat/server/guardScreenTypes";
import {
	ImageScreenBlockedError,
	ImageScreenUnavailableError,
	TooManyImagesToScreenError,
	screenStoredImages,
	tooManyImagesMessage,
} from "./uploadImageGuard";

/** The screen's cap, written out: changing it changes the screen's coverage, which is a decision for the
 *  safety lead, so a change here should be a deliberate edit to this spec too (CUR-4662). */
const MAX_SCREENED_IMAGES_PER_FILE = 20;

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const on = { enabled: () => true, configured: () => true, logger: quiet };

/** A distinct solid-colour PNG per index, so dedupe sees n different pictures. */
async function png(i: number): Promise<Uint8Array> {
	return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i % 256, g: (i * 7) % 256, b: 40 } } })
		.png()
		.toBuffer();
}

function judgeAnswering(fn: (query: string) => JudgeOutcome) {
	const calls: string[] = [];
	const judge: JudgeFn = async (target, query) => {
		expect(target.kind).toBe("image");
		calls.push(query);
		return fn(query);
	};
	return { judge, calls };
}
const no: JudgeOutcome = { answer: { kind: "score", score: 0.01, yes: false }, httpOk: true, servedModel: "m" };
const yes: JudgeOutcome = { answer: { kind: "score", score: 0.99, yes: true }, httpOk: true, servedModel: "m" };
const unreachable: JudgeOutcome = { answer: { kind: "unknown" }, httpOk: false };

const policy = loadGuardPolicy()!;
const childQueries = childRules(policy).map((r) => r.query);

describe("screenStoredImages — child-tier rules only, fail closed", () => {
	it("asks only the child-tier rules, once per distinct picture, and resolves when every answer is no", async () => {
		const { judge, calls } = judgeAnswering(() => no);
		const a = await png(1);
		await screenStoredImages([a, await png(2), a], { ...on, judge });
		expect(childQueries.length).toBeGreaterThan(0);
		expect(childQueries.length).toBeLessThan(policy.entries.length);
		expect(calls).toHaveLength(2 * childQueries.length);
		expect(new Set(calls)).toEqual(new Set(childQueries));
	});

	it("refuses a picture a child rule says yes to, naming the rule key and nothing from the bytes", async () => {
		const hit = childQueries[0];
		const { judge } = judgeAnswering((q) => (q === hit ? yes : no));
		const err = await screenStoredImages([await png(3)], { ...on, judge }).catch((e) => e);
		expect(err).toBeInstanceOf(ImageScreenBlockedError);
		const rule = childRules(policy).find((r) => r.query === hit)!;
		expect(err.category).toBe(rule.key);
		expect(err.hits).toEqual([{ key: rule.key, action: "block", tier: "child" }]);
	});

	it("refuses as unavailable (fail closed) when the screen cannot be reached", async () => {
		const { judge } = judgeAnswering(() => unreachable);
		await expect(screenStoredImages([await png(4)], { ...on, judge })).rejects.toBeInstanceOf(
			ImageScreenUnavailableError
		);
	});

	it("refuses as unavailable (fail closed) when a picture cannot be rendered for the screen", async () => {
		const { judge, calls } = judgeAnswering(() => no);
		const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		await expect(screenStoredImages([broken], { ...on, judge })).rejects.toBeInstanceOf(ImageScreenUnavailableError);
		expect(calls).toHaveLength(0);
	});

	it(`refuses a file with more than ${MAX_SCREENED_IMAGES_PER_FILE} distinct pictures before any call, rather than screening a subset`, async () => {
		const { judge, calls } = judgeAnswering(() => no);
		const many = await Promise.all(Array.from({ length: MAX_SCREENED_IMAGES_PER_FILE + 1 }, (_, i) => png(i + 10)));
		await expect(screenStoredImages(many, { ...on, judge })).rejects.toBeInstanceOf(TooManyImagesToScreenError);
		expect(calls).toHaveLength(0);
	});

	it("tells the person how many pictures the file has, the most we check, and to split it (CUR-4662)", async () => {
		const many = await Promise.all(Array.from({ length: 41 }, (_, i) => png(i + 100)));
		const refused = await screenStoredImages(many, { ...on, judge: judgeAnswering(() => no).judge }).catch((e) => e);
		expect(refused).toBeInstanceOf(TooManyImagesToScreenError);
		expect(tooManyImagesMessage(refused.count)).toBe(
			`This file has 41 pictures in it, and we can check up to ${MAX_SCREENED_IMAGES_PER_FILE} in one file, so it wasn't added. Split it into smaller files of up to ${MAX_SCREENED_IMAGES_PER_FILE} pictures and add each one.`
		);
	});

	it("refuses loudly when guard-primary is on and no endpoint is configured, never a silent pass", async () => {
		await expect(
			screenStoredImages([await png(5)], { enabled: () => true, configured: () => false, logger: quiet })
		).rejects.toBeInstanceOf(ImageScreenUnavailableError);
		expect(quiet.error).toHaveBeenCalled();
	});

	it("makes no call when guard-primary is off, matching chat, whose screen runs under the same flag", async () => {
		const { judge, calls } = judgeAnswering(() => yes);
		await screenStoredImages([await png(6)], { ...on, enabled: () => false, judge });
		expect(calls).toHaveLength(0);
	});
});
