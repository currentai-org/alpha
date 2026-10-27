import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared store (replayStore.ts), as a map keyed by scope and hash. Reads go this run's scope, then
// develop's, as the real one does.
const shared = new Map<string, Record<string, unknown>>();
let storeDown = false;
let lookupHost: string | undefined;
const SCOPE = "someone/sol-1-a-ticket-branch";
vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./replayStore", () => ({
	lookup: async (hash: string, _scope?: string, host?: string) => {
		lookupHost = host;
		if (storeDown) throw new Error("replay store answered 502");
		for (const scope of [SCOPE, "develop"]) {
			const c = shared.get(`${scope}:${hash}`);
			if (c) return { cassette: c, scope };
		}
		return null;
	},
	record: async (c: { requestHash: string }) => void shared.set(`${SCOPE}:${c.requestHash}`, c),
}));

// MOCK_ANSWER in modelReplay.ts, which says plainly that no recording matched.
const MOCK_ANSWER = "[mock answer] No recording matched this request, so the scenario harness answered in place of the model.";
const { cassettes, keyedBody, looseReplayKey, normalizeRequest, replayKey, replayOrRecord, requestParts, toolLooseReplayKey, REPLAY_HEADER, REPLAY_MISS_STATUS } = await import(
	"./modelReplay"
);

const URL_ = "https://api.mistral.ai/v1/chat/completions";
const body = (fence: string, today: string) =>
	JSON.stringify({
		model: "mistral-large-2512",
		messages: [
			{ role: "system", content: `Today is ${today}. The latest message is wrapped in <${fence}> tags.` },
			{ role: "user", content: `<${fence}>\nWhere do you run?\n</${fence}>` },
		],
	});
const SSE = 'data: {"choices":[{"delta":{"content":"Zurich."}}]}\n\ndata: [DONE]\n\n';
const sse = (text = SSE, status = 200) =>
	new Response(text, { status, headers: { "content-type": "text/event-stream", "x-litellm-model-group": "m", "set-cookie": "a=b" } });
const REFUSAL_TTL_MS = 10 * 60 * 1000; // modelReplay.ts: a recorded 429 is replayed for ten minutes
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
	shared.clear();
	cassettes.clear();
	storeDown = false;
	lookupHost = undefined;
});
const recorded = () => [...shared.entries()].filter(([k]) => k.startsWith(`${SCOPE}:`));

describe("requestParts: which part of a missed request changed", () => {
	it("names the system part, and only it, when two runs of one question differ in the system prompt", () => {
		const a = requestParts(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)"));
		const b = requestParts(
			body("Q_9f8e7d6c", "Tuesday, 6 October 2026 (UTC)").replace("The latest message", "The newest message")
		);
		const changed = Object.keys(a).filter((k) => a[k] !== b[k]);
		expect(changed).toEqual(["system"]);
	});

	it("keeps the same ask across turns of one conversation, so a miss can be matched to its first turn", () => {
		const first = JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)"));
		const second = {
			...first,
			messages: [...first.messages, { role: "assistant", content: "Zurich." }, { role: "user", content: "Why?" }],
		};
		const a = requestParts(JSON.stringify(first));
		const b = requestParts(JSON.stringify(second));
		expect(b.ask).toBe(a.ask);
		expect(b.users).not.toBe(a.users);
		expect(b.turns).toBe("4");
	});

	it("returns nothing for a body that is not a chat request, rather than throwing", () => {
		expect(requestParts("not json")).toEqual({});
		expect(requestParts(JSON.stringify({ input: "x" }))).toEqual({});
	});
});

describe("model replay keys (SOL-92)", () => {
	it("gives two turns of the same question the same key though their fence nonce and date line differ", () => {
		const a = body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (Asia/Seoul)");
		const b = body("Q_9f8e7d6c", "Monday, 5 October 2026 (America/Los_Angeles)");
		expect(a).not.toBe(b);
		expect(replayKey("/v1/chat/completions", a)).toBe(replayKey("/v1/chat/completions", b));
		expect(normalizeRequest("Today is 2026-10-06.")).toBe("Today is DATE.");
	});

	it("gives a changed prompt a different key, so it misses rather than replaying the old answer", () => {
		const a = body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)");
		expect(replayKey("/v1/chat/completions", a)).not.toBe(
			replayKey("/v1/chat/completions", a.replace("Where do you run?", "Who runs you?"))
		);
		expect(replayKey("/v1/chat/completions", a)).not.toBe(replayKey("/v1/completions", a));
	});

	it("gives two runs of a spec whose prompt carries a Date.now() stamp the same key, and leaves a shorter number alone (SOL-181)", () => {
		const a = body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)").replace("Where do you run?", "Why two tides? 1791853934211");
		const b = a.replace("1791853934211", "1791854002750");
		expect(replayKey("/v1/chat/completions", a)).toBe(replayKey("/v1/chat/completions", b));
		expect(normalizeRequest("order 179185393421 of 2")).toBe("order 179185393421 of 2");
		expect(normalizeRequest("id 17918539342110")).toBe("id 17918539342110");
	});
});

