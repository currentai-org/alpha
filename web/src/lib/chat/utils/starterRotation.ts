// Picks which starter prompts to show on a given visit, and remembers what was shown last
// time (via a small first-party cookie, see +layout.server.ts) so a returning visitor doesn't see
// the identical set twice in a row. (CUR-620)

/** Starter prompts on the empty state (CUR-620). Client-safe: the chat loader and the /alpha demo both read it. */
export const STARTER_COUNT = 3;

/** Fisher-Yates, seeded via an injectable rng so tests can be deterministic. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
	const arr = items.slice();
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/**
 * Picks `count` prompts from `pool`, excluding whatever was shown last visit (`previous`) whenever
 * the pool is large enough to still fill `count` without them — a strictly stronger guarantee than
 * "not an identical set," which is cheap to give when the pool supports it. Falls back to sampling
 * the full pool when `previous` would starve the pick (small or operator-overridden pool), so the
 * function always returns `count` items rather than a short list.
 */
export function pickRotatingStarters(
	pool: readonly string[],
	count: number,
	previous: readonly string[] = [],
	rng: () => number = Math.random
): string[] {
	if (pool.length <= count) return pool.slice(0, count);
	const seen = new Set(previous);
	const fresh = pool.filter((p) => !seen.has(p));
	const source = fresh.length >= count ? fresh : pool;
	return shuffle(source, rng).slice(0, count);
}

// The cookie stores INDICES into the current pool, not prompt text — smaller, and never leaks
// prompt content. An index that's out of range (pool edited/reordered since the cookie was set)
// is silently dropped rather than treated as an error; worst case is one visit's "avoid repeat"
// guarantee lapses, not a crash or a wrong prompt.
export const STARTER_HISTORY_COOKIE = "ap_starters_seen";

export function decodeStarterHistory(raw: string | undefined, pool: readonly string[]): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => Number.parseInt(s, 10))
		.filter((i) => Number.isInteger(i) && i >= 0 && i < pool.length)
		.map((i) => pool[i]);
}

export function encodeStarterHistory(shown: readonly string[], pool: readonly string[]): string {
	return shown
		.map((s) => pool.indexOf(s))
		.filter((i) => i >= 0)
		.join(",");
}
