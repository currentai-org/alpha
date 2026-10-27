// SDK-built clients (search classifier, planner, task-model calls) replay like the answer does
// when the request's context carries a replay mode, and are untouched otherwise. (SOL-148)
import { afterEach, describe, expect, it, vi } from "vitest";

const replayOrRecord = vi.fn(async () => new Response("replayed"));
vi.mock("$lib/chat/server/config", () => ({ config: {} }));
vi.mock("$lib/chat/server/endpoints/openai/modelReplay", () => ({ replayOrRecord }));

const { replayAwareFetch } = await import("./openaiClient");
const { runWithRequestContext, updateRequestContext } = await import("./requestContext");

afterEach(() => {
	vi.unstubAllGlobals();
	replayOrRecord.mockClear();
});

describe("replayAwareFetch (SOL-148)", () => {
	it("goes straight to fetch when the request asked for no replay", async () => {
		const live = vi.fn(async () => new Response("live"));
		vi.stubGlobal("fetch", live);
		const res = await runWithRequestContext(() => replayAwareFetch("https://x.test/v1/chat/completions", { body: "{}" }));
		expect(await res.text()).toBe("live");
		expect(replayOrRecord).not.toHaveBeenCalled();
	});

	it("routes through replayOrRecord with the request's mode", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const res = await runWithRequestContext(async () => {
			updateRequestContext({ replayMode: "none" });
			return replayAwareFetch("https://x.test/v1/chat/completions", { body: "{}" });
		});
		expect(await res.text()).toBe("replayed");
		expect(replayOrRecord).toHaveBeenCalledWith(
			"https://x.test/v1/chat/completions",
			{ body: "{}" },
			expect.any(Function),
			{ sdkCall: true },
			"none",
			{}
		);
	});

	it("passes a caller's liveOnMiss through to replayOrRecord (SOL-262)", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await runWithRequestContext(async () => {
			updateRequestContext({ replayMode: "mock" });
			return replayAwareFetch("https://api.openalex.org/works?search=q", {}, { liveOnMiss: true });
		});
		expect(replayOrRecord).toHaveBeenLastCalledWith("https://api.openalex.org/works?search=q", {}, expect.any(Function), { sdkCall: true }, "mock", {
			liveOnMiss: true,
		});
	});
});
