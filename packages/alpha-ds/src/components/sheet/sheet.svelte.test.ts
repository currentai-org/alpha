import { cleanup, render } from 'vitest-browser-svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Harness from './sheet.harness.svelte';

// useSheetOpen() is what lets a floating control outside a sheet (the guided tour's Resume chip)
// step aside while a sheet covers the screen. It has to stay true until the LAST open sheet closes,
// and opening a sheet must not loop its own effect (a tracked-count bug once threw
// effect_update_depth_exceeded on every sheet).

const readout = () => document.querySelector('[data-sheet-open]')?.getAttribute('data-sheet-open');
// element.click(): an open sheet sets pointer-events: none on the body, which a real tap would obey.
const toggle = (which: string) =>
	document.querySelector<HTMLButtonElement>(`[data-toggle="${which}"]`)!.click();

describe('useSheetOpen', () => {
	afterEach(() => cleanup());

	it('is true while any sheet is open and false only once every sheet has closed', async () => {
		await render(Harness);
		await expect.poll(readout).toBe('no');

		toggle('a');
		await expect.poll(readout).toBe('yes');
		toggle('b');
		await expect.poll(readout).toBe('yes');
		toggle('a');
		await expect
			.poll(readout, { message: 'closing one of two open sheets reported none open' })
			.toBe('yes');
		toggle('b');
		await expect.poll(readout).toBe('no');
	});

	it('goes back to false when an open sheet unmounts without closing', async () => {
		await render(Harness);
		toggle('a');
		await expect.poll(readout).toBe('yes');
		toggle('mount-a');
		await expect
			.poll(readout, { message: 'an unmounted open sheet still counts as open' })
			.toBe('no');
	});
});
