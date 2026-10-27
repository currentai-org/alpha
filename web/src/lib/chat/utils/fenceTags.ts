// The per-turn injection fence wraps the person's message in `<Q_xxxxxxxx>` tags (grounding.ts,
// native.ts), and a reasoning model narrates it: "The user has provided a message inside the
// <Q_33024de9> tags." The answer is scrubbed server-side (stripFenceTags), but the reasoning panel shows
// the model's text as it streams, so the visitor read the opaque nonce. This is the panel's scrub. It matches
// only our nonce shape, Q_ + 8 hex (randomUUID().slice(0, 8)), as a tag or bare. (CUR-3164)

const FENCE_RE = /<\/?Q_[0-9a-f]{8}>|\bQ_[0-9a-f]{8}\b/g;

// While a tag is still arriving the text can end in `<`, `<Q`, `</Q_3a`…; holding that tail back keeps a
// half-written nonce off the screen until the next token says whether it is one.
const PARTIAL_TAIL_RE = /<\/?(?:Q(?:_[0-9a-f]{0,8})?)?$/;

/** Removes the fence nonce from model text a visitor reads, tag or bare; text without one is returned as is. */
export function scrubFenceNonce(text: string, streaming = false): string {
	if (!text.includes("Q") && !(streaming && text.endsWith("<"))) return text;
	let out = text.replace(FENCE_RE, "");
	if (out !== text) out = out.replace(/([^\s]) {2,}(?=\S)/g, "$1 ");
	return streaming ? out.replace(PARTIAL_TAIL_RE, "") : out;
}

// The opening words of each harness's fenced-turn preamble (grounding.ts, promptSections.ts). They live
// here so the reasoning panel can read them; fencePreamble.ts re-exports them for the server.
export const SCAFFOLDED_FENCE_OPENING = "The user's message is wrapped in";
export const NATIVE_FENCE_OPENING = "The person's latest message is wrapped in";
const FENCE_OPENINGS = [SCAFFOLDED_FENCE_OPENING, NATIVE_FENCE_OPENING].map((o) => o.toLowerCase());

// A sentence, a line break, or the unterminated tail, each with the spaces after it.
const SEGMENT_RE = /[^.!?\n]*(?:[.!?]+|\n|$)[ \t]*/g;

/**
 * A reasoning model restates our fence preamble ("The user's message is wrapped in markers."),
 * and once the nonce is scrubbed the visitor still reads our prompt plumbing. The restatement is never
 * one sentence: a model goes on to paraphrase the rest of the guard ("the question inside those tags", "I
 * should not mention the tags or the wrapper"), so a sentence that opens with one of our own preamble
 * openings drops the rest of its line with it. Lines before and after are kept as is. The trigger stays
 * our own preamble's words, so no wording of the model's is classified. While streaming, a tail that
 * could still become one is held back until it ends. (CUR-3945)
 */
export function scrubFenceNarration(text: string, streaming = false): string {
	let out = "";
	let dropped = false;
	let skippingLine = false;
	for (const [seg] of text.matchAll(SEGMENT_RE)) {
		if (!seg) continue;
		const endsLine = seg.includes("\n");
		if (skippingLine) {
			if (endsLine) skippingLine = false;
			continue;
		}
		const head = seg.trimStart().replace(/[‘’]/g, "'").toLowerCase();
		const atTail = !/[.!?\n]/.test(seg);
		const restates = head.length > 0 && FENCE_OPENINGS.some((o) => head.startsWith(o));
		const mayBecome = streaming && atTail && head.length > 0 && FENCE_OPENINGS.some((o) => o.startsWith(head));
		if (restates || mayBecome) {
			dropped = true;
			skippingLine = restates && !endsLine;
			continue;
		}
		out += seg;
	}
	return dropped ? out : text;
}
