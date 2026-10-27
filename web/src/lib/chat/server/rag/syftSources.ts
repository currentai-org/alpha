// Pattern-A federated RAG over OpenMined SyftHub (generic over any SyftHub data source).
//
//   discoverSources(query)  → client.hub.search(...)   — semantic search over endpoint metadata
//                                                         picks the most relevant DATA sources
//   querySyftSources(query) → client.search.query(...) — server-side parallel retrieval + rerank
//                                                         across the picked sources, mapped to RagSource
//
// Identity is the SERVICE token (or guest mode); `search.query` takes no per-user email, so chat
// users are never passed through. FAIL-OPEN everywhere: no token, no relevant source, or any SDK
// error returns [] so the chat answers without federated grounding.
//
// Cost & latency are bounded by ONE deadline owned here: `querySyftSources` starts an
// AbortController, and `withDeadline` aborts the (metered) `search.query` and resolves [] if the
// deadline fires — so an abandoned metered call cannot keep running and settle. There is no second
// timer in index.ts. See docs/plans/syfthub-pattern-a.md.

import { EndpointType, type SourceInfo } from "@syfthub/sdk";
import type { RagSource } from "$lib/chat/types/Rag";
import { getSyftClient, syftClientBuildKey } from "./syftClient";
import { syft, syftRouter } from "./env";
import { rerankByRelevance, rerankEnabled } from "$lib/chat/server/search/rerank";
import { withDeadline } from "./evidence";
import { stripHtml, toSnippet, capLabel, RAW_SNIPPET_CAP } from "./parseDoc";
import { getSyftCatalog, type CatalogResult } from "./syftCatalog";
import { routeEndpoints, logRouterShadow, type RouterDecision } from "./syftRouter";
import { isSyftEndpointPath } from "./syftPrompts";
import { logger } from "$lib/chat/server/logger";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";

/** A data source discovery picked for a query: its `owner/slug` path, display name, and score. */
export type EndpointPick = { path: string; name: string; score: number };

// ── discovery cache (TTL + LRU) ──────────────────────────────────────────────────────────────
// hub.search is an extra round-trip per turn; cache its picks briefly. Key mixes the client build
// identity + all discovery-affecting config so a token/base/scope/threshold change can't return
// stale picks. Bounded LRU caps memory.
const DISCOVERY_CACHE = new Map<string, { expires: number; picks: EndpointPick[] }>();
const DISCOVERY_CACHE_MAX = 256;
// A RAW-empty hub.search response is ambiguous: genuine no-match, a fast SDK-swallowed network error,
// and a dark no-embeddings backend ALL surface as [] (the SDK can't tell them apart). Negative-cache
// that ambiguous empty for only this long so a transient fast failure can't shadow a query for the full
// positive TTL, while still coalescing same-query bursts. A response that returned rows (even if all
// filtered out) is definitively live and keeps discoveryCacheTtlMs.
const EMPTY_DISCOVERY_CACHE_TTL_MS = 15_000;
// When a scope filter is active we over-fetch before post-filtering so in-scope sources ranked
// just below the global top-K aren't dropped.
const SCOPE_OVERFETCH = 4;

// hub.search returns [] both for "no relevant source" AND for "hub has no embeddings backend" —
// the SDK can't distinguish them. Warn ONCE per process the first time discovery comes back empty
// from a configured hub, so a misconfigured deploy (SyftHub silently dark) is still diagnosable.
let warnedEmptyDiscovery = false;

function discoveryCacheKey(query: string, c: ReturnType<typeof syft>): string {
	return JSON.stringify([
		syftClientBuildKey(),
		c.guestMode,
		c.discoveryTopK,
		c.discoveryMinScore,
		c.scopeTag,
		c.scopeOwner,
		c.sourceBlocklist,
		query.trim().toLowerCase(),
	]);
}

function cacheGet(key: string): EndpointPick[] | undefined {
	const e = DISCOVERY_CACHE.get(key);
	if (!e) {
		return undefined;
	}
	if (e.expires <= Date.now()) {
		DISCOVERY_CACHE.delete(key);
		return undefined;
	}
	DISCOVERY_CACHE.delete(key); // re-insert to mark most-recently-used
	DISCOVERY_CACHE.set(key, e);
	return e.picks;
}

function cacheSet(key: string, picks: EndpointPick[], ttlMs: number): void {
	DISCOVERY_CACHE.set(key, { expires: Date.now() + ttlMs, picks });
	if (DISCOVERY_CACHE.size > DISCOVERY_CACHE_MAX) {
		const oldest = DISCOVERY_CACHE.keys().next().value;
		if (oldest !== undefined) {
			DISCOVERY_CACHE.delete(oldest);
		}
	}
}

/** Test-only: drop all cached discovery picks, the once-per-process warning latch, and breaker state. */
export function _resetDiscoveryCache(): void {
	DISCOVERY_CACHE.clear();
	warnedEmptyDiscovery = false;
	resetDiscoveryBreaker("");
}

