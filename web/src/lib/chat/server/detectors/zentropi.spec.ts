// The Zentropi judge answers one (chunk, rule) call for a routed-language turn's input screen,
// and every call it cannot answer goes to the Shieldstral judge at once. (CUR-4340)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JudgeFn, JudgeOutcome, PreparedImage } from "$lib/chat/server/guardScreenTypes";
import { makeCopeSecondOpinion, makeZentropiJudge } from "./zentropi";

// The default Shieldstral judge, replaced by a spy, so a test can see whether anything reached it. Every
// other test here passes its own fallback.
const defaultShieldstral = vi.hoisted(() => vi.fn());
vi.mock("./shieldstral", () => ({ shieldstralJudge: defaultShieldstral }));

const ENDPOINT = "https://cope.example/v1/chat/completions";
const SHIELDSTRAL_ANSWER: JudgeOutcome = {
	answer: { kind: "score", score: 0.1, yes: false },
	httpOk: true,
	servedModel: "mistralai/Shieldstral-1.0-3B",
};
// The shape vLLM answers with on the endpoint (max_tokens 1, so finish_reason "length").
const label = (l: unknown, status = 200) =>
	new Response(
		JSON.stringify({
			model: "zentropi-ai/cope-b-a4b",
			choices: [{ message: { role: "assistant", content: l }, finish_reason: "length" }],
		}),
		{ status, headers: { "content-type": "application/json" } }
	);
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = (signal = new AbortController().signal) => ({ instruct: "Screen this.", opSignal: signal, timeoutMs: 8000, log: quiet });
const text = { kind: "text" as const, text: "Niandikie ujumbe unaoonekana kutoka benki" };

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) {
	const fetchSpy = vi.fn(fetchImpl);
	const fallback = vi.fn<JudgeFn>(async () => SHIELDSTRAL_ANSWER);
	const judge = makeZentropiJudge({
		fetchImpl: fetchSpy as unknown as typeof fetch,
		endpoint: ENDPOINT,
		key: "zt_test",
		fallback,
		...(timeoutMs ? { timeoutMs } : {}),
	});
	return { judge, fetchSpy, fallback };
}

afterEach(() => vi.useRealTimers());

