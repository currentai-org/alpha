import { logger } from "$lib/chat/server/logger";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
// NOTE: generateFromDefaultEndpoint is imported DYNAMICALLY inside correctEntityQuery — same reason
// queryRewrite.ts defers it: keeps sanitizeCorrection importable by tests without booting the model layer.

// Entity-name typo correction (CUR-877) — a PARALLEL branch of retrieveWeb's engine fan-out
// (openSearch.ts), not a sequential pre-check like contextualizeQuery (queryRewrite.ts). A misspelled
// proper noun breaks both the model's own recall AND Firecrawl's lexical search identically — real
// Firecrawl calls confirmed "goad pistilli" returns zero overlapping results against the real Giada
// Pistilli's clean top-1 hit for the correctly-spelled name (CUR-875). A sequential correction step
// would add its own model-call latency to EVERY search; firing it alongside the other engines instead
// hides that cost inside the budget Firecrawl's own round-trip already spends. A returned correction
// gets its own concurrent Firecrawl request (see openSearch.ts), judged by the same reranker already
// scoring every other engine's results — dedupe() there already collapses any URL overlap with the
// primary Firecrawl call, so no new merge logic is needed.

const CORRECTION_PROMPT = `You check a web search query for ONE misspelled proper noun — a person, organization, place, or other named entity whose spelling looks wrong. If you are confident a name is misspelled AND you know the correct spelling, output ONLY the query with just that name corrected and nothing else changed. If nothing looks misspelled, or you are not confident of the correct spelling, output exactly: NONE. Never invent an entity that is not already in the query, and never touch a name that is already spelled correctly.`;

/** Sentinel distinguishing "the timer won the race" from any real (possibly falsy-looking) model output. */
const TIMED_OUT = Symbol("entity-correction-timeout");

// generateFromDefaultEndpoint takes no AbortSignal, so nothing else can cut this call off once
// started — race it against a timer instead of letting a stalled model call hold retrieveWeb's whole
// Promise.allSettled hostage. Raising this does NOT change worst-case turn latency: this branch runs
// inside openSearch.ts's firecrawl-corrected engine, under the SAME firecrawlCap (9000ms default) the
// primary Firecrawl call already bounds the whole retrieval by — so this only ever narrows how much of
// that existing budget the correction call gets to use before giving up, never widens the turn's ceiling.
// A shorter value is too short for a cold serverless instance's first call on a slow tier. The
// value is engineering judgment, not a measured threshold.
const CORRECTION_TIMEOUT_MS = 5000;

/**
 * Clean the model's correction and guard against a no-op or degenerate answer. Pure + testable, same
 * shape as queryRewrite.ts's sanitizeRewrite — but returns undefined (never a fallback string) since
 * "nothing to correct" and "correction failed" both mean the same thing here: skip the extra request.
 */
export function sanitizeCorrection(raw: string, original: string): string | undefined {
	let s = (raw ?? "").trim();
	if (!s || /^none$/i.test(s)) return undefined;
	// First line only — the model occasionally appends an explanation despite the instruction.
	s = s.split("\n")[0].trim();
	s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (!s || s.length > 200) return undefined;
	// The model just echoed the query back — nothing to gain from a second, identical Firecrawl call.
	if (s.toLowerCase() === original.trim().toLowerCase()) return undefined;
	return s;
}

/**
 * Ask a fast, cheap model whether `query` contains a misspelled entity name and, if so, return the
 * corrected query. Best-effort: returns undefined on any error, timeout, "NONE", or degenerate output
 * — never throws. The caller (openSearch.ts) treats undefined exactly like "nothing to correct" and
 * skips the second Firecrawl request.
 */
/** Who asked. The title path (`title.ts`) re-runs this on a conversation's first turn whether or not
 *  that turn searched, so a log line that cannot say which caller it came from cannot size either
 *  one (CUR-2140). */
export type EntityCorrectionCaller = "search" | "title";

/** What one call came to. `none` is the model saying NONE; `unusable` is any other answer
 *  sanitizeCorrection rejects (an echo, an over-long reply). Both skip the extra request. Every outcome is
 *  logged, so the timeout share has a denominator (CUR-2140). */
type CorrectionOutcome = "found" | "none" | "unusable" | "empty" | "timeout" | "error";

