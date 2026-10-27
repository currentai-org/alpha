import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

const appState = vi.hoisted(() => ({
	page: { url: new URL('https://alpha.test/chat/settings/storage'), data: {} }
}));
vi.mock('$app/state', () => appState);

import StorageSettingsPanel from './StorageSettingsPanel.svelte';
import type { LocationsState } from './locationTypes';

// Settings → Storage holds the storage settings in headed sections and no file list; the
// files are on the rail's Files page, which it links to. (CUR-4363)
const locations: LocationsState = {
	locations: [
		{ id: 'alpha', kind: 'alpha', label: 'Alpha storage', detail: '', status: 'ok', lastError: null, grant: 'alpha' },
		{
			id: 'loc-1',
			kind: 'hf-bucket',
			label: 'someone/alpha-files',
			detail: 'someone/alpha-files',
			status: 'ok',
			lastError: null,
			grant: 'token'
		}
	],
	defaultLocation: 'last',
	lastUsed: 'alpha',
	uploadsGoTo: 'alpha',
	connectAvailable: true
};
const files = [
	{ path: 'users/u1/a.txt', size: 1000 },
	{ path: 'users/u1/b.txt', size: 2000 }
];

describe('Settings → Storage (CUR-4363)', () => {
	beforeEach(() => {
		appState.page.url = new URL('https://alpha.test/chat/settings/storage');
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ files: [{ path: 'x' }, { path: 'y' }, { path: 'z' }] }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it('shows usage, Locations, Link your own Hugging Face bucket and Where your files are kept as headed sections in that order, with no file list', async () => {
		const { container } = await render(StorageSettingsPanel, { initialFiles: files, initialLocations: locations });
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Usage', 'Locations', 'Link your own Hugging Face bucket', 'Where your files are kept']);
		await expect.element(page.getByRole('meter')).toBeVisible();
		await expect.element(page.getByText('2 files').first()).toBeVisible();
		expect(container.querySelector('[data-file-row]'), 'a file list is on the settings page').toBeNull();
		expect(container.querySelector('input[type=file]'), 'an uploader is on the settings page').toBeNull();
	});

	it('links to the files page as Open your files', async () => {
		await render(StorageSettingsPanel, { initialFiles: files, initialLocations: locations });
		await expect.element(page.getByRole('link', { name: 'Open your files' })).toHaveAttribute('href', '/chat/storage');
	});

	it('shows the bucket link form without a disclosure to open first', async () => {
		const { container } = await render(StorageSettingsPanel, { initialFiles: files, initialLocations: locations });
		await expect.element(page.getByTestId('link-bucket-form')).toBeVisible();
		await expect.element(page.getByTestId('storage-connect')).toBeVisible();
		expect(container.querySelector('[data-testid="storage-advanced"]')).toBeNull();
	});

	it("gives each location its file count, reading a linked bucket's from its own listing", async () => {
		await render(StorageSettingsPanel, { initialFiles: files, initialLocations: locations });
		const rows = page.getByTestId('storage-location');
		await expect.element(rows.nth(0).getByTestId('location-file-count')).toHaveTextContent('2 files');
		await expect.element(rows.nth(1).getByTestId('location-file-count')).toHaveTextContent('3 files');
		expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('location=loc-1'))).toBe(true);
	});

	it('offers Make a new bucket (recommended) before Link a bucket you already have, with the approval detail folded until asked for (CUR-4659)', async () => {
		const { container } = await render(StorageSettingsPanel, { initialFiles: files, initialLocations: locations });
		const choices = [...container.querySelectorAll('[data-testid=storage-link-section] h3')].map((h) => h.textContent?.trim());
		expect(choices).toEqual(['Make a new bucket', 'Link a bucket you already have']);
		await expect.element(page.getByTestId('storage-connect-choice').getByText('Recommended')).toBeVisible();
		await expect.element(page.getByTestId('storage-connect-how')).not.toBeVisible();
		await page.getByRole('button', { name: 'How connecting works' }).click();
		await expect.element(page.getByTestId('storage-connect-how')).toHaveTextContent(/revoke access any time/);
	});

	it('with Connect unavailable, offers only Link a bucket you already have', async () => {
		const { container } = await render(StorageSettingsPanel, {
			initialFiles: files,
			initialLocations: { ...locations, connectAvailable: false }
		});
		const choices = [...container.querySelectorAll('[data-testid=storage-link-section] h3')].map((h) => h.textContent?.trim());
		expect(choices).toEqual(['Link a bucket you already have']);
		await expect.element(page.getByTestId('link-bucket-form')).toBeVisible();
	});

	it('keeps the bucket name a refused connect came back with in the field (CUR-4234)', async () => {
		appState.page.url = new URL('https://alpha.test/chat/settings/storage?connect_error=taken&bucket=my-bucket');
		await render(StorageSettingsPanel, { initialFiles: files, initialLocations: locations });
		await expect.element(page.getByTestId('storage-connect').getByRole('textbox')).toHaveValue('my-bucket');
	});

	it('with the storage-locations flag off, shows usage and where files are kept but no locations or linking', async () => {
		const { container } = await render(StorageSettingsPanel, { initialFiles: files, initialLocations: null });
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Usage', 'Where your files are kept']);
	});
});
