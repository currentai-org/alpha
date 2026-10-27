import { describe, it, expect } from "vitest";
import { peekServedModel, sameModelId, withServedModel } from "./servedModelPeek";

const enc = new TextEncoder();

/** A stream that yields each string as its own read, the way a network body arrives in pieces. */
function pieces(...parts: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(c) {
			for (const p of parts) c.enqueue(enc.encode(p));
			c.close();
		},
	});
}

const sse = (model: string, content: string) =>
	`data: ${JSON.stringify({ model, choices: [{ delta: { content } }] })}\n\n`;

describe("peekServedModel", () => {
	it("reads the model off a streamed body and replays every byte, in order, to the reader after it", async () => {
		const body = sse("aisingapore/Qwen-SEA-LION-v4-32B-IT", "I") + sse("aisingapore/Qwen-SEA-LION-v4-32B-IT", " don't") + "data: [DONE]\n\n";
		const res = new Response(pieces(body.slice(0, 20), body.slice(20, 70), body.slice(70)), {
			headers: { "content-type": "text/event-stream" },
		});

		const { model, response } = await peekServedModel(res);

		expect(model).toBe("aisingapore/Qwen-SEA-LION-v4-32B-IT");
		expect(await response.text()).toBe(body);
	});

	it("stops reading once the model is known, leaving the rest of the stream unread until asked", async () => {
		let pulls = 0;
		const src = new ReadableStream<Uint8Array>({
			pull(c) {
				pulls++;
				c.enqueue(enc.encode(sse("swiss-ai/apertus-v1.5-70b", "x")));
				if (pulls === 50) c.close();
			},
		});
		const { model } = await peekServedModel(
			new Response(src, { headers: { "content-type": "text/event-stream" } })
		);

		expect(model).toBe("swiss-ai/apertus-v1.5-70b");
		expect(pulls).toBeLessThan(5); // one chunk named it; the peek did not drain the answer
	});

	it("reads the model off a JSON body and returns an unread copy of it", async () => {
		const json = JSON.stringify({ model: "aisingapore/Qwen-SEA-LION-v4-32B-IT", choices: [] });
		const { model, response } = await peekServedModel(
			new Response(json, { headers: { "content-type": "application/json" } })
		);

		expect(model).toBe("aisingapore/Qwen-SEA-LION-v4-32B-IT");
		expect(await response.text()).toBe(json);
	});

	it("reads the provider a body names alongside the model, streamed or JSON", async () => {
		const chunk = `data: ${JSON.stringify({ model: "mistralai/mistral-large-2610", provider: "Mistral", choices: [] })}\n\n`;
		const streamed = await peekServedModel(
			new Response(pieces(chunk), { headers: { "content-type": "text/event-stream" } })
		);
		const json = await peekServedModel(
			new Response(JSON.stringify({ model: "m", provider: "Mistral" }), {
				headers: { "content-type": "application/json" },
			})
		);

		expect(streamed.provider).toBe("Mistral");
		expect(json.provider).toBe("Mistral");
		expect((await peekServedModel(new Response(pieces(sse("m", "x")), { headers: { "content-type": "text/event-stream" } }))).provider).toBeUndefined();
	});

	it("passes an error response through untouched, with no model", async () => {
		const res = new Response('{"error":"at capacity"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});
		const out = await peekServedModel(res);

		expect(out.model).toBeUndefined();
		expect(out.response).toBe(res);
	});
});

describe("sameModelId", () => {
	it("ignores case and LiteLLM's openai/ prefix", () => {
		expect(sameModelId("swiss-ai/Apertus-v1.5-70B", "swiss-ai/apertus-v1.5-70b")).toBe(true);
		expect(sameModelId("openai/swiss-ai/Apertus-v1.5-70B", "swiss-ai/apertus-v1.5-70b")).toBe(true);
	});

	it("tells a different model apart", () => {
		expect(sameModelId("aisingapore/Qwen-SEA-LION-v4-32B-IT", "swiss-ai/apertus-v1.5-70b")).toBe(false);
	});
});

describe("withServedModel (the wrong_model_served fault)", () => {
	const SUB = "aisingapore/Qwen-SEA-LION-v4-32B-IT";

	it("makes every streamed chunk name the substitute while the headers and the text stay as they were, so the peek reads a swap", async () => {
		const body = sse("swiss-ai/apertus-v1.5-70b", "Tokyo") + sse("swiss-ai/apertus-v1.5-70b", " is") + "data: [DONE]\n\n";
		const res = new Response(pieces(body.slice(0, 33), body.slice(33, 90), body.slice(90)), {
			headers: { "content-type": "text/event-stream", "x-litellm-model-group": "swiss-ai/apertus-v1.5-70b" },
		});

		const swapped = await withServedModel(res, SUB);
		expect(swapped.headers.get("x-litellm-model-group")).toBe("swiss-ai/apertus-v1.5-70b");
		const { model, response } = await peekServedModel(swapped);
		expect(model).toBe(SUB);
		const text = await response.text();
		expect(text).not.toContain("apertus");
		expect(text).toContain('"content":"Tokyo"');
		expect(text).toContain("data: [DONE]");
	});

	it("rewrites a JSON body's model too", async () => {
		const res = new Response(JSON.stringify({ model: "mistral-large-2512", choices: [] }), {
			headers: { "content-type": "application/json" },
		});
		const { model } = await peekServedModel(await withServedModel(res, SUB));
		expect(model).toBe(SUB);
	});

	it("leaves a failed response untouched, so the fault never turns an error into a served answer", async () => {
		const res = new Response("upstream down", { status: 503, headers: { "content-type": "text/event-stream" } });
		expect(await withServedModel(res, SUB)).toBe(res);
	});
});
