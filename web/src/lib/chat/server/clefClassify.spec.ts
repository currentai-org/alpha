import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLEF_MAX_CHARS,
	CLEF_READS_PER_MINUTE,
	ClefError,
	__resetClefReadsForTest,
	classifyWithClef,
	clefLanguageOf,
	clefFetch,
	takeClefRead,
} from "./clefClassify";
import { lookup, record } from "./endpoints/openai/replayStore";
import { clefRoutingEnabled } from "./clefRoutingGate";
import { __resetFlagsForTest } from "./flags";

vi.mock("./endpoints/openai/replayStore", () => ({ lookup: vi.fn(), record: vi.fn(async () => {}) }));

const cfg = { url: "https://router.example/v1/cloudflare", apiKey: "k", model: "clef" };
// Recorded from the router (see routing/clef.spec.ts).
const ANSWERS = {"language":{"type":"choice","choice":"cat","probabilities":{"arb":0.0036,"cat":0.7005,"ces":0.0052,"cmn":0.0044,"dan":0.0038,"deu":0.0055,"ell":0.0043,"eng":0.0113,"eus":0.0056,"fin":0.0044,"fra":0.0057,"glg":0.0321,"hin":0.0039,"hun":0.0037,"ind":0.0041,"ita":0.0063,"jpn":0.004,"kor":0.0034,"mri":0.0038,"nld":0.007,"pol":0.0033,"por":0.0088,"ron":0.0046,"rus":0.0038,"spa":0.09,"swe":0.0039,"swh":0.0028,"tgl":0.0043,"tha":0.0032,"tur":0.0043,"ukr":0.0038,"vie":0.0043,"zlm":0.0034,"other":0.0369},"confidence":0.4869},"size":{"type":"score","score":1.1249,"legend":{"0":"A greeting or a one-line lookup","1":"An everyday request","2":"Analysis, code, or long multi-step work"},"probabilities":{"0":0.0756,"1":0.7239,"2":0.2005},"confidence":0.3549},"skill_web_search":{"type":"noul","noul":0.5544},"skill_code":{"type":"noul","noul":0.0033},"skill_math":{"type":"noul","noul":0.0042},"skill_translation":{"type":"noul","noul":0.0051},"skill_research":{"type":"noul","noul":0.0592},"skill_reasoning":{"type":"noul","noul":0.0306}};

const reply = (status: number, body: unknown) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("classifyWithClef", () => {
	it("posts the draft and the question set to <base>/<model> with the key, and returns a verdict", async () => {
		const fetchImpl = reply(200, { success: true, result: { model: "clef", answers: ANSWERS }, errors: [] });
		const v = await classifyWithClef("Com puc renovar el DNI a València?", cfg, fetchImpl as typeof fetch);
		expect(v).toMatchObject({ model: "clef", language: { value: "cat" }, difficulty: { value: "M" } });

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://router.example/v1/cloudflare/clef");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
		const sent = JSON.parse(String(init.body));
		expect(sent).toMatchObject({ model: "clef", state: "Com puc renovar el DNI a València?" });
		expect(Object.keys(sent.questions)).toContain("language");
	});

	it("sends only the first CLEF_MAX_CHARS of a long draft", async () => {
		const fetchImpl = reply(200, { success: true, result: { model: "clef", answers: ANSWERS } });
		await classifyWithClef("x".repeat(CLEF_MAX_CHARS * 2), cfg, fetchImpl as typeof fetch);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body)).state).toHaveLength(CLEF_MAX_CHARS);
	});

	it("fails loud (502) on a Clef error body instead of returning an empty verdict", async () => {
		const fetchImpl = reply(200, { success: false, result: {}, errors: [{ message: "Unsupported model" }] });
		await expect(classifyWithClef("hello there friend", cfg, fetchImpl as typeof fetch)).rejects.toMatchObject({
			status: 502,
		});
	});

	it("reports a timeout as 504", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new DOMException("timed out", "TimeoutError");
		});
		const err = await classifyWithClef("hello there friend", cfg, fetchImpl as typeof fetch).catch((e) => e);
		expect(err).toBeInstanceOf(ClefError);
		expect(err.status).toBe(504);
	});
});

describe("takeClefRead: per-session draft-read allowance", () => {
	beforeEach(() => __resetClefReadsForTest());

	it("allows CLEF_READS_PER_MINUTE reads a minute per session, then refuses until the window passes", () => {
		const t = 1_000_000;
		for (let i = 0; i < CLEF_READS_PER_MINUTE; i++) expect(takeClefRead("s1", t + i)).toBe(true);
		expect(takeClefRead("s1", t + 100)).toBe(false);
		expect(takeClefRead("s2", t + 100)).toBe(true);
		expect(takeClefRead("s1", t + 60_001)).toBe(true);
	});
});

