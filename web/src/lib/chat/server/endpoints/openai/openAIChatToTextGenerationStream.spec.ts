import { describe, it, expect, vi } from "vitest";
import { logger } from "$lib/chat/server/logger";
import {
	openAIChatToTextGenerationStream,
	openAIChatToTextGenerationSingle,
	withTruncationNotice,
	TRUNCATION_NOTICE,
	turnShapeOf,
} from "./openAIChatToTextGenerationStream";

// Minimal chat-completion chunk: only the fields the transform reads.
type Chunk = {
	model?: string;
	choices: { delta: { content?: string }; finish_reason: string | null }[];
};
async function* chunks(parts: Chunk[]): AsyncGenerator<Chunk> {
	for (const p of parts) yield p;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stream = (parts: Chunk[]) => openAIChatToTextGenerationStream(chunks(parts) as any);

async function collect(gen: AsyncGenerator<unknown>) {
	const out: { text: string; final: string | null; truncated?: boolean }[] = [];
	for await (const e of gen) {
		const o = e as { token: { text: string }; generated_text: string | null; truncated?: boolean };
		out.push({ text: o.token.text, final: o.generated_text, truncated: o.truncated });
	}
	return out;
}

// WHAT THESE GUARANTEE, and what they deliberately do not. The transform's job is to say the
// generation was cut, NOT to write the notice: generate.ts discards the final token and
// screenOutputStream rebuilds the body from Stream tokens, so a notice on the final token or in
// generated_text never reaches the user. A test that pins text at this layer cannot go red for the
// failure that matters, so these pin the FLAG, and
// the delivery is pinned where it can actually break (screenStream.spec.ts, and withTruncationNotice
// below). CUR-149.
describe("openAIChatToTextGenerationStream — flags a generation cut at the token cap", () => {
	it("sets truncated on the final chunk when finish_reason is length, and leaves the text alone", async () => {
		const events = await collect(
			stream([
				{ choices: [{ delta: { content: "Half a thought" }, finish_reason: null }] },
				{ choices: [{ delta: { content: " that runs on" }, finish_reason: "length" }] },
			])
		);
		const last = events.at(-1);
		expect(last?.truncated).toBe(true);
		// Verbatim: the transform must not smuggle the notice into text that gets rebuilt downstream.
		expect(last?.final).toBe("Half a thought that runs on");
		// The last delta streams on its own ordinary token ahead of the final chunk (CUR-2081), so the
		// final chunk carries no text of its own.
		expect(events.at(-2)?.text).toBe(" that runs on");
		expect(last?.text).toBe("");
	});

	it("does NOT flag a natural stop", async () => {
		const events = await collect(
			stream([{ choices: [{ delta: { content: "All done." }, finish_reason: "stop" }] }])
		);
		expect(events.at(-1)?.final).toBe("All done.");
		expect(events.at(-1)?.truncated).toBeUndefined();
	});

	it("does NOT flag an empty generation cut at length (nothing was said to annotate)", async () => {
		const events = await collect(
			stream([{ choices: [{ delta: { content: "" }, finish_reason: "length" }] }])
		);
		expect(events.at(-1)?.final).toBe("");
		expect(events.at(-1)?.truncated).toBeUndefined();
	});
});

describe("withTruncationNotice — the single place the notice is written", () => {
	it("appends once and only once, however many times a final answer passes through", () => {
		const once = withTruncationNotice("A cut answer", true);
		expect(once).toBe("A cut answer" + TRUNCATION_NOTICE);
		// The route calls this at a chokepoint several producers reach; a re-emitted final must not stack.
		expect(withTruncationNotice(once, true)).toBe(once);
	});

	it("leaves an untruncated answer, and an empty one, untouched", () => {
		expect(withTruncationNotice("Complete.", false)).toBe("Complete.");
		expect(withTruncationNotice("Complete.", undefined)).toBe("Complete.");
		expect(withTruncationNotice("   ", true)).toBe("   ");
	});
});

describe("openAIChatToTextGenerationStream — usage accounting (stream_options.include_usage)", () => {
	it("surfaces prompt/completion/total + cached_tokens from the trailing usage-only chunk", async () => {
		const parts = [
			{ choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] },
			// trailing usage-only chunk: empty choices, populated usage (vLLM prefix-cache hit here)
			{
				choices: [],
				usage: {
					prompt_tokens: 1200,
					completion_tokens: 40,
					total_tokens: 1240,
					prompt_tokens_details: { cached_tokens: 1000 },
				},
			},
		];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const gen = openAIChatToTextGenerationStream(chunks(parts as any) as any);
		const usages: unknown[] = [];
		for await (const e of gen) {
			const u = (e as { usage?: unknown }).usage;
			if (u) usages.push(u);
		}
		expect(usages).toEqual([
			{ promptTokens: 1200, completionTokens: 40, totalTokens: 1240, cachedTokens: 1000 },
		]);
	});
});