describe("replayOrRecord (SOL-92)", () => {
	it("on a miss calls the live model, hands back its whole body, and records it with only the kept headers", async () => {
		const live = vi.fn(async () => sse());
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const res = await replayOrRecord(URL_, init, live);
		expect(live).toHaveBeenCalledOnce();
		expect(await res.text()).toBe(SSE);
		await settle();
		const key = replayKey("/v1/chat/completions", init.body);
		const loose = looseReplayKey("/v1/chat/completions", init.body);
		expect(recorded().map(([k]) => k)).toEqual([`${SCOPE}:${key}`, `${SCOPE}:${loose}`]);
		const doc = recorded()[0][1];
		expect(doc).toMatchObject({ requestHash: key, status: 200, body: SSE, path: "/v1/chat/completions" });
		expect(doc.headers).toEqual({ "content-type": "text/event-stream", "x-litellm-model-group": "m" });
	});

	it("on a hit makes no live call, streams the recorded body and headers, and marks the response as replayed", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const key = replayKey("/v1/chat/completions", init.body);
		cassettes.set(key, {
			requestHash: key,
			path: "/v1/chat/completions",
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: SSE.repeat(40),
			recordedAt: "2026-10-06T00:00:00Z",
		});
		const live = vi.fn(async () => sse("live"));
		// A later turn of the same question: a new fence and a new day.
		const later = { method: "POST", body: body("Q_00ff00ff", "Wednesday, 7 October 2026 (UTC)") };
		const res = await replayOrRecord(URL_, later, live);
		expect(live).not.toHaveBeenCalled();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get(REPLAY_HEADER), "a replayed answer must say it was replayed").toBe("2026-10-06T00:00:00Z");
		expect(await res.text()).toBe(SSE.repeat(40));
		await settle();
		expect(recorded()).toHaveLength(0);
	});

	// GLM 5.2 on the HF router: customFetch reads the served model from `x-inference-provider`. A replay
	// without it persists no served model.
	describe("a turn on the HF router keeps the provider that served it", () => {
		const HF_URL = "https://router.huggingface.co/v1/chat/completions";
		const hfLive = () =>
			vi.fn(async () => new Response(SSE, { headers: { "content-type": "text/event-stream", "x-inference-provider": "scaleway" } }));
		const init = () => ({ method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") });

		it("records the provider header and hands it back on the replay", async () => {
			await (await replayOrRecord(HF_URL, init(), hfLive())).text();
			await settle();
			expect(recorded()[0][1].headers).toMatchObject({ "x-inference-provider": "scaleway" });
			const live = hfLive();
			const again = await replayOrRecord(HF_URL, init(), live);
			expect(live).not.toHaveBeenCalled();
			expect(again.headers.get("x-inference-provider")).toBe("scaleway");
		});

		const withoutProvider = () => {
			const key = replayKey("/v1/chat/completions", init().body);
			shared.set(`develop:${key}`, {
				requestHash: key,
				path: "/v1/chat/completions",
				host: "router.huggingface.co",
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: SSE,
				recordedAt: "2026-10-10T00:00:00Z",
			});
		};

		it("re-records a recording made without the provider header when the run records misses", async () => {
			withoutProvider();
			const live = hfLive();
			const res = await replayOrRecord(HF_URL, init(), live);
			expect(live).toHaveBeenCalledOnce();
			expect(res.headers.get("x-inference-provider")).toBe("scaleway");
		});

		it("still replays that recording in a run that must make no live call", async () => {
			withoutProvider();
			const live = hfLive();
			const res = await replayOrRecord(HF_URL, init(), live, {}, "none");
			expect(live).not.toHaveBeenCalled();
			expect(res.status).toBe(200);
		});
	});

	const cassetteFor = (body: string, text: string) => ({
		requestHash: replayKey("/v1/chat/completions", body),
		path: "/v1/chat/completions",
		status: 200,
		headers: { "content-type": "text/event-stream" },
		body: text,
		recordedAt: "2026-10-11T00:00:00Z",
	});

	it("a recording another branch's run left on develop is this run's hit, with no live call (SOL-148)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const c = cassetteFor(init.body, "from develop");
		shared.set(`develop:${c.requestHash}`, c);
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, init, live);
		expect(live).not.toHaveBeenCalled();
		expect(await res.text()).toBe("from develop");
	});

	it("reads this branch's own recording ahead of develop's (SOL-148)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const mine = cassetteFor(init.body, "mine");
		shared.set(`develop:${mine.requestHash}`, cassetteFor(init.body, "develop's"));
		shared.set(`${SCOPE}:${mine.requestHash}`, mine);
		expect(await (await replayOrRecord(URL_, init, async () => sse())).text()).toBe("mine");
	});

	it("a run's miss is the next run's hit: the second identical request makes no live call (SOL-148)", async () => {
		const live = vi.fn(async () => sse());
		const first = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		await (await replayOrRecord(URL_, first, live)).text();
		await settle();
		const second = { method: "POST", body: body("Q_77777777", "Wednesday, 7 October 2026 (UTC)") };
		expect(await (await replayOrRecord(URL_, second, live)).text()).toBe(SSE);
		expect(live).toHaveBeenCalledOnce();
	});

	it("keys a call on the app's model id, so an env change to the wire id still replays the recording (MISTRAL_CHAT_MODEL_MAP)", async () => {
		const live = vi.fn(async () => sse());
		const asWire = (wire: string) => ({
			method: "POST",
			body: JSON.stringify({ ...JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)")), model: wire }),
		});
		await (await replayOrRecord(URL_, asWire("mistralai/mistral-medium-3-5"), live, {}, "new_episodes", { appModelId: "mistral-medium-2604" })).text();
		await settle();
		const res = await replayOrRecord(URL_, asWire("mistral-medium-3.5-128b"), live, {}, "mock", { appModelId: "mistral-medium-2604" });
		expect(await res.text()).toBe(SSE);
		expect(res.headers.get(REPLAY_HEADER)).toBeTruthy();
		expect(live).toHaveBeenCalledOnce();
	});

	it("still replays a recording keyed on the wire id before appModelId existed, in a PR's mock run that never records", async () => {
		const live = vi.fn(async () => sse());
		const init = { method: "POST", body: JSON.stringify({ ...JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)")), model: "mistralai/mistral-medium-3-5" }) };
		await (await replayOrRecord(URL_, init, live, {}, "new_episodes")).text();
		await settle();
		const res = await replayOrRecord(URL_, init, live, {}, "mock", { appModelId: "mistral-medium-2604" });
		expect(await res.text()).toBe(SSE);
		expect(res.headers.get(REPLAY_HEADER)).toBeTruthy();
		expect(live).toHaveBeenCalledOnce();
	});

	it("still sends the wire id to the live model: only the key reads the app's id", async () => {
		const live = vi.fn(async (_init?: RequestInit) => sse());
		const init = { method: "POST", body: JSON.stringify({ model: "mistralai/mistral-medium-3-5", messages: [] }) };
		await (await replayOrRecord(URL_, init, live, {}, "new_episodes", { appModelId: "mistral-medium-2604" })).text();
		expect(JSON.parse(String(live.mock.calls[0][0]?.body)).model).toBe("mistralai/mistral-medium-3-5");
	});

	it("leaves a body whose model already is the app's id byte for byte, so recordings keyed before appModelId still match", () => {
		const b = body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)");
		expect(keyedBody(b, "mistral-large-2512")).toBe(b);
		expect(keyedBody(b, undefined)).toBe(b);
		expect(keyedBody("not json", "x")).toBe("not json");
		expect(replayKey("/v1/chat/completions", keyedBody(b, "mistral-large-2512"))).toBe(replayKey("/v1/chat/completions", b));
	});

	it("none mode fails a miss without calling the model, so a run can prove it made no live call (SOL-148)", async () => {
		const live = vi.fn(async () => sse());
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const res = await replayOrRecord(URL_, init, live, {}, "none");
		expect(live).not.toHaveBeenCalled();
		expect(res.status).toBe(REPLAY_MISS_STATUS);
		expect(res.ok).toBe(false);
		await settle();
		expect(recorded()).toHaveLength(0);
	});

	it("mock mode answers a streamed miss with the mock answer in the SDK's stream shape, calls no model and records nothing (SOL-208)", async () => {
		const live = vi.fn(async () => sse());
		const sent = JSON.stringify({ ...JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)")), stream: true });
		const res = await replayOrRecord(URL_, { method: "POST", body: sent }, live, {}, "mock");
		expect(live).not.toHaveBeenCalled();
		expect(res.status).toBe(200);
		expect(res.headers.get("x-model-mock")).toBe("1");
		const events = (await res.text()).split("\n\n").filter(Boolean);
		expect(events.at(-1)).toBe("data: [DONE]");
		const chunks = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, "")));
		expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(MOCK_ANSWER);
		expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
		expect(chunks[0].model).toBe("mistral-large-2512");
		await settle();
		expect(recorded()).toHaveLength(0);
	});

	it("mock mode streams its answer in more chunks than stream_truncates_midway lets through, so the fault still cuts a mocked turn (SOL-208)", async () => {
		const sent = JSON.stringify({ ...JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)")), stream: true });
		const res = await replayOrRecord(URL_, { method: "POST", body: sent }, vi.fn(async () => sse()), {}, "mock");
		const contentChunks = (await res.text())
			.split("\n\n")
			.filter((e) => e.startsWith("data: {"))
			.map((e) => JSON.parse(e.replace(/^data: /, "")).choices[0].delta.content)
			.filter(Boolean);
		// generate.ts cuts after 12 streamed tokens; one chunk is one token there.
		expect(contentChunks.length).toBeGreaterThan(12);
		await settle();
		expect(recorded()).toHaveLength(0);
	});

	it("mock mode answers a non-streamed miss with a whole chat completion (SOL-208)", async () => {
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") }, live, {}, "mock");
		expect(live).not.toHaveBeenCalled();
		const completion = await res.json();
		expect(completion.choices[0].message.content).toBe(MOCK_ANSWER);
		expect(completion.choices[0].finish_reason).toBe("stop");
	});

	it("mock mode still replays a recording when one matches, ahead of the mock (SOL-208)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		await replayOrRecord(URL_, init, async () => sse(), {}, "new_episodes");
		await settle();
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, init, live, {}, "mock");
		expect(live).not.toHaveBeenCalled();
		expect(res.headers.get("x-model-mock")).toBeNull();
		expect(await res.text()).toBe(SSE);
	});

	it("mock mode fails a miss it cannot answer generically, a forced tool call or a JSON schema, as none mode does, and never goes live (SOL-208)", async () => {
		const live = vi.fn(async () => sse());
		const base = JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)"));
		for (const extra of [
			{ tool_choice: { type: "function", function: { name: "search" } } },
			{ tool_choice: "required" },
			{ response_format: { type: "json_schema", json_schema: { name: "x", schema: {} } } },
		]) {
			const res = await replayOrRecord(URL_, { method: "POST", body: JSON.stringify({ ...base, ...extra }) }, live, {}, "mock");
			expect(res.status).toBe(REPLAY_MISS_STATUS);
		}
		const clef = await replayOrRecord("https://clef.example.org/v1/classify", { method: "POST", body: "{}" }, live, {}, "mock");
		expect(clef.status).toBe(REPLAY_MISS_STATUS);
		expect(live).not.toHaveBeenCalled();
	});

	it("mock mode answers a miss that forces a tool it offers with a mock call to that tool, its query the last user message, and never goes live (CUR-4083)", async () => {
		const live = vi.fn(async () => sse());
		const base = JSON.parse(body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)"));
		const forced = {
			...base,
			messages: [...(base.messages ?? []), { role: "user", content: "eviction notice rules in England" }],
			tools: [
				{
					type: "function",
					function: {
						name: "web_search",
						parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
					},
				},
			],
			tool_choice: { type: "function", function: { name: "web_search" } },
		};
		const whole = await replayOrRecord(URL_, { method: "POST", body: JSON.stringify({ ...forced, stream: false }) }, live, {}, "mock");
		const completion = await whole.json();
		expect(completion.choices[0].finish_reason).toBe("tool_calls");
		expect(completion.choices[0].message.tool_calls[0].function).toEqual({
			name: "web_search",
			arguments: JSON.stringify({ query: "eviction notice rules in England" }),
		});
		const streamed = await replayOrRecord(URL_, { method: "POST", body: JSON.stringify({ ...forced, stream: true }) }, live, {}, "mock");
		const text = await streamed.text();
		expect(text).toContain('"finish_reason":"tool_calls"');
		expect(text).toContain('"name":"web_search"');
		expect(text).not.toContain(MOCK_ANSWER);
		const unfillable = {
			...forced,
			tools: [{ type: "function", function: { name: "web_search", parameters: { properties: { n: { type: "number" } }, required: ["n"] } } }],
		};
		const miss = await replayOrRecord(URL_, { method: "POST", body: JSON.stringify(unfillable) }, live, {}, "mock");
		expect(miss.status).toBe(REPLAY_MISS_STATUS);
		expect(live).not.toHaveBeenCalled();
	});

	it("mock mode answers an unrecorded Firecrawl search or scrape with an empty result and never calls Firecrawl, so a PR run spends no credit (SOL-219)", async () => {
		const live = vi.fn(async () => new Response("{}"));
		const search = await replayOrRecord(
			"https://api.firecrawl.dev/v2/search",
			{ method: "POST", body: JSON.stringify({ query: "who won the 2026 world cup", limit: 5 }) },
			live,
			{},
			"mock"
		);
		expect(search.status).toBe(200);
		expect(await search.json()).toEqual({ success: true, data: { web: [] } });
		const scrape = await replayOrRecord(
			"https://api.firecrawl.dev/v2/scrape",
			{ method: "POST", body: JSON.stringify({ url: "https://example.org/a", formats: ["markdown"] }) },
			live,
			{},
			"mock"
		);
		expect(scrape.status).toBe(200);
		expect(await scrape.json()).toEqual({ success: true, data: { markdown: "", metadata: {} } });
		expect(live).not.toHaveBeenCalled();
	});

	it("new_episodes mode records a Firecrawl search once and replays it without a second live call (SOL-219)", async () => {
		const init = { method: "POST", body: JSON.stringify({ query: "firecrawl replay probe", limit: 5 }) };
		const answer = JSON.stringify({ success: true, data: { web: [{ url: "https://example.org", title: "t", description: "d" }] } });
		const live = vi.fn(async () => new Response(answer, { headers: { "content-type": "application/json" } }));
		await replayOrRecord("https://api.firecrawl.dev/v2/search", init, live, {}, "new_episodes");
		await settle();
		const again = await replayOrRecord("https://api.firecrawl.dev/v2/search", init, live, {}, "new_episodes");
		expect(live).toHaveBeenCalledTimes(1);
		expect(await again.text()).toBe(answer);
	});

	// The keyless open-web engines are GETs whose whole request is the query string. (SOL-262)
	it("mock mode calls an unrecorded engine, rerank or embedding request live, records none of them, and replays a recorded one", async () => {
		const live = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: "live" }] }), { headers: { "content-type": "application/json" } }));
		const opts = { liveOnMiss: true };
		const engine = await replayOrRecord("https://api.openalex.org/works?search=zurich", {}, live, {}, "mock", opts);
		const rerank = await replayOrRecord("https://gw.test/rerank", { method: "POST", body: JSON.stringify({ query: "q", documents: ["d"] }) }, live, {}, "mock", opts);
		const embed = await replayOrRecord(
			"https://router.huggingface.co/hf-inference/models/m/pipeline/feature-extraction",
			{ method: "POST", body: JSON.stringify({ inputs: "q" }) },
			live,
			{},
			"mock",
			opts
		);
		expect([engine.status, rerank.status, embed.status]).toEqual([200, 200, 200]);
		expect(await engine.json()).toEqual({ results: [{ title: "live" }] });
		expect(live).toHaveBeenCalledTimes(3);
		await settle();
		expect(recorded()).toEqual([]);
	});

	// The search-intent and self-identity embedders post the same body to "/" on two hosts. (SOL-269)
	it("two embedders posting one body to two hosts each replay their own recording, never the other model's vector", async () => {
		const init = { method: "POST", body: JSON.stringify({ inputs: "Quel modèle es-tu, et qui le fait tourner ?" }) };
		const opts = { liveOnMiss: true };
		const vector = (v: number) => vi.fn(async () => new Response(JSON.stringify([[v, v]]), { headers: { "content-type": "application/json" } }));
		const intent = vector(1);
		const identity = vector(2);
		await (await replayOrRecord("https://intent.endpoints.test/", init, intent, {}, "new_episodes", opts)).text();
		await settle();
		await (await replayOrRecord("https://identity.endpoints.test/", init, identity, {}, "new_episodes", opts)).text();
		await settle();
		const intentAgain = await replayOrRecord("https://intent.endpoints.test/", init, intent, {}, "mock", opts);
		const identityAgain = await replayOrRecord("https://identity.endpoints.test/", init, identity, {}, "mock", opts);
		expect([await intentAgain.json(), await identityAgain.json()]).toEqual([[[1, 1]], [[2, 2]]]);
		expect([intent.mock.calls.length, identity.mock.calls.length]).toEqual([1, 1]);
		expect(recorded()).toHaveLength(2);
	});

	it("never calls an unrecorded request live in mock mode unless its caller asked for liveOnMiss, nor in none mode even when it did", async () => {
		const live = vi.fn(async () => new Response("[]"));
		const init = { method: "POST", body: JSON.stringify({ query: "q", documents: ["d"] }) };
		const plain = await replayOrRecord("https://gw.test/rerank", init, live, {}, "mock");
		const none = await replayOrRecord("https://gw.test/rerank", init, live, {}, "none", { liveOnMiss: true });
		expect([plain.status, none.status]).toEqual([REPLAY_MISS_STATUS, REPLAY_MISS_STATUS]);
		expect(live).not.toHaveBeenCalled();
	});

	it("keys a GET on its query string, so two engine searches for different queries never replay each other's results", async () => {
		const json = (q: string) => new Response(JSON.stringify({ results: [{ title: q }] }), { headers: { "content-type": "application/json" } });
		let calls = 0;
		const live = vi.fn(async () => json(`live ${++calls}`));
		const call = (q: string) => replayOrRecord(`https://api.openalex.org/works?search=${q}`, {}, live, {}, "new_episodes");
		await (await call("zurich")).text();
		await settle();
		const other = await call("geneva");
		expect(live).toHaveBeenCalledTimes(2);
		expect(await other.json()).toEqual({ results: [{ title: "live 2" }] });
		await settle();
		const again = await call("zurich");
		expect(live).toHaveBeenCalledTimes(2);
		expect(await again.json()).toEqual({ results: [{ title: "live 1" }] });
	});

	it("records an arXiv Atom answer once it has closed, and replays it without a second live call", async () => {
		const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title></entry></feed>';
		const live = vi.fn(async () => new Response(atom, { headers: { "content-type": "application/atom+xml; charset=utf-8" } }));
		const url = "https://export.arxiv.org/api/query?search_query=all%3Areplay";
		await (await replayOrRecord(url, {}, live, {}, "new_episodes")).text();
		await settle();
		const again = await replayOrRecord(url, {}, live, {}, "mock");
		expect(live).toHaveBeenCalledTimes(1);
		expect(await again.text()).toBe(atom);
	});

	it("never records an arXiv Atom answer cut off before its root element closed", async () => {
		const live = vi.fn(async () => new Response('<?xml version="1.0"?><feed><entry><title>T', { headers: { "content-type": "application/atom+xml" } }));
		await (await replayOrRecord("https://export.arxiv.org/api/query?search_query=all%3Acut", {}, live, {}, "new_episodes")).text();
		await settle();
		expect(recorded()).toEqual([]);
	});

	it("all mode calls the live model over this branch's recording and develop's and a bundled one, and records over its own (SOL-166)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const bad = cassetteFor(init.body, "the failing first draw");
		shared.set(`${SCOPE}:${bad.requestHash}`, bad);
		shared.set(`develop:${bad.requestHash}`, cassetteFor(init.body, "develop's"));
		cassettes.set(bad.requestHash, cassetteFor(init.body, "bundled"));
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, init, live, {}, "all");
		expect(live).toHaveBeenCalledOnce();
		expect(res.headers.get(REPLAY_HEADER), "a live answer must not be marked as replayed").toBeNull();
		expect(await res.text()).toBe(SSE);
		await settle();
		expect(shared.get(`${SCOPE}:${bad.requestHash}`)?.body, "the retry's answer replaces the bad draw").toBe(SSE);
		// The next first attempt on the branch replays the retry's answer, not the bad one.
		expect(await (await replayOrRecord(URL_, init, live)).text()).toBe(SSE);
		expect(live).toHaveBeenCalledOnce();
	});

	it("records the upstream host and asks the store by it, so another branch's answer is read only from the same upstream (SOL-180)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		await (await replayOrRecord(URL_, init, async () => sse())).text();
		await settle();
		expect(lookupHost).toBe("api.mistral.ai");
		expect(recorded()[0][1]).toMatchObject({ host: "api.mistral.ai" });
	});

	it("a caller that stops mid-answer has its stream ended, while the whole answer is still recorded for the next run", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const parts = ['data: {"choices":[{"delta":{"content":"Zur"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"ich."}}]}\n\n', "data: [DONE]\n\n"];
		let sentSignal: AbortSignal | null | undefined = null;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const live = async (sent: RequestInit | undefined) => {
			sentSignal = sent?.signal;
			const enc = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				async start(c) {
					c.enqueue(enc.encode(parts[0]));
					await gate;
					c.enqueue(enc.encode(parts[1]));
					c.enqueue(enc.encode(parts[2]));
					c.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		};
		const stop = new AbortController();
		const res = await replayOrRecord(URL_, { ...init, signal: stop.signal }, live);
		expect(sentSignal, "the live call carried the caller's abort signal, so a Stop would kill the recording too").toBeUndefined();
		const reader = res.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(parts[0]);
		stop.abort();
		await expect(reader.read(), "the caller's stream kept going after Stop").rejects.toThrow();
		release();
		await settle();
		expect(recorded(), "the stopped answer was never recorded").toHaveLength(2);
		expect(recorded()[0][1]).toMatchObject({ body: parts.join("") });
	});

	it("a caller that gives up before the headers arrive is rejected at once, and the late answer is still recorded", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const live = async () => (await gate, sse());
		const deadline = new AbortController();
		const call = replayOrRecord(URL_, { ...init, signal: deadline.signal }, live);
		deadline.abort(new Error("first-chunk deadline"));
		await expect(call, "the caller waited on headers after its deadline fired").rejects.toThrow("first-chunk deadline");
		release();
		await settle();
		expect(recorded(), "the answer that arrived after the deadline was never recorded").toHaveLength(2);
	});

	it("hands back a stream the upstream closed mid-answer but never records it, so no branch replays it as whole (SOL-180)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const cut = 'data: {"choices":[{"delta":{"content":"Zur"},"finish_reason":null}]}\n\n';
		expect(await (await replayOrRecord(URL_, init, async () => sse(cut))).text()).toBe(cut);
		await settle();
		expect(recorded()).toHaveLength(0);
		const done = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
		await (await replayOrRecord(URL_, init, async () => sse(done))).text();
		await settle();
		expect(recorded(), "a stream with a finish reason and no [DONE] is whole").toHaveLength(2);
	});

	it("records a 429 only with an expiry ten minutes out, so it is never replayed to every later run (CUR-3982)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const before = Date.now();
		const res = await replayOrRecord(URL_, init, async () => sse("busy", 429));
		expect(res.status).toBe(429);
		expect(await res.text()).toBe("busy");
		const [[, c]] = recorded();
		expect(c.status).toBe(429);
		const until = Date.parse(String(c.refusedUntil));
		expect(until - before).toBeGreaterThanOrEqual(REFUSAL_TTL_MS);
		expect(until - Date.now()).toBeLessThanOrEqual(REFUSAL_TTL_MS);
	});

	it("a 429 whose Retry-After names a shorter wait is kept only that long, so a per-minute blip clears for the retry (CUR-3996)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const before = Date.now();
		await replayOrRecord(URL_, init, async () => new Response("busy", { status: 429, headers: { "retry-after": "2" } }));
		const [[, c]] = recorded();
		const until = Date.parse(String(c.refusedUntil));
		expect(until - before).toBeGreaterThanOrEqual(2000);
		expect(until - Date.now()).toBeLessThanOrEqual(2000);
	});

	it("a Retry-After longer than ten minutes is capped at ten (CUR-3996)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		await replayOrRecord(URL_, init, async () => new Response("busy", { status: 429, headers: { "retry-after": "86400" } }));
		const [[, c]] = recorded();
		expect(Date.parse(String(c.refusedUntil)) - Date.now()).toBeLessThanOrEqual(REFUSAL_TTL_MS);
	});

	it("a request the model refused moments ago is answered 429 from the store, with no second live call (CUR-3982)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const live = vi.fn(async () => sse("busy", 429));
		await (await replayOrRecord(URL_, init, live)).text();
		const again = await replayOrRecord(URL_, init, live);
		expect(again.status).toBe(429);
		expect(await again.text()).toBe("busy");
		expect(again.headers.get(REPLAY_HEADER)).toBeTruthy();
		expect(live).toHaveBeenCalledOnce();
	});

	it("a bundled good cassette answers in place of an unexpired 429 from the store (CUR-3996)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		await (await replayOrRecord(URL_, init, async () => sse("busy", 429))).text();
		const bundled = cassetteFor(init.body, "bundled");
		cassettes.set(bundled.requestHash, bundled);
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, init, live);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("bundled");
		expect(live).not.toHaveBeenCalled();
	});

	it("all mode never records a 429, so a refused retry cannot replace a good recording (CUR-3982)", async () => {
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		await (await replayOrRecord(URL_, init, async () => sse("busy", 429), {}, "all")).text();
		expect(recorded()).toHaveLength(0);
	});

	it("an unreachable store is a miss: the turn goes live in new_episodes mode and fails in none mode (SOL-148)", async () => {
		storeDown = true;
		const init = { method: "POST", body: body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)") };
		const live = vi.fn(async () => sse());
		expect(await (await replayOrRecord(URL_, init, live)).text()).toBe(SSE);
		expect((await replayOrRecord(URL_, init, live, {}, "none")).status).toBe(REPLAY_MISS_STATUS);
		expect(live).toHaveBeenCalledOnce();
	});
});

