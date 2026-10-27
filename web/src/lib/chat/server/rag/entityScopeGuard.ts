// A RAG hit can clear the cross-encoder relevance gate (rerankRag.ts) while still being about the
// wrong entity: a safety question about Anthropic and OpenAI is topically near our own "safety
// screen" taxonomy chunk, so the reranker correctly calls it relevant — the failure is entity
// attribution, not relevance, and a relevance gate structurally cannot see it (CUR-43). This is a
// named RAG failure mode ("deceptive grounding": arXiv 2607.09349) — a response
// can pass faithfulness and citation checks while attributing real evidence to the wrong subject,
// because neither check asks "is this passage about the entity the question names."
//
// So: one more small, cheap classifier call, same shape as classifySearchNeed
// (search/searchDecision.ts) — NOT a regex/keyword heuristic. A company-name list can't cover
// aliases ("SSI" vs "Safe Superintelligence") or non-English names, and the repo's rules rule out
// brittle-regex classification for exactly this reason.
//
// FAIL-OPEN, not fail-closed like classifySearchNeed. This guard lives inside the RAG pipeline,
// which has its own already-stated, repeated invariant (rag/index.ts, rerankRag.ts): an infra
// failure must never regress grounding below today's floor. classifySearchNeed can fail closed
// because a false "don't search" just answers from training — cheap to be wrong that way. Here,
// failing closed would mean an entity-scope infra hiccup silently drops hits that were fine,
// which is a worse failure than the one this guard exists to catch. So: error, timeout, or
// unparseable output all KEEP the hit.
import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { config } from "$lib/chat/server/config";
import { models } from "$lib/chat/server/models";
import { stripThink } from "$lib/chat/server/stripThink";
import { withTimeout } from "./evidence";
import type { RagSource } from "$lib/chat/types/Rag";

/** PostHog flag key. Owner: chat. New capability, no prior env-string state to fall back to —
 *  unreached PostHog means off, same shape as every other flag here except conversation-titles. */
export const ENTITY_SCOPE_GUARD_FLAG = "rag-entity-scope-guard";

/** Should surviving RAG hits get checked for entity attribution before grounding? Sync, never throws. */
export function entityScopeGuardEnabled(): boolean {
	return flagEnabledOr(ENTITY_SCOPE_GUARD_FLAG, () => false);
}

const CLASSIFY_TIMEOUT_MS = 4000;

// "Who runs Current AI?" retrieves "AI Potluck" — the chunk that literally says "from
// Current AI, a nonprofit coalition" — at a cosine rank comfortably inside the top-K, so retrieval
// is not where the risk lies. A single classifyEntityMatch call (one 3-token generation, no retry)
// judging that ONE passage against a brief, indirect self-reference question would decide alone
// whether the only relevant hit survives, and one ambiguous call would zero it out. Sampling more
// than once and requiring agreement before dropping avoids that: a genuine collider (CUR-43) is
// unambiguous and gets "no" from every sample, so this costs nothing on that side. (CUR-600)
const CLASSIFY_SAMPLES = 3;

const PREPROMPT = `You judge whether a retrieved passage actually discusses the specific entity or subject a question names, or is only topically related to a DIFFERENT entity.

Answer with exactly one word: yes or no.

- "yes" if the passage is about the entity/subject the question names. This includes questions about us (AI Potluck / Current AI) when the passage describes us.
- "no" if the passage covers the same general topic area but is about a different specific entity than the one the question names — for example the question names an external company and the passage describes our own catalog, taxonomy, or a different company instead.`;

// Pinned to the second-opinion model (GLM-5.2 on the HF router) rather than whatever the
// default endpoint serves. Following the serving model would change how many colliders this guard
// catches whenever the lane moves, with nothing re-measuring it (CUR-1120). The SECOND_OPINION_* lane is registered as a model only when its base
// URL and key are both set (maybeAddCompareModels in models.ts), so "registered" is the check. (CUR-1439)
let warnedUnpinned = false;

/** The model id this guard pins to, or undefined when the second-opinion lane isn't registered.
 *  Undefined falls back to the default endpoint and logs an error once per process: the guard still
 *  runs, but on a model nobody has measured it against. */
function entityScopeModelId(): string | undefined {
	const id = ((Reflect.get(config, "SECOND_OPINION_MODEL") as string | undefined) ?? "").trim();
	if (id && models.some((m) => m.id === id)) {
		return id;
	}
	if (!warnedUnpinned) {
		warnedUnpinned = true;
		logger.error(
			{ secondOpinionModelSet: Boolean(id) },
			"[rag] entity-scope classifier is NOT pinned: SECOND_OPINION_* lane unregistered, falling back to the default endpoint (CUR-1439)"
		);
	}
	return undefined;
}

/** Parse the classifier's raw output. Anchored on a leading "yes" so partial/rambling output does
 *  NOT count as a verdict either way — see classifyEntityMatch for why that resolves to keep, not
 *  drop. Exported for unit testing. */
export function parseEntityMatchVerdict(raw: string | undefined): "yes" | "no" | "unparseable" {
	const trimmed = (raw ?? "").trim();
	if (/^\s*yes\b/i.test(trimmed)) return "yes";
	if (/^\s*no\b/i.test(trimmed)) return "no";
	return "unparseable";
}