// The other wire shape: usage MERGED into the finish_reason chunk. Transcribed from a
// zai-org/GLM-5.2-FP8 stream on the HF router — reasoning_content, then content, then a
// single closing chunk carrying finish_reason "stop", an empty content delta AND usage together.
//
// These names say what must survive, not which branch runs. "handles a merged usage chunk" would pass
// just as well if the transform swallowed the answer and only kept the token counts — which looks like
// an accounting detail until the panel's GLM panelist and its aggregator both return empty
// (CUR-153).
const GLM_MERGED = [
	{ choices: [{ delta: { role: "assistant", reasoning_content: "Bern " }, finish_reason: null }] },
	{ choices: [{ delta: { role: "assistant", reasoning_content: "vs Zurich." }, finish_reason: null }] },
	{ choices: [{ delta: { role: "assistant", content: "Bern is the capital." }, finish_reason: null }] },
	{
		choices: [{ delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 29,
			completion_tokens: 348,
			total_tokens: 377,
			prompt_tokens_details: { cached_tokens: 0 },
		},
	},
];

describe("openAIChatToTextGenerationStream — usage merged into the finish_reason chunk", () => {
	it("still emits generated_text — the answer must not be lost with the chunk that carries the counts", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const events = await collect(openAIChatToTextGenerationStream(chunks(GLM_MERGED as any) as any));
		const finals = events.map((e) => e.final).filter((f): f is string => f !== null);
		expect(finals).toHaveLength(1);
		expect(finals[0]).toBe("<think>Bern vs Zurich.</think>Bern is the capital.");
	});

	it("does not buy that back by dropping the counts", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const gen = openAIChatToTextGenerationStream(chunks(GLM_MERGED as any) as any);
		const usages: unknown[] = [];
		for await (const e of gen) {
			const u = (e as { usage?: unknown }).usage;
			if (u) usages.push(u);
		}
		expect(usages).toEqual([
			{ promptTokens: 29, completionTokens: 348, totalTokens: 377, cachedTokens: 0 },
		]);
	});

	it("emits the final answer BEFORE the counts, same order as the trailing shape", async () => {
		// generate.ts logs usage and moves on precisely because accounting can never gate an answer.
		// Reversing the order here would make that comment false without breaking anything visibly.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const gen = openAIChatToTextGenerationStream(chunks(GLM_MERGED as any) as any);
		const seen: string[] = [];
		for await (const e of gen) {
			const o = e as { generated_text: string | null; usage?: unknown };
			if (o.generated_text) seen.push("final");
			if (o.usage) seen.push("usage");
		}
		expect(seen).toEqual(["final", "usage"]);
	});
});

