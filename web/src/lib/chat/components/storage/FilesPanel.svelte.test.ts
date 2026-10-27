import FilesPanel from './FilesPanel.svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { LocationsState, LocationSummary } from './locationTypes';

// A photo attached in chat minutes earlier must not sit below every older file in Your files;
// the list is sorted newest first, not left in the bucket listing's order. (CUR-4355)
describe('Your files (CUR-4355)', () => {
	it('lists the newest file first, whatever order the listing returned them in', async () => {
		const { container } = await render(FilesPanel, {
			initialFiles: [
				{ path: 'users/u1/blank-1000-pages.pdf', size: 1000, addedAt: '2026-10-02T10:00:00.000Z' },
				{ path: 'users/u1/conversations/c1/red-maple.jpg', size: 855_636, addedAt: '2026-10-21T21:10:00.000Z' },
				{ path: 'users/u1/ukds.pdf', size: 2000, addedAt: '2026-10-09T10:00:00.000Z' }
			]
		});
		const names = [...container.querySelectorAll('[data-file-row]')].map((row) => row.textContent ?? '');
		expect(names, 'the file list did not render three rows').toHaveLength(3);
		expect(names[0], 'the newest file is not first').toContain('red-maple.jpg');
		expect(names[1]).toContain('ukds.pdf');
		expect(names[2]).toContain('blank-1000-pages.pdf');
	});
});

// The places files live are a tab list, not a row of pressed buttons, and the keys work. (CUR-4363)
describe('Storage location tabs (CUR-4363)', () => {
	const alpha = { id: 'alpha', kind: 'alpha', label: 'Alpha storage', detail: '', status: 'ok', lastError: null, grant: 'alpha' } as const;
	const bucket = {
		id: 'loc-1',
		kind: 'hf-bucket',
		label: 'someone/alpha-files',
		detail: 'someone/alpha-files',
		status: 'ok',
		lastError: null,
		grant: 'token'
	} as const;
	const state = (locations: LocationSummary[]): LocationsState => ({
		locations,
		defaultLocation: 'last',
		lastUsed: 'alpha',
		uploadsGoTo: 'alpha',
		connectAvailable: false
	});
	const files = [
		{ path: 'users/u1/a.txt', size: 10, addedAt: '2026-10-02T10:00:00.000Z' },
		{ path: 'users/u1/b.txt', size: 10, addedAt: '2026-10-03T10:00:00.000Z' }
	];

	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it('shows the locations as a labelled tablist whose selected tab is the open place and carries its file count', async () => {
		await render(FilesPanel, { initialFiles: files, initialLocations: state([alpha, bucket]) });
		const tablist = page.getByRole('tablist', { name: 'Storage location' });
		await expect.element(tablist).toBeVisible();
		const tabs = tablist.getByRole('tab');
		expect(tabs.elements(), 'one tab per place').toHaveLength(2);
		const open = page.getByRole('tab', { name: /Alpha storage/ });
		await expect.element(open).toHaveAttribute('aria-selected', 'true');
		await expect.element(open).toHaveAccessibleName('Alpha storage 2 files');
		await expect.element(open.getByTestId('location-count')).toHaveTextContent('2');
		await expect.element(page.getByRole('tab', { name: /someone\/alpha-files/ })).toHaveAttribute('aria-selected', 'false');
		await expect.element(page.getByRole('tabpanel')).toBeVisible();
		expect(open.element().getAttribute('aria-controls'), 'the tab does not name its panel').toBe(
			page.getByRole('tabpanel').element().id
		);
	});

	it('moves the selection with ArrowRight, End and Home, and keeps one tab in the tab order', async () => {
		await render(FilesPanel, { initialFiles: files, initialLocations: state([alpha, bucket]) });
		const first = page.getByRole('tab', { name: /Alpha storage/ });
		const second = page.getByRole('tab', { name: /someone\/alpha-files/ });
		(first.element() as HTMLElement).focus();
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(second).toHaveAttribute('aria-selected', 'true');
		await expect.element(second).toHaveFocus();
		await expect.element(first).toHaveAttribute('aria-selected', 'false');
		expect(first.element().getAttribute('tabindex'), 'the unselected tab is still a tab stop').toBe('-1');
		await userEvent.keyboard('{Home}');
		await expect.element(first).toHaveAttribute('aria-selected', 'true');
		await userEvent.keyboard('{End}');
		await expect.element(second).toHaveAttribute('aria-selected', 'true');
		// Opening the bucket's tab reads the bucket's own list, which is where a dropped file then goes.
		expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('location=loc-1'))).toBe(true);
	});

	it('still shows the tab list with Alpha storage the only place, so the page reads the same before and after a bucket is linked', async () => {
		await render(FilesPanel, { initialFiles: files, initialLocations: state([alpha]) });
		await expect.element(page.getByRole('tablist', { name: 'Storage location' })).toBeVisible();
		await expect.element(page.getByRole('tab', { name: /Alpha storage/ })).toHaveAttribute('aria-selected', 'true');
	});

	it('keeps storage settings off the files page and links to them as Manage storage', async () => {
		const { container } = await render(FilesPanel, { initialFiles: files, initialLocations: state([alpha, bucket]) });
		expect(container.querySelector('[data-testid="storage-locations"]'), 'the locations settings are still on the files page').toBeNull();
		expect(container.querySelector('[data-testid="storage-link-section"]'), 'linking a bucket is still on the files page').toBeNull();
		const manage = page.getByRole('link', { name: 'Manage storage' });
		await expect.element(manage).toHaveAttribute('href', '/chat/settings/storage');
	});
});
