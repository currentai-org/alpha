import { citationOrder } from './trace/citedIndices';

// One entry per page in the citation strip, without changing what the model saw (CUR-888).
//
// A catalog product whose description runs long is several retrieved chunks sharing one url, and each
// is its own source number in the model's input, so the strip listed one product three times. The
// model keeps all three: every piece of the description reaches it and the reader clamp is untouched.
// Display is where they merge. Sources that share a link collapse to the entry of the first one, the
// entries are numbered 1..k with no gaps, cited pages first, and every [n] the answer wrote is rewritten
// to its entry's number, so a marker pointing at a duplicate lands on the entry the strip shows.
//
// A source with no link never merges: two url-less catalog chunks are different documents as far as
// the reader can tell, and a title match is not evidence they are the same one.

export type Collapsed<T> = {
	/** One per displayed entry, in order: the first source seen for each link. */
	entries: T[];
	/** `display[n - 1]` is the 1-based entry number for source n. */
	display: number[];
};

export function collapseSources<T extends { link?: string }>(
	sources: readonly T[],
	citedFirst: readonly number[] = []
): Collapsed<T> {
	const entries: T[] = [];
	const byLink = new Map<string, number>();
	const display: number[] = new Array(sources.length);
	const place = (i: number) => {
		if (display[i] !== undefined) return;
		const link = sources[i].link?.trim();
		const known = link ? byLink.get(link) : undefined;
		if (known !== undefined) {
			display[i] = known;
			return;
		}
		entries.push(sources[i]);
		if (link) byLink.set(link, entries.length);
		display[i] = entries.length;
	};
	// The pages the answer cites come first, in the order it first cites them, so an answer citing the
	// third and fourth of seven pages reads [1][2], not [3][4] (CUR-3933). The rest follow in order.
	for (const n of citedFirst) if (n >= 1 && n <= sources.length) place(n - 1);
	sources.forEach((_, i) => place(i));
	return { entries, display };
}

/**
 * Rewrite one run of adjacent markers, as source numbers, to the entry numbers the strip shows:
 * mapped, with a number no source has dropped, and with repeats removed in order of first
 * appearance, so "[1][2]" over two pieces of one page reads "[1]", never "[1][1]".
 */
export function collapseMarkerRun(run: readonly number[], display: readonly number[]): number[] {
	const out: number[] = [];
	for (const n of run) {
		const entry = n >= 1 ? display[n - 1] : undefined;
		if (entry !== undefined && !out.includes(entry)) out.push(entry);
	}
	return out;
}

type Numbered = { n: number; url?: string };

/**
 * The same collapse over a turn's server-numbered sources, RAG and web together, since web numbering
 * continues after RAG's: `display` maps each source's n to its entry number, and `duplicate` holds the
 * n of every source that shares an earlier one's url.
 */
function citationNumbers(
	sources: readonly Numbered[],
	content = ''
): {
	display: Map<number, number>;
	duplicate: Set<number>;
} {
	const sorted = [...sources].sort((a, b) => a.n - b.n);
	const position = new Map(sorted.map((s, i) => [s.n, i + 1]));
	// Stored numbering that starts past 1 sits after a visitor's own pasted [1]..[k] (visitorSources.ts),
	// whose numbers must not move, so only an answer with none of those is reordered.
	const citedFirst =
		sorted[0]?.n === 1 ? citationOrder(content).flatMap((n) => position.get(n) ?? []) : [];
	const { display } = collapseSources(
		sorted.map((s) => ({ link: s.url })),
		citedFirst
	);
	const seen = new Set<number>();
	const duplicate = new Set<number>();
	sorted.forEach((s, i) => {
		if (seen.has(display[i])) duplicate.add(s.n);
		seen.add(display[i]);
	});
	return { display: new Map(sorted.map((s, i) => [s.n, display[i]])), duplicate };
}

type WithSources = {
	content?: string;
	rag?: { sources: Numbered[] } | null;
	webSearch?: { sources: Numbered[] } | null;
};

/**
 * The message as the provenance panel shows it: duplicate sources dropped and the rest renumbered to
 * their entry numbers, so step counts, chips and both source strips agree with the inline markers.
 * Returned unchanged when nothing collapses, which is every turn with no shared url.
 */
export function collapseCitations<M extends WithSources>(message: M): M {
	const { display, duplicate } = citationNumbers(
		[...(message.rag?.sources ?? []), ...(message.webSearch?.sources ?? [])],
		message.content
	);
	if (!duplicate.size && [...display].every(([n, d]) => n === d)) return message;
	const renumber = <S extends Numbered>(list: S[]): S[] =>
		list
			.filter((s) => !duplicate.has(s.n))
			.map((s) => ({ ...s, n: display.get(s.n) ?? s.n }))
			.sort((a, b) => a.n - b.n);
	return {
		...message,
		rag: message.rag && { ...message.rag, sources: renumber(message.rag.sources) },
		webSearch: message.webSearch && {
			...message.webSearch,
			sources: renumber(message.webSearch.sources)
		}
	};
}

/** The answer's cited source numbers, as the entry numbers the collapsed strips show. */
export function renumberCited(cited: ReadonlySet<number>, message: WithSources): Set<number> {
	const { display } = citationNumbers(
		[...(message.rag?.sources ?? []), ...(message.webSearch?.sources ?? [])],
		message.content
	);
	return new Set([...cited].map((n) => display.get(n) ?? n));
}
