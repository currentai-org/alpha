import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
	page: { url: new URL('https://alpha.test/chat/settings/storage') }
}));
vi.mock('$app/state', () => appState);

import StorageLocations from './StorageLocations.svelte';
import type { LocationsState } from './locationTypes';

const locations: LocationsState = {
	locations: [
		{ id: 'alpha', kind: 'alpha', label: 'Alpha storage', detail: '', status: 'ok', lastError: null, grant: 'alpha' },
		{
			id: 'loc-1',
			kind: 'hf-bucket',
			label: 'someone on Hugging Face',
			detail: 'someone/alpha-files',
			status: 'ok',
			lastError: null,
			grant: 'oauth'
		}
	],
	defaultLocation: 'last',
	lastUsed: 'alpha',
	uploadsGoTo: 'ask',
	connectAvailable: true
};

async function outcomeAt(query: string): Promise<string> {
	appState.page.url = new URL(`https://alpha.test/chat/settings/storage?${query}`);
	const { baseElement } = await render(StorageLocations, { locations, onChanged: () => {} });
	const find = () => baseElement.querySelector('[data-testid="storage-connect-outcome"]');
	await expect.poll(find).not.toBeNull();
	return find()?.textContent ?? '';
}

describe('StorageLocations connect outcome (CUR-3326)', () => {
	it('names the bucket as already linked after a Connect that only refreshed it, rather than reporting a new connection', async () => {
		const text = await outcomeAt('connected=refreshed&bucket=someone%2Falpha-files');
		expect(text).toContain('someone/alpha-files was already linked');
		expect(text).toContain('connect again with a different bucket name');
		expect(text).not.toContain('Hugging Face is connected');
	});

	it('still reports a new link as connected', async () => {
		expect(await outcomeAt('connected=1')).toContain('Hugging Face is connected');
	});
});

describe('StorageLocations offer after a connect (CUR-2941)', () => {
	it('offers to save new files in the bucket just connected, on by default, with moving existing files left off', async () => {
		appState.page.url = new URL('https://alpha.test/chat/settings/storage?connected=1&location=loc-1');
		const { baseElement } = await render(StorageLocations, { locations, onChanged: () => {} });
		const offer = () => baseElement.querySelector('[data-testid="storage-move-offer"]');
		await expect.poll(offer).not.toBeNull();
		expect(offer()?.textContent).toContain('Use someone on Hugging Face for your files?');
		const save = offer()?.querySelector('[role="checkbox"]');
		expect(save?.getAttribute('aria-checked')).toBe('true');
	});

	it('offers nothing after a refresh of a bucket that was already linked', async () => {
		appState.page.url = new URL(
			'https://alpha.test/chat/settings/storage?connected=refreshed&bucket=someone%2Falpha-files'
		);
		const { baseElement } = await render(StorageLocations, { locations, onChanged: () => {} });
		await expect.poll(() => baseElement.querySelector('[data-testid="storage-connect-outcome"]')).not.toBeNull();
		expect(baseElement.querySelector('[data-testid="storage-move-offer"]')).toBeNull();
	});
});
