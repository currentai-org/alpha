// e2e-product: @chat
// e2e-area: @settings
import { test, expect } from './helpers/test';
import { journeyStep } from './helpers/journeyStep';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';

// W2 ("I know how to contribute and I get a response"), docs/journeys/w2-contribute.md.
//
// The sidebar's "Get involved" card says "Bring a dataset, your voice or an idea to fill one". This
// walks each of the three from `/chat` to the place that takes the submission. The data actions open
// partner sites in a new tab, so the spec fetches each link's page and checks it is the right public
// page rather than driving the partner's site. Dataset sharing on the Mozilla Data Collective needs an
// account and a reviewed uploader request, so "Share {language} data" goes to MDC's "Contribute your
// language" page, which lays out the ways in and pre-fills its dataset search from `utm_term`; its
// first target was MDC's sign-in page (CUR-3232), then its upload guide. Since the redesign the data
// actions sit under a language picker rather than in their own cards (SOL-191).

test(
	'from the chat sidebar, a visitor reaches a place that takes a dataset, a recording or an idea',
	{ tag: '@W2' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		const card = page.getByRole('complementary', { name: 'Get involved' });
		await journeyStep(page, 'W2', 1, async () => {
			await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
			await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
			await expect(card, 'the sidebar carries no Get involved card').toBeVisible({
				timeout: 15_000
			});
			await expect(card).toContainText(/\bdata\b/i);
		});

		await journeyStep(page, 'W2', 2, async () => {
			await card.getByRole('link', { name: /ways to contribute/i }).click();
			await page.waitForURL(/\/chat\/settings\/contribute/, { timeout: 15_000 });
			await expect(
				page.getByRole('heading', { name: 'Ways to help' }),
				'the contribute page lists no ways to help'
			).toBeVisible({ timeout: 15_000 });
			await expect(page, 'the tab kept the title of the page the visitor came from').toHaveTitle(
				'Contribute — Settings — Alpha'
			);
			// Every instance defaults to a Mistral model, so Mistral's open weights are among the projects to help.
			await expect(page.getByRole('link', { name: 'Mistral open models' })).toHaveAttribute(
				'href',
				'https://huggingface.co/mistralai'
			);
		});

		const data = page.locator('[data-contribute-data]');
		const answers200 = async (href: string, what: string) => {
			const res = await page.request.get(href, { maxRedirects: 0 });
			expect(res.status(), `${what} (${href}) does not answer 200 without sign-in`).toBe(200);
			return res;
		};

		await journeyStep(page, 'W2', 3, async () => {
			// Before a language is picked, the one data action is Common Voice's own language list.
			const languages = data.locator('[data-language-data-action="cv_languages"]');
			await expect(
				languages,
				'with no language picked, the page offers no data action'
			).toBeVisible();
			await expect(languages).toHaveAttribute(
				'href',
				/^https:\/\/commonvoice\.mozilla\.org\/[a-z-]+\/languages\?/
			);
			await answers200((await languages.getAttribute('href'))!, "Common Voice's language list");

			// So is MDC's contribute page, for someone who already has a dataset in any language (SOL-192).
			const shareAny = data.locator('[data-language-data-action="mdc_share"]');
			await expect(
				shareAny,
				'with no language picked, the page offers no way to share a dataset'
			).toBeVisible();
			await expect(shareAny).toContainText('Share a dataset you already have');
			await expect(shareAny).toHaveAttribute('target', '_blank');
			const anyHref = (await shareAny.getAttribute('href'))!;
			expect(
				new URL(anyHref).searchParams.has('utm_term'),
				"with no language picked, the link pre-fills MDC's dataset search anyway"
			).toBe(false);
			expect(
				await (await answers200(anyHref, 'Share a dataset you already have')).text(),
				`Share a dataset you already have (${anyHref}) is not the Mozilla Data Collective's contribute page`
			).toContain('Contribute your language');

			// The trigger is server-rendered, so a click can land before hydration and open nothing.
			const catalan = page.getByRole('option', { name: 'Catalan', exact: true });
			await expect(async () => {
				await page.locator('[data-contribute-language]').click();
				await expect(catalan).toBeVisible({ timeout: 2_000 });
			}).toPass({ timeout: 20_000 });
			await catalan.click();

			const share = page.locator(
				'[data-contribute-data="cat"] [data-language-data-action="mdc_share"]'
			);
			await expect(share, 'picking Catalan offered no way to share a dataset').toBeVisible();
			await expect(share).toContainText('Share Catalan data');
			await expect(share).toHaveAttribute('target', '_blank');
			const href = (await share.getAttribute('href'))!;
			expect(
				new URL(href).searchParams.get('utm_term'),
				"Share Catalan data does not pre-fill MDC's dataset search with Catalan"
			).toBe('cat');
			const mdcPage = await answers200(href, 'Share Catalan data');
			expect(
				await mdcPage.text(),
				`Share Catalan data (${href}) is not the Mozilla Data Collective's contribute page`
			).toContain('Contribute your language');
		});

		await journeyStep(page, 'W2', 4, async () => {
			const record = page.locator(
				'[data-contribute-data="cat"] [data-language-data-action="cv_speak"]'
			);
			await expect(record, 'picking Catalan offered no way to record sentences').toBeVisible();
			await expect(
				record,
				"the recording link does not open Common Voice's Catalan recording screen"
			).toHaveAttribute('href', /^https:\/\/commonvoice\.mozilla\.org\/ca\/speak\?/);
			await answers200((await record.getAttribute('href'))!, 'Help build an open Catalan dataset');
		});

		await journeyStep(page, 'W2', 5, async () => {
			await page
				.locator('[data-contribute-way="feedback"]')
				.getByRole('button', { name: 'Tell us' })
				.click();
			const form = page.locator('[data-report-dialog], [data-report-sheet]').first();
			await expect(form, 'Tell us opened no form').toBeVisible({ timeout: 10_000 });
			await expect(form, 'Tell us opened a bug report rather than a request').toHaveAccessibleName(
				'Tell us what’s missing'
			);
			// An idea is "Something else", already picked, so its text box shows without a click.
			await expect(form.locator('[data-report-category="other"]').getByRole('radio')).toBeChecked();
			const text = form.getByRole('textbox').first();
			await text.fill('A test idea, not sent.');
			await expect(text).toHaveValue('A test idea, not sent.');
			await expect(form.getByRole('button', { name: 'Send report' })).toBeVisible();
		});
	}
);