// ── discovery timeout + circuit breaker (dark-hub fast-fail) ───────────────────────────────────
// `hub.search` is UNCANCELLABLE: the SDK's SearchOptions exposes no signal/timeout, and on ANY HTTP
// failure — including its own 30s client timeout — it SWALLOWS the error and returns [] (verified in
// @syfthub/sdk 0.3.1 HubResource.search). So (a) a dark embeddings backend is indistinguishable from a
// genuine "no matching source" at the return value, (b) the outer withDeadline's ctrl.abort() can't
// reach the in-flight call, and (c) today a hung probe's eventual [] flows straight into the 5-min
// cache. Two LOCAL mechanisms compensate:
//   1. raceDiscovery caps each probe against a short timer and yields a DISTINCT sentinel on timeout
//      (never []), so a hang can't burn the whole retrieval deadline and a timeout is never cached.
//   2. A circuit breaker trips on consecutive LOCAL timeouts (never on empties — empty ≠ dark) and,
//      while open, skips the doomed probe entirely and fails fast. Keyed by client build so a rebuild
//      starts clean; the half-open probe is single-flight so a burst after cooldown can't restore the
//      request storm. Its OPEN/CLOSE logs give the timeout path visibility the once-per-process empty
//      warn (kept, for the fast-empty-dark case) can't.
const DISCOVERY_TIMEOUT = Symbol("syfthub-discovery-timeout");
const BREAKER_TRIP_THRESHOLD = 3; // consecutive local timeouts before the circuit opens
const BREAKER_COOLDOWN_MS = 30_000; // stay open this long before admitting one half-open probe

type DiscoveryBreaker = {
	buildKey: string; // client build generation this state belongs to (reset on rebuild)
	consecutiveTimeouts: number;
	openUntil: number; // epoch ms; 0 ⇒ closed
	probeInFlight: boolean; // a half-open probe is out (single-flight gate)
};
let discoveryBreaker: DiscoveryBreaker = {
	buildKey: "",
	consecutiveTimeouts: 0,
	openUntil: 0,
	probeInFlight: false,
};

function resetDiscoveryBreaker(buildKey: string): void {
	discoveryBreaker = { buildKey, consecutiveTimeouts: 0, openUntil: 0, probeInFlight: false };
}

/** May this caller issue the (uncancellable) hub.search probe? Resets state on a client rebuild;
 *  returns false while the circuit is open, admitting exactly ONE probe once the cooldown elapses. */
function breakerAllowsProbe(buildKey: string): boolean {
	if (discoveryBreaker.buildKey !== buildKey) {
		resetDiscoveryBreaker(buildKey); // a rebuilt client is a clean slate — never inherit dark state
	}
	const b = discoveryBreaker;
	if (b.openUntil === 0) {
		return true; // closed
	}
	if (Date.now() < b.openUntil) {
		return false; // open — fail fast, no probe
	}
	if (b.probeInFlight) {
		return false; // half-open, another probe already in flight (single-flight)
	}
	b.probeInFlight = true; // half-open — admit exactly one probe
	return true;
}

function breakerRecordTimeout(buildKey: string): void {
	const b = discoveryBreaker;
	if (b.buildKey !== buildKey) {
		return; // an outcome from a superseded build — ignore
	}
	b.probeInFlight = false;
	b.consecutiveTimeouts += 1;
	if (b.consecutiveTimeouts >= BREAKER_TRIP_THRESHOLD) {
		const wasClosed = b.openUntil === 0;
		b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
		if (wasClosed) {
			logger.warn(
				`[rag] SyftHub discovery breaker OPEN after ${b.consecutiveTimeouts} consecutive timeouts; skipping hub.search for ${BREAKER_COOLDOWN_MS}ms (embeddings backend likely dark)`
			);
		}
	}
}

function breakerRecordSuccess(buildKey: string): void {
	const b = discoveryBreaker;
	if (b.buildKey !== buildKey) {
		return;
	}
	const wasOpen = b.openUntil !== 0;
	b.probeInFlight = false;
	b.consecutiveTimeouts = 0;
	b.openUntil = 0;
	if (wasOpen) {
		logger.info("[rag] SyftHub discovery breaker CLOSED; hub.search recovered");
	}
}

/** Neutral outcome (a real SDK throw, or a stale/aborted return): free the half-open slot without
 *  counting it as a dark-timeout strike OR a heal. */
function breakerRecordNeutral(buildKey: string): void {
	if (discoveryBreaker.buildKey === buildKey) {
		discoveryBreaker.probeInFlight = false;
	}
}

/** Budget-aware cap (ms) for a single discovery probe. Standalone (no deadline) ⇒ the full configured
 *  cap. Otherwise ≤ half the remaining turn budget so the metered retrieval always keeps at least its
 *  share — a fall-through after the router already spent time can't starve search.query. ≤ 0 ⇒ the
 *  deadline is already blown (caller skips discovery entirely). */
export function discoverCapMs(deadlineAt: number | undefined, configCapMs: number): number {
	if (deadlineAt === undefined) {
		return configCapMs;
	}
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) {
		return 0;
	}
	return Math.max(1, Math.min(configCapMs, Math.floor(remaining / 2)));
}

/** Race the uncancellable `hub.search` against a local timer. On timeout, resolve the DISCOVERY_TIMEOUT
 *  sentinel (NOT []) so a dark-hub hang is distinguishable from a genuine empty; the orphaned hub.search
 *  promise is abandoned (nothing awaits, processes, or caches its eventual result). */
async function raceDiscovery<T>(
	work: Promise<T>,
	capMs: number
): Promise<T | typeof DISCOVERY_TIMEOUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof DISCOVERY_TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(DISCOVERY_TIMEOUT), capMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// ── embedding discovery (today's hub.search path, factored) ────────────────────────────────────
/** Cosine-over-metadata discovery: semantic search over endpoint metadata, filtered by relevance
 *  floor and (optionally, on a shared hub) by our owner/tag. Cached. Fail-open: []. This is the
 *  pre-flight router's single FALL-THROUGH target — called identically for the shadow comparison and
 *  the real fallback (both thread `deadlineAt`, so the cap + breaker cover EVERY discovery path, not
 *  just router-off). It owns the DISCOVERY_CACHE read/write AND its own acquire-time build-key guard,
 *  and takes NO buildKey argument: it validates against the client build IT actually searched, so the
 *  shadow comparison can't diverge from the real fallback after a rebuild. */
