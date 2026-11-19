// The Mila suicide-prevention detector scores a finished answer: windows cut by the endpoint's tokenizer,
// one batched predict per 32 windows, the highest sigmoid against the threshold. Every check it cannot
// finish is `unknown`, and `unknown` never flags (fail open).
import { afterEach, describe, expect, it, vi } from "vitest";
import { MILA_SP_MAX_BATCH, MILA_SP_WINDOW_TOKENS, cutWindows, milaSpScore, sigmoid } from "./milaSp";

const BASE = "https://mila.example";
const UNSAFE_LOGIT = 2.0; // sigmoid ≈ 0.88
const SAFE_LOGIT = -3.66; // the endpoint's score for a safe English reply, sigmoid ≈ 0.025

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** TEI's `/tokenize` shape: one token per word with its leading whitespace, start/stop as UTF-8 byte offsets. */
function tokenize(text: string) {
	const enc = new TextEncoder();
	const tokens: Array<{ id: number; text: string; special: boolean; start: number; stop: number }> = [];
	for (const m of text.matchAll(/\s*\S+/g)) {
		const start = enc.encode(text.slice(0, m.index)).length;
		tokens.push({ id: 1, text: m[0], special: false, start, stop: start + enc.encode(m[0]).length });
	}
	return [tokens];
}

type PredictBody = { inputs: string[][]; raw_scores: boolean };

/** A fake endpoint: a window holding UNSAFE scores unsafe, anything else safe. */
function endpoint(opts: { predict?: (body: PredictBody) => Response | Promise<Response> } = {}) {
	const predictBodies: PredictBody[] = [];
	const tokenizeBodies: unknown[] = [];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		if (url === `${BASE}/tokenize`) {
			tokenizeBodies.push(body);
			return json(tokenize(body.inputs));
		}
		if (url === `${BASE}/predict`) {
			predictBodies.push(body);
			if (opts.predict) return opts.predict(body);
			return json(body.inputs.map(([w]: string[]) => [{ score: w.includes("UNSAFE") ? UNSAFE_LOGIT : SAFE_LOGIT, label: "LABEL_0" }]));
		}
		return json({ error: "not found" }, 404);
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, spy: fetchImpl, predictBodies, tokenizeBodies };
}

