import type { Page } from '@playwright/test';
import { pageDataNode } from './pageData';

// The home page's updates tile renders only when the CMS holds an update inside its window
// (`updatesHref` in home-hero.svelte). A preview's CMS can go weeks without a new post, and then the
// tile is correctly absent. These read what the page rendered from, so a spec can tell that state
// from a tile that is missing while updates exist.

/**
 * The updates count and window, in weeks, the home page rendered from. Read from SvelteKit's
 * serialized load data for `/`: the page's data node is the one whose root carries
 * `recentUpdatesCount`.
 */
export async function recentUpdatesWindow(page: Page): Promise<{ count: number; weeks: number }> {
	const res = await page.request.get('/__data.json');
	if (!res.ok()) throw new Error(`/__data.json answered ${res.status()}`);
	const flat = pageDataNode(await res.json(), 'recentUpdatesCount');
	if (!flat) throw new Error('/__data.json carries no recentUpdatesCount');
	return {
		count: flat[flat[0].recentUpdatesCount] as unknown as number,
		weeks: flat[flat[0].weeks] as unknown as number
	};
}

const UNIT_MS: Record<string, number> = {
	second: 1_000,
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
	week: 7 * 86_400_000,
	month: 30 * 86_400_000,
	year: 365 * 86_400_000
};

/**
 * When an update card says it was posted, in epoch ms, from its text: "3 days ago", "today",
 * "yesterday", "11 Oct 2026" or "Oct 11, 2026". Undefined when the card carries none of these.
 */
export function postedAt(card: string, now = Date.now()): number | undefined {
	const relative = card.match(/\b(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i);
	if (relative) return now - Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()];
	if (/\b(today|just now)\b/i.test(card)) return now;
	if (/\byesterday\b/i.test(card)) return now - UNIT_MS.day;
	const absolute = card.match(
		/\b\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}\b|\b[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}\b/
	);
	if (!absolute) return undefined;
	const at = Date.parse(absolute[0]);
	return Number.isNaN(at) ? undefined : at;
}
