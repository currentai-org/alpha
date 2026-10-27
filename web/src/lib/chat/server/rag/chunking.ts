// Split admin-uploaded document text into bounded, embeddable chunks. Mirrors the committed
// catalog's "short, self-contained snippet" shape: paragraph-first, sentence-fallback, hard
// char-bound. Pure + dependency-free so it's unit-testable in the hermetic CI gate. Retrieval is
// chunk-level (one rag_chunks row + one embedding per chunk), like the committed store.

import { CURATED_SNIPPET_CAP } from "./parseDoc";

/** Naive sentence split: runs of non-terminator chars ending in . ! ? (or the trailing remainder).
 *  Good enough to break an oversized paragraph; never used on text that already fits. */
function splitIntoSentences(paragraph: string): string[] {
	const matches = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
	return (matches ?? [paragraph]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Break `text` into chunks each at most `maxChars` long. Atomic units are paragraphs; an oversized
 * paragraph is split into sentences, and an oversized sentence into hard char slices — so no unit
 * (and therefore no chunk) ever exceeds `maxChars`. Units are then greedily packed to fill chunks.
 * Returns [] for empty/whitespace input.
 *
 * THE DEFAULT IS THE READER'S CAP. This is the producer end of the pipe whose consumer end is
 * `toSnippet(chunk.text, CURATED_SNIPPET_CAP)` in adminStore.ts, and the only production caller
 * (adminWrites.ts) passes no `maxChars`. A larger default would let an admin upload a 1,200-char
 * chunk and the model would be handed the first 480 of it with an ellipsis, silently: the answer reads
 * as honest, because the model is answering accurately about the fraction it received.
 *
 * build-rag-index.mjs splits at 420 for the same reason. It matters most where it is least visible:
 * the admin corpus is the create→retire→activate path used to CORRECT a wrong answer, so the text most
 * likely to be truncated is text written because the model got something wrong.
 *
 * Kept as a parameter rather than hardcoded so the specs can drive the splitter at small bounds, but
 * the default is the one value that makes producer and consumer agree without a call site having
 * to remember. `curatedSnippetsIntact.spec.ts` calls this bare, the way production does, and goes red
 * if the default ever drifts back above the reader's cap.
 *
 * COST: at 480 a document yields roughly 2.5x the chunks it would at 1200, against
 * `maxChunksPerDoc()` (default 50). The per-document ceiling is about 24k characters, and an upload
 * past it throws `RagWriteError` telling the admin to split it, which is a loud failure rather than
 * silent truncation.
 */
export function chunkDocumentText(text: string, maxChars = CURATED_SNIPPET_CAP): string[] {
	const bound = Math.max(1, Math.floor(maxChars));
	const clean = (text ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.trim();
	if (!clean) return [];

	// 1) Atomic units, each guaranteed ≤ bound.
	const units: string[] = [];
	for (const para of clean
		.split(/\n{2,}/)
		.map((p) => p.replace(/\n/g, " ").trim())
		.filter(Boolean)) {
		if (para.length <= bound) {
			units.push(para);
			continue;
		}
		for (const sentence of splitIntoSentences(para)) {
			if (sentence.length <= bound) {
				units.push(sentence);
				continue;
			}
			for (let i = 0; i < sentence.length; i += bound) {
				const slice = sentence.slice(i, i + bound).trim();
				if (slice) units.push(slice);
			}
		}
	}

	// 2) Greedily pack units (joined by a space) into chunks up to `bound`.
	const chunks: string[] = [];
	let buf = "";
	for (const unit of units) {
		if (!buf) {
			buf = unit;
		} else if (buf.length + 1 + unit.length <= bound) {
			buf = `${buf} ${unit}`;
		} else {
			chunks.push(buf);
			buf = unit;
		}
	}
	if (buf) chunks.push(buf);
	return chunks;
}
