// A visitor's own numbered sources, pasted into their message (CUR-3844).
//
// Someone who pastes "[1] Smith 2021, ..." and "[2] ..." and asks for a cited answer expects the answer's
// [1] and [2] to mean those. Our retrieved sources share the same [n] namespace, so without this the
// no-source guard deleted the visitor's markers as fabricated, and a searched turn relinked them to web
// pages they never gave. The rule reads only the message's shape, so it holds in any language: lines
// that open with [1], [2], … in order, outside code. The server numbers its own sources after them and the guards treat 1..k as backed; the
// renderer shows each as the visitor's text rather than a link. Shared by both, so they agree on k.

export type VisitorSource = { n: number; text: string };

/** Longest text kept per source; the renderer shows it as the marker's label. */
const MAX_TEXT = 120;

/**
 * The visitor's numbered sources, in order: each line that starts with `[n]` (after optional indent or a
 * list bullet), counting up from [1] without a gap. A list that skips a number stops at the gap, and one
 * that does not start at [1] is not a source list. Lines inside a fenced code block are ignored.
 */
export function parseVisitorSources(message: string | undefined): VisitorSource[] {
	const out: VisitorSource[] = [];
	if (!message || !message.includes("[")) return out;
	let inFence = false;
	for (const raw of message.split(/\r?\n/)) {
		const line = raw.trimStart();
		if (line.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const marker = /^(?:[-*•]\s+)?\[(\d{1,3})\]\s*(.*)$/.exec(line);
		if (!marker) continue;
		const n = Number(marker[1]);
		if (n !== out.length + 1) {
			// A repeat of an earlier number (a reference back to it) is not a new source; anything else
			// out of order ends the list.
			if (n >= 1 && n <= out.length) continue;
			break;
		}
		const text = marker[2].trim();
		if (!text) break;
		out.push({ n, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text });
	}
	return out;
}

/** The per-turn note that tells the model the person's [1]..[k] are theirs and ours start at [k+1]. */
export function visitorSourcesNote(count: number): string | undefined {
	if (count <= 0) return undefined;
	const range = count === 1 ? "[1]" : `[1] to [${count}]`;
	return `The person's message numbers its own sources ${range}. When you use one of them, cite it by that same number. Any source retrieved on this turn is numbered from [${count + 1}].`;
}

type NumberedSource = { n?: number; title: string; link: string };

/**
 * The list the renderer resolves [n] against, by position: the visitor's [1]..[k] as unlinked entries,
 * then our stored sources in their server-assigned order. A message saved before CUR-3844 numbered our
 * sources from [1] even when the visitor's were there, so the visitor entries go in only when every
 * stored source is numbered after them; otherwise the stored numbering stands as it was saved.
 */
export function citationSourceList(
	visitorCount: number,
	stored: NumberedSource[]
): { title: string; link: string }[] {
	const firstStored = stored.length ? Math.min(...stored.map((s) => s.n ?? 0)) : Infinity;
	const visitor: NumberedSource[] =
		firstStored > visitorCount
			? Array.from({ length: visitorCount }, (_, i) => ({ n: i + 1, title: "", link: "" }))
			: [];
	return [...visitor, ...stored]
		.sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
		.map(({ title, link }) => ({ title, link }));
}
