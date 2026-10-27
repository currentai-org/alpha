import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Harness from './tabs.harness.svelte';

// The Files page lists every linked storage place as a segment. With more places than fit one row,
// a sideways-scrolling strip hides some of them behind a scrollbar and cuts a label mid-word.

afterEach(() => cleanup());

const PLACES = [
	'Alpha storage 0',
	'my-research-bucket 12',
	'team-datasets 48',
	'Google Drive 7',
	'thesis-drafts 3',
	'photos-2026 120',
	'client-archive 9'
];

describe('segment tabs', () => {
	it('wrap onto more rows instead of scrolling sideways, so every place is in view', async () => {
		render(Harness, { labels: PLACES });
		const tablist = page.getByRole('tablist', { name: 'Storage location' });
		await expect.element(tablist).toBeVisible();
		const list = tablist.element() as HTMLElement;
		const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
		expect(tabs).toHaveLength(PLACES.length);

		expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
		const box = list.getBoundingClientRect();
		for (const tab of tabs) {
			const r = tab.getBoundingClientRect();
			expect(r.left).toBeGreaterThanOrEqual(box.left);
			expect(r.right).toBeLessThanOrEqual(box.right + 0.5);
		}
		// More than one row: the strip grew downward rather than sideways.
		expect(
			new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size
		).toBeGreaterThan(1);
	});
});