async function embeddingDiscover(
	query: string,
	signal?: AbortSignal,
	deadlineAt?: number
): Promise<EndpointPick[]> {
	if (signal?.aborted) {
		return [];
	}
	// `hub.search` is UNAUTHENTICATED (the SDK posts it with includeAuth:false), so discovery uses the
	// plain client and never blocks on JWT login — only metered retrieval (querySyftSources) does. The
	// acquisition is guarded so a throwing constructor fails open to [] even when called standalone.
	let client;
	try {
		client = getSyftClient();
	} catch (e) {
		logger.warn(e, "[rag] SyftHub client acquisition failed; no federated sources this turn");
		return [];
	}
	if (!client) {
		return [];
	}
	// Build key of the client we are about to run hub.search on. If the shared client is rebuilt (a
	// runtime token/base change) while that await is in flight, these picks belong to the OLD hub —
	// we discard them below so the caller never queries stale owner/slug paths against the new hub.
	const buildKeyAtAcquire = syftClientBuildKey();
	const c = syft();
	const key = discoveryCacheKey(query, c);
	const cached = cacheGet(key);
	if (cached) {
		return cached; // serve known-good (or known-empty) picks even while the breaker is open
	}

	// Bound the probe against the remaining turn budget BEFORE consulting the breaker, so a blown
	// deadline neither strikes the breaker nor issues a doomed call.
	const capMs = discoverCapMs(deadlineAt, c.discoverTimeoutMs ?? 3000);
	if (capMs <= 0) {
		return [];
	}
	// Circuit open (backend known-dark) ⇒ skip the uncancellable probe entirely and fail fast.
	if (!breakerAllowsProbe(buildKeyAtAcquire)) {
		return [];
	}

	const hasScope = Boolean(c.scopeOwner || c.scopeTag || c.sourceBlocklist.length);
	let results;
	try {
		results = await raceDiscovery(
			client.hub.search(query, {
				type: EndpointType.DATA_SOURCE,
				topK: hasScope ? c.discoveryTopK * SCOPE_OVERFETCH : c.discoveryTopK,
				minScore: c.discoveryMinScore,
			}),
			capMs
		);
	} catch (e) {
		// A real SDK throw (rare — the SDK swallows network errors into []); not a dark-timeout signal.
		breakerRecordNeutral(buildKeyAtAcquire);
		logger.warn(e, "[rag] SyftHub discovery failed; no federated sources this turn");
		return [];
	}

	if (results === DISCOVERY_TIMEOUT) {
		// The ONE dark-hub signal: count it, and return [] UNCACHED so a transient hang can't poison the
		// cache for the full TTL. The abandoned hub.search runs on to the SDK's 30s and is never processed.
		breakerRecordTimeout(buildKeyAtAcquire);
		return [];
	}
	// Post-await NEUTRAL guards FIRST (uncached, no strike AND no heal): an outer-deadline abort or a
	// client rebuild mid-search means this completion is DISCARDED — free the half-open slot but never let
	// a probe we're throwing away flip the breaker's health verdict (a heal here could close an open
	// circuit off a result the caller never used). Return [] without warning, caching, or filtering.
	if (signal?.aborted) {
		breakerRecordNeutral(buildKeyAtAcquire);
		return [];
	}
	if (syftClientBuildKey() !== buildKeyAtAcquire) {
		breakerRecordNeutral(buildKeyAtAcquire);
		return [];
	}
	// A genuinely-usable non-timeout completion — even an empty one — proves the backend answered: heal.
	breakerRecordSuccess(buildKeyAtAcquire);

	// A genuine fast-empty from a configured hub: keep the once-per-process diagnostic (the timeout
	// breaker never fires for a fast-empty-dark backend, so this is that mode's only visibility).
	if (!results.length && !warnedEmptyDiscovery) {
		warnedEmptyDiscovery = true;
		logger.warn(
			"[rag] SyftHub discovery returned no endpoints; if unexpected, verify the hub has an embeddings backend configured and that sources are published"
		);
	}

	let filtered = results.filter((r) => r.relevanceScore >= c.discoveryMinScore);
	if (c.scopeOwner) {
		filtered = filtered.filter((r) => r.ownerUsername === c.scopeOwner);
	}
	if (c.scopeTag) {
		filtered = filtered.filter((r) => (r.tags ?? []).includes(c.scopeTag));
	}
	if (c.sourceBlocklist.length) {
		filtered = filtered.filter(
			(r) => !c.sourceBlocklist.includes(`${r.ownerUsername}/${r.slug}`.toLowerCase())
		);
	}
	const picks: EndpointPick[] = filtered.slice(0, c.discoveryTopK).map((r) => ({
		path: `${r.ownerUsername}/${r.slug}`,
		name: r.name,
		score: r.relevanceScore,
	}));
	// Gate on the RAW response, not the filtered picks: a hub that returned rows we then filtered out is
	// still live (full TTL); only a raw [] is the ambiguous transient-vs-stable case (short negative TTL).
	const ttlMs =
		results.length === 0
			? Math.min(c.discoveryCacheTtlMs, EMPTY_DISCOVERY_CACHE_TTL_MS)
			: c.discoveryCacheTtlMs;
	cacheSet(key, picks, ttlMs);
	return picks;
}