describe("clef-routing fails closed", () => {
	beforeEach(() => __resetFlagsForTest());

	it("is off while no flag snapshot exists, so no draft leaves the device", () => {
		expect(clefRoutingEnabled()).toBe(false);
	});
});

// A scenario run's draft reads go through the model replay store, so CI's reads stop spending
// the Clef quota real visitors share. The key is the whole request, so a changed question set or a
// different model misses and goes live, the same contract as a model answer. (SOL-201)
describe("clefFetch: Clef reads replay in scenario runs (SOL-201)", () => {
	const ok = { success: true, result: { model: "clef", answers: ANSWERS }, errors: [] };

	beforeEach(() => {
		vi.mocked(lookup).mockReset();
		vi.mocked(record).mockClear();
	});

	it("is the live fetch, untouched, when the request asked for no replay", () => {
		const live = reply(200, ok) as unknown as typeof fetch;
		expect(clefFetch(null, live)).toBe(live);
	});

	it("fails a none-mode miss as a ClefError and makes no live call", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		const live = reply(200, ok);
		const err = await classifyWithClef("hello there friend", cfg, clefFetch("none", live as typeof fetch)).catch((e) => e);
		expect(err).toBeInstanceOf(ClefError);
		expect(live).not.toHaveBeenCalled();
	});

	it("answers from a stored recording with no live call", async () => {
		vi.mocked(lookup).mockResolvedValue({
			scope: "develop",
			cassette: {
				requestHash: "h",
				path: "/v1/cloudflare/clef",
				host: "router.example",
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(ok),
				recordedAt: "2026-10-14T00:00:00.000Z",
			},
		});
		const live = reply(200, ok);
		const v = await classifyWithClef("Com puc renovar el DNI a València?", cfg, clefFetch("new_episodes", live as typeof fetch));
		expect(v).toMatchObject({ model: "clef", language: { value: "cat" } });
		expect(live).not.toHaveBeenCalled();
	});

	it("calls Clef live on a new_episodes miss and records the answer", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		const live = reply(200, ok);
		const v = await classifyWithClef("hello there friend", cfg, clefFetch("new_episodes", live as typeof fetch));
		expect(v.model).toBe("clef");
		expect(live).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
		expect(vi.mocked(record).mock.calls[0][0]).toMatchObject({ path: "/v1/cloudflare/clef", host: "router.example", status: 200 });
	});

	// A refusal is kept for ten minutes, so reruns stop spending a quota that is already gone,
	// and it expires on its own so the read goes live again once Clef answers. (CUR-3996)
	it("records a refused read with a ten-minute expiry, so reruns replay the 429 instead of retrying it", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		const live = reply(429, { success: false, result: {}, errors: [{ message: "used up your daily free allocation" }] });
		const before = Date.now();
		const err = await classifyWithClef("hello there friend", cfg, clefFetch("new_episodes", live as typeof fetch)).catch((e) => e);
		expect(err).toBeInstanceOf(ClefError);
		await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
		const doc = vi.mocked(record).mock.calls[0][0];
		expect(doc).toMatchObject({ path: "/v1/cloudflare/clef", status: 429 });
		const ttl = Date.parse(doc.refusedUntil ?? "") - before;
		expect(ttl).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
		expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
	});
});

describe("clefLanguageOf (CUR-2237)", () => {
	const cfg = { url: "https://clef.test/v1", apiKey: "k", model: "clef" };
	const answering = (choice: string, p: number, ok = true) =>
		vi.fn(async (_url: string, _init: RequestInit) =>
			new Response(JSON.stringify({ success: ok, result: { answers: { language: { choice, probabilities: { [choice]: p } } } } }), {
				status: ok ? 200 : 500,
			})
		);

	it("offers the extra languages beside Auto's and returns Clef's sure choice", async () => {
		const f = answering("hau", 0.89);
		expect(await clefLanguageOf("Menene babban birnin Japan?", ["hau", "amh"], cfg, f as unknown as typeof fetch)).toBe("hau");
		const body = JSON.parse(String(f.mock.calls[0][1].body));
		expect(Object.keys(body.questions)).toEqual(["language"]);
		expect(body.questions.language.criteria).toMatchObject({ hau: "Hausa", amh: "Amharic", eng: "English", other: expect.any(String) });
	});

	it("returns null, a real 'not this', when Clef's choice is under the floor", async () => {
		expect(await clefLanguageOf("x", ["hau"], cfg, answering("hau", 0.4) as unknown as typeof fetch)).toBeNull();
	});

	it("returns undefined, 'no read', with no config, an upstream error, or a throw", async () => {
		expect(await clefLanguageOf("x", ["hau"], undefined)).toBeUndefined();
		expect(await clefLanguageOf("x", ["hau"], cfg, answering("hau", 0.9, false) as unknown as typeof fetch)).toBeUndefined();
		const boom = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		expect(await clefLanguageOf("x", ["hau"], cfg, boom as unknown as typeof fetch)).toBeUndefined();
	});
});
