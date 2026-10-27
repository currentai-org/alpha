// SyftHub data-source CATALOG for the pre-flight LLM router (docs/plans/syfthub-preflight-router.md).
//
// The hub's data-source catalog is small and fully enumerable: `hub.browse({ endpointType:
// DATA_SOURCE }).all()` yields every published source with its owner/slug, name, description, tags and
// policies. Feeding the WHOLE scoped catalog to the router LLM each turn is therefore cheap — and lets
// the model reason ("latest paper from Lausanne → EPFL") where cosine-over-metadata can't.
//
// FAIL-OPEN: error / empty catalog / build-key mismatch ⇒ `null` (NEVER `[]`). `null` means "no catalog
// → router undecided → fall through to embedding discovery"; an empty array would wrongly read as "a
// real catalog with no entries" and could suppress the fallback. The cache is written ONLY on the
// fully-settled success path (complete `.all()`, not aborted, scope-filtered, post-await build-key
// re-verified) so a soft-cap abort mid-browse can never poison the long-lived cache with a partial fetch.

import { EndpointType, type EndpointPublic, type Policy } from "@syfthub/sdk";
import { getSyftClient, syftClientBuildKey } from "./syftClient";
import { syft, syftRouter } from "./env";
import { capLabel } from "./parseDoc";
import { logger } from "$lib/chat/server/logger";

/** One data source as the router sees it. `metered` is derived (raw policies dropped — only the §7
 *  Q4 price-cap, deferred, would need them). Every prompt-facing field is capped before it lands here. */
export type CatalogEntry = {
	path: string; // owner/slug
	name: string;
	description: string;
	tags: string[];
	metered: boolean;
};

/** The scoped catalog paired with the EXACT build key it was fetched under — routed picks must be
 *  guarded against *this* build, not an outer variable a later placement could desync from. */
export type CatalogResult = { entries: CatalogEntry[]; buildKey: string };

// Endpoint descriptions are richer than the short labels, so give them a wider prompt budget than the
// LABEL_CAP titles — still bounded so an un-chunked / abusive description can't blow the router prompt.
const CATALOG_DESC_CAP = 300;
// Bound the tag list too (count + per-tag length): tags are attacker-controlled third-party text.
const CATALOG_MAX_TAGS = 12;

// ── catalog cache (long TTL + LRU) ───────────────────────────────────────────────────────────────
// hub.browse is an extra round-trip; cache the scoped catalog under a long TTL keyed by {buildKey,
// scopeOwner, scopeTag}. Long is safe because the ROUTER-DECISION cache (syftRouter.ts) fingerprints
// the prompt-relevant catalog fields — a description/tag change reshapes that fingerprint and
// invalidates stale decisions even while this catalog entry is still warm.
const CATALOG_CACHE = new Map<string, { expires: number; result: CatalogResult }>();
const CATALOG_CACHE_MAX = 64;

/** Test-only: drop all cached catalogs. */
export function _resetCatalogCache(): void {
	CATALOG_CACHE.clear();
}

function catalogCacheKey(
	buildKey: string,
	scopeOwner: string,
	scopeTag: string,
	sourceBlocklist: string[]
): string {
	return JSON.stringify([buildKey, scopeOwner, scopeTag, sourceBlocklist]);
}

function cacheGet(key: string): CatalogResult | undefined {
	const e = CATALOG_CACHE.get(key);
	if (!e) {
		return undefined;
	}
	if (e.expires <= Date.now()) {
		CATALOG_CACHE.delete(key);
		return undefined;
	}
	CATALOG_CACHE.delete(key); // re-insert to mark most-recently-used
	CATALOG_CACHE.set(key, e);
	return e.result;
}

function cacheSet(key: string, result: CatalogResult, ttlMs: number): void {
	CATALOG_CACHE.set(key, { expires: Date.now() + ttlMs, result });
	if (CATALOG_CACHE.size > CATALOG_CACHE_MAX) {
		const oldest = CATALOG_CACHE.keys().next().value;
		if (oldest !== undefined) {
			CATALOG_CACHE.delete(oldest);
		}
	}
}