// ── pre-flight router budget (single-deadline constraint, §4) ──────────────────────────────────
// Floor reserved for embeddingDiscover + the metered search.query AFTER the router spends its slice,
// so the whole preflight (catalog + LLM) can never starve the fallback + retrieval.
const MIN_FALLBACK_BUDGET_MS = 4000;
const ROUTER_UNDECIDED = { kind: "undecided" } as const;
type PreflightResult = { cat: CatalogResult; d: RouterDecision } | { kind: "undecided" };

/** EFFECTIVE router soft cap. Pure of any config/fresh-`syft()` read (only the captured snapshot the
 *  caller fed `withDeadline`, plus one `Date.now()`): the router may consume at most this slice,
 *  leaving ≥ MIN_FALLBACK_BUDGET_MS for the fallback + retrieval. `deadlineAt === undefined` (a
 *  standalone `discoverSources(query)` call) ⇒ 0 ⇒ router skipped. ≤ 0 ⇒ no room for both ⇒ router
 *  disabled this turn (fall through immediately), never clamped to a starving sliver. */
export function effectiveRouterCap(
	deadlineAt: number | undefined,
	retrieveTimeoutMs: number,
	requestedCapMs: number
): number {
	if (deadlineAt === undefined) {
		return 0;
	}
	return Math.min(
		requestedCapMs,
		deadlineAt - Date.now(),
		retrieveTimeoutMs - MIN_FALLBACK_BUDGET_MS
	);
}

/** Abortable timer that CLEARS itself when the preflight wins the race (signal abort → clear+resolve),
 *  so a won race leaves no dangling timeout. Never touches the outer `ctrl`. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true }
		);
	});
}

// ── discovery (router branch + embedding fall-through) ─────────────────────────────────────────
/** Which data sources should answer this query. Router OFF (default) ⇒ byte-for-byte embeddingDiscover
 *  (today's behavior). Router ON (or shadow) ⇒ an LLM reasons over the scoped catalog FIRST, under a
 *  soft cap that preserves the fallback budget; any miss / undecided / empty-without-honor falls
 *  through to embeddingDiscover. Fail-open everywhere. The three trailing params are optional so the
 *  standalone `discoverSources(query)` (spec.ts) keeps router-off behavior (no deadlineAt ⇒ cap 0 ⇒
 *  router skipped); `querySyftSources` is the only production caller and threads all three. */
export async function discoverSources(
	query: string,
	signal?: AbortSignal,
	deadlineAt?: number,
	retrieveTimeoutMs?: number,
	// Optional per-turn timing sink: records catalogMs (the cold hub.browse, the warm-up target)
	// and routerMs (the pre-flight LLM). Both otherwise vanish inside the caller's ragMs. Absent for the
	// standalone `discoverSources(query)` (spec.ts).
	spans?: TurnSpans,
	// VERIFIED catalog pre-gate survivors (preGateCatalog): when present, the router reasons over ONLY
	// these paths — a smaller prompt, and the pick floor already applied. Absent ⇒ full catalog (the
	// pre-gate abstained or is off). Never filters embeddingDiscover (its picks are membership-filtered
	// or post-gated by the caller).
	allowedPaths?: ReadonlySet<string>
): Promise<EndpointPick[]> {
	const r = syftRouter();
	const routerActive = r.enabled || r.shadow; // shadow ALSO activates the router (it just logs)
	// `retrieveTimeoutMs` is the CAPTURED snapshot the caller fed withDeadline — never re-read syft()
	// here (it could desync). r.timeoutMs is static config, safe to read.
	const cap = effectiveRouterCap(deadlineAt, retrieveTimeoutMs ?? 0, r.timeoutMs);
	if (routerActive && cap > 0) {
		const child = new AbortController();
		const onAbort = () => child.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// ONE race over the ENTIRE preflight (catalog + route). The delay resolves the router to
			// undecided and aborts ONLY the child — never the outer ctrl that guards search.query.
			const decision = await Promise.race<PreflightResult>([
				(async (): Promise<PreflightResult> => {
					const catStart = Date.now();
					const cat = await getSyftCatalog(child.signal);
					// max(): a warm/cached browse is ~0, so the max across a turn's catalog reads is the
					// one cold fetch — the number a warm leg drives toward ~0.
					if (spans) spans.syftCatalogMs = Math.max(spans.syftCatalogMs ?? 0, Date.now() - catStart);
					if (!cat || child.signal.aborted) {
						return ROUTER_UNDECIDED;
					}
					// Post-catalog gate: if the browse already spent the reserve, don't even start the LLM.
					if (deadlineAt !== undefined && deadlineAt - Date.now() <= MIN_FALLBACK_BUDGET_MS) {
						return ROUTER_UNDECIDED;
					}
					// Pre-gate survivors (when verified) shrink the router's catalog to the floor-cleared
					// entries. An EMPTY intersection means the catalog was rebuilt between the pre-gate and
					// here — the survivor paths can't be trusted against the new build, so fall through
					// (undecided) rather than routing over nothing.
					const entries = allowedPaths
						? cat.entries.filter((e) => allowedPaths.has(e.path))
						: cat.entries;
					if (entries.length === 0) {
						return ROUTER_UNDECIDED;
					}
					const routeStart = Date.now();
					const d = await routeEndpoints(query, entries, child.signal);
					if (spans) spans.syftRouterMs = Date.now() - routeStart;
					return { cat, d };
				})(),
				delay(cap, child.signal).then(() => {
					child.abort();
					return ROUTER_UNDECIDED;
				}),
			]);
			if (signal?.aborted) {
				return [];
			}
			if ("d" in decision) {
				const { cat, d } = decision;
				if (r.shadow) {
					// Shadow NEVER drives retrieval: log routed-vs-embedding, return the embedding picks.
					const embeddingPicks = await embeddingDiscover(query, signal, deadlineAt);
					logRouterShadow(query, d, embeddingPicks);
					return embeddingPicks;
				}
				if (d.kind === "picks") {
					// Post-routing stale guard: a rebuild between routing and return ⇒ suppress the picks
					// (matches the existing embedding stale-pick guard).
					if (syftClientBuildKey() !== cat.buildKey) {
						return [];
					}
					return d.picks;
				}
				if (d.kind === "empty" && r.honorEmpty) {
					return []; // deliberate precision/cost opt-in
				}
				// d.kind === "undecided", OR empty-without-honor ⇒ fall through ↓
			}
		} catch (e) {
			logger.warn(e, "[rag] SyftHub router failed; falling back to embedding discovery");
		} finally {
			child.abort(); // clears the delay timer if the preflight won the race
			signal?.removeEventListener("abort", onAbort);
		}
		if (signal?.aborted) {
			return [];
		}
	}
	// ── fall-through target (owns DISCOVERY_CACHE + guard); deadlineAt threads the cap + breaker here ──
	return embeddingDiscover(query, signal, deadlineAt);
}