// The conversation route persists the turn on FinalAnswer, which comes from the chunk carrying
// generated_text. Provenance that trails it misses that write, so an export taken as the answer
// settles shows no served model (CUR-2078). And a consumer that stops reading early, as output
// screening does when its phase deadline trips, never reaches a late yield at all (CUR-2343).
describe("openAIChatToTextGenerationStream — header provenance goes out with the first chunk", () => {
	const served = { model: "swiss-ai/apertus-v1.5-70b", backend: "https://api.featherless.ai/v1" };
	const run = (parts: Chunk[]) =>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		openAIChatToTextGenerationStream(chunks(parts) as any, () => served);
	const kinds = async (gen: AsyncGenerator<unknown>) => {
		const out: string[] = [];
		for await (const e of gen) {
			const o = e as { routerMetadata?: unknown; generated_text: string | null };
			out.push(o.routerMetadata ? "metadata" : o.generated_text !== null ? "final" : "token");
		}
		return out;
	};

	it("yields the header metadata once, ahead of the first token", async () => {
		expect(
			await kinds(
				run([
					{ choices: [{ delta: { content: "Par" }, finish_reason: null }] },
					{ choices: [{ delta: { content: "is." }, finish_reason: "stop" }] },
				])
			)
		).toEqual(["metadata", "token", "token", "final"]);
	});

	it("has already yielded it when the consumer stops after the first token", async () => {
		const gen = run([
			{ choices: [{ delta: { content: "Par" }, finish_reason: null }] },
			{ choices: [{ delta: { content: "is" }, finish_reason: null }] },
			{ choices: [{ delta: { content: "." }, finish_reason: "stop" }] },
		]);
		const seen: string[] = [];
		for await (const e of gen) {
			const o = e as { routerMetadata?: unknown; token: { text: string } };
			seen.push(o.routerMetadata ? "metadata" : o.token.text);
			if (o.token.text === "Par") break; // the screen's phase deadline cancels the source here
		}
		expect(seen).toEqual(["metadata", "Par"]);
	});

	it("still yields it for a stream that sends no chunk", async () => {
		expect(await kinds(run([]))).toEqual(["metadata"]);
	});
});

// The HF router sends `x-inference-provider` and no served-model header, so a pinned GLM
// turn persisted a provider and an empty model. The body's own `model` is the router's report of what
// served, and it fills the gap only when the headers named no model. (CUR-1683)
describe("openAIChatToTextGenerationStream — a provider-only header report takes the served model from the body", () => {
	const metadataOf = async (
		headers: { model?: string; provider?: string },
		bodyModel: string,
		requestedModel?: string
	) => {
		const source = chunks([
			{ model: bodyModel, choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] },
		] as Chunk[]) as unknown as Parameters<typeof openAIChatToTextGenerationStream>[0];
		const gen = openAIChatToTextGenerationStream(
			source,
			() => headers,
			Date.now(),
			false,
			requestedModel
		);
		for await (const e of gen) {
			const o = e as { routerMetadata?: { model?: string; provider?: string } };
			if (o.routerMetadata) return o.routerMetadata;
		}
		return undefined;
	};

	it("records the body's model beside the provider the HF router named", async () => {
		expect(await metadataOf({ provider: "scaleway" }, "zai-org/GLM-5.2")).toEqual({
			provider: "scaleway",
			model: "zai-org/GLM-5.2",
		});
	});

	it("records the requested id when the provider names the same model by its short name", async () => {
		expect(
			(await metadataOf({ provider: "scaleway" }, "glm-5.2", "zai-org/GLM-5.2"))?.model
		).toBe("zai-org/GLM-5.2");
	});

	it("records a different model as the provider reported it, so a substitution stays visible", async () => {
		expect(
			(await metadataOf({ provider: "scaleway" }, "glm-4.6", "zai-org/GLM-5.2"))?.model
		).toBe("glm-4.6");
	});

	it("never overrides a model the headers or the lane seed already named", async () => {
		expect(
			(await metadataOf({ provider: "scaleway", model: "aisingapore/Qwen-SEA-LION-v4-32B-IT" }, "x/other"))
				?.model
		).toBe("aisingapore/Qwen-SEA-LION-v4-32B-IT");
	});
});

