import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/state', () => ({
	page: { url: new URL('https://alpha.test/chat/storage'), data: { attachmentsEnabled: true } }
}));

import Harness from './FilesPanel.locationTabs.harness.svelte';
import type { LocationsState, LocationSummary } from './locationTypes';

// CUR-4441. Four Hugging Face buckets linked through Connect, labelled the way the connect callback
// labels them ("<account>/<bucket> on Hugging Face"), shaped like the rows on develop. Every label
// starts with the same account, so a tab that clips its label clips the only part that differs.
const hf = (id: string, label: string, bucket: string): LocationSummary => ({
	id,
	kind: 'hf-bucket',
	label,
	detail: `huggingface.co/buckets/example-account/${bucket}`,
	status: 'ok',
	lastError: null,
	grant: 'oauth'
});

const locations: LocationsState = {
	locations: [
		{ id: 'alpha', kind: 'alpha', label: 'Alpha storage', detail: '', status: 'ok', lastError: null, grant: 'alpha' },
		hf('l1', 'example-account on Hugging Face', 'alpha-files'),
		hf('l2', 'example-account/alpha-walk on Hugging Face', 'alpha-walk'),
		hf('l3', 'example-account/Walk.Notes_v2 on Hugging Face', 'Walk.Notes_v2'),
		hf('l4', 'example-account/ALPHA-FILES on Hugging Face', 'ALPHA-FILES')
	],
	defaultLocation: 'last',
	lastUsed: 'alpha',
	uploadsGoTo: 'alpha',
	connectAvailable: true
};

// What each tab must show for a person to tell it from the others, and the full name behind it.
const EXPECTED: [id: string, shows: string, full: string | null][] = [
	['alpha', 'Alpha storage', null],
	['l1', 'alpha-files', 'example-account on Hugging Face'],
	['l2', 'alpha-walk', 'example-account/alpha-walk on Hugging Face'],
	['l3', 'Walk.Notes_v2', 'example-account/Walk.Notes_v2 on Hugging Face'],
	['l4', 'ALPHA-FILES', 'example-account/ALPHA-FILES on Hugging Face']
];

afterEach(() => cleanup());

function tab(id: string): HTMLElement {
	const el = document.querySelector<HTMLElement>(`[role="tab"][data-location-id="${id}"]`);
	if (!el) throw new Error(`no tab for ${id}`);
	return el;
}

/** True when some visible element inside the tab is cut off: its content is wider than its box.
 *  A screen-reader-only count is a 1px box by design, so it is not a visible element. */
function clipped(el: HTMLElement): boolean {
	return [el, ...el.querySelectorAll<HTMLElement>('*:not(.sr-only)')].some((e) => e.scrollWidth > e.clientWidth + 1);
}

/** The open tooltip a tab names as its description, the way a screen reader reaches it too. */
function tooltipOf(t: HTMLElement): HTMLElement | null {
	const id = t.getAttribute('aria-describedby');
	const el = id ? document.getElementById(id) : null;
	return el?.checkVisibility() ? el : null;
}

describe('Files page location tabs (CUR-4441)', () => {
	it('show each linked bucket by its own name, uncut, rather than a shared account prefix ending in an ellipsis', async () => {
		render(Harness, { initialFiles: [], initialLocations: locations });
		await expect.element(page.getByRole('tablist')).toBeVisible();
		for (const [id, shows] of EXPECTED) {
			const t = tab(id);
			expect(t.innerText, id).toContain(shows);
			expect(clipped(t), `${id} is clipped`).toBe(false);
		}
		// The bucket name is the name: a shared "example-account/" is not repeated on every tab.
		const names = EXPECTED.map(([id]) => tab(id).innerText);
		expect(names.filter((n) => n.includes('example-account'))).toEqual([]);
	});

	it('names the full place on hover and on keyboard focus, so nothing the tab leaves out is out of reach', async () => {
		render(Harness, { initialFiles: [], initialLocations: locations });
		await expect.element(page.getByRole('tablist')).toBeVisible();

		await userEvent.hover(tab('l2'));
		await expect.poll(() => tooltipOf(tab('l2'))?.innerText).toContain('example-account/alpha-walk on Hugging Face');
		expect(tooltipOf(tab('l2'))?.innerText).toContain('huggingface.co/buckets/example-account/alpha-walk');
		await userEvent.unhover(tab('l2'));

		tab('l3').focus();
		await expect.poll(() => tooltipOf(tab('l3'))?.innerText).toContain('example-account/Walk.Notes_v2 on Hugging Face');
	});
});