// ── retrieval ────────────────────────────────────────────────────────────────────────────────
/** Log any non-success per-source retrieval status so a silent fail-open is still debuggable. */
function logRetrievalInfo(info: SourceInfo[] | undefined): void {
	for (const s of info ?? []) {
		if (s.status !== "success") {
			logger.warn(
				{ path: s.path, status: s.status, error: s.errorMessage },
				"[rag] SyftHub source retrieval not OK"
			);
		}
	}
}

// ── catalog PRE-gate (TTFT) ──────────────────────────────────────────────────────────────────
// One floor-clearing catalog entry, with the cross-encoder score that admitted it (captured via the
// reranker's scoreAdjust hook — survivors only) and the metered flag the auto-pick cost rule needs.
// Ordered by score DESC (the reranker's output order).
export type PreGateSurvivor = { path: string; name: string; score: number; metered: boolean };

// Result of scoring the WHOLE scoped catalog against the query BEFORE any discovery/routing runs.
// `verified: true` means the cross-encoder actually scored this turn — survivors are the only paths
// whose name+description clear the pick floor, so downstream picks outside the set are off-topic BY
// THE SAME SCORER the post-router gate would apply. `buildKey` is the catalog build the scores came
// from (the auto-pick stale guard). `verified: false` = the pre-gate abstained (disabled / no catalog
// / cold reranker) and the caller must run today's full path unchanged.
type CatalogPreGate =
	| { verified: true; survivors: readonly PreGateSurvivor[]; buildKey: string }
	| { verified: false };
const PREGATE_ABSTAIN: CatalogPreGate = { verified: false };

/** TTFT: score the whole catalog against the query with the pick gate's scorer + floor BEFORE the LLM
 *  router. The router costs ~1.3s per turn to pick sources the
 *  post-router pick gate then drops — this inverts the order so the cheap
 *  deterministic check runs first: a verified all-below-floor result skips router + discovery + pick
 *  gate + metered retrieval outright, and a verified survivor set shrinks the router's catalog and
 *  replaces the redundant post-router rerank with set membership. Scores the SAME text the pick gate
 *  scores (entry name + description), so survivorship is equivalent to passing gatePicksByRelevance.
 *  FAIL-OPEN: pre-gate off (SYFTHUB_CATALOG_PREGATE=off), gate floor ≤ 0, reranker disabled, no/empty
 *  catalog, or an UNVERIFIED score (cold/timeout) ⇒ abstain, and the caller runs today's path. */
async function preGateCatalog(query: string, signal: AbortSignal): Promise<CatalogPreGate> {
	const c = syft();
	if (!c.catalogPregate || !(c.pickMinRerank > 0) || !rerankEnabled()) {
		return PREGATE_ABSTAIN;
	}
	try {
		const cat = await getSyftCatalog(signal);
		if (!cat || cat.entries.length === 0 || signal.aborted) {
			return PREGATE_ABSTAIN;
		}
		const candidates = cat.entries.map((e) => ({
			path: e.path,
			title: e.name || e.path,
			snippet: e.description,
			metered: e.metered,
		}));
		// scoreAdjust is the reranker's survivors-only post-floor hook — used here purely as a CAPTURE
		// side-channel for the raw scores (returning raw unchanged ⇒ no reorder), so the auto-pick rule
		// can see how decisively each survivor cleared the floor.
		const scores = new Map<string, number>();
		const { items, verified } = await rerankByRelevance(query, candidates, {
			minScore: c.pickMinRerank,
			allowEmpty: true,
			timeoutMs: 2500,
			scoreAdjust: (cand, raw) => {
				scores.set(cand.path, raw);
				return raw;
			},
		});
		if (!verified) {
			return PREGATE_ABSTAIN;
		}
		const survivors: readonly PreGateSurvivor[] = items.map((i) => ({
			path: i.path,
			name: i.title,
			score: scores.get(i.path) ?? 0,
			metered: i.metered,
		}));
		if (survivors.length < cat.entries.length) {
			logger.info(
				{ catalog: cat.entries.length, kept: survivors.length, floor: c.pickMinRerank },
				"[rag] SyftHub catalog pre-gate scored the catalog before the router"
			);
		}
		return { verified: true, survivors, buildKey: cat.buildKey };
	} catch {
		return PREGATE_ABSTAIN; // best-effort — never let the pre-gate break discovery
	}
}

