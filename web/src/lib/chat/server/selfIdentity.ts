// Is this turn a question about the assistant itself (which model it is, who made, serves or runs
// it, where its answer runs)? The conversation route uses the verdict to keep such a question off the
// web (CUR-2135).
//
// An embedding margin, same shape as search/searchIntent.ts: max cosine to questions about the
// assistant minus max cosine to near misses about other models, companies and title-holders. It reads
// meaning, so "Who holds the world chess championship title?" stays on the near side of "Who runs
// you?" without anyone listing words.
//
// It embeds with its own multilingual model rather than the RAG embedder: the English-only
// all-MiniLM-L6-v2 flags "Why is Tokyo the capital of Japan?" asked in Amharic or Chinese and misses
// the identity question in many translations. At this threshold (evidence on CUR-2135) the Tokyo
// question is flagged in none of 20 languages and the identity question is caught in all 18; on 24
// English phrasings held back from fitting, 8 of 12 questions about the assistant are caught and 1 of
// 12 near misses is flagged. Misses are the side to give up: a miss leaves the turn as it would be
// without this check.
//
// The margin alone flags factual questions that resemble nothing on either side, such as one that sits
// at 0.31 to the nearest question about the assistant and 0.24 to the nearest near miss, a margin of
// 0.07. SELF_IDENTITY_MIN_SELF also requires the query to be close to a question about the assistant.
// Offline (evidence on CUR-2135): the 33 identity questions, EN/FR/DE and 18 translations included,
// score 0.56 or more to the self exemplars; of 149 factual questions and near misses, the highest
// scores 0.54 and the margin alone flags 27. With the floor, 33 of 33 caught and 0 of 149 flagged.
//
// A follow-up about who oversees something else can read as one about the assistant: German "wer
// überwacht sie?" (them) is spelled like formal "Sie" (you), and can veto the search at a margin like 0.32.
// The near misses hold four "who enforces or supervises these rules" questions for that (CUR-3964):
// with them, such follow-ups in five languages veto 0 of 20; 31 of 32 identity questions in 15
// languages are still caught, the miss being "Who monitors you?".

import { embedText, embedTexts, maxCosine } from "$lib/chat/server/rag/embed";
import { MULTILINGUAL_EMBEDDING_MODEL } from "$lib/chat/server/rag/env";
import { logger } from "$lib/chat/server/logger";
import { flagEnabledOr } from "$lib/chat/server/flags";

import SELF_EXAMPLES from "$lib/chat/server/data/selfIdentityExamples.json";
import NOT_SELF_EXAMPLES from "$lib/chat/server/data/notSelfIdentityExamples.json";

/** PostHog key for the provider stamp. Registered in flagKeys.ts. */
export const PROVIDER_STAMP_FLAG = "identity-provider-stamp";

export function providerStampEnabled(): boolean {
	return flagEnabledOr(PROVIDER_STAMP_FLAG, () => false);
}

/** Operating point, measured in SELF_IDENTITY_MODEL's space (see the header). */
const SELF_IDENTITY_THRESHOLD = 0.04;

/** The least cosine to a question about the assistant that can stamp, whatever the margin. Measured in
 *  the same space: identity questions start at 0.56, factual questions top out at 0.54. */
const SELF_IDENTITY_MIN_SELF = 0.5;

/** How long a turn waits for the verdict once the answer has finished. The requests start with the
 *  turn, so this bounds only the extra wait at the end of it. */
const VERDICT_BUDGET_MS = 6000;

/** How long the embedding requests themselves may run. HF serves this model serverless and loads it on
 *  demand: a cold load can outlast the 6 s budget, and the same model then answers in
 *  about 150 ms. A request that outlives one turn's budget still fills the caches,
 *  so the next turn finds them warm. */
const EMBED_TIMEOUT_MS = 30000;

/** The embedding model the threshold was measured in, pinned so a change to the RAG embedder cannot
 *  move it. A cosine margin means nothing in another model's space. */
const SELF_IDENTITY_MODEL = MULTILINGUAL_EMBEDDING_MODEL;

/** PURE: how close the query sits to questions about the assistant, and how much closer than to the near misses. */
function selfIdentityScores(
	query: readonly number[],
	self: readonly (readonly number[])[],
	notSelf: readonly (readonly number[])[]
): { selfScore: number; margin: number } {
	const selfScore = maxCosine(query, self);
	return { selfScore, margin: selfScore - maxCosine(query, notSelf) };
}

type ExemplarVectors = { self: number[][]; notSelf: number[][] };
let exemplarCache: ExemplarVectors | null = null;
let exemplarsInFlight: Promise<ExemplarVectors | null> | null = null;

/** Embedded once per process in one batched call, shared by every turn that asks while it runs. */
function exemplarVectors(): Promise<ExemplarVectors | null> {
	if (exemplarCache) return Promise.resolve(exemplarCache);
	exemplarsInFlight ??= embedTexts(
		[...SELF_EXAMPLES, ...NOT_SELF_EXAMPLES],
		EMBED_TIMEOUT_MS,
		SELF_IDENTITY_MODEL
	)
		.then((all) => {
			if (all) {
				exemplarCache = {
					self: all.slice(0, SELF_EXAMPLES.length),
					notSelf: all.slice(SELF_EXAMPLES.length),
				};
			}
			return exemplarCache;
		})
		.finally(() => {
			exemplarsInFlight = null;
		});
	return exemplarsInFlight;
}

export type SelfIdentityVerdict = {
	isSelf: boolean;
	ok: boolean;
	margin: number;
	/** Cosine to the nearest question about the assistant; present when `ok`. */
	selfScore?: number;
	reason?: "empty-query" | "no-vector" | "over-budget" | "threw";
};

