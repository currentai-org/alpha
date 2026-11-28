// Pictures and the adult-content rules. With no known-CSAM hash check, the Shieldstral screen
// is a chat picture's only check, so:
//   • an unanswered `chat-block-sexual` (or any `imageFailsClosed` rule) on a PICTURE refuses the turn as
//     couldn't-check, while the same unanswered rule on TEXT keeps the content fail-open;
//   • `chat-block-sexual-nudity-image` is asked on pictures only, never on a text chunk;
//   • ADULT_CONTENT_SCREEN=off on a self-host drops both adult rules (and so the image fail-closed), is
//     ignored on any other edition, and never drops a child-safety rule.
// Every screen runs the real rules.json through an injected judge; no picture bytes are real.
import { describe, it, expect, vi, afterEach } from "vitest";
import { getGuardVerdict, runGuardScreen, rulesForScreen, adultContentScreenOff } from "./guardGate";
import { loadGuardPolicy, type GuardRule } from "./guardPolicy";
import { validateGuardPolicy } from "./guardPolicyCore.mjs";
import type { GuardScreenInput, JudgeFn, JudgeTarget, PreparedImage } from "./guardScreenTypes";

vi.mock("$lib/chat/server/db/guardDailyCounts", () => ({ countGuardHitsSafe: vi.fn() }));

const SEXUAL = "chat-block-sexual";
const NUDITY = "chat-block-sexual-nudity-image";
const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const policy = () => loadGuardPolicy()!;

const img = (): PreparedImage => ({
	sha: "sha-test",
	mime: "image/png",
	source: Buffer.from("not a real picture"),
	screenB64: "QUJD",
	sourceMessageId: "m1",
	caption: "",
});
const pictureTurn = (corpus = ""): GuardScreenInput => ({ corpus, typedTurnText: corpus, images: [img()], failedUnits: [] });
const textTurn = (corpus: string): GuardScreenInput => ({ corpus, typedTurnText: corpus, images: [], failedUnits: [] });

type Answer = "yes" | "no" | "unknown";
/** A judge that answers `answers[ruleKey]` on units of `kind` (or any kind when omitted), "no" otherwise,
 *  and records every (unit kind, rule key) it was asked. */
function judgeWith(answers: Record<string, Answer>, kind?: JudgeTarget["kind"]) {
	const keyByQuery = new Map(policy().entries.map((r) => [r.query, r.key]));
	const asked: Array<[JudgeTarget["kind"], string]> = [];
	const judge = vi.fn<JudgeFn>(async (target, query) => {
		const key = keyByQuery.get(query) ?? "?";
		asked.push([target.kind, key]);
		const a = !kind || target.kind === kind ? (answers[key] ?? "no") : "no";
		if (a === "unknown") return { answer: { kind: "unknown" }, httpOk: true, servedModel: "m" };
		return { answer: { kind: "token", yes: a === "yes" }, httpOk: true, servedModel: "m" };
	});
	return { judge, asked };
}

afterEach(() => vi.unstubAllEnvs());

describe("rules.json carries the image rules the screen reads", () => {
	it("chat-block-sexual fails closed on pictures and is adult content; the nudity rule is image-only, fails closed, and is adult content", () => {
		const sexual = policy().byKey.get(SEXUAL)!;
		const nudity = policy().byKey.get(NUDITY)!;
		expect(sexual).toMatchObject({ tier: "content", action: "block", imageFailsClosed: true, adultContent: true });
		expect(sexual.units).toBeUndefined();
		expect(nudity).toMatchObject({ tier: "content", action: "block", units: ["image"], imageFailsClosed: true, adultContent: true });
	});

	it("no child-safety rule is adult content, so the self-host switch can never reach one", () => {
		for (const r of policy().entries.filter((e) => e.tier === "child")) expect(r.adultContent).toBeUndefined();
	});
});

describe("the validator refuses image-rule fields it cannot enforce", () => {
	const base = (guard: Record<string, unknown>) => ({
		_shield: { instruct: "i", categoryThreshold: 0.5, concurrency: 2, operationDeadlineMs: 20000 },
		"chat-block-child-sexual-content": { guard: { query: "CHILD?", action: "block" } },
		"chat-block-x": { guard: { query: "X?", action: "block", ...guard } },
	});
	it.each([
		[{ units: [] }, "guard.units"],
		[{ units: ["audio"] }, "guard.units"],
		[{ units: ["image", "image"] }, "guard.units"],
		[{ imageFailsClosed: "yes" }, "imageFailsClosed"],
		[{ units: ["text"], imageFailsClosed: true }, "imageFailsClosed"],
		[{ adultContent: 1 }, "adultContent"],
	])("refuses %j", (guard, field) => {
		const { errors } = validateGuardPolicy(base(guard));
		expect(errors.join("\n")).toContain(field);
	});
	it("refuses adultContent on a child-safety rule", () => {
		const { errors } = validateGuardPolicy({
			...base({}),
			"chat-block-child-grooming": { guard: { query: "G?", action: "block", adultContent: true } },
		});
		expect(errors.join("\n")).toContain("child safety is never switchable");
	});
	it("accepts units, imageFailsClosed and adultContent on a content rule", () => {
		const { errors, entries } = validateGuardPolicy(base({ units: ["image"], imageFailsClosed: true, adultContent: true }));
		expect(errors).toEqual([]);
		expect(entries.find((e) => e.key === "chat-block-x")).toMatchObject({ units: ["image"], imageFailsClosed: true, adultContent: true });
	});
});