export async function correctEntityQuery(
	query: string,
	locals: App.Locals | undefined,
	caller: EntityCorrectionCaller = "search",
	// Every production caller takes the default. The spec passes a short budget so its three timeout
	// cases don't each sit out a real 5s.
	timeoutMs: number = CORRECTION_TIMEOUT_MS
): Promise<string | undefined> {
	const q = query.trim();
	if (!q) return undefined;
	const startedAt = Date.now();
	let firstTokenAt: number | undefined;
	let served: { requestedModel?: string; backend?: string; model?: string; provider?: string } = {};
	let failed: "ceiling" | "error" | undefined;
	// One line per call, every path (CUR-2140). `firstTokenMs` absent on a timeout means nothing
	// streamed inside the budget, a stall; present means the model was producing and slow to finish.
	// `requestedModel` is always there; `backend` only arrives with the gateway's headers at the end of
	// the stream, so a timed-out call never carries one, and a lane that sends none (the HF router)
	// never does.
	const logOutcome = (outcome: CorrectionOutcome) =>
		logger.info(
			{
				leg: "entity-correction",
				caller,
				outcome,
				ms: Date.now() - startedAt,
				firstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - startedAt,
				requestedModel: served.requestedModel,
				backend: served.backend,
				provider: served.provider,
				servedModel: served.model,
				queryLength: q.length,
				timeoutMs,
			},
			"[search] entity-name correction outcome"
		);
	try {
		const { generateFromDefaultEndpoint } = await import(
			"$lib/chat/server/generateFromDefaultEndpoint"
		);
		// Two bounds, cutting different things — CUR-1655.
		//   signal  cancels the underlying HTTP request, so the generation genuinely STOPS. This is the
		//           one that matters: the drain below loops `await generator.next()` with no abort, so
		//           without it an abandoned drain keeps the upstream async iterator from ever returning
		//           `done`, screenStream's producer never finishes, and the whole turn dies at the
		//           watchdog having shown the user nothing (CUR-1657).
		//   race    guarantees THIS function returns within the budget whatever the endpoint does —
		//           including a hang before any fetch is issued, which a request signal cannot reach.
		// Holding `gen` also lets us close the generator itself; that is the weakest of the three (it
		// queues behind the in-flight next()) and is kept only because it costs one line.
		const signal = AbortSignal.timeout(timeoutMs);
		const gen = generateFromDefaultEndpoint({
			messages: [{ from: "user", content: `Query: "${q}"\n\nCorrected query (or NONE):` }],
			preprompt: CORRECTION_PROMPT,
			generateSettings: { max_tokens: 40, temperature: 0 },
			signal,
			onServed: (s) => {
				served = { ...served, ...s };
			},
			onFailure: (kind) => {
				failed = kind;
			},
			locals,
		});
		// getReturnFromGenerator's loop, plus the time the first token arrived.
		const call = (async () => {
			for (;;) {
				const step = await gen.next();
				if (step.done) return step.value;
				if (
					firstTokenAt === undefined &&
					step.value.type === MessageUpdateType.Stream &&
					step.value.token
				) {
					firstTokenAt = Date.now();
				}
			}
		})();
		// Cleared in the finally: a correction that WINS the race would otherwise leave this timer armed for the
		// rest of CORRECTION_TIMEOUT_MS, which can hold a serverless function open past the answer.
		let correctionTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
			correctionTimer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
		});
		let raw: string | typeof TIMED_OUT;
		try {
			raw = await Promise.race([call, timeout]);
		} finally {
			if (correctionTimer) clearTimeout(correctionTimer);
		}
		// The signal and the timer share one budget, so either can land first. When the signal wins,
		// generateFromDefaultEndpoint swallows the abort and returns "", which would read as a model
		// that said nothing and log no timeout at all (CUR-2140).
		if (raw === TIMED_OUT || (signal.aborted && !raw)) {
			// Belt-and-braces behind the signal above: close the generator too, the same move as
			// failover.ts's abandon(). On its own this is NOT enough: the drain pulls again the instant a
			// pull resolves, so return() queues behind the in-flight next() and cannot interrupt a pull
			// that never settles. The signal is what actually cuts it.
			// Fire-and-forget with the rejection swallowed: this path is already giving up on the answer,
			// so a failure to close cleanly must not become the caller's error.
			//
			// An abandoned drain keeps the upstream async iterator from ever returning `done`, so
			// screenStream's producer never sets sourceDone and its consumer parks on an unbounded wait:
			// nothing is screened, no token is released, and output screening is the first-token gate.
			// A turn that logs the timeout below without this dies at the 45s watchdog far more often than
			// one with neither this nor a hedge (CUR-1657).
			// "" not undefined: this generator is AsyncGenerator<MessageUpdate, string, undefined>, so its
			// return value is typed string — and "" is already what generateFromDefaultEndpoint itself
			// returns on its own failure path, so the closed generation resolves exactly like a failed one.
			void Promise.resolve(gen.return("")).catch(() => {});
			// No query text in the log (house rule, see rag/localStore.ts) — a length is enough
			// to see the timeout happen without shipping the user's search text to Axiom. (CUR-914)
			logger.warn(
				{ queryLength: q.length },
				"[search] entity-name correction timed out — skipping correction branch"
			);
			logOutcome("timeout");
			return undefined;
		}
		const text = String(raw ?? "");
		const corrected = sanitizeCorrection(text, q);
		// The only success signal this branch has ever emitted was its own absence — a timeout or
		// error warns, but a real correction returned nothing to distinguish "found a typo, dispatched
		// a corrected search" from "judged nothing wrong" in prod logs. Both are silent verdicts;
		// this one is the interesting one to see happen.
		if (corrected) {
			// No query text in the log (house rule) — lengths only, same reasoning as the
			// timeout branch above. (CUR-914)
			logger.info(
				{ originalLength: q.length, correctedLength: corrected.length },
				"[search] entity-name correction found — dispatching corrected query"
			);
			logOutcome("found");
		} else {
			// An empty reply is a failed call when the endpoint said so (a refused request, the 15s
			// ceiling); otherwise the model really answered with nothing.
			const t = text.trim();
			logOutcome(!t ? (failed ? "error" : "empty") : /^none$/i.test(t) ? "none" : "unusable");
		}
		return corrected;
	} catch (e) {
		logger.warn(e, "[search] entity-name correction failed — skipping correction branch");
		logOutcome("error");
		return undefined;
	}
}