/**
 * Is `text` a question about the assistant itself? `ok: false` means no opinion, and the caller stamps
 * nothing: an answer without the stamp is what every turn gets today.
 *
 * Starts the embedding calls now and returns the reader. The budget starts when the reader is called,
 * so a turn that starts this with the request and reads it once the answer has finished gives a cold
 * embedder the whole generation to load in, and waits at most VERDICT_BUDGET_MS past the answer. A clock started with the turn would give up at 6 s on a turn that takes 18 s to answer.
 *
 * COST: one embedding call per turn (about 150 ms warm), plus the exemplars' one
 * batched call the first time a process asks.
 */
export function startSelfIdentityVerdict(text: string): () => Promise<SelfIdentityVerdict> {
	const q = (text ?? "").trim();
	if (!q) return async () => ({ isSelf: false, ok: false, margin: 0, reason: "empty-query" });
	// Each half timed on its own: a slow query embed means the model is cold at HF, a slow exemplar
	// batch means this process is new. The over-budget log carries both.
	const started = Date.now();
	const hadExemplars = exemplarCache !== null;
	const took: { queryMs?: number; exemplarsMs?: number } = {};
	const timed = <T>(p: Promise<T>, key: keyof typeof took) =>
		p.finally(() => {
			took[key] = Date.now() - started;
		});
	const vectors = Promise.all([
		timed(embedText(q, EMBED_TIMEOUT_MS, SELF_IDENTITY_MODEL), "queryMs"),
		timed(exemplarVectors(), "exemplarsMs"),
	]);
	// Read once, maybe after a rejection has already happened; this keeps it from counting as unhandled.
	vectors.catch(() => undefined);
	return async () => {
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const overBudget = new Promise<"over-budget">((resolve) => {
				timer = setTimeout(() => resolve("over-budget"), VERDICT_BUDGET_MS);
			});
			const got = await Promise.race([vectors, overBudget]).finally(() => clearTimeout(timer));
			if (got === "over-budget") {
				// The requests keep running and fill the caches; this turn goes unstamped, as every turn did
				// before the stamp existed. Logged so a cold embedder shows up as a count.
				logger.info(
					{ leg: "self-identity", budgetMs: VERDICT_BUDGET_MS, hadExemplars, ...took },
					"[self-identity] no verdict within budget; not stamped"
				);
				// How late it was, once it settles: the number that sizes the budget and says which half to fix.
				vectors.finally(() =>
					logger.info(
						{ leg: "self-identity", lateMs: Date.now() - started, hadExemplars, ...took },
						"[self-identity] verdict settled after the turn gave up"
					)
				).catch(() => undefined);
				return { isSelf: false, ok: false, margin: 0, reason: "over-budget" };
			}
			const [qVec, ex] = got;
			if (!qVec || !ex) {
				logger.info({ leg: "self-identity" }, "[self-identity] embedding returned nothing; not stamped");
				return { isSelf: false, ok: false, margin: 0, reason: "no-vector" };
			}
			const { selfScore, margin } = selfIdentityScores(qVec, ex.self, ex.notSelf);
			return {
				isSelf: margin >= SELF_IDENTITY_THRESHOLD && selfScore >= SELF_IDENTITY_MIN_SELF,
				ok: true,
				margin,
				selfScore,
			};
		} catch (e) {
			logger.warn({ err: e, leg: "self-identity" }, "[self-identity] classification failed");
			return { isSelf: false, ok: false, margin: 0, reason: "threw" };
		}
	};
}

/** What a search decision saw of the identity verdict. A question about Alpha that searched anyway
 *  is explained by one of: the reader was never built, the verdict missed the decision's budget, it
 *  had no opinion, or it read the question as not about Alpha (CUR-2135). Each search line carries
 *  which. */
export type IdentityReading =
	| { identity: "not-run" }
	| { identity: "missed-budget"; identityBudgetMs: number }
	| { identity: "no-opinion"; identityReason: string }
	| { identity: "self" | "not-self"; identityMargin: number; selfScore?: number };

function readingOf(v: SelfIdentityVerdict | undefined): IdentityReading {
	if (!v) return { identity: "no-opinion", identityReason: "threw" };
	if (!v.ok) return { identity: "no-opinion", identityReason: v.reason ?? "unknown" };
	return { identity: v.isSelf ? "self" : "not-self", identityMargin: v.margin, selfScore: v.selfScore };
}

/** Reads the verdict within `budgetMs`, never rejecting. On a miss the verdict keeps running, and the
 *  reading it would have given is logged once it settles, so a missed veto shows what it would have said. */
export async function readIdentityWithin(
	read: (() => Promise<SelfIdentityVerdict>) | undefined,
	budgetMs: number,
	leg: string
): Promise<{ verdict?: SelfIdentityVerdict; reading: IdentityReading }> {
	if (!read) return { reading: { identity: "not-run" } };
	const started = Date.now();
	const verdict = read().catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const missed = new Promise<"missed">((resolve) => {
		timer = setTimeout(() => resolve("missed"), budgetMs);
	});
	const got = await Promise.race([verdict, missed]).finally(() => clearTimeout(timer));
	if (got === "missed") {
		void verdict.then((late) =>
			logger.info(
				{ leg, lateMs: Date.now() - started, identityBudgetMs: budgetMs, late: readingOf(late) },
				"[self-identity] verdict arrived after the search decision"
			)
		);
		return { reading: { identity: "missed-budget", identityBudgetMs: budgetMs } };
	}
	return { verdict: got, reading: readingOf(got) };
}