describe("openAIChatToTextGenerationSingle — flags a non-streamed answer cut at the token cap", () => {
	const run = async (finish_reason: string, content: string) => {
		const completion = {
			choices: [{ message: { content }, finish_reason }],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const out = [];
		for await (const e of openAIChatToTextGenerationSingle(completion)) {
			out.push(e as { generated_text: string; truncated?: boolean });
		}
		return out[0];
	};

	it("sets truncated and leaves the text for the one append site", async () => {
		const first = await run("length", "A cut answer");
		expect(first.truncated).toBe(true);
		expect(first.generated_text).toBe("A cut answer");
	});

	it("leaves a naturally-stopped non-streamed answer unflagged", async () => {
		const first = await run("stop", "Complete.");
		expect(first.truncated).toBeUndefined();
		expect(first.generated_text).toBe("Complete.");
	});
});

// Mistral can send `content` as a list of parts rather than a string (CUR-2340). Read as a string, the
// first such delta throws `content.trim is not a function` and the answer never finishes.
describe("openAIChatToTextGenerationStream — content sent as a list of parts", () => {
	it("finishes the answer with the text parts when a delta's content is a list, rather than throwing", async () => {
		const events = await collect(
			stream([
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{ choices: [{ delta: { content: [{ type: "text", text: "Hello" }] as any }, finish_reason: null }] },
				{
					choices: [
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						{ delta: { content: [{ type: "text", text: ", world." }] as any }, finish_reason: "stop" },
					],
				},
			])
		);
		expect(events.at(-1)?.final).toBe("Hello, world.");
	});

	it("keeps a thinking part out of the answer text", async () => {
		const parts = [
			{ type: "thinking", thinking: [{ type: "text", text: "Let me add these." }] },
			{ type: "text", text: "It is 4." },
		];
		const events = await collect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			stream([{ choices: [{ delta: { content: parts as any }, finish_reason: "stop" }] }])
		);
		const final = events.at(-1)?.final ?? "";
		expect(final.replace(/<think>[\s\S]*?<\/think>/, "")).toBe("It is 4.");
	});

	it("skips a part that carries no text (an image) instead of printing [object Object]", async () => {
		const parts = [
			{ type: "text", text: "See " },
			{ type: "image_url", image_url: { url: "https://example.test/a.png" } },
			{ type: "text", text: "above." },
		];
		const events = await collect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			stream([{ choices: [{ delta: { content: parts as any }, finish_reason: "stop" }] }])
		);
		expect(events.at(-1)?.final).toBe("See above.");
	});

	// Shapes as Large 3 streams them with a tool declared: a lone reference delta between
	// two string deltas, and a reference beside a text part.
	it("writes a reference part back as the [n] citation it stands for, never dropping it", async () => {
		const events = await collect(
			stream([
				{ choices: [{ delta: { content: "9% is recycled " }, finish_reason: null }] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{ choices: [{ delta: { content: [{ type: "reference", reference_ids: [3] }] as any }, finish_reason: null }] },
				{ choices: [{ delta: { content: ". In the US, 8.7%" }, finish_reason: null }] },
				{
					choices: [
						{
							delta: {
								content: [
									{ type: "reference", reference_ids: [7, 8] },
									{ type: "text", text: "." },
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
								] as any,
							},
							finish_reason: "stop",
						},
					],
				},
			])
		);
		expect(events.at(-1)?.final).toBe("9% is recycled [3]. In the US, 8.7%[7][8].");
	});

	// Deltas a model really streamed: a
	// reference naming a tool, then that call's arguments as plain text, split across deltas (CUR-2777).
	it("drops a call written into the answer (a reference naming a tool, then its JSON) so the visitor never reads it", async () => {
		const deltas: unknown[] = [
			"0% de la", " factura en algunas", " zonas)",
			[{ type: "reference", reference_ids: ["calculate"] }],
			'{"', "expression", '": "5', "0% *", ' 1"} [', "^", "1^", "].\n\nEn", " cambio,", " menor en", " comparación",
			[{ type: "reference", reference_ids: ["web_search"] }],
			'{"query": "', "por", "centaje de consumo", " aire a", 'condicionado"}', ".",
		];
		const events = await collect(
			stream([
				...deltas.map((content) => ({
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					choices: [{ delta: { content: content as any }, finish_reason: null }],
				})),
				{ choices: [{ delta: { content: "" }, finish_reason: "stop" }] },
			])
		);
		const final = events.at(-1)?.final ?? "";
		expect(final).toBe("0% de la factura en algunas zonas) [^1^].\n\nEn cambio, menor en comparación.");
		expect(final).not.toMatch(/"query"|"expression"|web_search|calculate/);
	});

	it("keeps the text after a reference naming a tool when no call follows it", async () => {
		const events = await collect(
			stream([
				{ choices: [{ delta: { content: "Heating costs most" }, finish_reason: null }] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{ choices: [{ delta: { content: [{ type: "reference", reference_ids: ["web_search"] }] as any }, finish_reason: null }] },
				{ choices: [{ delta: { content: " in winter." }, finish_reason: "stop" }] },
			])
		);
		expect(events.at(-1)?.final).toBe("Heating costs most in winter.");
	});

	// The same call typed as plain text, the tool's own name first. (CUR-2777)
	describe("a call typed into the answer as the tool's name then its JSON", () => {
		const run = (deltas: string[], toolNames = ["web_search", "calculate"]) =>
			collect(
				openAIChatToTextGenerationStream(
					chunks([
						...deltas.map((content) => ({ choices: [{ delta: { content }, finish_reason: null }] })),
						{ choices: [{ delta: { content: "" }, finish_reason: "stop" }] },
					] as never) as never,
					undefined,
					Date.now(),
					true,
					"mistral-large-2512",
					toolNames
				)
			).then((events) => (events.at(-1) as { final?: string } | undefined)?.final ?? "");

		it("drops it, split across deltas, and keeps the prose either side", async () => {
			expect(await run(["moins élevées.", "web_sea", 'rch{"query": "co', 'ût chauffage"}', " Voilà."])).toBe(
				"moins élevées. Voilà."
			);
		});

		it("keeps a tool's name written as an ordinary word", async () => {
			expect(await run(["Use web_search", " when facts change."])).toBe("Use web_search when facts change.");
		});

		it("gives back text held at the very end because it could have opened a call", async () => {
			expect(await run(["Ask the calc"])).toBe("Ask the calc");
		});

		it("drops nothing when the request declared no tools", async () => {
			expect(await run(['x web_search{"query": "a"}'], [])).toBe('x web_search{"query": "a"}');
		});
	});

	// CUR-2777, through a router that drops the `reference` part:
	// "The capital of Chile is Santiago{"query": "capital of Chile"}". Only the arguments are left.
	describe("a call left as bare arguments, with no reference and no tool name before it", () => {
		const TOOLS = [
			{ name: "web_search", parameters: { properties: { query: {} }, required: ["query"] } },
			{ name: "calculate", parameters: { properties: { expression: {} }, required: ["expression"] } },
			{ name: "current_datetime", parameters: { properties: { timezone: {} } } },
		];
		const run = (deltas: string[]) =>
			collect(
				openAIChatToTextGenerationStream(
					chunks([
						...deltas.map((content) => ({ choices: [{ delta: { content }, finish_reason: null }] })),
						{ choices: [{ delta: { content: "" }, finish_reason: "stop" }] },
					] as never) as never,
					undefined,
					Date.now(),
					true,
					"mistral-large-2512",
					TOOLS
				)
			).then((events) => (events.at(-1) as { final?: string } | undefined)?.final ?? "");

		it("drops arguments that fit a declared tool, split across deltas, and keeps the prose either side", async () => {
			expect(await run(["The capital of Chile is Santiago", '{"que', 'ry": "capital of', ' Chile"}', "."])).toBe(
				"The capital of Chile is Santiago."
			);
			expect(await run(['Half is {"expression": "50% * 1"} small.'])).toBe("Half is  small.");
		});

		it("still drops a call typed with its tool name, name included, when the tools carry schemas", async () => {
			expect(await run(["x web_search", '{"query": "a"}'])).toBe("x ");
			expect(await run(['x web_search{"query": "a", "extra": 1} y'])).toBe("x  y");
		});

		it("keeps an object whose keys fit no declared tool", async () => {
			expect(await run(['Send {"name": "Ada"} as the body.'])).toBe('Send {"name": "Ada"} as the body.');
		});

		it("keeps an object missing a key the tool requires", async () => {
			expect(await run(['Try {"timezone": "x", "query": 1, "extra": 2} here.'])).toBe(
				'Try {"timezone": "x", "query": 1, "extra": 2} here.'
			);
		});

		it("keeps a call-shaped object inside a code fence or inline code", async () => {
			const fenced = 'Example:\n```json\n{"query": "a"}\n```\nDone.';
			expect(await run([fenced])).toBe(fenced);
			expect(await run(["Pass `", '{"query": "a"}', "` to it."])).toBe('Pass `{"query": "a"}` to it.');
		});

		it("gives back a brace that never closes, and prose braces that are not JSON", async () => {
			expect(await run(["Sets like {1, 2} and {a"])).toBe("Sets like {1, 2} and {a");
		});
	});
});

// The first-chunk allowance can only be set per turn shape once the finish line records the
// shape, so Axiom can split Large 3's time to first chunk by photo turn and text turn. (CUR-4003)
describe("the [generation] finish line records the turn's shape (CUR-4003)", () => {
	it("counts each image part and every character of text, in string and part-array messages", () => {
		expect(
			turnShapeOf([
				{ content: "You are Alpha." },
				{
					content: [
						{ type: "text", text: "What is in this photo?" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
						{ type: "image_url", image_url: { url: "data:image/webp;base64,BBBB" } },
					],
				},
			])
		).toEqual({ imageParts: 2, promptChars: "You are Alpha.".length + "What is in this photo?".length });
	});

	it("reads a text-only turn as zero images, so a missing count never passes for a text turn", () => {
		expect(turnShapeOf([{ content: "hello" }, { content: undefined }])).toEqual({
			imageParts: 0,
			promptChars: 5,
		});
	});

	it("puts the shape on the finish line it was handed", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
		try {
			await collect(
				openAIChatToTextGenerationStream(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					chunks([{ choices: [{ delta: { content: "A cat." }, finish_reason: "stop" }] }]) as any,
					undefined,
					Date.now(),
					false,
					undefined,
					[],
					{ imageParts: 1, promptChars: 22 }
				)
			);
			const finish = info.mock.calls.find((c) => c[1] === "[generation] finish");
			expect(finish?.[0]).toMatchObject({ imageParts: 1, promptChars: 22 });
		} finally {
			info.mockRestore();
		}
	});
});

describe("openAIChatToTextGenerationStream — a tool call's name reaches dispatch and replay as the declared name", () => {
	// Medium 3.5 sent "\t\t  \nweb_search". Kept verbatim, the native kit ran no tool and the
	// next round replayed the padded name, which LiteLLM refused with a 400 that ended the turn. (CUR-4362)
	const toolStream = (name: string) =>
		openAIChatToTextGenerationStream(
			chunks([
				{
					model: "mistralai/mistral-medium-3-5",
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call_1", type: "function", function: { name, arguments: '{"query":"x"}' } },
								],
							} as Chunk["choices"][number]["delta"],
							finish_reason: "tool_calls",
						},
					],
				},
			]) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
			undefined,
			Date.now(),
			true,
			undefined,
			["web_search", "calculate"]
		);
	const callsOf = async (name: string) => {
		for await (const out of toolStream(name)) {
			const calls = (out as { toolCalls?: { id: string; name: string; arguments: string }[] }).toolCalls;
			if (calls) return calls;
		}
		return undefined;
	};

	it("strips leading and trailing whitespace (tabs, spaces, newlines) from a streamed tool call's name", async () => {
		expect(await callsOf("\t\t  \nweb_search \n")).toEqual([
			{ id: "call_1", name: "web_search", arguments: '{"query":"x"}' },
		]);
	});

	it("leaves an unpadded name exactly as sent, and logs nothing about it", async () => {
		const warn = vi.spyOn(logger, "warn");
		expect((await callsOf("web_search"))?.[0].name).toBe("web_search");
		expect(warn.mock.calls.filter((c) => c[1] === "[generation] tool call name normalised")).toEqual([]);
		warn.mockRestore();
	});

	it("logs the raw padded name, escaped, so which side added the padding stays measurable", async () => {
		const warn = vi.spyOn(logger, "warn");
		await callsOf("\t\tweb_search");
		const hits = warn.mock.calls.filter((c) => c[1] === "[generation] tool call name normalised");
		expect(hits.map((c) => c[0])).toEqual([
			{ model: "mistralai/mistral-medium-3-5", rawName: JSON.stringify("\t\tweb_search"), declared: true },
		]);
		warn.mockRestore();
	});
});
