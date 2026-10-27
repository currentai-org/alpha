// e2e-product: @site
import { test, expect } from './helpers/test';

// The privacy notice is CMS content. Where an editor typed an address rather than linking it with the
// button, Lexical stores an `autolink`, and the renderer only knew `link`, so "To exercise any of
// these rights, contact us at ." lost its address (CUR-1843). Other paragraphs on the page carry the
// same address as ordinary links, so "the page has a mailto link" stays green through the bug; the
// assertion is scoped to the sentence that uses an autolink.
test('the privacy notice says where to exercise your rights, with the address as a mailto link', async ({
	page
}) => {
	const res = await page.goto('/privacy-notice', { waitUntil: 'domcontentloaded' });
	expect(res?.status(), 'the privacy notice did not load').toBe(200);
	const rights = page.locator('main p', { hasText: 'exercise any of these rights' });
	await expect(rights, 'the rights paragraph is missing from the privacy notice').toBeVisible({
		timeout: 15_000
	});
	const mailto = rights.locator('a[href^="mailto:"]');
	await expect(
		mailto,
		'the rights paragraph has no mailto link, so it reads "contact us at ." with the address missing'
	).toBeVisible();
	await expect(mailto).toHaveText(/\S+@\S+\.\S+/);
});
