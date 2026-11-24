// e2e-product: @chat
// e2e-area: @provenance @settings
import { readFileSync } from 'node:fs';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';

// A French, Spanish or German visitor who sends "Report a problem" reads the thank-you and its link to
// their reports in their own language. The three strings first shipped in English only, so
// the runtime fell back to English. A browser walk cannot send a report, since a real one reaches staff, so
// this spec answers the send itself: the thank-you is what the dialog renders for any 2xx, and nothing
// lands in the shared preview's reports table. The expected text comes from each catalog, so a copy
// edit moves the spec with it, and each locale also refuses the English.
const load = (name: string) =>
	JSON.parse(
		readFileSync(new URL(`../../messages/${name}.json`, import.meta.url), 'utf8')
	) as Record<string, string>;
const en = load('en');

for (const locale of ['fr', 'es', 'de'] as const) {
	const cat = load(locale);

	test(
		`a ${locale} visitor who sends Report a problem reads the thank-you and the link to their reports in ${locale}, not English`,
		{ tag: ['@A5'] },
		async ({ page, context, baseURL }) => {
			test.setTimeout(90_000);
			await context.addCookies([
				{ name: 'PARAGLIDE_LOCALE', value: locale, url: baseURL as string }
			]);

			// The welcome dialog's names are translated too, so it is closed by its data attributes. Its
			// Start button is disabled until hydration, so the handler waits for it to enable and presses
			// it from `waitForFunction`, which no locator handler intercepts (see helpers/welcome.ts).
			const welcome = page.locator('[data-welcome]');
			await page.addLocatorHandler(welcome, async () => {
				await page
					.waitForFunction(
						() => {
							if (!document.querySelector('[data-welcome]')) return true;
							const start = document.querySelector<HTMLButtonElement>('[data-welcome-start]');
							if (!start || start.disabled) return false;
							start.click();
							return true;
						},
						undefined,
						{ timeout: 20_000 }
					)
					.catch(() => {});
			});

			let posted = 0;
			await page.route(
				(url) => url.pathname.endsWith('/api/report'),
				(route) => {
					if (route.request().method() !== 'POST') return route.fallback();
					posted += 1;
					return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
				}
			);

			await page.goto(chatEntry(), { waitUntil: 'commit' });

			const accountMenu = page.locator('[data-account-trigger]').filter({ visible: true }).first();
			const trigger = page.getByRole('menuitem', { name: cat.product_reportProblem });
			const form = page.getByRole('dialog', { name: cat.product_reportProblem });
			await expect(async () => {
				if (!(await form.isVisible())) {
					if (!(await trigger.isVisible())) await accountMenu.click({ timeout: 5_000 });
					await trigger.click({ timeout: 5_000 });
				}
				await expect(form).toBeVisible({ timeout: 3_000 });
			}, `the ${locale} report form never opened from the account menu`).toPass({
				timeout: 45_000
			});

			await form.locator('[data-report-category="bug"]').click();
			await form.getByRole('textbox').fill(`walk ${locale}`);
			await form.getByRole('button', { name: cat.report_send }).click();

			const status = form.getByRole('status');
			await expect(status.getByText(cat.report_sent), `the ${locale} thank-you line`).toBeVisible({
				timeout: 10_000
			});
			expect(posted, 'the form showed a thank-you without sending').toBe(1);
			await expect(status).toContainText(cat.report_sentHelpReports);
			const link = status.locator('[data-own-reports-link]');
			await expect(link).toHaveText(cat.product_yourReports);

			const text = await status.innerText();
			for (const key of ['report_sent', 'report_sentHelpReports', 'product_yourReports']) {
				expect(cat[key], `${key} has its own ${locale} text`).not.toBe(en[key]);
				expect(text, `the English of ${key} is in the ${locale} thank-you`).not.toContain(en[key]);
			}

			await link.click();
			await page.waitForURL(/\/settings\/reports/, { timeout: 30_000 });
			await expect(page.getByRole('heading', { level: 1 })).toHaveText(cat.product_yourReports);
		}
	);
}