describe("an unanswered chat-block-sexual refuses a picture and still allows text", () => {
	it("a picture whose chat-block-sexual check went unanswered is declined as couldn't-check", async () => {
		const { judge } = judgeWith({ [SEXUAL]: "unknown" }, "image");
		const v = await getGuardVerdict(pictureTurn(), { judge, logger: quiet() });
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
		expect(v.hits).toEqual([]);
	});

	it("a picture whose nudity check went unanswered is declined as couldn't-check", async () => {
		const { judge } = judgeWith({ [NUDITY]: "unknown" }, "image");
		const v = await getGuardVerdict(pictureTurn(), { judge, logger: quiet() });
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
	});

	it("the same unanswered chat-block-sexual on text fails open, as every content rule on text does", async () => {
		const { judge } = judgeWith({ [SEXUAL]: "unknown" }, "text");
		const v = await getGuardVerdict(textTurn("what is the capital of France"), { judge, logger: quiet() });
		expect(v.verdict.status).toBe("unknown");
		expect(v.childSafety).toEqual({ flagged: false });
		expect(v.contentPolicy).toEqual({ action: "allow" });
	});

	it("an unanswered content rule without imageFailsClosed on a picture still fails open", async () => {
		const { judge } = judgeWith({ "chat-block-drugs": "unknown" }, "image");
		const v = await getGuardVerdict(pictureTurn(), { judge, logger: quiet() });
		expect(v.childSafety).toEqual({ flagged: false });
		expect(v.contentPolicy).toEqual({ action: "allow" });
	});

	it("a picture the nudity rule answers yes to gets the sexual-content decline", async () => {
		const { judge } = judgeWith({ [NUDITY]: "yes" }, "image");
		const v = await getGuardVerdict(pictureTurn(), { judge, logger: quiet() });
		expect(v.contentPolicy).toEqual({ action: "block", category: NUDITY });
	});
});

describe("the nudity rule is asked on pictures only", () => {
	it("a turn with text and a picture asks the nudity rule once, on the picture, and every other rule on both", async () => {
		const { judge, asked } = judgeWith({});
		const s = await runGuardScreen(pictureTurn("hello there"), { judge, logger: quiet() });
		expect(s.status).toBe("safe");
		expect(asked.filter(([, k]) => k === NUDITY)).toEqual([["image", NUDITY]]);
		expect(asked.filter(([, k]) => k === SEXUAL).map(([kind]) => kind).sort()).toEqual(["image", "text"]);
	});

	it("a text-only turn never asks the nudity rule", async () => {
		const { judge, asked } = judgeWith({});
		await runGuardScreen(textTurn("hello there"), { judge, logger: quiet() });
		expect(asked.some(([, k]) => k === NUDITY)).toBe(false);
		expect(asked.some(([, k]) => k === SEXUAL)).toBe(true);
	});
});

describe("ADULT_CONTENT_SCREEN: on by default, a self-host may switch it off, child safety never", () => {
	const keys = (rules: GuardRule[]) => rules.map((r) => r.key);

	it("default (unset): both adult rules are asked on a self-host and on a hosted edition", () => {
		for (const edition of ["selfhost", "hosted", ""]) {
			vi.stubEnv("ALPHA_EDITION", edition);
			vi.stubEnv("ADULT_CONTENT_SCREEN", "");
			expect(adultContentScreenOff()).toBe(false);
			expect(keys(rulesForScreen(policy().entries, {}))).toEqual(expect.arrayContaining([SEXUAL, NUDITY]));
		}
	});

	it("off on a self-host drops both adult rules and keeps every child-safety rule", () => {
		vi.stubEnv("ALPHA_EDITION", "selfhost");
		vi.stubEnv("ADULT_CONTENT_SCREEN", "off");
		expect(adultContentScreenOff()).toBe(true);
		for (const screen of ["input", "output"] as const) {
			const asked = keys(rulesForScreen(policy().entries, { screen }));
			expect(asked).not.toContain(SEXUAL);
			expect(asked).not.toContain(NUDITY);
			expect(asked).toEqual(expect.arrayContaining(["chat-block-child-sexual-content", "chat-block-child-grooming"]));
		}
	});

	it("off on a self-host: an unanswered picture check no longer refuses, and the nudity rule is never asked", async () => {
		vi.stubEnv("ALPHA_EDITION", "selfhost");
		vi.stubEnv("ADULT_CONTENT_SCREEN", "off");
		const { judge, asked } = judgeWith({ [SEXUAL]: "unknown", [NUDITY]: "unknown" }, "image");
		const v = await getGuardVerdict(pictureTurn(), { judge, logger: quiet() });
		expect(v.childSafety).toEqual({ flagged: false });
		expect(v.contentPolicy).toEqual({ action: "allow" });
		expect(asked.some(([, k]) => k === SEXUAL || k === NUDITY)).toBe(false);
		expect(asked.some(([, k]) => k === "chat-block-child-sexual-content")).toBe(true);
	});

	it("off on a self-host: an unanswered child-safety check on a picture still refuses it", async () => {
		vi.stubEnv("ALPHA_EDITION", "selfhost");
		vi.stubEnv("ADULT_CONTENT_SCREEN", "off");
		const { judge } = judgeWith({ "chat-block-child-sexual-content": "unknown" }, "image");
		const v = await getGuardVerdict(pictureTurn(), { judge, logger: quiet() });
		expect(v.childSafety).toEqual({ flagged: true, unscreened: true });
	});

	it("off on a hosted or unset edition is ignored and both adult rules still run", () => {
		for (const edition of ["hosted", ""]) {
			vi.stubEnv("ALPHA_EDITION", edition);
			vi.stubEnv("ADULT_CONTENT_SCREEN", "off");
			const log = quiet();
			expect(adultContentScreenOff(log)).toBe(false);
			expect(keys(rulesForScreen(policy().entries, {}))).toEqual(expect.arrayContaining([SEXUAL, NUDITY]));
		}
	});
});