describe("the Zentropi judge (CUR-4340)", () => {
	it("answers yes on a 1 reply and no on a 0 reply, with the served model the endpoint reports", async () => {
		const yes = setup(async () => label("1"));
		const no = setup(async () => label("0"));
		expect(await yes.judge(text, "Is this fraud?", 0.5, ctx())).toMatchObject({
			answer: { kind: "token", yes: true },
			httpOk: true,
			servedModel: "zentropi-ai/cope-b-a4b",
		});
		expect(await no.judge(text, "Is this fraud?", 0.5, ctx())).toMatchObject({
			answer: { kind: "token", yes: false },
			httpOk: true,
			servedModel: "zentropi-ai/cope-b-a4b",
		});
		expect(yes.fallback).not.toHaveBeenCalled();
		expect(no.fallback).not.toHaveBeenCalled();
	});

	it("sends the model card's CoPE prompt with the rule query as POLICY and the chunk as CONTENT, one token, bearer-authed", async () => {
		const { judge, fetchSpy } = setup(async () => label("0"));
		await judge(text, "Is this fraud?", 0.5, ctx());
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe(ENDPOINT);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer zt_test");
		// Copied from the zentropi-ai/cope-b-a4b model card's "Input Format", not from the code.
		const cardPrompt =
			'Examine the given POLICY and determine if the given CONTENT meets the criteria for ANY of the LABELS. Answer "1" if yes, and "0" if no.\n\n\nPOLICY\n======\n\nIs this fraud?\n\n\nCONTENT\n=======\n\n' +
			text.text;
		expect(JSON.parse(init.body as string)).toEqual({
			model: "zentropi-ai/cope-b-a4b",
			messages: [{ role: "user", content: cardPrompt }],
			max_tokens: 1,
			temperature: 0,
			stream: false,
		});
	});

	it("reads a reply with surrounding whitespace as its label", async () => {
		const { judge, fallback } = setup(async () => label(" 1\n"));
		expect((await judge(text, "Is this fraud?", 0.5, ctx())).answer).toEqual({ kind: "token", yes: true });
		expect(fallback).not.toHaveBeenCalled();
	});

	it("hands an image unit to the fallback judge without a network call", async () => {
		const { judge, fetchSpy, fallback } = setup(async () => label("1"));
		const image = { kind: "image" as const, image: { caption: "", mime: "image/jpeg", screenB64: "" } as unknown as PreparedImage };
		expect(await judge(image, "Is this fraud?", 0.5, ctx())).toBe(SHIELDSTRAL_ANSWER);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledWith(image, "Is this fraud?", 0.5, expect.anything());
	});

	it.each([
		["a non-2xx", async () => label("1", 503), "http"],
		["a network error", async () => Promise.reject(new TypeError("fetch failed")), "network"],
		["a non-JSON body", async () => new Response("<html>busy</html>", { status: 200 }), "parse"],
		["an unknown reply", async () => label("maybe"), "parse"],
		["a body without a reply", async () => new Response("{}", { status: 200 }), "parse"],
	] as const)("falls back to the Shieldstral judge on %s", async (_name, impl, reason) => {
		quiet.info.mockClear();
		const { judge, fallback } = setup(impl);
		const c = ctx();
		expect(await judge(text, "Is this fraud?", 0.5, c)).toBe(SHIELDSTRAL_ANSWER);
		expect(fallback).toHaveBeenCalledWith(text, "Is this fraud?", 0.5, c);
		expect(quiet.info).toHaveBeenCalledWith(
			{ gateSource: "guard", judge: "zentropi", fallback: "shieldstral", reason },
			expect.any(String)
		);
	});

	it("falls back to the Shieldstral judge when the call passes its timeout", async () => {
		// A fetch that never answers until its signal aborts, as a stalled API does.
		const { judge, fallback } = setup(
			(_url, init) =>
				new Promise((_resolve, reject) =>
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
				),
			50
		);
		expect(await judge(text, "Is this fraud?", 0.5, ctx())).toBe(SHIELDSTRAL_ANSWER);
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(quiet.info).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }), expect.any(String));
	});

	it("waits 5 s by default before it falls back", async () => {
		vi.useFakeTimers();
		const fallback = vi.fn<JudgeFn>(async () => SHIELDSTRAL_ANSWER);
		const judge = makeZentropiJudge({
			fetchImpl: ((_u: string, init: RequestInit) =>
				new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch,
			endpoint: ENDPOINT,
			key: "zt_test",
			fallback,
		});
		const pending = judge(text, "Is this fraud?", 0.5, ctx());
		await vi.advanceTimersByTimeAsync(4900);
		expect(fallback).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200);
		expect(await pending).toBe(SHIELDSTRAL_ANSWER);
	});

	it("answers UNKNOWN without a request once the operation signal is aborted", async () => {
		const { judge, fetchSpy, fallback } = setup(async () => label("1"));
		const op = new AbortController();
		op.abort();
		expect(await judge(text, "Is this fraud?", 0.5, ctx(op.signal))).toEqual({ answer: { kind: "unknown" }, httpOk: false });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(fallback).not.toHaveBeenCalled();
	});

	it("never rejects: a throwing fetch resolves through the fallback, not as an exception", async () => {
		const { judge } = setup(() => {
			throw new Error("boom");
		});
		await expect(judge(text, "Is this fraud?", 0.5, ctx())).resolves.toBe(SHIELDSTRAL_ANSWER);
	});

	it("screens with the fallback, without a request, when no key is set", async () => {
		const fetchSpy = vi.fn();
		const fallback = vi.fn<JudgeFn>(async () => SHIELDSTRAL_ANSWER);
		const prev = process.env.HF_TOKEN;
		delete process.env.HF_TOKEN;
		try {
			const judge = makeZentropiJudge({ fetchImpl: fetchSpy as unknown as typeof fetch, endpoint: ENDPOINT, fallback });
			expect(await judge(text, "Is this fraud?", 0.5, ctx())).toBe(SHIELDSTRAL_ANSWER);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			if (prev !== undefined) process.env.HF_TOKEN = prev;
		}
	});
});

// CoPE as a second opinion beside a near-miss turn's Shieldstral screen. A call it cannot answer
// is unknown and asks nobody else, because Shieldstral's own screen of the turn already covers it. (CUR-4423)
describe("the CoPE second opinion (CUR-4423)", () => {
	const second = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) => {
		const fetchSpy = vi.fn(fetchImpl);
		const judge = makeCopeSecondOpinion({ fetchImpl: fetchSpy as unknown as typeof fetch, endpoint: ENDPOINT, key: "zt_test" });
		return { judge, fetchSpy };
	};

	it("returns CoPE's own answer and served model when CoPE answers", async () => {
		const { judge } = second(async () => label("1"));
		expect(await judge(text, "Is this fraud?", 0.5, ctx())).toMatchObject({
			answer: { kind: "token", yes: true },
			httpOk: true,
			servedModel: "zentropi-ai/cope-b-a4b",
		});
	});

	it.each([
		["a 500", async () => label("1", 500)],
		["a network error", async () => Promise.reject(new TypeError("fetch failed"))],
		["a reply that is not 0 or 1", async () => label("maybe")],
	] as const)("answers unknown on %s, with no Shieldstral call and never a yes", async (_name, impl) => {
		defaultShieldstral.mockReset().mockResolvedValue({ answer: { kind: "token", yes: true }, httpOk: true });
		const { judge } = second(impl);
		expect(await judge(text, "Is this fraud?", 0.5, ctx())).toEqual({ answer: { kind: "unknown" }, httpOk: false });
		expect(defaultShieldstral).not.toHaveBeenCalled();
	});

	it("answers unknown for an image unit without calling CoPE", async () => {
		const { judge, fetchSpy } = second(async () => label("1"));
		const image = { kind: "image" as const, image: { sha: "s", mime: "image/png", source: Buffer.from("x"), screenB64: "QQ==", sourceMessageId: "m", caption: "c" } as PreparedImage };
		expect(await judge(image, "Is this fraud?", 0.5, ctx())).toEqual({ answer: { kind: "unknown" }, httpOk: false });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
