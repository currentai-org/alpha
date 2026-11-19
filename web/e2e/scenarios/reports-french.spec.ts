// e2e-product: @chat
// e2e-area: @provenance @settings
import { readFileSync } from 'node:fs';
import { test, expect } from './helpers/test';

// A French visitor reads Settings → Your reports in French. The page's intro, its empty
// state, each report's category and status and its "sent <date>" line were hard-coded English, so
// French showed "Reports you sent from under an answer…" and "Received". The expected text comes
// from the French catalog itself, so the spec follows a copy edit, and it also refuses the English.
const load = (name: string) =>
	JSON.parse(
		readFileSync(new URL(`../../messages/${name}.json`, import.meta.url), 'utf8')
	) as Record<string, string>;
const fr = load('fr');
const en = load('en');

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: baseURL as string }]);
});

test(
	'Settings > Your reports in French shows the intro, the empty state, and a sent report with its category, status and date in French, none of the English it used to show',
	{ tag: ['@preview-only', '@A5', '@CUR-3921'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/chat/settings/reports', { waitUntil: 'commit' });
		const empty = page.locator('[data-own-reports-empty]');
		await expect(empty, 'the empty state is not the French catalog text').toHaveText(
			fr.reports_emptyBrowser,
			{ timeout: 30_000 }
		);
		await expect(page.getByText(fr.reports_intro)).toBeVisible();
		const body = (await page.locator('main').innerText()).toLowerCase();
		for (const key of ['reports_intro', 'reports_emptyBrowser']) {
			expect(fr[key], `${key} has its own French text`).not.toBe(en[key]);
			expect(body, `the English of ${key} is on the page`).not.toContain(en[key].toLowerCase());
		}

		const words = `rapport de test ${Date.now()}`;
		const sent = await page.request.post('/chat/api/report', {
			data: { category: 'bug', detail: words }
		});
		expect(sent.status(), 'the report was not filed').toBe(200);
		await page.reload({ waitUntil: 'commit' });

		const mine = page.locator('[data-own-report]').filter({ hasText: words });
		await expect(mine, 'the report just sent is not listed').toHaveCount(1, { timeout: 30_000 });
		await expect(mine.locator('[data-own-report-status]')).toHaveText(fr.reports_statusReceived);
		await expect(mine).toContainText(fr.report_bugLabel);
		await expect(mine).toContainText(fr.reports_aboutChat);
		await expect(mine).not.toContainText('About the chat');
		await expect(mine).not.toContainText('Received');
		await expect(mine).not.toContainText(' sent ');
	}
);
