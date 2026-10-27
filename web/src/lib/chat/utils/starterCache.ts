import type { SearchSource } from "$lib/chat/types/Search";

// Read side of the warm response cache (static/data/starterCache.json, produced by
// scripts/warm-cache.mjs). Intended consumer: the conversation page's stream-failure
// branch — when live inference stalls or drops BEFORE the first token (the poor-connectivity
// case), render a warmed answer for a known prompt as a resilience fallback instead of
// hanging. Live-first policy: this is only ever reached on failure, and every entry is a
// real model output, so nothing here misleads.
//
// Deliberately dependency-free (no $app/paths / $env): pure and unit-testable with no
// SvelteKit mocking. Static JSON lives at site root `/data/…` (see staticDataUrl).

export interface CachedAnswer {
	prompt: string;
	answer: string;
	sources: SearchSource[];
	/** Retrieval date for grounded entries (ISO); null for model-knowledge answers. */
	asOf: string | null;
	grounded: boolean;
	model: string;
	generatedAt: string;
}

interface CacheArtifact {
	entries?: Record<string, CachedAnswer>;
}

/** Whitespace/case-insensitive normaliser — mirrors scripts/warm-cache.mjs `normalize()`. */
export const normalizePrompt = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();

/** Pure lookup: the warmed entry whose prompt matches (and model, if given), or null.
 *  Linear over a handful of entries — no hashing needed on the read side. */
export function findCachedAnswer(
	entries: Record<string, CachedAnswer>,
	promptText: string,
	model?: string
): CachedAnswer | null {
	const want = normalizePrompt(promptText);
	for (const entry of Object.values(entries)) {
		if (normalizePrompt(entry.prompt) === want && (!model || entry.model === model)) return entry;
	}
	return null;
}

let cachePromise: Promise<Record<string, CachedAnswer>> | null = null;

/** Lazily load the warm cache and look up an answer. Fetched ONLY on first call (i.e. on a
 *  stream failure, never on the happy path), memoised, and fails CLOSED to null so a
 *  missing/broken cache can never block the UI. Returns null on miss. */
export async function getCachedAnswer(
	promptText: string,
	opts: { model?: string } = {}
): Promise<CachedAnswer | null> {
	const { model } = opts;
	if (!cachePromise) {
		cachePromise = fetch("/data/starterCache.json")
			.then((r) => (r.ok ? (r.json() as Promise<CacheArtifact>) : null))
			.then((art) => art?.entries ?? {})
			.catch(() => ({}) as Record<string, CachedAnswer>);
	}
	return findCachedAnswer(await cachePromise, promptText, model);
}

/** Test seam: drop the memoised load so a fresh fetch happens next call. */
export function __resetStarterCacheForTests(): void {
	cachePromise = null;
}
