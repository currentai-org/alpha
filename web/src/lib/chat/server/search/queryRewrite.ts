import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { logger } from "$lib/chat/server/logger";
// NOTE: `generateFromDefaultEndpoint` (which pulls the model registry / $env graph) is imported
// DYNAMICALLY inside contextualizeQuery — keeping it off the module's top level lets the pure helpers
// (needsContextualization / sanitizeRewrite) be imported by tests + the eval harness without booting
// the model layer (the same reason classifierPrompt is split out from searchDecision).

// Conversational query rewriting (coreference resolution) before an open-web search.
//
// A follow-up like "what most recent research says about it?" was being searched VERBATIM — the
// dangling "it" carries no topic, so the open-web search returns junk (a dinosaur follow-up
// returns "Whataboutism" and "Missing scientists conspiracy theory"). The fix is the standard history-aware retrieval step: rewrite the latest
// message into a STANDALONE query using the recent turns, THEN search.
//
// Two-layer, latency-conscious:
//   1. `needsContextualization` — a deterministic gate (pure). Only context-dependent messages
//      (dangling pronouns / fragment openers) pay for a rewrite; a standalone query searches as-is
//      with zero extra cost. Reused by tests + the eval harness.
//   2. `contextualizeQuery` — a single cheap, best-effort model call that resolves the references.
//      Fails OPEN to the raw query on any error/degenerate output: a bad rewrite must never block or
//      worsen the search (the raw query is the existing behaviour, so we can only improve).

export interface RewriteTurn {
	from: "user" | "assistant";
	content: string;
}

