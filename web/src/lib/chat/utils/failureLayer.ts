/**
 * Which layer a failed turn died in, so the turn-failure alert can page on our own pipeline
 * breaking and report a saturated partner model host as what it is.
 *
 *   ours      our code or our timing: an exception we threw, a stall in one of our own steps (retrieval,
 *             a tool, the output screen), a stream we received and then lost, a guard that emptied the
 *             answer, or a failure nobody recorded a cause for
 *   upstream  the model host: a 429 or 5xx, no first chunk before our deadline, a stream it dropped, a
 *             connection it refused, or a model call that stalled with none of our steps running
 *   client    the visitor's side: they stopped the turn, their message was too long for the model, or
 *             the model is their own local endpoint and it did not answer
 *
 * The inputs are recorded at the site that decided the failure (failureCause in the route), never read
 * back out of a message or a log line. A failure with no recorded cause is `ours`: an unexplained
 * failure has to page until someone explains it, and that is the conservative error for an alert whose
 * job is to catch our own breakage.
 */
import { FAILURE_OUTCOMES, type TurnOutcome } from "./outcomeLadder";

export type FailureLayer = "ours" | "upstream" | "client";

/** What ended a failed turn, named by the code path that decided it. */
export type FailureCause =
	/** The host answered 429 (failover.ts and the generation catch read it with isRateLimited). */
	| "upstream-rate-limited"
	/** The host answered 5xx. */
	| "upstream-http-5xx"
	/** No lane sent a first chunk by its deadline (NoFirstChunkError). */
	| "upstream-no-first-chunk"
	/** The host's stream closed mid-answer (upstreamDropped.ts). */
	| "upstream-dropped"
	/** The connection to the host failed before any response (refused, reset, DNS, connect timeout). */
	| "upstream-unreachable"
	/** The newest message alone was over the model's context, refused before any call. */
	| "message-too-long"
	/** The watchdog ended the turn while the model call was the only thing running (watchdogBlamesModel). */
	| "watchdog-model-stalled"
	/** The watchdog ended the turn before the model call began, or while one of our steps ran. */
	| "watchdog-our-step"
	/** The output screen's own phase deadline fired (screenStream.ts). */
	| "output-screen-timeout"
	/** The stream ended and nothing was written ("No output generated after streaming"). */
	| "no-output"
	/** Any other thrown error: a 4xx other than 429 (a request we built wrong, a key we hold), or a bug. */
	| "exception";

export interface FailureLayerInputs {
	outcome: TurnOutcome;
	/** Null when no failure site recorded one. */
	cause: FailureCause | null;
	/** The model is a visitor's own local endpoint (isLocalModelId). */
	isLocalModel: boolean;
	/** A token streamed from the model this turn (`firstTokenReached` on the outcome line). */
	firstTokenReached: boolean;
}

/** Causes that mean the model's host did not deliver. On a local model that host is the visitor's. */
const HOST_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>([
	"upstream-rate-limited",
	"upstream-http-5xx",
	"upstream-no-first-chunk",
	"upstream-dropped",
	"upstream-unreachable",
	"watchdog-model-stalled",
]);

/**
 * The layer a turn failed in, or null for a turn that did not fail. `aborted` is labelled `client` so a
 * reader of the outcome line can see it, though the rate alerts never count it (FAILURE_OUTCOMES).
 */
export function classifyFailureLayer(t: FailureLayerInputs): FailureLayer | null {
	if (t.outcome === "aborted") return "client";
	if (!FAILURE_OUTCOMES.has(t.outcome)) return null;
	// The model wrote something and a guard of ours judged none of it an answer (outcomeLadder.ts). The
	// host delivered; the decision to show the visitor our pointer instead was ours.
	if (t.outcome === "empty") return "ours";
	if (t.cause === "message-too-long") return "client";
	// "no-output" splits on whether the host sent anything: nothing at all is the host's empty stream,
	// tokens that arrived and were then not written are ours to have lost.
	const hostDidNotDeliver =
		(t.cause !== null && HOST_CAUSES.has(t.cause)) || (t.cause === "no-output" && !t.firstTokenReached);
	if (hostDidNotDeliver) return t.isLocalModel ? "client" : "upstream";
	return "ours";
}

/**
 * Our own mitigation for the failed turn, which the harm alert reads. Both mitigations
 * the app has run INSIDE the turn, before its outcome is written: lane failover (failover.ts, including
 * Large 3 → Medium on a 429) and nothing else. So a turn that failed already failed after them.
 *
 *   tried      a backup lane was announced (a Failover update) and the turn still failed
 *   available  the model has a backup lane, but the turn failed where failover cannot act (after the
 *              first chunk, or in our own step)
 *   none       the model has a single lane
 */
export type FallbackState = "tried" | "available" | "none";

export function fallbackState(t: { failoverAnnounced: boolean; laneCount: number }): FallbackState {
	if (t.failoverAnnounced) return "tried";
	return t.laneCount > 1 ? "available" : "none";
}