describe("replay across deployments whose system prompt differs (SOL-208)", () => {
	const onDevelop = body("Q_1a2b3c4d", "Tuesday, 6 October 2026 (UTC)");
	const onPr = onDevelop.replace("The latest message", "Screening is off on this preview. The latest message");

	it("in mock mode replays develop's answer to the same conversation when only the system prompt differs", async () => {
		await (await replayOrRecord(URL_, { method: "POST", body: onDevelop }, async () => sse())).text();
		await settle();
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, { method: "POST", body: onPr }, live, {}, "mock");
		expect(live).not.toHaveBeenCalled();
		expect(await res.text()).toBe(SSE);
	});

	it("in a live mode calls the model instead, so a PR that changes the prompt still records against the model", async () => {
		await (await replayOrRecord(URL_, { method: "POST", body: onDevelop }, async () => sse())).text();
		await settle();
		const live = vi.fn(async () => sse());
		await (await replayOrRecord(URL_, { method: "POST", body: onPr }, live)).text();
		expect(live).toHaveBeenCalledOnce();
	});

	it("in nearest mode (the gallery) replays develop's answer when only the graded build's system prompt differs, with no live call", async () => {
		await (await replayOrRecord(URL_, { method: "POST", body: onDevelop }, async () => sse())).text();
		await settle();
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, { method: "POST", body: onPr }, live, {}, "nearest");
		expect(live).not.toHaveBeenCalled();
		expect(await res.text()).toBe(SSE);
	});

	it("in nearest mode calls the model once for a conversation nobody recorded, records it, and never answers with a mock", async () => {
		const live = vi.fn(async () => sse());
		const first = await replayOrRecord(URL_, { method: "POST", body: onPr }, live, {}, "nearest");
		expect(await first.text()).toBe(SSE);
		await settle();
		const again = await replayOrRecord(URL_, { method: "POST", body: onPr }, live, {}, "nearest");
		expect(await again.text()).toBe(SSE);
		expect(live).toHaveBeenCalledOnce();
	});

	it("gives a different question a different loose key, so the fallback never answers the wrong conversation", () => {
		expect(looseReplayKey("/v1/chat/completions", onPr)).toBe(looseReplayKey("/v1/chat/completions", onDevelop));
		expect(looseReplayKey("/v1/chat/completions", onPr)).not.toBe(
			looseReplayKey("/v1/chat/completions", onPr.replace("Where do you run?", "Who runs you?"))
		);
		expect(looseReplayKey("/v1/chat/completions", "not json")).toBeNull();
	});

	it("a recording run that hits an exact recording without a loose key writes one, so older recordings become reachable", async () => {
		const exact = replayKey("/v1/chat/completions", onDevelop);
		shared.set(`develop:${exact}`, { requestHash: exact, path: "/v1/chat/completions", host: "api.mistral.ai", status: 200, headers: {}, body: SSE, recordedAt: "2026-10-14T00:00:00Z" });
		await (await replayOrRecord(URL_, { method: "POST", body: onDevelop }, vi.fn())).text();
		await settle();
		// No tools offered, so the tool key is the same key and is written once.
		expect(recorded().map(([k]) => k)).toEqual([`${SCOPE}:${looseReplayKey("/v1/chat/completions", onDevelop)}`]);
	});
});