// Referential pronouns that point OUT of the message (need prior context to resolve).
//
// English only, and deliberately so for now — see NON_ENGLISH_REFERENTIAL below for the half of the
// live traffic this misses.
const REFERENTIAL =
	/\b(it|its|it's|this|that|these|those|they|them|their|theirs|the (?:former|latter|first|second|third|last|other)(?:\s+one)?|he|him|his|she|her|hers|one|ones)\b/i;

// Fragment / continuation openers — a message that only makes sense as a follow-up.
const FRAGMENT_OPENER =
	/^(and|but|so|or|also|what about|how about|why|why not|and what|what else|any other|anything else|more|tell me more|go on|continue|elaborate|expand)\b/i;

// Bare replies and standalone imperatives. These carry NO topic at all, so searching them verbatim
// cannot do anything but retrieve on the wrong sense of the word — and unlike a dangling pronoun,
// there is no referential token for REFERENTIAL to catch. Searched verbatim (CUR-151), "yes"
// retrieves the band Yes, "try now" a product review of TryNow, "search again" a dance track, and
// "double check on the web" a paper on web-search association measures. The model then answers from
// conversation context and correctly cites none of them, which the zero-citation metric scores as
// the model disobeying its citation instruction.
const BARE_REPLY_OR_IMPERATIVE =
	/^(yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank you|please|again|now|do it|go ahead|try (?:it|now|again)|search (?:it|now|again)|look (?:it up|again)|check (?:it|now|again|online)|double[- ]check|verify|confirm|fact[- ]check|source(?:s)?(?: it)?|cite|next|previous|back)\b[\s.!?]*$/i;

// The same imperatives followed ONLY by channel/filler words — "double check on the web", "search
// again online", "verify that for me". The anchored form above cannot see these because it requires
// end-of-string, and "double check on the web" retrieves a paper on web-search association
// measures.
//
// The tail must be channel words to the END, which is doing the real work here. A content-token
// floor is the wrong discriminator: it fires on "search for Apertus 1.5
// benchmarks" and "tell me about the Digital Omnibus", both of which name a topic and search
// perfectly well as written. What separates a topicless imperative from an imperative WITH a topic
// is not how few words follow the verb, it's whether any of them names anything. So `find`, `tell`,
// `show` and `give` are deliberately absent from the verb list — they almost always take a topic.
const IMPERATIVE_NO_TOPIC =
	/^(try|search|look|re-?search|check|double[- ]check|verify|confirm|fact[- ]check)\b(\s+(it|that|this|them|again|now|online|up|once more|please|properly|carefully|for me|on|in|the|web|internet|net|google|source|sources))*\s*[.!?]*$/i;

// Referential markers in the non-English languages this app actually receives. The gate is reached
// on every searched turn regardless of language, and production carries French and Spanish traffic
// ("et à l'ONU", "Qui est le président de la république", "Cuales son las noticias hoy") — all of
// which sailed past an English-only regex. Not exhaustive per language and not meant to be: these
// are the closed-class referential words, which is where the coverage-per-token is highest.
const NON_ENGLISH_REFERENTIAL =
	/(^|\s)(et\s|aussi\s|alors\s|donc\s|encore\b|celui|celle|ceux|celles|ceci|cela|ça\b|leur(?:s)?\b|y\s|en\s+plus\b|y\s+también\b|también\b|eso\b|esa\b|ese\b|esto\b|esta\b|estos\b|aquello\b|su(?:s)?\b|ello\b|und\s+(?:auch|was)\b|dies(?:e|es|er)?\b|jene(?:r|s)?\b|dazu\b|davon\b|damit\b)/i;

// Stopwords stripped before counting how much TOPIC a query carries. Deliberately excludes proper
// nouns and any content word — everything here is a function word or a interrogative shell.
const LOW_CONTENT =
	/\b(a|an|the|is|are|was|were|be|been|am|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|of|to|in|on|at|for|from|with|about|as|by|and|or|but|if|then|than|so|too|very|just|really|what|which|who|whom|whose|when|where|how|why|you|your|yours|me|my|mine|i|we|us|our|ours|actual|exactly|please|now|again|me|tell|show|give|find|get|say|said)\b/gi;

/**
 * How many content-bearing tokens does this query carry once function words are removed? A query
 * with fewer than two cannot specify a topic on its own — "what are your actual sources" reduces to
 * zero, "what model are you exactly" to one ("model", which is precisely the word that retrieved
 * modelling quizzes). Pure + exported so the spec can pin the reduction rather than only the verdict.
 */
export function contentTokenCount(query: string): number {
	return query
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s'-]/gu, " ")
		.replace(LOW_CONTENT, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1).length;
}

/**
 * Does this query depend on prior conversation to be searchable on its own? Deterministic + pure.
 * True for dangling pronouns ("…about it") and continuation fragments ("and the second?"); false for
 * a self-contained query ("what is the biggest dinosaur"). Over-triggering is cheap (the rewrite
 * falls back to the original); under-triggering leaves the junk-source bug, so we bias toward true.
 *
 * Pronoun and continuation rules alone don't deliver that bias (CUR-151): on turns that searched,
 * retrieved sources, and cited none of them, those two rules rarely fire, and one fire is a FALSE
 * positive ("…and is he the current manager of Liverpool", where "he" resolves inside the same
 * sentence).
 *
 * The misses fall into three kinds, and each gets a rule rather than more pronouns: bare replies
 * and imperatives that carry no topic at all, non-English referentials against an English-only
 * regex, and queries whose content reduces to almost nothing once function words are stripped.
 *
 * On the cost of firing: a true positive saves a junk retrieval; a false positive costs ONE cheap
 * model call whose degenerate output falls back to the raw query anyway (`sanitizeRewrite`). That
 * asymmetry is the whole argument for widening, and it is why the content-token floor is set at a
 * conservative 2 rather than tuned — this gate should be generous, and the layer that must not be
 * generous is `sanitizeRewrite`.
 */
export function needsContextualization(query: string): boolean {
	const q = query.trim();
	if (!q) return false;
	return (
		REFERENTIAL.test(q) ||
		FRAGMENT_OPENER.test(q) ||
		BARE_REPLY_OR_IMPERATIVE.test(q) ||
		NON_ENGLISH_REFERENTIAL.test(q) ||
		IMPERATIVE_NO_TOPIC.test(q) ||
		contentTokenCount(q) < 2
	);
}

/** Sentinel distinguishing "the timer won the race" from any real (possibly falsy) model output. */
const TIMED_OUT = Symbol("query-rewrite-timeout");

/** Matches entityCorrection's CORRECTION_TIMEOUT_MS — the sibling call in this same search path, with
 *  the same 40-token budget against the same task model. Both run inside openSearch's firecrawlCap, so
 *  this narrows how much of an existing budget the rewrite may spend, never widens the turn's ceiling. */
const REWRITE_TIMEOUT_MS = 5000;

const REWRITE_PROMPT = `You rewrite a user's latest message into a standalone open-web search query. Resolve any pronouns or references ("it", "that", "they", "the second one") using the conversation so the query is meaningful on its own, with no prior context. Keep it short and search-like. Output ONLY the rewritten query — no quotes, no label, no explanation. If the message is already standalone, output it unchanged.`;

/**
 * Clean the model's rewrite and guard against degenerate output. Pure + testable. Falls back to the
 * original query when the rewrite is empty, over-long (the model rambled), or otherwise unusable.
 */
export function sanitizeRewrite(raw: string, fallback: string): string {
	let s = (raw ?? "").trim();
	if (!s) return fallback;
	// First line only — the model occasionally appends an explanation despite the instruction.
	s = s.split("\n")[0].trim();
	// Strip a leading label ("Standalone search query:", "Query -") and surrounding quotes/backticks.
	s = s.replace(/^(standalone search query|search query|query|search)\s*[:\-–]\s*/i, "").trim();
	s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (!s || s.length > 200) return fallback;
	return s;
}

/** What the rewrite call's response recorded: the model asked for, and the backend, served model and
 *  provider the endpoint reported. Any field the response did not carry stays unset. */
export type RewriteServed = {
	requestedModel?: string;
	model?: string;
	backend?: string;
	provider?: string;
	failed?: boolean;
};

/**
 * Rewrite `query` into a standalone search query using recent `history`, when it needs it. Best-effort:
 * returns the raw query unchanged when contextualization isn't needed, there's no history, or the
 * model call fails — never throws, never blocks the search.
 */
export async function contextualizeQuery(
	query: string,
	history: RewriteTurn[],
	locals: App.Locals | undefined,
	/** Told where the rewrite ran, from the call's own response, once it has answered (CUR-3563). Not
	 *  called when the rewrite was skipped, timed out or failed. */
	onAnswered?: (served: RewriteServed) => void
): Promise<string> {
	const q = query.trim();
	if (!q || history.length === 0 || !needsContextualization(q)) return q;

	try {
		const { generateFromDefaultEndpoint } = await import("$lib/chat/server/generateFromDefaultEndpoint");
		const convo = history
			.slice(-4)
			.map((m) => `${m.from === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
			.join("\n");
		// This call is bounded like its two siblings in this directory (entityCorrection's 5s race,
		// searchDecision's CLASSIFIER_HTTP_TIMEOUT_MS). A side-call that hangs here would take the whole
		// turn down at the 45s watchdog with nothing shown to the user and no log marker.
		const served: RewriteServed = {};
		const rewriteCall = getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [
					{
						from: "user",
						content: `Conversation so far:\n${convo}\n\nLatest user message: "${q}"\n\nStandalone search query:`,
					},
				],
				preprompt: REWRITE_PROMPT,
				generateSettings: { max_tokens: 40, temperature: 0 },
				signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
				onFailure: () => {
					served.failed = true;
				},
				onServed: (s) => {
					for (const [k, v] of Object.entries(s)) if (v) served[k as keyof typeof s] = v;
				},
				locals,
			})
		);
		let rewriteTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
			rewriteTimer = setTimeout(() => resolve(TIMED_OUT), REWRITE_TIMEOUT_MS);
		});
		let raw: string | typeof TIMED_OUT;
		try {
			raw = await Promise.race([rewriteCall, timeout]);
		} finally {
			if (rewriteTimer) clearTimeout(rewriteTimer);
		}
		if (raw === TIMED_OUT) {
			// CUR-914 house rule: lengths only, never the query text.
			logger.warn(
				{ queryLength: q.length, timeoutMs: REWRITE_TIMEOUT_MS },
				"[search] query contextualization timed out — using the raw query"
			);
			return q;
		}
		if (!served.failed) onAnswered?.(served);
		return sanitizeRewrite(String(raw ?? ""), q);
	} catch (e) {
		logger.warn(e, "[search] query contextualization failed — using raw query");
		return q;
	}
}
