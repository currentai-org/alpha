// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// A product page lists its openness attributes (license, source, core features withheld, ...)
// parsed from the `components` string os-ai-map publishes. That string joins attributes with ';'
// and does not escape a ';' inside an attribute's parenthetical detail, so a naive split showed
// PyCaret's license as "MIT(OSI" with the rest of the detail gone.
//
// PyCaret's and Albumentations' license details each carry a ';' inside parentheses in the
// published data, so both pages showed an unclosed "(" before the fix. If either is rescored
// without one, pick another product from
// `select p.slug, o.components from "os-ai-map".openness o join "os-ai-map".products p
//  on p.id = o.product_id where o.components ~ '\([^)]*;'`.

async function attributes(page: Page, slug: string) {
	const res = await page.goto(`/product/${slug}`, { waitUntil: 'domcontentloaded' });
	expect(res?.status(), `/product/${slug} answered ${res?.status()}`).toBe(200);
	const openness = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Openness' }) });
	await expect(openness.locator('dt').first()).toBeVisible({ timeout: 30_000 });
	return openness.locator('dl').evaluate((dl) => {
		const keys = [...dl.querySelectorAll('dt')].map((el) => el.textContent?.trim() ?? '');
		const values = [...dl.querySelectorAll('dd')].map((el) => el.textContent?.trim() ?? '');
		return keys.map((key, i) => ({ key, value: values[i] ?? '' }));
	});
}

const count = (text: string, ch: string) => text.split(ch).length - 1;

test.describe('product openness attributes', { tag: '@G1' }, () => {
	for (const slug of ['pycaret', 'albumentations']) {
		test(
			`${slug}: every attribute shows its whole detail, with each parenthesis closed and spaced from the word before it`,
			{ tag: '@live' },
			async ({ page }) => {
				const rows = await attributes(page, slug);
				expect(rows.length, 'the page listed no openness attributes').toBeGreaterThan(0);
				for (const { key, value } of rows) {
					expect(count(value, '('), `${key} shows unbalanced parentheses: "${value}"`).toBe(
						count(value, ')')
					);
					// The value's own detail opener, not a '(' inside the detail like `IsEE()`.
					expect(value, `${key} runs a word into its detail: "${value}"`).not.toMatch(
						/^[^\s(]*[A-Za-z0-9]\(/
					);
				}
			}
		);
	}

	test(
		'pycaret: the license detail keeps the text after its inner ";"',
		{ tag: '@live' },
		async ({ page }) => {
			const rows = await attributes(page, 'pycaret');
			const license = rows.find((r) => r.key.toLowerCase() === 'license');
			expect(license?.value, 'pycaret lists no license attribute').toBeTruthy();
			expect(license!.value).toMatch(/^MIT \(OSI; .+\)$/);
		}
	);
});
