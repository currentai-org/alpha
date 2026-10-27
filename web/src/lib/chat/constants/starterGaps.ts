// Maps a curated starter / on-stage demo prompt to the open-stack gap it deliberately
// surfaces, so the chat can offer an honest "this touches a gap → get involved" CTA
// deep-linked to the right live-stack node.
//
// HONESTY RULE — load-bearing: only curated prompts whose gap we genuinely know get an
// entry here. We never INFER a gap from free-form model output (that would fabricate
// provenance, the one thing the product can't do). A prompt with no entry shows no CTA.
//
// `node` is an id in static/data/stack-map.json (the node the CTA pulses + deep-links).
// `ask` is the open contribution the gap needs — shown in the CTA and prefilled into the
// Raise-your-hand form's detail (via the contributeOpen store's { topic }).

import { chromeLanguage } from "$lib/chat/chromeCopy";
import { detectLanguage } from "$lib/chat/routing/heuristic";
import { fromIso1 } from "$lib/chat/routing/languages";

export interface StarterGap {
	node: string;
	ask: string;
}

// The ALWAYS-TRUE gap of the web-search component: every search runs on open indexes
// (Wikipedia + Firecrawl + OpenAlex), never a full open web index — so this gap holds for
// ANY web-grounded turn, not just a curated prompt. Surfacing it does NOT violate the
// no-inference honesty rule below (we aren't guessing a gap from model output — it's a fixed,
// known property of the websearch node, same text the node's map description names). Shown ONCE
// per conversation, on the FIRST web-grounded answer, then demure — the "emphasize a component
// the first time it activates, quiet after" trace principle. `node` matches WEBSEARCH_NODE.
const WEB_SEARCH_GAP: StarterGap = {
	node: "websearch",
	ask: "a Google-scale open web search index",
};

/** WEB_SEARCH_GAP for the first web-grounded answer, or undefined when that answer is written in a
 *  different language from the card. The card follows the browser's language (chromeCopy.ts), so an
 *  English browser asking in French would get an English recruitment line under a French answer (CUR-2377).
 *  The answer's language is the routing heuristic's verdict on its text, counting its runners-up: the
 *  heuristic reads short French answers ("La capitale du Japon est Tokyo.") as Spanish with French
 *  second, so counting the runners-up keeps a French browser's card on most answers (CUR-2394). The
 *  cost is a French card under a Spanish answer in a French browser, which is still the reader's own language. An undecided
 *  verdict shows no card, since the card is an optional invitation and the answer is never wrong
 *  without it. */
export function webSearchGapFor(answer: string | undefined, uiLang: string | null | undefined): StarterGap | undefined {
	if (!answer) return undefined;
	const card = fromIso1(chromeLanguage(uiLang));
	const verdict = detectLanguage(answer);
	const readsAs = verdict.value === card || verdict.alternatives.some((a) => a.value === card);
	return readsAs ? WEB_SEARCH_GAP : undefined;
}

// Keyed by the prompt text. Kept SEPARATE from `suggestions` (string[]) so the starters
// list and the tuning-panel starters default stay a plain string array, untouched.
//
// CURATION RULE: an entry is only honest if the node it
// deep-links to ACTUALLY MATCHES the ask. We deliberately do NOT have a farmer→local-data
// entry: the farmer prompt's real gap is "no local agricultural dataset behind the model",
// but the map has no data/dataset node — the nearest candidate, `localculture`, is actually
// "community self-configuration of a deployment", an unrelated topic. Pointing there would
// misrepresent the gap. That entry waits on a real data node in static/data/stack-map.json
// (a content call), not a forced mis-aim.
// Keyed by the EXACT starter-prompt text (see suggestions.ts). Honour the CURATION RULE above: only
// an entry whose node ACTUALLY matches the ask. An entry keyed to a prompt that has left the pool
// never shows its CTA, so rekey when the pool changes (CUR-620). The electric-cars fact-check earns
// the same CTA on the same reasoning: it's a claim whose honest resolution is an open web search, the exact gap the
// `websearch` node names ("a Google-scale open web index is still the honest gap"). The pool has no
// EU-AI-Act-shaped entry here (see suggestions.ts): a recency question a model with no fresh
// grounding can't honestly answer is a worse target than one that passes verification.
const GAPS: Record<string, StarterGap> = {
	"Fact-check this: electric cars are worse for the climate than petrol cars once you count the battery.":
		{ node: "websearch", ask: "a Google-scale open web search index" },
};

/** Collapse whitespace + case so a chip click and a pasted/typed copy of the same prompt
 *  both match. Pure. */
export function normalizeStarter(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

const BY_NORM: Record<string, StarterGap> = Object.fromEntries(
	Object.entries(GAPS).map(([k, v]) => [normalizeStarter(k), v])
);

/** The gap a curated prompt deliberately surfaces, or undefined for prompts that don't
 *  target one (e.g. the provenance/governance starter). Matches on normalized text. */
export function gapForPrompt(text: string | undefined | null): StarterGap | undefined {
	if (!text) return undefined;
	return BY_NORM[normalizeStarter(text)];
}
