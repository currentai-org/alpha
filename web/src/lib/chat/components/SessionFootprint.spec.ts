import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Harness from './SessionFootprint.harness.svelte';

describe('SessionFootprint before the browser store loads', () => {
	// The server has no sessionStorage, so its store holds zero tokens. Showing that figure would make a
	// reload flash "0Wh" over a session that had used energy, until hydration put the real figure back
	// (CUR-1890).
	it('hides the energy and time figures in server-rendered HTML rather than showing a zero', () => {
		const { body } = render(Harness);
		const trigger = body.slice(body.indexOf('data-footprint-trigger'));
		const figures = [...trigger.matchAll(/<span class="([^"]*tabular-nums[^"]*)"/g)].map((m) => m[1]);
		expect(figures).toHaveLength(2);
		for (const cls of figures) expect(cls.split(/\s+/)).toContain('invisible');
	});
});