describe("replay of a tool-using turn across runs (SOL-217)", () => {
	const PATH = "/v1/chat/completions";
	const toolTurn = (o: { ids?: [string, string]; results?: [string, string]; description?: string; args?: string } = {}) => {
		const [a, b] = o.ids ?? ["call_abc", "call_def"];
		const [ra, rb] = o.results ?? ["Zurich is in Switzerland.", "Population 421,878."];
		return JSON.stringify({
			model: "mistral-large-3",
			messages: [
				{ role: "system", content: "You are Alpha." },
				{ role: "user", content: "Where is Zurich?" },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{ id: a, type: "function", function: { name: "web_search", arguments: o.args ?? '{"q":"Zurich"}' } },
						{ id: b, type: "function", function: { name: "fetch", arguments: '{"url":"https://example.org"}' } },
					],
				},
				{ role: "tool", tool_call_id: a, content: ra },
				{ role: "tool", tool_call_id: b, content: rb },
			],
			tools: [
				{ type: "function", function: { name: "web_search", description: o.description ?? "Search the web.", parameters: {} } },
				{ type: "function", function: { name: "fetch", description: "Fetch a page.", parameters: {} } },
			],
		});
	};

	it("matches when only the provider's tool_call ids differ", () => {
		expect(toolLooseReplayKey(PATH, toolTurn({ ids: ["chatcmpl-tool-1", "chatcmpl-tool-2"] }))).toBe(toolLooseReplayKey(PATH, toolTurn()));
	});

	it("keeps the pairing of a call and its result, so swapping which result answers which call is a different key", () => {
		const swapped = JSON.parse(toolTurn());
		swapped.messages[3].tool_call_id = "call_def";
		swapped.messages[4].tool_call_id = "call_abc";
		expect(toolLooseReplayKey(PATH, JSON.stringify(swapped))).not.toBe(toolLooseReplayKey(PATH, toolTurn()));
	});

	it("matches when only the tool output differs, as a live search returns different pages each run", () => {
		expect(toolLooseReplayKey(PATH, toolTurn({ results: ["Other page.", "Other figure."] }))).toBe(toolLooseReplayKey(PATH, toolTurn()));
	});

	it("matches when only a tool's description differs, keying tool schemas by name", () => {
		expect(toolLooseReplayKey(PATH, toolTurn({ description: "Search the web. Screening is off on this preview." }))).toBe(
			toolLooseReplayKey(PATH, toolTurn())
		);
	});

	it("still tells apart turns that called a tool with different arguments", () => {
		expect(toolLooseReplayKey(PATH, toolTurn({ args: '{"q":"Geneva"}' }))).not.toBe(toolLooseReplayKey(PATH, toolTurn()));
	});

	it("still tells apart turns that offered a different set of tools", () => {
		const fewer = JSON.parse(toolTurn());
		fewer.tools = fewer.tools.slice(0, 1);
		expect(toolLooseReplayKey(PATH, JSON.stringify(fewer))).not.toBe(toolLooseReplayKey(PATH, toolTurn()));
	});

	it("in mock mode still replays a recording stored under the SOL-208 key, which a request offering tools never shares with the tool key", async () => {
		const turn = toolTurn();
		expect(toolLooseReplayKey(PATH, turn)).not.toBe(looseReplayKey(PATH, turn));
		shared.set(`develop:${looseReplayKey(PATH, turn)}`, { requestHash: "x", path: PATH, host: "api.mistral.ai", status: 200, headers: {}, body: SSE, recordedAt: "2026-10-14T00:00:00Z" });
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, { method: "POST", body: turn.replace("You are Alpha.", "You are Alpha on a PR.") }, live, {}, "mock");
		expect(live).not.toHaveBeenCalled();
		expect(await res.text()).toBe(SSE);
	});

	it("in mock mode replays a tool turn whose tool output differs from the recording, through the tool key", async () => {
		shared.set(`develop:${toolLooseReplayKey(PATH, toolTurn())}`, { requestHash: "x", path: PATH, host: "api.mistral.ai", status: 200, headers: {}, body: SSE, recordedAt: "2026-10-14T00:00:00Z" });
		const live = vi.fn(async () => sse());
		const res = await replayOrRecord(URL_, { method: "POST", body: toolTurn({ results: ["Other page.", "Other figure."], ids: ["x1", "x2"] }) }, live, {}, "mock");
		expect(live).not.toHaveBeenCalled();
		expect(await res.text()).toBe(SSE);
	});

	it("logs which loose key a mock-mode hit came through and the ask it answered, so a spec's hits can be found in the logs", async () => {
		const { logger } = await import("$lib/chat/server/logger");
		const hitLine = () =>
			vi.mocked(logger.info).mock.calls.find(([, msg]) => String(msg).startsWith("[replay] hit on the conversation"))?.[0] as
				| { matched?: string; parts?: { ask?: string } }
				| undefined;
		const ask = requestParts(toolTurn()).ask;

		vi.mocked(logger.info).mockClear();
		shared.set(`develop:${toolLooseReplayKey(PATH, toolTurn())}`, { requestHash: "x", path: PATH, host: "api.mistral.ai", status: 200, headers: {}, body: SSE, recordedAt: "2026-10-14T00:00:00Z" });
		await replayOrRecord(URL_, { method: "POST", body: toolTurn({ results: ["Other page.", "Other figure."], ids: ["x1", "x2"] }) }, vi.fn(async () => sse()), {}, "mock");
		expect(hitLine()).toMatchObject({ matched: "tool", parts: { ask } });

		shared.clear();
		vi.mocked(logger.info).mockClear();
		shared.set(`develop:${looseReplayKey(PATH, toolTurn())}`, { requestHash: "x", path: PATH, host: "api.mistral.ai", status: 200, headers: {}, body: SSE, recordedAt: "2026-10-14T00:00:00Z" });
		await replayOrRecord(URL_, { method: "POST", body: toolTurn().replace("You are Alpha.", "You are Alpha on a PR.") }, vi.fn(async () => sse()), {}, "mock");
		expect(hitLine()).toMatchObject({ matched: "plain", parts: { ask } });
	});

	it("names which reply message differed in requestParts", () => {
		const a = requestParts(toolTurn()).reply_each.split(",");
		const b = requestParts(toolTurn({ results: ["Zurich is in Switzerland.", "Other figure."] })).reply_each.split(",");
		expect(a).toHaveLength(3);
		expect(a.map((h, i) => h === b[i])).toEqual([true, true, false]);
	});
});
