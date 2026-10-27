import { describe, it, expect } from "vitest";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";

// LIVE CONTRACT CHECK for the OpenAI-compatible STREAMING wire shape.
//
// This is the shape the whole product rests on: the main turn (LiteLLM → Apertus), the second-opinion
// panel, the search-decision classifiers and the query rewriter all parse `choices[0].delta.content`
// out of SSE frames terminated by `data: [DONE]`. Other specs cover it only incidentally, in that a
// TOTAL break would fail them (CUR-81). A renamed or
// restructured delta would not error; it would stream zero visible tokens, which is precisely the
// "200 with an empty stream" failure the synthetic turn was built to catch, one layer down.
//
// WHY NOT THE SECOND-OPINION MODEL ITSELF. `SECOND_OPINION_MODEL` in production is zai-org/GLM-5.2-FP8, which
// spends most of its budget on hidden `reasoning_content` and answers in ~10s rather than the ~0.5s the
// model below takes. Pinning the general wire contract to it would make a nightly job slow for no extra
// coverage. It gets its own case at the bottom of this file instead, because its FRAME SHAPE differs.
//
// That model does not time out: it finishes in about 10s direct. An empty reply at ~10s through the
// app looks identical to a timeout from the outside, and its cause is on our side (the merged-usage
// case below).
//
// Consequence worth stating: this does NOT prove the second-opinion feature works end to end. It proves
// the transport it shares with everything else still has the shape we parse.

