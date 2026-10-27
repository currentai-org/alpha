import NameNotice from './NameNotice.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';

// The chip must not read "Alpha doesn't have a name", which says the app has no name (CUR-3315).
describe('the name notice', () => {
	it('says Alpha won’t pretend to be a person, never that Alpha has no name', async () => {
		const { container } = await render(NameNotice, { name: 'Martin' });
		const text = container.textContent ?? '';
		expect(text).toContain('Alpha won’t pretend to be a person');
		expect(text).not.toMatch(/Alpha doesn’t have a name/);
	});
});
