/**
 * The first-token median alert's decision, kept free of the DB and the logger so a replay of real turns
 * and the unit tests run the same code the cron does (CUR-2243).
 *
 * The turn-outcome rate alert sees a pool that stops answering: the watchdogs end those turns
 * `timedOut`. It cannot see one that still answers, slowly: every turn can complete while guests wait
 * a median of 12s or more for the first words, and the rate alert never fires.
 *
 * A median of the newest 15 completed turns, because prod's healthy daily p90 already reaches 23s. Sized
 * on 885 production turns over two weeks: a 15s ceiling is crossed only in a real slowdown. The window is 12h, not
 * the rate alert's 6h, because at prod's few turns an hour a 6h window held 15 completed turns after only
 * 56% of turns, against 85% for 12h; sampling fewer than 15 instead raised 7 to 32 false alarms on
 * healthy days. Fewer than 15 completed turns in the window is no verdict, so a quiet night neither
 * raises nor clears it.
 */

export const TURN_SPEED_WINDOW_MS = 12 * 60 * 60_000;
export const TURN_SPEED_SAMPLE = 15;
const TURN_SPEED_MAX_MEDIAN_TTFT_MS = 15_000;

export type TurnSpeedVerdict =
	| { kind: "no-verdict"; total: number }
	| { kind: "healthy" | "slow"; total: number; medianTtftMs: number };

/** `ttfts` are the newest completed turns' first-token times in the window, newest first. Only the newest
 *  TURN_SPEED_SAMPLE count. */
export function turnSpeedVerdict(ttfts: readonly number[]): TurnSpeedVerdict {
	const recent = ttfts.slice(0, TURN_SPEED_SAMPLE);
	if (recent.length < TURN_SPEED_SAMPLE) return { kind: "no-verdict", total: recent.length };
	const sorted = [...recent].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const medianTtftMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	return {
		kind: medianTtftMs > TURN_SPEED_MAX_MEDIAN_TTFT_MS ? "slow" : "healthy",
		total: recent.length,
		medianTtftMs,
	};
}