const words = (n: number, word = "word") => Array.from({ length: n }, () => word).join(" ");

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("sigmoid and the threshold", () => {
	it("turns the raw logit into p(unsafe)", () => {
		expect(sigmoid(0)).toBe(0.5);
		expect(sigmoid(SAFE_LOGIT)).toBeCloseTo(0.025, 3);
		expect(sigmoid(UNSAFE_LOGIT)).toBeCloseTo(0.881, 3);
	});

	it("flags an answer whose p(unsafe) is exactly the threshold (label 1 at p >= 0.5)", async () => {
		const ep = endpoint({ predict: () => json([[{ score: 0, label: "LABEL_0" }]]) });
		expect(await milaSpScore("Some reply.", undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" })).toEqual({
			verdict: "unsafe",
			score: 0.5,
		});
	});

	it("passes an answer just under the threshold", async () => {
		const ep = endpoint({ predict: () => json([[{ score: -0.01, label: "LABEL_0" }]]) });
		const res = await milaSpScore("Some reply.", undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" });
		expect(res.verdict).toBe("safe");
	});
});

describe("windows from the tokenizer's byte offsets", () => {
	it("slices accented French by UTF-8 byte offsets, not string indices", () => {
		const text = "Il a été là, très bien.";
		const [tokens] = tokenize(text);
		expect(cutWindows(text, tokens)).toEqual([text]);
		// One token per window, to see each slice land on its word.
		const singles = tokens.map((t) => cutWindows(text, [t])[0]);
		expect(singles).toEqual(["Il", " a", " été", " là,", " très", " bien."]);
	});

	it("keeps a 510-token answer in one window and puts token 511 in the next, each token in exactly one window", () => {
		const exact = words(MILA_SP_WINDOW_TOKENS);
		expect(cutWindows(exact, tokenize(exact)[0])).toHaveLength(1);
		const over = `${words(MILA_SP_WINDOW_TOKENS)} last`;
		const windows = cutWindows(over, tokenize(over)[0]);
		expect(windows).toHaveLength(2);
		expect(tokenize(windows[0])[0]).toHaveLength(MILA_SP_WINDOW_TOKENS);
		expect(windows[1]).toBe(" last");
		expect(windows.join("")).toBe(over);
	});

	it("sends the answer to /tokenize without special tokens and each window as its own input", async () => {
		const ep = endpoint();
		const text = `${words(MILA_SP_WINDOW_TOKENS)} ${words(10, "tail")}`;
		await milaSpScore(text, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" });
		expect(ep.tokenizeBodies).toEqual([{ inputs: text, add_special_tokens: false }]);
		expect(ep.predictBodies).toHaveLength(1);
		expect(ep.predictBodies[0].raw_scores).toBe(true);
		// [[w1], [w2]], never a flat [w1, w2], which TEI reads as one sentence pair.
		expect(ep.predictBodies[0].inputs).toEqual([[words(MILA_SP_WINDOW_TOKENS)], [` ${words(10, "tail")}`]]);
		const [, init] = ep.spy.mock.calls[0];
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
	});

	it("flags unsafe text that is only in a later window, scoring the answer by its highest window", async () => {
		const ep = endpoint();
		const text = `${words(MILA_SP_WINDOW_TOKENS * 2)} UNSAFE`;
		const res = await milaSpScore(text, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" });
		expect(ep.predictBodies[0].inputs).toHaveLength(3);
		expect(res).toEqual({ verdict: "unsafe", score: sigmoid(UNSAFE_LOGIT) });
	});
});

describe("batches", () => {
	it("sends at most 32 windows per predict call and scores every window across the calls", async () => {
		const ep = endpoint();
		const windowsWanted = MILA_SP_MAX_BATCH + 3;
		const text = `${words(MILA_SP_WINDOW_TOKENS * (windowsWanted - 1))} UNSAFE`;
		const res = await milaSpScore(text, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" });
		expect(ep.predictBodies.map((b) => b.inputs.length)).toEqual([MILA_SP_MAX_BATCH, 3]);
		// The unsafe window is the 35th, in the second call.
		expect(res.verdict).toBe("unsafe");
	});

	it("passes a long answer whose every window is safe", async () => {
		const ep = endpoint();
		const res = await milaSpScore(words(MILA_SP_WINDOW_TOKENS * 3), undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" });
		expect(res).toEqual({ verdict: "safe", score: sigmoid(SAFE_LOGIT) });
	});
});

describe("fail open: a check it cannot finish is unknown, never unsafe", () => {
	const unsafeText = "UNSAFE reply";

	it("is unknown (fail open, no request) when HF_TOKEN is unset", async () => {
		vi.stubEnv("HF_TOKEN", "");
		const ep = endpoint();
		expect(await milaSpScore(unsafeText, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE })).toEqual({
			verdict: "unknown",
			reason: "config",
		});
		expect(ep.spy).not.toHaveBeenCalled();
	});

	it("is unknown (fail open) on a 500 from predict", async () => {
		const ep = endpoint({ predict: () => json({ error: "boom" }, 500) });
		expect(await milaSpScore(unsafeText, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" })).toEqual({
			verdict: "unknown",
			reason: "http",
		});
	});

	it("is unknown (fail open) when one of several predict calls fails", async () => {
		let calls = 0;
		const ep = endpoint({
			predict: (body) =>
				++calls === 2 ? json({ error: "boom" }, 503) : json(body.inputs.map(() => [{ score: UNSAFE_LOGIT, label: "LABEL_0" }])),
		});
		const text = words(MILA_SP_WINDOW_TOKENS * (MILA_SP_MAX_BATCH + 1));
		expect((await milaSpScore(text, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" })).verdict).toBe("unknown");
	});

	it("is unknown (fail open) when the whole check passes its one time budget", async () => {
		const ep = endpoint({
			predict: (body) =>
				new Promise<Response>((resolve) =>
					setTimeout(() => resolve(json(body.inputs.map(() => [{ score: UNSAFE_LOGIT, label: "LABEL_0" }]))), 200)
				),
		});
		// The fake ignores the abort signal, so wrap it in one that honours it, as real fetch does.
		const honouring = (async (url: string, init: RequestInit) =>
			Promise.race([
				ep.fetchImpl(url, init),
				new Promise<never>((_, reject) => {
					if (init.signal) init.signal.onabort = () => reject(init.signal?.reason);
				}),
			])) as unknown as typeof fetch;
		expect(await milaSpScore(unsafeText, undefined, { fetchImpl: honouring, apiBase: BASE, key: "k", timeoutMs: 20 })).toEqual({
			verdict: "unknown",
			reason: "timeout",
		});
	});

	it("is unknown (fail open) when the caller's signal aborts", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			init.signal?.throwIfAborted();
			return json([]);
		}) as unknown as typeof fetch;
		expect((await milaSpScore(unsafeText, ctrl.signal, { fetchImpl, apiBase: BASE, key: "k" })).verdict).toBe("unknown");
	});

	it("is unknown (fail open) on a network error", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		expect(await milaSpScore(unsafeText, undefined, { fetchImpl, apiBase: BASE, key: "k" })).toEqual({
			verdict: "unknown",
			reason: "network",
		});
	});

	it("is unknown (fail open) on a predict body that is not one score per input", async () => {
		for (const body of [{ error: "x" }, [[{ label: "LABEL_0" }]], [[{ score: "high" }]], "not json"]) {
			const ep = endpoint({
				predict: () =>
					typeof body === "string" ? new Response(body, { status: 200 }) : json(body),
			});
			expect(await milaSpScore(unsafeText, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" })).toEqual({
				verdict: "unknown",
				reason: "parse",
			});
		}
	});

	it("is unknown (fail open) on a tokenize body that is not one input's byte offsets", async () => {
		for (const body of [{ error: "x" }, [[{ start: 0 }]], [[{ start: 0, stop: 999 }]], [[]]]) {
			const fetchImpl = (async () => json(body)) as unknown as typeof fetch;
			expect(await milaSpScore(unsafeText, undefined, { fetchImpl, apiBase: BASE, key: "k" })).toEqual({
				verdict: "unknown",
				reason: "parse",
			});
		}
	});

	it("is unknown (fail open) when predict returns fewer results than windows", async () => {
		const ep = endpoint({ predict: () => json([[{ score: UNSAFE_LOGIT, label: "LABEL_0" }]]) });
		const text = words(MILA_SP_WINDOW_TOKENS * 2);
		expect(await milaSpScore(text, undefined, { fetchImpl: ep.fetchImpl, apiBase: BASE, key: "k" })).toEqual({
			verdict: "unknown",
			reason: "count",
		});
	});
});
