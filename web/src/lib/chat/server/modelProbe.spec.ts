import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Endpoint, EndpointParameters, TextGenerationStreamOutputSimplified } from "./endpoints/types";

const busy = vi.hoisted(() => ({
	noteFailed: vi.fn(async () => ({ consecutiveFailures: 1, updatedAt: new Date() })),
	noteAnswered: vi.fn(async () => {}),
}));
vi.mock("$lib/chat/server/modelBusy", () => busy);
vi.mock("$lib/chat/server/db/client", () => ({ getDb: () => ({}) }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("$lib/chat/server/turnDeadlines", () => ({ firstTokenDeadlineMs: () => 45_000 }));

const { PROBE_EVERY_MINUTES, countsAsDown, dueThisMinute, probeAndRecord, probeModel } = await import("./modelProbe");
const { NoFirstChunkError } = await import("./endpoints/failover");

const MODEL = "swiss-ai/apertus-v1.5-70b";
const chunk = (text: string, extra: Partial<TextGenerationStreamOutputSimplified> = {}) =>
	({ token: { id: 1, text, logprob: 0, special: false }, generated_text: null, details: null, ...extra }) as TextGenerationStreamOutputSimplified;

function target(endpoint: Endpoint) {
	const getEndpoint = vi.fn(async () => endpoint);
	return { model: { id: MODEL, getEndpoint }, getEndpoint };
}
const answering =
	(served?: string): Endpoint =>
	async () =>
		(async function* () {
			yield chunk("Hi", served ? { routerMetadata: { model: served } } : {});
			yield chunk(" there");
		})();
const throwing =
	(status: number): Endpoint =>
	async () => {
		throw Object.assign(new Error(`${status}`), { status });
	};
/** Accepts the call and sends nothing until aborted, as a stalled host does. */
const silent: Endpoint = (p: EndpointParameters) =>
	new Promise((_, reject) => p.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

beforeEach(() => {
	busy.noteFailed.mockClear();
	busy.noteAnswered.mockClear();
});

describe("probeModel (CUR-4042)", () => {
	it("answers ok on the model's first chunk and stops reading there", async () => {
		const { model } = target(answering(MODEL));
		const verdict = await probeModel(model);
		expect(verdict).toMatchObject({ ok: true, served: MODEL, identity: "match" });
	});

	it("goes through the model's own endpoint with its busy recording off, so a probe is counted once, by the probe", async () => {
		const { model, getEndpoint } = target(answering());
		await probeModel(model);
		expect(getEndpoint).toHaveBeenCalledWith({ recordBusy: false });
	});

	it("goes red on a 429 from every lane, the failure a visitor on a spent account gets", async () => {
		const { model } = target(throwing(429));
		expect(await probeModel(model)).toMatchObject({ ok: false, reason: "http-429" });
	});

	it("goes red on a lane that sends nothing before the first-token deadline a visitor's turn would get", async () => {
		const { model } = target(silent);
		const verdict = await probeModel(model, { deadlineMs: 30 });
		expect(verdict).toMatchObject({ ok: false, reason: "no-first-chunk-30ms" });
	});

	it("goes red when the model's own lanes give up and a backup serving another model announces itself", async () => {
		const failingOver: Endpoint = async () =>
			(async function* () {
				yield chunk("", { failover: { from: MODEL, to: "zai-org/GLM-5.3", reason: "unavailable" } });
				yield chunk("Hi");
			})();
		const { model } = target(failingOver);
		expect(await probeModel(model)).toMatchObject({ ok: false, reason: "backup-lane:zai-org/GLM-5.3" });
	});

	it("goes red on an empty completion, a lost turn arriving fast", async () => {
		const empty: Endpoint = async () => (async function* () {})();
		const { model } = target(empty);
		expect(await probeModel(model)).toMatchObject({ ok: false, reason: "empty-completion" });
	});

	it("asks every lane to refuse under the every_lane_rate_limited fault, and only then", async () => {
		const seen: EndpointParameters[] = [];
		const recording: Endpoint = async (p) => {
			seen.push(p);
			if (p.rateLimitEveryLane) throw Object.assign(new Error("429"), { status: 429 });
			return answering()(p);
		};
		const { model } = target(recording);
		expect(await probeModel(model, { refuse: true })).toMatchObject({ ok: false, reason: "http-429" });
		expect(await probeModel(model)).toMatchObject({ ok: true });
		expect(seen.map((p) => p.rateLimitEveryLane ?? false)).toEqual([true, false]);
	});

	it("gives no verdict on a 400: our request was refused, which says nothing about whether the model answers", async () => {
		const { model } = target(throwing(400));
		expect(await probeModel(model)).toMatchObject({ ok: null, reason: "http-400" });
	});

	it("counts gateway timeouts, 5xx, the router's 404, dropped connections and a silent last lane as down, and other 4xx as not", () => {
		expect(countsAsDown(Object.assign(new Error(), { status: 504 }))).toBe(true);
		expect(countsAsDown(Object.assign(new Error(), { status: 503 }))).toBe(true);
		expect(countsAsDown(Object.assign(new Error(), { status: 404 }))).toBe(true);
		expect(countsAsDown(new Error("fetch failed"))).toBe(true);
		expect(countsAsDown(new NoFirstChunkError("silent"))).toBe(true);
		expect(countsAsDown(Object.assign(new Error(), { status: 401 }))).toBe(false);
		expect(countsAsDown(Object.assign(new Error(), { status: 400 }))).toBe(false);
	});

	it("goes red on the router's 404 for a model it has no working entry for, so the probe marks it down (CUR-4629)", async () => {
		const { model } = target(throwing(404));
		expect(await probeModel(model)).toMatchObject({ ok: false, reason: "http-404" });
		await probeAndRecord(model);
		expect(busy.noteFailed).toHaveBeenCalledWith(MODEL, undefined, { decisive: true });
	});
});

describe("probeAndRecord (CUR-4042)", () => {
	it("marks the model busy on one failed probe, under the spec's scope when one is given", async () => {
		const { model } = target(throwing(429));
		await probeAndRecord(model, { scope: "run-1" });
		expect(busy.noteFailed).toHaveBeenCalledWith(MODEL, "run-1", { decisive: true });
		expect(busy.noteAnswered).not.toHaveBeenCalled();
	});

	it("clears the mark on an answered probe", async () => {
		const { model } = target(answering());
		await probeAndRecord(model);
		expect(busy.noteAnswered).toHaveBeenCalledWith(MODEL, undefined);
		expect(busy.noteFailed).not.toHaveBeenCalled();
	});

	it("neither marks nor clears on an inconclusive probe", async () => {
		const { model } = target(throwing(400));
		await probeAndRecord(model);
		expect(busy.noteFailed).not.toHaveBeenCalled();
		expect(busy.noteAnswered).not.toHaveBeenCalled();
	});
});

describe("dueThisMinute: the probe stagger (CUR-4042)", () => {
	const ids = ["a", "b", "c", "d", "e", "f", "g"];
	const minutes = (n: number) => Array.from({ length: n }, (_, i) => Date.UTC(2026, 9, 25, 12, i));

	it("probes every model exactly once in each run of PROBE_EVERY_MINUTES consecutive minutes", () => {
		for (let start = 0; start < 8; start++) {
			const window = minutes(start + PROBE_EVERY_MINUTES).slice(start);
			const probed = window.flatMap((t) => dueThisMinute(ids, t)).sort();
			expect(probed).toEqual(ids);
		}
	});

	it("spreads the probes so no minute runs more than its share", () => {
		const most = Math.max(...minutes(60).map((t) => dueThisMinute(ids, t).length));
		expect(most).toBe(Math.ceil(ids.length / PROBE_EVERY_MINUTES));
	});
});
