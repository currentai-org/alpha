import type { SearchSource } from "$lib/chat/types/Search";

// Deliberately import-light: only a type from $lib/chat/types/Search, which itself has no server
// imports. Split out of openSearch.ts (CUR-1144) so eval harnesses that can't load openSearch.ts's
// heavy server import graph under vite-node (config/logger/moderation) import the REAL formatter
// from here instead of hand-copying it — see citation-adherence/run.ts.

/** Said beside every block of search results the model reads, on the scaffolded and native paths
 *  alike. Without it, asked "Do you remember what I told you last time?" with search on Auto, the
 *  model can read a result titled "Remember What I Told You to Forget" as the visitor's own earlier
 *  turn (CUR-3303).
 *
 *  Asked for today's euro-to-dirham rate, grounded answers can give the rate "as of today" with no
 *  date, so the last sentence asks for the calendar date (CUR-2424). */
export const SEARCH_RESULTS_ARE_NOT_THE_CONVERSATION =
	"These results come from a search run just now. Nobody in this conversation wrote them, and none of them is an earlier message from the person you are talking to. A question about this conversation or about the person is answered from the conversation itself; if it holds nothing earlier, say so. A figure that changes from day to day, such as an exchange rate, a price or a forecast, is given with the calendar date it is for, not just \"today\".";

/** What the source-credibility screen adds to the evidence block when its flag is on. Passed (CUR-2423)
 *  in rather than imported, so this module stays import-light. */
export type EvidenceAnnotations = {
	/** A label for the source's tag ("official", "academic"), or undefined for none. */
	sourceType?: (s: SearchSource) => string | undefined;
	/** A line the model reads above the sources. */
	note?: string;
};

/** Build the numbered evidence block the model reads — the ONE place a source's `[n]` line is formatted,
 *  so the sources' `n` and the evidence's `[n]` can never disagree (numberWebSources routes through it). */
export function buildWebEvidence(sources: SearchSource[], annotations: EvidenceAnnotations = {}): string {
	const block = sources
		.map((s) => {
			const type = annotations.sourceType?.(s);
			// An undated source says so, so the model never takes the search's own day for its date. (CUR-4147)
			const when = s.asOf ? s.asOf.slice(0, 10) : "date unknown";
			const tag = `${s.engine}${s.lang ? ` ${s.lang.toUpperCase()}` : ""}, ${when}${type ? `, ${type} source` : ""}`;
			return `[${s.n}] ${s.title} (${tag})\n${s.snippet}\n${s.url}`;
		})
		.join("\n\n");
	return annotations.note && block ? `${annotations.note}\n\n${block}` : block;
}