const LIVE = process.env.OPENAI_WIRE_LIVE === "1";
const BASE = (process.env.SECOND_OPINION_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SECOND_OPINION_API_KEY || process.env.HF_TOKEN || "";
// Recorded as fast in second-opinion/+server.ts; deliberately NOT the configured panel model. This is
// hfJudgeClient.ts's DEFAULT_JUDGE_MODEL, which answers "ok" on the gateway with the X-HF-Bill-To header
// this file already sends below. A model deprovisioned from the gateway fails every live run
// identically and buries real vendor-health signal (CUR-519).
const MODEL = process.env.OPENAI_WIRE_MODEL || "Qwen/Qwen2.5-72B-Instruct";
// The configured panel/aggregator model, pinned only for the merged-usage case at the bottom.
const PANEL_MODEL = process.env.SECOND_OPINION_MODEL || "zai-org/GLM-5.2-FP8";
// The HF router attributes an unbilled call to the TOKEN'S PERSONAL namespace, which has no
// Inference-Providers grant → 403. Every caller in src/ sends this header (endpointOai, moderation,
// rag/env, the judge client); a test that omits it reproduces a 403 that is about the test, not the
// vendor. Same class of mistake as the rerank credential order.
const BILL_TO = process.env.HF_BILL_TO || "";
const ready = LIVE && Boolean(BASE && KEY);

describe.skipIf(!ready)("OpenAI-compatible streaming wire contract (live)", () => {
	it("streams SSE frames carrying choices[0].delta.content, terminated by [DONE]", async () => {
		const res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${KEY}`,
				// The HF router WAFs the OpenAI SDK's default UA; warm.ts overrides it for the same reason.
				"User-Agent": "aipotluck.org",
				...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: "user", content: "Reply with exactly: ok" }],
				// 16 tokens is plenty for a model that answers directly and nowhere near enough for a reasoning
				// model, which spends them all thinking and never reaches its answer; the result would then
				// depend on whether it opens a think block on a trivial prompt. 256 fits a short think block
				// plus "ok", still one cheap call.
				max_tokens: 256,
				stream: true,
			}),
			signal: AbortSignal.timeout(90_000),
		});

		expect(res.status, "non-2xx here means no answers at all, product-wide").toBe(200);
		expect(res.body).toBeTruthy();

		let sawDone = false;
		let text = "";
		let frames = 0;
		let choiceFrames = 0;
		let reasoning = "";
		let buf = "";
		const decoder = new TextDecoder();
		for await (const chunk of res.body!) {
			buf += decoder.decode(chunk as Uint8Array, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const raw of lines) {
				const line = raw.trim();
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") {
					sawDone = true;
					continue;
				}
				frames++;
				const json = JSON.parse(payload);
				const choice = json?.choices?.[0];
				// A frame with NO choice is the trailing usage-only chunk, which is legitimate: it is half
				// of the `stream_options.include_usage` convention, and a backend may send it in addition
				// to merging usage into the finish_reason chunk (one GLM-5.2 sample did both, two usage
				// frames in one stream). Asserting a delta on EVERY frame made this red against exactly
				// the streams CUR-153 is about. Skip them; `choiceFrames` below keeps the contract armed.
				if (!choice) continue;
				choiceFrames++;
				// The exact access path every consumer uses, on the frames that claim to carry a choice.
				const delta = choice.delta;
				expect(delta, "choices[0].delta missing — every consumer reads exactly this").toBeDefined();
				if (typeof delta.content === "string") text += delta.content;
				// Reasoning models put their tokens in reasoning_content / reasoning, not content, and can
				// spend a whole budget there without ever emitting content — GLM-5.2-FP8 does this. Counted
				// separately rather than folded into `text`, because "the stream carried tokens" and "the
				// stream carried an ANSWER" are different facts and only the second one renders. Folding
				// them together would make the assertion below green on a stream a user sees nothing from.
				if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
				if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
			}
		}

		expect(frames, "no SSE data frames at all").toBeGreaterThan(0);
		// Without this, a stream of nothing but usage-only frames would skip the loop body entirely and
		// the delta contract would go unasserted rather than red.
		expect(
			choiceFrames,
			"every frame was choice-free — no frame ever carried choices[0], so the delta contract was never exercised"
		).toBeGreaterThan(0);
		// The failure this exists to catch: frames arrive, the stream looks plausible, nothing renders.
		// The message distinguishes the two ways that happens, because they have different owners: a
		// stream carrying NEITHER is a wire/backend problem, while a stream carrying only reasoning is
		// the model spending its whole budget thinking — which empties a second-opinion panelist via
		// stripThink and is a token-budget question, not a wire one (CUR-149).
		expect(
			text.trim().length,
			reasoning.trim().length > 0
				? `only reasoning_content arrived (${reasoning.trim().length} chars), never delta.content — the model never finished thinking inside its budget, so a consumer reading content sees an empty answer`
				: "frames streamed but neither delta.content nor reasoning_content carried text — a user would see an empty answer"
		).toBeGreaterThan(0);
		// Absent [DONE] the stream never terminates cleanly and consumers hang to their deadline.
		expect(sawDone, "no [DONE] terminator — consumers would hang until their timeout").toBe(true);
	}, 120_000);

	// Non-streaming is a separate shape (`message.content`, not `delta.content`) and is what the
	// search-decision classifiers use. Cheap to pin while we are here.
	it("non-streaming responses carry choices[0].message.content", async () => {
		const res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${KEY}`,
				"User-Agent": "aipotluck.org",
				...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: "user", content: "Reply with exactly: ok" }],
				// 16 tokens is plenty for a model that answers directly and nowhere near enough for a reasoning
				// model, which spends them all thinking and never reaches its answer; the result would then
				// depend on whether it opens a think block on a trivial prompt. 256 fits a short think block
				// plus "ok", still one cheap call.
				max_tokens: 256,
				stream: false,
			}),
			signal: AbortSignal.timeout(90_000),
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(typeof json?.choices?.[0]?.message?.content, "message.content is the non-stream path").toBe(
			"string"
		);
	}, 120_000);

	// The frame shape under test. Providers may attach `usage` to a trailing choice-free chunk (the
	// stream_options.include_usage convention) or MERGE it into the chunk carrying finish_reason.
	// openAIChatToTextGenerationStream must not skip a chunk because it carries usage: on the merged shape
	// that is the only chunk it marks `last`, and skipping it drops generated_text, so the answer vanishes
	// while the counts survive. Unit tests pin the transform against a transcript; this pins the transcript
	// against the vendor, so a backend that switches shape is learned here rather than from a user.
	//
	// This asserts nothing about WHICH shape arrives. Either is legal and the transform handles both.
	// What it asserts is that a stream carrying usage still carries text, a property that can fail
	// end to end while every layer below looks healthy.
	it("a stream carrying usage still carries answer text, merged shape or trailing", async () => {
		const res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${KEY}`,
				"User-Agent": "aipotluck.org",
				...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
			},
			body: JSON.stringify({
				model: PANEL_MODEL,
				messages: [{ role: "user", content: "Name one Swiss city." }],
				// GLM-5.2 is a reasoning model and its thinking length varies per call: at 512 a run can
				// spend all 512 on reasoning and end on finish_reason "length" with no content (CUR-2611).
				// This case is about where usage sits, so give the model room to finish.
				max_tokens: 4096,
				stream: true,
			}),
			signal: AbortSignal.timeout(90_000),
		});
		expect(res.status).toBe(200);

		let text = "";
		let reasoning = "";
		let finishReason: string | null = null;
		let usageChunks = 0;
		let usageMergedWithFinish = 0;
		let sawFinishReason = false;
		let buf = "";
		const decoder = new TextDecoder();
		for await (const chunk of res.body!) {
			buf += decoder.decode(chunk as Uint8Array, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const raw of lines) {
				const line = raw.trim();
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") continue;
				const json = JSON.parse(payload);
				const choice = json?.choices?.[0];
				if (typeof choice?.delta?.content === "string") text += choice.delta.content;
				const thought = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
				if (typeof thought === "string") reasoning += thought;
				if (choice?.finish_reason) {
					sawFinishReason = true;
					finishReason = choice.finish_reason;
				}
				if (json?.usage) {
					usageChunks++;
					if (choice?.finish_reason) usageMergedWithFinish++;
				}
			}
		}

		// Without a finish_reason the transform has no `last` chunk and emits no final under EITHER shape.
		expect(sawFinishReason, "no finish_reason in the stream — nothing would ever be marked final").toBe(
			true
		);
		// A reasoning-only stream that ran out of tokens is a budget problem, not CUR-153's dropped frame,
		// so it gets its own message rather than reading as a wire defect.
		expect(
			text.trim().length,
			reasoning.trim().length > 0 && finishReason === "length"
				? `only reasoning arrived (${reasoning.trim().length} chars) before finish_reason "length" — the model spent the whole budget thinking; raise max_tokens, this is not the CUR-153 wire defect`
				: "usage frames arrived but no answer text did — the exact end state CUR-153 produced"
		).toBeGreaterThan(0);
		// Recorded, not asserted: which shape this backend sends today. A change here is the signal to
		// re-read the transform, not a failure in itself.
		console.info(
			`[wire] ${PANEL_MODEL}: usage chunks=${usageChunks}, merged with finish_reason=${usageMergedWithFinish}`
		);
	}, 120_000);

	// THE SDK'S OWN PARSING, which every case above deliberately bypasses.
	//
	// The cases above use raw `fetch`, on purpose: they pin what the VENDOR emits, independent of any
	// client library. That leaves a gap nothing else covers — whether the openai SDK version we actually
	// ship can read what the vendor actually sends. Two independent things, and only their conjunction
	// puts tokens on a screen.
	//
	// An SDK major that restructures streaming can pass type checks, a green suite and a build while
	// failing on the wire: only a real turn proves the wire behaviour. A raw-fetch spec stays green
	// through an SDK that cannot parse a single frame.
	//
	// Goes through `createOpenAIClient` rather than `new OpenAI(...)` so it exercises the construction
	// path the app uses, including the maxRetries floor that verify-openai-retries.mjs exists to defend.
	// Same model and prompt as the first case, so a red here against a green there isolates the SDK as
	// the difference.
	it("the openai SDK version we ship can iterate this gateway's stream", async () => {
		const client = await createOpenAIClient({
			baseURL: BASE,
			apiKey: KEY,
			// Required since CUR-1345, and the value is part of what this spec asserts: a live gateway that
			// hangs must fail this test rather than hold it open until the runner's own timeout, which
			// reports as a flaky suite instead of a broken wire.
			timeout: 30_000,
			// Same reason as the raw-fetch case: the HF router WAFs the SDK's default User-Agent, and
			// every caller in src/ sends X-HF-Bill-To or eats a 403 about the test rather than the vendor.
			defaultHeaders: {
				"User-Agent": "aipotluck.org",
				...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
			},
		});

		const stream = await client.chat.completions.create(
			{
				model: MODEL,
				messages: [{ role: "user", content: "Reply with exactly: ok" }],
				max_tokens: 256,
				stream: true,
			},
			{ signal: AbortSignal.timeout(90_000) }
		);

		let chunks = 0;
		let text = "";
		for await (const part of stream) {
			chunks++;
			const delta = part.choices?.[0]?.delta;
			text += delta?.content ?? "";
			// Reasoning models carry the text here instead — same allowance the raw-fetch case makes, and
			// for the same reason: "the SDK parsed frames" is the claim, not "the model was terse".
			text += (delta as { reasoning_content?: string } | undefined)?.reasoning_content ?? "";
		}

		// Reaching here at all means the SDK's async iterator terminated cleanly on `[DONE]` rather than
		// hanging to the deadline, which is the other half of what v7 rewrote.
		expect(
			chunks,
			"the SDK yielded no chunks — it could not parse a stream the raw-fetch case above can read"
		).toBeGreaterThan(0);
		expect(
			text.trim().length,
			"the SDK yielded chunks but no text came out of choices[0].delta — a user sees an empty answer"
		).toBeGreaterThan(0);
		console.info(`[wire] openai SDK: ${chunks} chunks, ${text.trim().length} chars`);
	}, 120_000);
});
