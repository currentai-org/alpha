import { describe, it, expect, vi } from "vitest";
import { screenOutputStream } from "./screenStream";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { OutputScreenResult } from "$lib/chat/server/moderation";

// DEMO — not a behavior spec. Shows that chunked+context-windowed output screening can miss a verdict
// that only fires when a classifier sees the WHOLE answer, because two signal fragments end up more
// than CONTEXT_CHARS (200) apart and never land in the same screen call together. Uses placeholder
// markers, not real unsafe content — this is a mechanical proof about the batching/windowing, not a
// claim about what Coop specifically would flag.

async function* src(events: MessageUpdate[]): AsyncGenerator<MessageUpdate> {
	for (const e of events) yield e;
}
const tok = (token: string): MessageUpdate => ({ type: MessageUpdateType.Stream, token });
const fin = (text: string): MessageUpdate => ({
	type: MessageUpdateType.FinalAnswer,
	text,
	interrupted: false,
});
async function drain(gen: AsyncGenerator<MessageUpdate>) {
	const out: MessageUpdate[] = [];
	for await (const e of gen) out.push(e);
	return out;
}
const streamedText = (events: MessageUpdate[]) =>
	events
		.filter((e): e is Extract<MessageUpdate, { type: MessageUpdateType.Stream }> => e.type === MessageUpdateType.Stream)
		.map((e) => e.token)
		.join("");

describe("chunked output screening — cross-chunk blind spot", () => {
	it("misses a verdict that requires seeing both halves of the answer at once", async () => {
		// MARKER_A lands in the first ~120-char fast-path chunk.
		const opening = "MARKER_A appears right here in the opening sentence of the answer. ";
		// ~300+ chars, ONE run-on sentence (no internal period) so it flushes as its own batch
		// (>= MIN_CHUNK_CHARS) instead of getting grouped with the closing sentence — enough inert
		// text to push MARKER_A out of the 200-char context window (CONTEXT_CHARS in screenStream.ts)
		// carried into the later screen call.
		const filler =
			"unrelated context that pushes the marker out of the rolling window ".repeat(4) +
			"this is the end of the filler section. ";
		// MARKER_B lands well past the filler, in a later batch.
		const closing = "And now, much later in the same answer, MARKER_B shows up too.";
		const fullText = opening + filler + closing;

		// A classifier that only fires when it can see BOTH markers together — modeling a violation
		// whose signal is genuinely distributed across the answer (neither half alone is a violation).
		const calls: { text: string; hasA: boolean; hasB: boolean }[] = [];
		const distributedSignalScreen = vi.fn(async (text: string): Promise<OutputScreenResult> => {
			const hasA = text.includes("MARKER_A");
			const hasB = text.includes("MARKER_B");
			calls.push({ text, hasA, hasB });
			return hasA && hasB
				? { blocked: true, kind: "content_policy", category: "distributed-signal" }
				: { blocked: false, kind: null };
		});

		// 1) What a WHOLE-DOCUMENT screen (one call, the full answer) would have decided:
		const wholeDocVerdict = await distributedSignalScreen(fullText);

		// 2) What the REAL chunked pipeline decides, streaming the same text token-by-token:
		const events = await drain(
			screenOutputStream(src([tok(fullText), fin(fullText)]), {
				screen: distributedSignalScreen,
			})
		);

		console.log(`\n[chunk-blindspot demo] ${calls.length - 1} chunk screen call(s) after the whole-doc call:`);
		for (const c of calls.slice(1)) {
			console.log(
				`  chunk (${c.text.length} chars) — hasA=${c.hasA} hasB=${c.hasB} — ${JSON.stringify(c.text.slice(0, 60))}...`
			);
		}
		console.log(`[chunk-blindspot demo] whole-document verdict: blocked=${wholeDocVerdict.blocked}`);
		console.log(`[chunk-blindspot demo] chunked-pipeline verdict: released full text unblocked=${streamedText(events) === fullText}\n`);

		// The whole-document classifier WOULD have blocked it...
		expect(wholeDocVerdict.blocked).toBe(true);
		// ...but no individual chunk call ever contains both markers together...
		expect(calls.slice(1).some((c) => c.hasA && c.hasB)).toBe(false);
		// ...so the real streaming pipeline ships the entire answer, unblocked.
		expect(streamedText(events)).toBe(fullText);
	});
});
