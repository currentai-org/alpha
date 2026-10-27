import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Page from './+page.svelte';

describe('/alpha landing head', () => {
	it('emits a canonical URL for /alpha and the product headline', () => {
		const { head, body } = render(Page, { props: {} });
		expect(head).toContain('rel="canonical"');
		expect(head).toContain('/alpha');
		expect(body).toContain('Make AI yours.');
		expect(body).toContain('Your language. Your data. Your rules.');
		expect(body).toContain('href="/chat"');
	});
});
