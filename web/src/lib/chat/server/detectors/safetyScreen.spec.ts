// SAFETY_SCREEN picks one detector per value, with no fallback between them. The default is committed
// config keyed by edition: a self-host reads the Qwen3Guard pairing, everything else reads Shieldstral.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCREEN_DEFAULT, SHIELDSTRAL_PAIRED_RULES } from "../../../../../config/safetyScreen";
import { loadGuardPolicy } from "$lib/chat/server/guardPolicy";

const { shield, cfg } = vi.hoisted(() => ({ shield: { judge: vi.fn() }, cfg: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
vi.mock("./shieldstral", async (orig) => {
	const actual = await orig<typeof import("./shieldstral")>();
	return {
		...actual,
		shieldstralJudge: shield.judge,
		shieldstralConfigured: () => Boolean(process.env.GUARD_SHADOW_URL),
	};
});

const { resolveSafetyScreen, safetyScreen, safetyScreenConfigured, safetyScreenModels, screenJudge } = await import("./safetyScreen");
const { QWEN3GUARD_MODEL } = await import("./qwen3guard");

const ctx = () => ({ instruct: "x", opSignal: new AbortController().signal, timeoutMs: 5000, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
const query = (key: string) => loadGuardPolicy()!.entries.find((r) => r.key === key)!.query;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	shield.judge.mockReset();
	delete cfg.ALPHA_EDITION;
});

describe("the default screen by edition", () => {
	it("is the Qwen3Guard pairing on a self-host and Shieldstral otherwise", () => {
		expect(resolveSafetyScreen(undefined, true)).toBe("qwen3guard");
		expect(resolveSafetyScreen("", true)).toBe("qwen3guard");
		expect(resolveSafetyScreen(undefined, false)).toBe("shieldstral");
		expect(SAFETY_SCREEN_DEFAULT).toEqual({ hosted: "shieldstral", selfhost: "qwen3guard" });
	});

	it("reads the edition from ALPHA_EDITION: selfhost gets qwen3guard, hosted and unset get shieldstral", () => {
		vi.stubEnv("SAFETY_SCREEN", "");
		cfg.ALPHA_EDITION = "selfhost";
		expect(safetyScreen()).toBe("qwen3guard");
		cfg.ALPHA_EDITION = "hosted";
		expect(safetyScreen()).toBe("shieldstral");
		delete cfg.ALPHA_EDITION;
		expect(safetyScreen()).toBe("shieldstral");
	});

	it("lets SAFETY_SCREEN override either default, case and space ignored", () => {
		expect(resolveSafetyScreen(" Shieldstral ", true)).toBe("shieldstral");
		expect(resolveSafetyScreen("qwen3guard-only", false)).toBe("qwen3guard-only");
		expect(resolveSafetyScreen("qwen3guard", false)).toBe("qwen3guard");
	});

	it("is an error for an unrecognised value, never a default", () => {
		expect(() => resolveSafetyScreen("qwen", true)).toThrow(/SAFETY_SCREEN="qwen" is not one of/);
	});
});

describe("what each screen needs and which model it expects back", () => {
	it("needs GUARD_SHADOW_URL for shieldstral, both URLs for the pairing, QWEN3GUARD_URL alone for qwen3guard-only", () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		vi.stubEnv("QWEN3GUARD_URL", "");
		vi.stubEnv("SAFETY_SCREEN", "shieldstral");
		expect(safetyScreenConfigured()).toBe(false);
		vi.stubEnv("GUARD_SHADOW_URL", "http://s");
		expect(safetyScreenConfigured()).toBe(true);
		vi.stubEnv("SAFETY_SCREEN", "qwen3guard");
		expect(safetyScreenConfigured()).toBe(false);
		vi.stubEnv("QWEN3GUARD_URL", "http://q");
		expect(safetyScreenConfigured()).toBe(true);
		vi.stubEnv("SAFETY_SCREEN", "qwen3guard-only");
		vi.stubEnv("GUARD_SHADOW_URL", "");
		expect(safetyScreenConfigured()).toBe(true);
	});

	it("expects Qwen3Guard and Shieldstral from the pairing, and one model otherwise", () => {
		vi.stubEnv("SAFETY_SCREEN", "qwen3guard");
		expect(safetyScreenModels()).toContain(QWEN3GUARD_MODEL);
		expect(safetyScreenModels()).toHaveLength(2);
		vi.stubEnv("SAFETY_SCREEN", "qwen3guard-only");
		expect(safetyScreenModels()).toEqual([QWEN3GUARD_MODEL]);
		vi.stubEnv("SAFETY_SCREEN", "shieldstral");
		expect(safetyScreenModels()).toHaveLength(1);
	});
});

describe("the judge dispatches on SAFETY_SCREEN, with no fallback between detectors", () => {
	const text = { kind: "text" as const, text: "hello" };
	const qwenReply = (content: string) =>
		vi.fn(async () => new Response(JSON.stringify({ model: QWEN3GUARD_MODEL, choices: [{ message: { content } }] }), { status: 200 }));

	it("sends every rule to Shieldstral under shieldstral", async () => {
		vi.stubEnv("SAFETY_SCREEN", "shieldstral");
		shield.judge.mockResolvedValue({ answer: { kind: "token", yes: false }, httpOk: true });
		const fetchSpy = qwenReply("Safety: Safe\nCategories: None");
		vi.stubGlobal("fetch", fetchSpy);
		await screenJudge(text, query("chat-block-violence"), 0.5, ctx());
		expect(shield.judge).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends exactly the four paired rules, and every picture rule, to Shieldstral under the pairing", async () => {
		vi.stubEnv("SAFETY_SCREEN", "qwen3guard");
		vi.stubEnv("QWEN3GUARD_URL", "http://q");
		shield.judge.mockResolvedValue({ answer: { kind: "token", yes: false }, httpOk: true });
		vi.stubGlobal("fetch", qwenReply("Safety: Safe\nCategories: None"));
		const rules = loadGuardPolicy()!.entries.map((r) => r.key);
		for (const key of rules) await screenJudge({ kind: "text", text: `t-${key}` }, query(key), 0.5, ctx());
		const asked = shield.judge.mock.calls.map((c) => c[1]);
		expect(new Set(asked)).toEqual(new Set(SHIELDSTRAL_PAIRED_RULES.map(query)));
		await screenJudge({ kind: "image", image: {} as never }, query("chat-block-violence"), 0.5, ctx());
		expect(shield.judge).toHaveBeenCalledTimes(SHIELDSTRAL_PAIRED_RULES.length + 1);
	});

	it("answers every rule from Qwen3Guard and none from Shieldstral under qwen3guard-only, and a picture is unknown", async () => {
		vi.stubEnv("SAFETY_SCREEN", "qwen3guard-only");
		vi.stubEnv("QWEN3GUARD_URL", "http://q");
		const fetchSpy = qwenReply("Safety: Unsafe\nCategories: Violent");
		vi.stubGlobal("fetch", fetchSpy);
		const o = await screenJudge(text, query("chat-block-violence"), 0.5, ctx());
		expect(o.answer).toEqual({ kind: "token", yes: true });
		const img = await screenJudge({ kind: "image", image: {} as never }, query("chat-block-violence"), 0.5, ctx());
		expect(img.answer).toEqual({ kind: "unknown" });
		expect(shield.judge).not.toHaveBeenCalled();
	});

	it("answers unknown, and says why, for an unrecognised SAFETY_SCREEN", async () => {
		vi.stubEnv("SAFETY_SCREEN", "bogus");
		const c = ctx();
		const o = await screenJudge(text, query("chat-block-violence"), 0.5, c);
		expect(o.answer).toEqual({ kind: "unknown" });
		expect(c.log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("SAFETY_SCREEN"));
		expect(shield.judge).not.toHaveBeenCalled();
	});
});
