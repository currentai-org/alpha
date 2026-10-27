// The opening words of each harness's fenced-turn preamble, defined in fenceTags.ts so the reasoning
// panel can read them too. The prompts build their sentence from these, and honestyStream treats an
// answer that opens with one as a recital of our own prompt (CUR-3886): some models repeat the whole
// preamble to the length cap instead of answering.
import { NATIVE_FENCE_OPENING, SCAFFOLDED_FENCE_OPENING } from "$lib/chat/utils/fenceTags";

export { NATIVE_FENCE_OPENING, SCAFFOLDED_FENCE_OPENING };

const OPENINGS = [SCAFFOLDED_FENCE_OPENING, NATIVE_FENCE_OPENING].map((o) => o.toLowerCase());

/** True when the answer opens with a fenced-turn preamble, ignoring leading whitespace, quote marks
 *  and markdown emphasis or headings. A match anywhere later in the answer does not count. */
export function opensWithFencePreamble(answer: string): boolean {
	const head = answer
		.replace(/^[\s>#*_"'`“”‘’]+/, "")
		.replace(/[‘’]/g, "'")
		.slice(0, 60)
		.toLowerCase();
	return OPENINGS.some((o) => head.startsWith(o));
}
