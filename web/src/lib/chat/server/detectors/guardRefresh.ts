const HOUR_MS = 60 * 60 * 1000;

/**
 * When a `@real-screen` run refreshes a stored guard verdict live (SOL-267). A verdict comes due 1 to 3
 * days after it was recorded and then refreshes only in its own hour of the quietest window of
 * production traffic, 02:00-06:00 UTC.
 * Both come from a hash of the key, so verdicts recorded in one run come due on different days and
 * hours rather than as one burst of ~300. One more than 7 days old refreshes at any hour, so a week
 * with no off-peak develop run cannot freeze it.
 */
export function guardRefreshDue(recordedAt: string, key: string, now = Date.now()): boolean {
	const age = now - Date.parse(recordedAt);
	if (!(age <= 7 * 24 * HOUR_MS)) return true;
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
	const dueAfter = (24 + (h % 48)) * HOUR_MS;
	const quietHour = 2 + ((h >>> 8) % 4);
	return age > dueAfter && new Date(now).getUTCHours() === quietHour;
}
