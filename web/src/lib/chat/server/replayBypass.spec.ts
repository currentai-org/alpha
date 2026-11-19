import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// In a scenario request, a model call that skips the replay store must say so, because the turn still
// answers and nothing else would: the run spends a provider allowance production shares on every pass.

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));
// The store answers nothing, so every replayOrRecord call below is a miss that goes live.
vi.mock("$lib/chat/server/endpoints/openai/replayStore", () => ({
	lookup: vi.fn(async () => null),
	record: vi.fn(async () => {}),
}));

import { runWithRequestContext, updateRequestContext } from "$lib/chat/server/requestContext";
import type { ReplayMode } from "$lib/chat/server/endpoints/openai/modelReplay";

const network = vi.fn(async () => new Response("{}", { status: 200 }));
const bypassLines = () => warn.mock.calls.filter(([, msg]) => String(msg).startsWith("[replay] bypass"));

function inRequest<T>(replayMode: ReplayMode | undefined, fn: () => Promise<T>): Promise<T> {
	return runWithRequestContext(async () => {
		if (replayMode) updateRequestContext({ replayMode, url: "/chat/api/some-route" });
		return fn();
	});
}

beforeAll(async () => {
	vi.stubGlobal("fetch", network);
	(await import("./replayBypass")).installReplayBypassGuard();
});

beforeEach(() => {
	warn.mockClear();
	network.mockClear();
});

describe("replay bypass guard", () => {
	it("reports a raw model call made in a scenario request, naming its host and path but no body", async () => {
		await inRequest("mock", () =>
			fetch("https://router.example/v1/chat/completions", { method: "POST", body: '{"messages":[]}' })
		);
		expect(bypassLines()).toHaveLength(1);
		const [fields] = bypassLines()[0];
		expect(fields).toMatchObject({ host: "router.example", path: "/v1/chat/completions", mode: "mock" });
		expect(JSON.stringify(fields)).not.toContain("messages");
		// Capture-and-warn: the call still goes out.
		expect(network).toHaveBeenCalledTimes(1);
	});

	it("reports a speech synthesis on the Hugging Face router too", async () => {
		await inRequest("new_episodes", () =>
			fetch("https://router.huggingface.co/deepinfra/v1/openai/audio/speech", { method: "POST" })
		);
		expect(bypassLines()).toHaveLength(1);
	});

	it("does not report the live call the replay layer itself makes on a recording miss", async () => {
		const { replayOrRecord } = await import("$lib/chat/server/endpoints/openai/modelReplay");
		await inRequest("new_episodes", () =>
			replayOrRecord(
				"https://router.example/v1/chat/completions",
				{ method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) },
				(init) => fetch("https://router.example/v1/chat/completions", init),
				{},
				"new_episodes"
			)
		);
		expect(network).toHaveBeenCalledTimes(1);
		expect(bypassLines()).toHaveLength(0);
	});

	it("reports nothing outside a scenario request, so production never logs it", async () => {
		await inRequest(undefined, () => fetch("https://router.example/v1/chat/completions", { method: "POST" }));
		expect(bypassLines()).toHaveLength(0);
	});

	it("reports nothing for a call that is not a model call, such as a search engine's GET", async () => {
		await inRequest("mock", () => fetch("https://en.wikipedia.org/w/api.php?action=query&list=search"));
		expect(bypassLines()).toHaveLength(0);
	});
});
