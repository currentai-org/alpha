// The per-turn injection fence wraps the person's message in `<Q_xxxxxxxx>` tags (grounding.ts,
// native.ts), and a reasoning model narrates it: "The user has provided a message inside the
// <Q_33024de9> tags." The answer is scrubbed server-side (stripFenceTags), but the reasoning panel shows
// the model's text as it streams, so the visitor read the opaque nonce. This is the panel's scrub. It matches
// only our nonce shape, Q_ + 8 hex (randomUUID.slice(0, 8)), as a tag or bare.

// A model whose harness row sets compactFence (harnessProfiles.ts) gets QUESTION_ + 4 digits instead: in a
// replay of the self-host walk turn, qwen2.5-0.5b at temperature 0 answered 10 of 10 under that shape and
// 9 of 10 under a fresh Q_ + 8 hex, 8 of 10 under Q_ + 8 digits.
export const COMPACT_FENCE_PREFIX = "QUESTION_";
/** Both fence nonce shapes, as a regex source for every matcher that must recognise one. */
export const FENCE_NONCE_SOURCE = `(?:Q_[0-9a-f]{8}|${COMPACT_FENCE_PREFIX}\\d{4})`;

const FENCE_RE = new RegExp(`</?${FENCE_NONCE_SOURCE}>|\\b${FENCE_NONCE_SOURCE}\\b`, "g");

// While a tag is still arriving the text can end in `<`, `<Q`, `</Q_3a`, `<QUEST`…; holding that tail back
// keeps a half-written nonce off the screen until the next token says whether it is one.
const TAIL_RE = /<\/?([A-Za-z0-9_]{0,13})$/;
function isNoncePrefix(s: string): boolean {
	return (
		/^Q(?:_[0-9a-f]{0,8})?$/.test(s) ||
		s === "" ||
		COMPACT_FENCE_PREFIX.startsWith(s) ||
		new RegExp(`^${COMPACT_FENCE_PREFIX}\\d{0,4}$`).test(s)
	);
}
function dropPartialTail(text: string): string {
	const tail = TAIL_RE.exec(text);
	return tail && isNoncePrefix(tail[1]) ? text.slice(0, tail.index) : text;
}

/** Removes the fence nonce from model text a visitor reads, tag or bare; text without one is returned as is. */
export function scrubFenceNonce(text: string, streaming = false): string {
	if (!text.includes("Q") && !(streaming && text.endsWith("<"))) return text;
	let out = text.replace(FENCE_RE, "");
	if (out !== text) out = out.replace(/([^\s]) {2,}(?=\S)/g, "$1 ");
	return streaming ? dropPartialTail(out) : out;
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
 * could still become one is held back until it ends.
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
