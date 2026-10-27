/**
 * Per-instance admission gate for generation concurrency.
 *
 * On Vercel Fluid one instance serves many concurrent invocations. Past the inference endpoint's
 * flat batch-region, admitting more generations doesn't add throughput — it just makes EVERYONE's
 * TTFT creep (the queue at the model). This caps concurrent generations PER INSTANCE so the route can
 * SHED overflow as a fast retryable 503 ("at capacity, try again") instead of degrading the whole
 * room. Global cap ≈ (live instances × per-instance cap) — imprecise but bounded and safe.
 *
 * The design is deliberately simple, so the gate cannot become a failure source itself:
 *  - NO shared state / NO new hot-path dependency → no new single-point-of-failure. A precise global
 *    cap would need a cross-instance counter (Postgres/Redis on the hot path); not worth the
 *    coordination cost or the extra DB load.
 *  - FAIL-OPEN by construction: disabled (admit all) whenever MAX_CONCURRENT_GENERATIONS <= 0, which
 *    is the DEFAULT — so landing this is a no-op until it's tuned to the endpoint's measured knee.
 *  - LEAK-PROOF only because the caller releases in `finally` AND generations are hard-bounded
 *    (generationDeadline + the pre-stream chain deadline) so a hung turn frees its slot within the
 *    ladder's worst case — see $lib/chat/utils/deadlineLadder — never at the platform kill, which
 *    runs no `finally` at all. Without those bounds this gate would leak slots and become the
 *    very failure it exists to prevent — that dependency is intentional and load-bearing.
 */

let inFlight = 0;

/** Env-tunable cap; <= 0 (the default) disables the gate entirely (admit all). Read per-call so it can
 *  be re-tuned via env without a redeploy touching this module. */
function maxConcurrent(): number {
	const n = Number(process.env.MAX_CONCURRENT_GENERATIONS);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Try to take a generation slot. Returns true if admitted — the caller MUST call
 * releaseGenerationSlot() exactly once in a `finally`. Returns false when this instance is at
 * capacity; the caller should shed the turn as a retryable 503 rather than call the model. When the
 * gate is disabled (cap <= 0) this always admits and takes no slot (release is then a no-op).
 */
export function tryAcquireGenerationSlot(): boolean {
	const max = maxConcurrent();
	if (max <= 0) return true; // disabled → always admit, no slot taken
	if (inFlight >= max) return false;
	inFlight++;
	return true;
}

/** Release a slot taken by tryAcquireGenerationSlot(). Clamped at 0 so a double-release (or a release
 *  after the gate was disabled mid-flight) can never drive the counter negative and wedge the gate. */
export function releaseGenerationSlot(): void {
	if (inFlight > 0) inFlight--;
}

/** Test/introspection only — current in-flight count on THIS instance. */
export function generationInFlight(): number {
	return inFlight;
}
