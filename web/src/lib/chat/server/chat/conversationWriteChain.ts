/**
 * Per-request SERIALIZED conversation-write chain (TTFT plan §A, invariant 3).
 *
 * `docStore.updateOne` is a read-modify-write of the WHOLE conversation document (db/docStore.ts:
 * select → applyUpdate → write full row). Two in-flight `conversations.updateOne` for the same conv is
 * a LOST UPDATE. Every conversation write in the POST handler FROM THE CLAIM ONWARD — the user-msg
 * persist, `saveTitle`, and `persistConversation` on every terminal path (client-detach, abort, error,
 * finally) — MUST flow through ONE chain so they land strictly in order, never concurrently.
 *
 * The pre-stream overlap (§A) makes this load-bearing: the user-msg persist no longer blocks the handler
 * (it overlaps retrieval), so without the chain a slow user-msg write could still be in flight when the
 * terminal persist fires — the exact concurrent-updateOne race the chain forecloses.
 */

/** A serialized write chain. `enqueue` runs writes strictly in order; see the interface method. */
export interface ConversationWriteChain {
	/**
	 * Enqueue `write` to run AFTER every previously-enqueued link has settled, in order. Returns the
	 * link's OWN promise, which REJECTS if `write` rejects — so a caller that must observe the outcome
	 * (the user-msg persist, whose failure errors the turn before generation — invariant 5) can await it.
	 *
	 * The chain's tail ALWAYS advances PAST a failure (invariant 3): the tail is advanced by a `.catch`
	 * attached to the SAME returned promise, so (a) one rejecting link never wedges later links, and (b)
	 * the returned promise is already handled — a link whose returned promise is never awaited (its join
	 * skipped because an EARLIER join threw and entered the stream catch) does NOT surface as an
	 * unhandled rejection (invariant 7's three-branch case, collapsed into the single tail-advance since
	 * both branches attach to the one promise). Rejections are otherwise SILENT here: the callers that
	 * need logging own it (persistConversation try/catch-logs today; a user-msg/saveTitle rejection is
	 * surfaced by the awaiter into the stream catch).
	 */
	enqueue<T>(write: () => Promise<T>): Promise<T>;
}

export function createConversationWriteChain(): ConversationWriteChain {
	// The chain tail: settles when the last enqueued link has run. It advances past failures (never
	// rejects) so later links still run — an awaiter observes a failure via the per-link promise
	// enqueue() returns, not via the tail.
	let tail: Promise<unknown> = Promise.resolve();
	return {
		enqueue<T>(write: () => Promise<T>): Promise<T> {
			const link = tail.then(() => write());
			// Advance the tail via a `.catch` on `link`: this both (a) keeps the next link unblocked past a
			// failure and (b) registers a rejection handler on `link` so the returned promise never floats.
			tail = link.catch(() => undefined);
			return link;
		},
	};
}