/** A source is "metered" if it carries an ENABLED payment policy (or a priced config). Over-marking is
 *  the SAFE direction here — the flag only nudges the router to be conservative about a paid pick and
 *  feeds the selected-metered cost log; under-marking would hide a real charge from that signal. */
function isMetered(policies: readonly Policy[] | undefined): boolean {
	return (policies ?? []).some((p) => {
		if (!p?.enabled) {
			return false;
		}
		const t = (p.type ?? "").toLowerCase();
		if (t.includes("mpp") || t.includes("pay") || t.includes("price") || t.includes("charge")) {
			return true;
		}
		const price = (p.config as Record<string, unknown> | undefined)?.price;
		return typeof price === "number" && price > 0;
	});
}

function toEntry(e: EndpointPublic): CatalogEntry {
	return {
		path: `${e.ownerUsername}/${e.slug}`,
		name: capLabel(e.name),
		description: capLabel(e.description, CATALOG_DESC_CAP),
		tags: (e.tags ?? []).slice(0, CATALOG_MAX_TAGS).map((t) => capLabel(t)),
		metered: isMetered(e.policies),
	};
}

/** Fetch the scoped data-source catalog for the router, paired with its build key. `null` on any
 *  failure / empty / abort / build-key change ⇒ caller treats it as "router undecided, fall through".
 *  `signal` is the preflight child: a soft-cap abort mid-browse returns `null` WITHOUT caching. */
export async function getSyftCatalog(signal?: AbortSignal): Promise<CatalogResult | null> {
	// hub.browse is UNAUTHENTICATED (like hub.search), but the client still needs a token to construct;
	// no token ⇒ null client ⇒ no catalog ⇒ fall through (no federated path), exactly as today.
	let client;
	try {
		client = getSyftClient();
	} catch (e) {
		logger.warn(e, "[rag] SyftHub client acquisition failed; no router catalog this turn");
		return null;
	}
	if (!client) {
		return null;
	}
	if (signal?.aborted) {
		return null;
	}
	// Build key of the client we are about to browse. If the shared client is rebuilt (a runtime
	// token/base change) while the browse is in flight, the catalog belongs to the OLD hub — discard it.
	const buildKeyAtAcquire = syftClientBuildKey();
	const c = syft();
	const r = syftRouter();
	const key = catalogCacheKey(buildKeyAtAcquire, c.scopeOwner, c.scopeTag, c.sourceBlocklist);
	const cached = cacheGet(key);
	if (cached) {
		return cached;
	}

	let raw: EndpointPublic[];
	try {
		raw = await client.hub.browse({ endpointType: EndpointType.DATA_SOURCE }).all();
	} catch (e) {
		logger.warn(
			e,
			"[rag] SyftHub catalog browse failed; router falls through to embedding discovery"
		);
		return null;
	}

	// Settle-only guards: a soft-cap abort mid-browse, or a client rebuild during it, must
	// NOT write the long-lived cache — treat both as a failed fetch and fall through.
	if (signal?.aborted) {
		return null;
	}
	if (syftClientBuildKey() !== buildKeyAtAcquire) {
		return null;
	}

	// Apply the SAME scope filters as embedding discovery so a shared hub still restricts to our sources.
	// This scoped catalog is the ONLY catalog used for prompting + pick validation.
	let scoped = raw;
	if (c.scopeOwner) {
		scoped = scoped.filter((e) => e.ownerUsername === c.scopeOwner);
	}
	if (c.scopeTag) {
		scoped = scoped.filter((e) => (e.tags ?? []).includes(c.scopeTag));
	}
	// Blocklisted sources are removed from the catalog itself, so the router can never pick them
	// (pick validation only keeps paths present in this catalog) and never spends prompt budget on them.
	if (c.sourceBlocklist.length) {
		scoped = scoped.filter(
			(e) => !c.sourceBlocklist.includes(`${e.ownerUsername}/${e.slug}`.toLowerCase())
		);
	}

	const entries = scoped.map(toEntry);
	if (entries.length === 0) {
		// Empty catalog ⇒ null (NOT a cached []): there is nothing to route over, so fall through.
		return null;
	}
	const result: CatalogResult = { entries, buildKey: buildKeyAtAcquire };
	cacheSet(key, result, r.catalogTtlMs);
	return result;
}
