// Host-type screen for open-web search results (CUR-2423). Pure and a LEAF module, like sourcePrior.ts.
//
// The reranker scores relevance and a forum post can be very relevant, so without this screen a
// YouTube video or a Reddit thread can be cited for a factual claim. This classifies each
// result's host so retrieveWeb can drop forum, social and low-credibility pages BEFORE the reranker
// (a dropped page can then never be refilled into the top-K), and so the evidence block can tell the
// model which of what is left are official or academic sources.
//
// The lists are generated from WP:RSP and Iffy.news (sourceCredibilityHosts.ts). Official and academic
// are read off the host's suffix, which only ever ADDS a label: it never drops anything.

import { LOW_CREDIBILITY_HOSTS, USER_POSTED_HOSTS } from "./sourceCredibilityHosts";

/** PostHog flag gating the screen in retrieveWeb, off by default. */
export const SOURCE_CREDIBILITY_FLAG = "source-credibility-filter";

export type SourceType ="user-posted" | "low-credibility" | "official" | "academic" | "web";

const USER_POSTED = new Set(USER_POSTED_HOSTS);
const LOW = new Set(LOW_CREDIBILITY_HOSTS);

// Government and intergovernmental hosts: example.gov, *.gov.uk, *.gouv.fr, *.gob.mx, *.go.ke,
// *.govt.nz, *.gc.ca, *.int, and the EU institutions on europa.eu.
const OFFICIAL_RE =
	/(^|\.)(gov|mil|int)$|(^|\.)(gov|gouv|gob|govt|go|gv|mil)\.[a-z]{2}$|(^|\.)(gc\.ca|europa\.eu|un\.org)$/;
// Universities: *.edu, *.edu.au, *.ac.uk, *.ac.jp …
const ACADEMIC_RE = /(^|\.)edu$|(^|\.)(edu|ac)\.[a-z]{2}$/;

/** `host` and each parent domain, most specific first: a.b.example.com → [a.b.example.com, b.example.com, example.com]. */
function hostAndParents(host: string): string[] {
	const parts = host.split(".");
	const out: string[] = [];
	for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
	return out;
}

export function classifyHost(url: string): SourceType {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
	} catch {
		return "web";
	}
	const names = hostAndParents(host);
	// The lists are checked before the suffixes, so a state outlet on a .gob.ve host that WP:RSP rates
	// unreliable comes out low-credibility.
	if (names.some((h) => USER_POSTED.has(h))) return "user-posted";
	if (names.some((h) => LOW.has(h))) return "low-credibility";
	if (OFFICIAL_RE.test(host)) return "official";
	if (ACADEMIC_RE.test(host)) return "academic";
	return "web";
}

function isScreenedOut(type: SourceType): boolean {
	return type === "user-posted" || type === "low-credibility";
}

/** Below this many surviving sources, after the screen removed at least one, the evidence carries a
 *  thin-evidence note instead of being topped up from what was removed. */
const THIN_EVIDENCE_BELOW = 3;

export type CredibilityScreen = { kept: number; dropped: number };

/** The screen's verdict on a candidate list. Pure: the caller decides what to do with `kept`. */
export function screenSources<T extends { url: string }>(
	candidates: T[]
): { kept: T[]; screen: CredibilityScreen } {
	const kept = candidates.filter((c) => !isScreenedOut(classifyHost(c.url)));
	return { kept, screen: { kept: kept.length, dropped: candidates.length - kept.length } };
}

/** The line the model reads above the evidence when the screen left it short. Undefined otherwise. */
export function thinEvidenceNote(screen: CredibilityScreen | undefined, finalCount: number): string | undefined {
	if (!screen || screen.dropped === 0 || finalCount === 0 || finalCount >= THIN_EVIDENCE_BELOW) return undefined;
	return `Note: only ${finalCount} source${finalCount === 1 ? "" : "s"} below passed the source screen (forum, social and low-credibility pages were removed). Say plainly that the evidence is thin, and attribute claims to the source that makes them rather than stating them as settled fact.`;
}