/** Ask the model whether `hit` actually discusses the entity `query` names. Scores title + snippet
 *  — the exact text that becomes prompt evidence if this hit grounds the answer, matching
 *  rerankRag.ts's own principle of judging what the model will actually see. Never throws: an
 *  error or empty/short query resolves to true (keep), the fail-open direction this guard commits to.
 *
 *  `locals` must be the real per-request App.Locals, not undefined (CUR-1120): this call goes
 *  through generateFromDefaultEndpoint -> endpointOai.ts, which reads locals?.billingOrganization to
 *  set X-HF-Bill-To. The served token's Inference-Providers permission is org-scoped, so an unbilled
 *  call resolves on the personal-user HF scope and 403s ("insufficient permissions ... on behalf of
 *  user ...") — same mechanism classifySearchNeed threads locals through for
 *  (searchDecision.ts). A 403 here doesn't surface as an error to the
 *  user: it's caught below and treated as fail-open, so the practical effect is CUR-43's colliders
 *  silently grounding again every time the classifier 403s. */
export async function classifyEntityMatch(
	query: string,
	hit: Pick<RagSource, "title" | "snippet">,
	locals: App.Locals | undefined
): Promise<boolean> {
	const q = query.trim();
	if (q.length < 3) {
		return true;
	}
	const modelId = entityScopeModelId();
	try {
		// generateFromDefaultEndpoint never throws: a failed call comes back as "", which parses as
		// unparseable and keeps the hit. onFailure is the only way to tell that apart (CUR-2123).
		let failed: { kind: "ceiling" | "error"; status?: number } | undefined;
		const raw = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [
					{
						from: "user",
						content: `Passage:\nTitle: ${hit.title}\n${hit.snippet}\n\nQuestion: "${q}"`,
					},
				],
				preprompt: PREPROMPT,
				generateSettings: { max_tokens: 3, temperature: 0 },
				...(modelId
					? {
							modelId,
							// GLM thinks by default and a 3-token budget spent thinking leaves no verdict,
							// which parses as unparseable and fails open. Which field turns reasoning off
							// depends on the provider (Scaleway reads reasoning_effort and not
							// thinking; novita and zai-org the reverse), so this asks for "off" and lets
							// reasoningOffRequest (thinkFilter.ts) send the field the verified profile names.
							disableThinking: true,
							// Opt out of the OPENAI_PROVIDER pin, which names a provider that doesn't host
							// GLM — same reason second-opinion/+server.ts passes it.
							provider: "auto",
						}
					: {}),
				// Cancel the request at our own deadline instead of abandoning it (CUR-1655).
				timeoutMs: CLASSIFY_TIMEOUT_MS,
				onFailure: (kind, status) => (failed = { kind, status }),
				locals,
			})
		);
		if (failed) {
			failOpenDeparture("entity-scope", failed.kind, { status: failed.status, modelId });
			return true;
		}
		// Belt to disableThinking's braces: a think block that still leaks into content is removed
		// before parsing, so a stray leading <think> can't read as unparseable by itself.
		const verdict = parseEntityMatchVerdict(stripThink(String(raw ?? "")));
		if (verdict === "unparseable") {
			failOpenDeparture("entity-scope", "unparseable", { modelId });
		}
		return verdict !== "no";
	} catch (e) {
		logger.error(e, "[rag] entity-scope classifier failed; keeping the hit");
		failOpenDeparture("entity-scope", "threw", { modelId });
		return true;
	}
}

/** Samples classifyEntityMatch CLASSIFY_SAMPLES times for one hit and keeps it unless a strict
 *  majority of the samples independently say "no" — see the CUR-600 comment above CLASSIFY_SAMPLES
 *  for why a single sample isn't enough. Each sample keeps its own fail-open timeout, so an infra
 *  failure still only ever pushes toward "keep", matching classifyEntityMatch's own contract. */
async function keepsHitOnEntityScope(
	query: string,
	hit: Pick<RagSource, "title" | "snippet">,
	locals: App.Locals | undefined
): Promise<boolean> {
	const votes = await Promise.all(
		Array.from({ length: CLASSIFY_SAMPLES }, () =>
			withTimeout(classifyEntityMatch(query, hit, locals), CLASSIFY_TIMEOUT_MS, true)
		)
	);
	const noVotes = votes.filter((keep) => !keep).length;
	return noVotes * 2 <= CLASSIFY_SAMPLES;
}

/** Filter RAG hits to the ones whose evidence text actually discusses the entity the query names.
 *  Runs CLASSIFY_SAMPLES classifier calls per hit, in parallel, each on its own fail-open timeout —
 *  a slow or down classifier degrades to today's behavior (every hit kept), never to fewer hits
 *  than today. */
export async function filterByEntityScope<T extends Pick<RagSource, "title" | "snippet">>(
	query: string,
	hits: T[],
	locals: App.Locals | undefined
): Promise<T[]> {
	if (hits.length === 0) {
		return hits;
	}
	const verdicts = await Promise.all(hits.map((hit) => keepsHitOnEntityScope(query, hit, locals)));
	const kept = hits.filter((_, i) => verdicts[i]);
	if (kept.length !== hits.length) {
		logger.info(
			{ retrieved: hits.length, kept: kept.length },
			"[rag] entity-scope guard dropped a hit whose evidence was about a different entity"
		);
	}
	return kept;
}