/** Auto-pick from VERIFIED pre-gate scores — skip the router LLM when the decision is not genuinely
 *  ambiguous. Two rules (both dead when `minScore` ≤ 0, the single kill switch):
 *    • DECISIVE: survivors scoring ≥ minScore (default 0.9 — near-certainty on the bimodal BGE scale)
 *      are picked directly, capped at maxEndpoints. Sub-decisive survivors are NOT dragged along —
 *      precision over recall on the (possibly metered) retrieval path.
 *    • LONE FREE SURVIVOR: with exactly one survivor, the LLM can only pick it or decline, and the
 *      decline only matters for COST — so a lone FREE source is picked without the ~1.3s LLM call,
 *      while a lone METERED one still consults the LLM (preserving its veto over spend).
 *  Returns null when the LLM is genuinely needed (ambiguous multi-survivor field, or lone metered). */
export function autopickFromSurvivors(
	survivors: readonly PreGateSurvivor[],
	maxEndpoints: number,
	minScore: number
): EndpointPick[] | null {
	if (!(minScore > 0) || survivors.length === 0) {
		return null;
	}
	const toPick = (s: PreGateSurvivor): EndpointPick => ({
		path: s.path,
		name: s.name,
		score: s.score,
	});
	const decisive = survivors.filter((s) => s.score >= minScore);
	if (decisive.length > 0) {
		return decisive.slice(0, Math.max(1, maxEndpoints)).map(toPick);
	}
	if (survivors.length === 1 && !survivors[0].metered) {
		return [toPick(survivors[0])];
	}
	return null;
}

/** Pre-retrieval pick gate: score each discovered/routed pick's name+description against the query
 *  with the SAME cross-encoder that vets retrieved results, and drop picks below the floor BEFORE the
 *  metered search.query. This is the deterministic "is this question about this source's collection?"
 *  check — the router LLM alone is pick-happy (it selects a metered source even for general-knowledge
 *  queries, and the paid retrieve's documents are then all dropped by the
 *  post-retrieval relevance gate). Costs one warm reranker call (~0.4s, unmetered) and saves the
 *  ~3-4s + $ metered leg whenever nothing clears the floor. Runs only when preGateCatalog ABSTAINED —
 *  a verified pre-gate already floor-scored every catalog entry, so the caller filters picks by
 *  survivor membership instead of paying a second identical rerank. FAIL-OPEN: gate off (floor ≤ 0),
 *  reranker disabled, or an UNVERIFIED rerank (cold/timeout/transport) keeps ALL picks — today's
 *  behavior. */
async function gatePicksByRelevance(
	query: string,
	picks: EndpointPick[],
	signal: AbortSignal
): Promise<EndpointPick[]> {
	const c = syft();
	if (!picks.length || !(c.pickMinRerank > 0) || !rerankEnabled()) {
		return picks;
	}
	// Description + metered lookup from the (long-TTL cached) catalog — a miss scores on the name alone,
	// and (for fail-closed) counts as metered. ONE catalog read feeds both.
	const desc = new Map<string, string>();
	const metered = new Map<string, boolean>();
	try {
		const cat = await getSyftCatalog(signal);
		for (const e of cat?.entries ?? []) {
			desc.set(e.path, e.description);
			metered.set(e.path, e.metered);
		}
	} catch {
		// Catalog is best-effort here; the gate can still score names.
	}
	const candidates = picks.map((p) => ({
		pick: p,
		title: p.name || p.path,
		snippet: desc.get(p.path) ?? "",
	}));
	const { items, verified } = await rerankByRelevance(query, candidates, {
		minScore: c.pickMinRerank,
		allowEmpty: true,
		timeoutMs: 2500,
	});
	if (!verified) {
		// Cold/failed reranker lane. Default ("off") degrades to ungated picks (never to fewer sources).
		// FAIL-CLOSED-FOR-METERED (§3.4, opt-in): the reranker can't confirm a metered pick is on-topic,
		// and an off-topic metered search.query burns budget + real $ — so drop the metered picks and keep
		// only the free ones. Unknown metered status (catalog miss) counts as metered (conservative — don't
		// pay for an unverifiable pick). "shadow" logs the would-drop set without changing behavior.
		if (c.pickGateFailClosed !== "on" && c.pickGateFailClosed !== "shadow") {
			return picks; // "off" / unset ⇒ today's ungated-all behavior
		}
		const isMetered = (p: EndpointPick): boolean => metered.get(p.path) ?? true;
		const droppedMetered = picks.filter(isMetered);
		if (droppedMetered.length) {
			const shadow = c.pickGateFailClosed === "shadow";
			logger[shadow ? "info" : "warn"](
				{
					mode: c.pickGateFailClosed,
					meteredPicks: droppedMetered.map((p) => p.path),
					keptFree: picks.filter((p) => !isMetered(p)).map((p) => p.path),
					floor: c.pickMinRerank,
				},
				`[rag] SyftHub pick gate unverified — metered picks ${shadow ? "WOULD be dropped (shadow)" : "dropped (fail-closed)"}`
			);
		}
		// shadow ⇒ keep today's behavior (all picks); on ⇒ keep only the free picks.
		return c.pickGateFailClosed === "shadow" ? picks : picks.filter((p) => !isMetered(p));
	}
	if (items.length < picks.length) {
		logger.info(
			{ before: picks.length, kept: items.length, floor: c.pickMinRerank },
			"[rag] SyftHub pick relevance gate dropped off-topic picks before the metered retrieve"
		);
	}
	return items.map((i) => i.pick);
}

