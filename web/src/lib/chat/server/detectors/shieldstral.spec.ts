// A scenario run's guard calls replay from the model replay store, so CI stops queueing on the
// guard GPU www shares; outside a scenario request the judge calls the guard live, as before. (SOL-258)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/endpoints/openai/replayStore", () => ({
	lookup: vi.fn(),
	record: vi.fn(async () => {}),
	replayScope: () => "test",
	readScopes: () => ["test"],
}));

const { makeShieldstralJudge } = await import("./shieldstral");
const { guardRefreshDue } = await import("./guardRefresh");
const HOUR = 60 * 60 * 1000;
const { lookup, record } = await import("$lib/chat/server/endpoints/openai/replayStore");
const { runWithRequestContext, updateRequestContext } = await import("$lib/chat/server/requestContext");

const ENDPOINT = "https://guard.example/v1/chat/completions";
// A clean "No" with logprobs, the shape the guard's vLLM answers with.
const VERDICT = {
	model: "mistralai/Shieldstral-1.0-3B",
	choices: [
		{
			message: { content: "No" },
			logprobs: { content: [{ top_logprobs: [{ token: "No", logprob: -0.01 }, { token: "Yes", logprob: -6 }] }] },
		},
	],
};
const ok = () => new Response(JSON.stringify(VERDICT), { status: 200, headers: { "content-type": "application/json" } });

const judge = makeShieldstralJudge({ endpoint: ENDPOINT, token: "t" });
const ctx = () => ({ instruct: "Screen this.", opSignal: new AbortController().signal, timeoutMs: 5000, log: { info: () => {}, warn: () => {}, error: () => {} } });
const ask = () => judge({ kind: "text", text: "how do volcanoes form" }, "Is this about weapons?", 0.5, ctx());
const inScenario = <T>(mode: "new_episodes" | "none" | "mock", fn: () => Promise<T>) =>
	runWithRequestContext(async () => {
		updateRequestContext({ replayMode: mode });
		return fn();
	});

let live: ReturnType<typeof vi.fn>;
beforeEach(() => {
	live = vi.fn(async () => ok());
	vi.stubGlobal("fetch", live);
	vi.mocked(lookup).mockReset();
	vi.mocked(record).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the guard judge replays in scenario runs (SOL-258)", () => {
	it("calls the guard live and never touches the store when the request asked for no replay", async () => {
		const out = await runWithRequestContext(ask);
		expect(out.answer).toMatchObject({ yes: false });
		expect(live).toHaveBeenCalledTimes(1);
		expect(lookup).not.toHaveBeenCalled();
	});

	it("answers from a stored verdict with no live guard call", async () => {
		vi.mocked(lookup).mockResolvedValue({
			scope: "develop",
			cassette: { requestHash: "h", path: "/v1/chat/completions", host: "guard.example", status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(VERDICT), recordedAt: "2026-10-16T00:00:00.000Z" },
		});
		const out = await inScenario("new_episodes", ask);
		expect(out).toMatchObject({ httpOk: true, answer: { yes: false }, servedModel: "mistralai/Shieldstral-1.0-3B" });
		expect(live).not.toHaveBeenCalled();
	});

	it("keys the recording on the whole request, so a changed rule query is a different key", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		await inScenario("new_episodes", ask);
		await inScenario("new_episodes", () => judge({ kind: "text", text: "how do volcanoes form" }, "Is this about drugs?", 0.5, ctx()));
		const keys = vi.mocked(lookup).mock.calls.map((c) => c[0]);
		expect(new Set(keys).size).toBe(2);
	});

	it("goes live and records on a mock-mode miss, never handing the guard a mock answer that reads as UNKNOWN", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		const out = await inScenario("mock", ask);
		expect(out.answer).toMatchObject({ yes: false });
		expect(live).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(record).toHaveBeenCalled());
		expect(vi.mocked(record).mock.calls[0][0]).toMatchObject({ path: "/v1/chat/completions", host: "guard.example", status: 200 });
	});

	const storedAt = (recordedAt: string) =>
		vi.mocked(lookup).mockResolvedValue({
			scope: "develop",
			cassette: { requestHash: "h", path: "/v1/chat/completions", host: "guard.example", status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(VERDICT), recordedAt },
		});
	const realScreen = () =>
		runWithRequestContext(async () => {
			updateRequestContext({ replayMode: "mock", guardLive: true });
			return ask();
		});

	it("calls the live guard for a @real-screen send over a verdict due for a refresh, and records what it said (SOL-267)", async () => {
		storedAt(new Date(Date.now() - 8 * 24 * HOUR).toISOString());
		const out = await realScreen();
		expect(out.answer).toMatchObject({ yes: false });
		expect(live).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(record).toHaveBeenCalled());
	});

	it("replays a verdict under a day old for a @real-screen send, so develop runs stop sending every screen to the shared GPU (SOL-267)", async () => {
		storedAt(new Date(Date.now() - HOUR).toISOString());
		const out = await realScreen();
		expect(out).toMatchObject({ httpOk: true, answer: { yes: false } });
		expect(live).not.toHaveBeenCalled();
	});

	it("calls the live guard for a @real-screen send with no stored verdict at all", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		await realScreen();
		expect(live).toHaveBeenCalledTimes(1);
	});

	it("reads a none-mode miss as UNKNOWN and makes no live guard call", async () => {
		vi.mocked(lookup).mockResolvedValue(null);
		const out = await inScenario("none", ask);
		expect(out).toMatchObject({ answer: { kind: "unknown" }, httpOk: false });
		expect(live).not.toHaveBeenCalled();
	});
});

describe("a @real-screen verdict refreshes off-peak and spread out, never as one burst (SOL-267)", () => {
	const recorded = Date.parse("2026-10-16T13:00:00.000Z");
	const keys = Array.from({ length: 300 }, (_, i) => `guard-key-${i}`);
	const at = (hoursAfter: number) => recorded + hoursAfter * HOUR;
	const due = (key: string, hoursAfter: number) => guardRefreshDue(new Date(recorded).toISOString(), key, at(hoursAfter));

	it("never refreshes a verdict under a day old, at any hour", () => {
		for (let h = 0; h < 24; h++) expect(keys.filter((k) => due(k, h))).toEqual([]);
	});

	it("refreshes a verdict under a week old only in 02:00-06:00 UTC, www's quietest hours", () => {
		for (let h = 24; h < 7 * 24; h++) {
			const hour = new Date(at(h)).getUTCHours();
			if (hour < 2 || hour >= 6) expect(keys.filter((k) => due(k, h))).toEqual([]);
		}
	});

	it("spreads 300 verdicts recorded in one run over days and hours, so no hour refreshes more than a third of them", () => {
		const firstDue = new Map<string, number>();
		for (let h = 24; h < 7 * 24; h++) for (const k of keys) if (!firstDue.has(k) && due(k, h)) firstDue.set(k, h);
		expect(firstDue.size).toBe(300);
		const perHour = new Map<number, number>();
		for (const h of firstDue.values()) perHour.set(h, (perHour.get(h) ?? 0) + 1);
		expect(Math.max(...perHour.values())).toBeLessThanOrEqual(100);
		expect(new Set([...firstDue.values()].map((h) => Math.floor(h / 24))).size).toBeGreaterThanOrEqual(2);
	});

	it("refreshes a verdict more than a week old at any hour, so no quiet-hour run for a week cannot freeze it", () => {
		expect(keys.every((k) => due(k, 7 * 24 + 11))).toBe(true);
	});
});
