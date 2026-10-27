/**
 * Run an invalidation until its result is OBSERVED to apply, bounded.
 *
 * SvelteKit's `invalidate()` resolves when its load settles — but a load superseded by a NEWER
 * invalidation/navigation returns without applying anything (the router's latest-wins token check
 * precedes `update()` in kit's client). So "the awaited invalidate resolved" is not evidence that
 * fresh data landed. Callers that must not proceed until a refresh has actually delivered (the
 * conversation page's post-turn resync releasing its sync hold) detect application by identity:
 * every load run constructs a fresh object, so an applied refresh always changes `getCurrent()`.
 *
 * If an attempt was superseded, either the superseding load applies (its data is strictly fresher
 * than ours — fetched later — so the caller is equally satisfied) or it too was cancelled, and
 * re-invalidating makes us the newest token. Bounded for liveness: a pathological run of
 * supersede-and-cancel races exhausts the budget and returns false rather than looping forever.
 *
 * @returns true once `getCurrent()` changed from its starting identity; false if the attempt
 *          budget ran out without an observed apply.
 */
export async function refreshUntilApplied(opts: {
	/** Identity probe for the reactive value the invalidation replaces (e.g. `() => data.messages`). */
	getCurrent: () => unknown;
	/** The invalidation to run (e.g. `() => safeInvalidate(UrlDependency.Conversation)`). */
	invalidate: () => Promise<void>;
	/** Attempt budget. Default 3. */
	attempts?: number;
}): Promise<boolean> {
	const { getCurrent, invalidate, attempts = 3 } = opts;
	const before = getCurrent();
	for (let attempt = 0; attempt < attempts && getCurrent() === before; attempt++) {
		await invalidate();
	}
	return getCurrent() !== before;
}