/** Discover relevant sources, retrieve+rerank documents from them, and map to citable RagSources.
 *  Single self-owned deadline aborts the metered retrieval; fail-open to [] on anything — the WHOLE
 *  body is try/catch-wrapped so even a throwing client/config can't reject index.ts's Promise.all
 *  (index.ts deliberately drops the outer withTimeout, so this owns fail-open entirely). */
export async function querySyftSources(
	query: string,
	// Optional per-turn timing sink for the SyftHub stage decomposition: pickGate + metered are
	// timed here, catalog + router inside discoverSources. Absent ⇒ nothing recorded (fail-open).
	spans?: TurnSpans,
	// PROMPT-ROUTED override (SYFTHUB_PROMPT_ROUTING): when non-empty, retrieve DIRECTLY from these
	// `owner/slug` data stores and skip the ENTIRE discovery stack (catalog pre-gate, router, embedding
	// discovery, pick gate) — the caller (index.ts) already decided the stores from syftPrompts.json, so
	// they are always consulted. Absent/empty ⇒ today's discovery-driven path, byte-for-byte.
	forcedEndpoints?: readonly string[]
): Promise<Omit<RagSource, "n">[]> {
	try {
		const c = syft();
		const ctrl = new AbortController();
		// Stamp the single deadline from the SAME captured `c` fed to withDeadline below, and thread it
		// (plus the captured timeout) into discoverSources so the pre-flight router's soft cap is computed
		// against the real outer deadline — never a fresh syft() read that could desync.
		const deadlineAt = Date.now() + c.retrieveTimeoutMs;

		const work: Promise<Omit<RagSource, "n">[]> = (async () => {
			// PROMPT-ROUTED override: when the caller OPTS IN by passing `forcedEndpoints` (even []), query
			// those data stores DIRECTLY — the whole discovery stack (catalog pre-gate, router, embedding
			// discovery, pick gate) is bypassed, so the attached sources are ALWAYS consulted regardless of
			// catalog scores. This is a HARD boundary: once a caller opts into forced mode, an empty/invalid
			// list FAILS CLOSED (returns []) — it must never fall back to rediscovering arbitrary sources
			// (which in prompt-only mode would violate the "only matched prompts fire" guarantee).
			const promptRouted = forcedEndpoints !== undefined;
			// Valid + de-duplicated forced endpoints, with the SYFTHUB_SOURCE_BLOCKLIST kill switch applied:
			// the discovery/catalog paths filter blocklisted sources, so the direct path MUST too — a
			// blocklisted source must never be queried or billed, even in prompt-only mode. (Blocklist entries
			// are already lower-cased in env.syft; compare paths lower-cased to match.)
			const blocked = new Set(c.sourceBlocklist);
			const validForced = (forcedEndpoints ?? []).filter(isSyftEndpointPath).map((p) => p.trim());
			const forced = Array.from(new Set(validForced.filter((p) => !blocked.has(p.toLowerCase()))));
			let gated: EndpointPick[];
			if (promptRouted) {
				const droppedBlocklisted = validForced.filter((p) => blocked.has(p.toLowerCase()));
				if (droppedBlocklisted.length) {
					logger.warn(
						{ dropped: droppedBlocklisted },
						"[rag] SyftHub prompt-routed — dropped blocklisted endpoint(s) (SYFTHUB_SOURCE_BLOCKLIST)"
					);
				}
				if (!forced.length) {
					// forced mode with no queryable endpoint (all invalid or blocklisted) ⇒ fail closed,
					// never rediscover.
					return [];
				}
				gated = forced.map((path) => ({ path, name: path, score: 1 }));
				logger.info(
					{ endpoints: forced },
					"[rag] SyftHub prompt-routed — querying the attached data stores directly (discovery skipped)"
				);
			} else {
				// TTFT: catalog PRE-gate — one cross-encoder pass over the whole catalog BEFORE the router.
				// Verified-empty ⇒ no source can clear the pick floor, so the router LLM, discovery, pick
				// gate, and metered retrieval are all skipped (the post-gate would have dropped every pick
				// anyway — same scorer, same floor, same text). Abstained ⇒ today's path byte-for-byte.
				const preStart = Date.now();
				const pre = await preGateCatalog(query, ctrl.signal);
				if (spans) spans.syftPregateMs = Date.now() - preStart;
				if (pre.verified && pre.survivors.length === 0) {
					logger.info(
						{ floor: c.pickMinRerank },
						"[rag] SyftHub catalog pre-gate: no source clears the floor — skipping router + retrieval"
					);
					return [];
				}
				if (ctrl.signal.aborted) {
					return [];
				}
				const survivorPaths = pre.verified
					? new Set<string>(pre.survivors.map((s) => s.path))
					: undefined;
				// AUTO-PICK (router acceleration): with verified pre-gate SCORES, a decisive or lone-free
				// survivor set needs no LLM to route — pick directly and skip discoverSources entirely.
				// Scoped to the ENABLED (non-shadow) router: with the router off, embedding discovery keeps
				// driving as today (auto-picking there could retrieve from sources hub.search wouldn't
				// surface); in shadow, the real router must run for the comparison to mean anything. The
				// buildKey check mirrors the router path's stale-pick guard — a client rebuild since the
				// pre-gate scored invalidates the survivors.
				const r = syftRouter();
				const auto =
					pre.verified && r.enabled && !r.shadow && syftClientBuildKey() === pre.buildKey
						? autopickFromSurvivors(pre.survivors, r.maxEndpoints, c.routerAutopickScore)
						: null;
				if (auto) {
					logger.info(
						{
							picked: auto.length,
							survivors: pre.verified ? pre.survivors.length : 0,
							topScore: Math.round((auto[0]?.score ?? 0) * 1000) / 1000,
						},
						"[rag] SyftHub auto-pick from pre-gate scores — router LLM skipped"
					);
				}
				// Discover next (unless auto-picked): if nothing matches we never enter the metered call.
				// The router (when on) runs inside discoverSources under its own child controller + soft cap
				// — over ONLY the pre-gate survivors when the pre-gate verified; search.query below still
				// receives ONLY ctrl.signal (the one timer allowed to abort the metered call).
				const picks =
					auto ??
					(await discoverSources(
						query,
						ctrl.signal,
						deadlineAt,
						c.retrieveTimeoutMs,
						spans,
						survivorPaths
					));
				if (ctrl.signal.aborted || !picks.length) {
					return [];
				}
				// Deterministic relevance gate on the picks themselves — skip the metered call entirely
				// when no source's own description is plausibly about the query (see gatePicksByRelevance).
				// A VERIFIED pre-gate already floor-scored every catalog entry on the same name+description
				// text, so survivor membership IS the gate — no second rerank round-trip.
				const pickGateStart = Date.now();
				gated = survivorPaths
					? picks.filter((p) => survivorPaths.has(p.path))
					: await gatePicksByRelevance(query, picks, ctrl.signal);
				if (spans) spans.syftPickGateMs = Date.now() - pickGateStart;
			}
			if (ctrl.signal.aborted || !gated.length) {
				return [];
			}
			const client = getSyftClient(); // PAT injected as the aggregator's MPP user_token (see syftClient.ts)
			if (!client || ctrl.signal.aborted) {
				return [];
			}
			// The client has the PAT as `user_token`, so search.query pays metered sources via the PAT's
			// wallet. `SYFTHUB_GUEST_MODE` opts out of paying (unauthenticated access to policy-free
			// sources): when set we pass guestMode:true, which makes the SDK send NO user_token.
			const meteredStart = Date.now();
			const res = await client.search.query({
				prompt: query,
				dataSources: gated.map((p) => p.path),
				topK: c.retrieveTopK,
				similarityThreshold: c.similarityThreshold,
				guestMode: c.guestMode || undefined,
				signal: ctrl.signal,
			});
			if (spans) spans.syftMeteredMs = Date.now() - meteredStart;
			logRetrievalInfo(res.retrievalInfo);
			// A source we couldn't actually READ (access_denied, error, timeout, …) must not ground the
			// answer: any "documents" it returned are a failure artifact (e.g. a Cloudflare "Just a moment…"
			// challenge page), not real content. Drop docs whose source path reported a non-"success" status.
			// A doc whose path isn't listed in retrievalInfo is kept (fail-open — unknown ≠ failed).
			const unreadable = new Set(
				(res.retrievalInfo ?? []).filter((s) => s.status !== "success").map((s) => s.path)
			);
			return (
				res.documents
					.filter((doc) => !unreadable.has(doc.slug))
					.map((doc) => ({
						// Every field below is injected into the prompt — bound ALL of them, not just the body.
						// SearchDocument carries title directly; slug is owner/slug. Cap raw first (an un-chunked
						// source can return megabytes), then clamp: snippet to 480, labels to LABEL_CAP.
						// Fall back AFTER capping, not before: a truthy-but-empty-after-cleaning title (e.g. "   "
						// or "<span></span>") must still yield to the slug rather than skip straight to "Source".
						title: capLabel(doc.title) || capLabel(doc.slug) || "Source",
						snippet: toSnippet(stripHtml((doc.content ?? "").slice(0, RAW_SNIPPET_CAP))),
						engine: "SyftHub" as const,
						sourceName: capLabel(doc.slug), // owner/slug of the source the doc came from
					}))
					// Drop docs whose capped window held no usable text — an empty snippet grounds nothing and
					// would only invite the model to cite [n] with no evidence behind it (fail-open: [] is fine).
					.filter((s) => s.snippet.length > 0)
			);
		})().catch((e) => {
			// A deadline abort rejects search.query with an AbortError — that's the EXPECTED timeout
			// path, not a failure, so don't warn on it (avoids noise on every slow turn).
			if (!ctrl.signal.aborted) {
				logger.warn(e, "[rag] SyftHub retrieval failed; answering without federated grounding");
			}
			return [] as Omit<RagSource, "n">[];
		});

		// ONE deadline: aborts the metered search.query and resolves [] if it fires. No second timer.
		return withDeadline(
			work,
			c.retrieveTimeoutMs,
			() => ctrl.abort(),
			[] as Omit<RagSource, "n">[]
		);
	} catch (e) {
		logger.warn(
			e,
			"[rag] SyftHub path failed before retrieval; answering without federated grounding"
		);
		return [];
	}
}
