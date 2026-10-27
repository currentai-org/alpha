// e2e-product: @chat
// e2e-area: @settings
import { expect, test } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';

// Settings → Contribute leads with Common Voice: for most people who find Alpha weak in their
// language, recording or writing sentences is the thing they can do. The link goes straight to the
// language's recording screen when Common Voice takes it, and to Common Voice's request form when it
// doesn't (see commonVoice.ts).

const COMMON_VOICE = 'https://commonvoice.mozilla.org';

async function openContribute(page: import('@playwright/test').Page) {
	await page.goto('/chat/settings', { waitUntil: 'load' });
	await page.getByRole('link', { name: 'Contribute', exact: true }).first().click();
	await expect(page).toHaveURL(/\/chat\/settings\/contribute/);
	await expect(page.locator('[data-contribute]')).toBeVisible({ timeout: 20_000 });
}

async function pickLanguage(page: import('@playwright/test').Page, name: string) {
	// The trigger is server-rendered, so a click can land before hydration and open nothing: retry
	// until the list is up.
	const option = page.getByRole('option', { name, exact: true });
	await expect(async () => {
		await page.locator('[data-contribute-language]').click();
		await expect(option).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
	await option.click();
}

test(
	"a Catalan speaker's first data action opens Common Voice's Catalan recording screen, before the Data Collective",
	{ tag: '@contribute' },
	async ({ page }) => {
		await openContribute(page);
		await pickLanguage(page, 'Catalan');

		const actions = page.locator('[data-contribute-data="cat"] [data-language-data-action]');
		await expect(actions.first()).toHaveAttribute('data-language-data-action', 'cv_speak');
		await expect(actions.nth(1)).toHaveAttribute('data-language-data-action', 'mdc_share');

		const voice = actions.first();
		await expect(voice).toContainText('Help build an open Catalan dataset');
		const href = new URL((await voice.getAttribute('href')) ?? '');
		expect(href.origin + href.pathname).toBe(`${COMMON_VOICE}/ca/speak`);
		expect(href.searchParams.get('utm_source')).toBe('aipotluck');
		expect(href.searchParams.get('utm_content')).toBe('contribute_page');
		await expect(voice).toHaveAttribute('target', '_blank');

		// Common Voice appears once, in the language section; the page offers no dataset browsing.
		await expect(page.locator('[data-contribute-way="voice"]')).toHaveCount(0);
		await expect(page.getByText('Browse datasets')).toHaveCount(0);
	}
);

test(
	'a language Common Voice lists but cannot record yet (Tagalog) goes to its language list, not an empty recording screen',
	{ tag: '@contribute' },
	async ({ page }) => {
		await openContribute(page);
		await pickLanguage(page, 'Tagalog');

		const voice = page.locator('[data-contribute-data="tgl"] [data-language-data-action]').first();
		await expect(voice).toHaveAttribute('data-language-data-action', 'cv_in_progress');
		await expect(voice).toContainText('Help Common Voice get ready for Tagalog');
		const href = new URL((await voice.getAttribute('href')) ?? '');
		expect(href.origin + href.pathname).toBe(`${COMMON_VOICE}/en/languages`);
	}
);

test(
	"the Language panel's “Other ways to help” opens Contribute already set to the language of the draft",
	{ tag: ['@contribute', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		// The Language pill shows only while Auto is choosing (ChatComposerFrame's `languagesOn`).
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog
				.getByRole('button', { name: /start chatting|^skip$/i })
				.first()
				.click();
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Bon dia, com puc arribar a la platja des de la estació de tren?');
		// Auto's read of the draft names Catalan on the model pill before the panel can carry it.
		await expect(page.getByRole('button', { name: /^Model:/ })).toContainText('Catalan', {
			timeout: 30_000
		});

		await page.getByRole('button', { name: 'Language: how Alpha picks a model for yours' }).click();
		const panel = page.locator('[data-language-support-panel]');
		await expect(panel.locator('[data-language-support-preview]')).toContainText('Catalan');
		// A language Alpha handles well still gets the ways to help with it, one tile each.
		const contribute = panel.locator('[data-languages-contribute]');
		await expect(
			contribute.getByRole('heading', { name: 'Help Alpha get better at Catalan' })
		).toBeVisible();
		await expect(contribute.locator('[data-language-data-action="cv_speak"]')).toHaveAttribute(
			'target',
			'_blank'
		);
		// Catalan already has a strong model, so the model question asks for a better one.
		await expect(contribute.locator('[data-language-data-model-open]')).toContainText(
			'Know a better model for Catalan?'
		);
		// The panel's “Help it learn” link sits under the languages still below the dependable line, and
		// every launch language clears it on the catalog's measured scores, so the draft's own section carries the
		// way to Contribute.
		await panel.locator('[data-languages-more]').click();

		await expect(page).toHaveURL(/\/chat\/settings\/contribute\?language=cat$/);
		await expect(
			page.locator('[data-contribute-language]'),
			'Contribute did not open on the language the panel carried'
		).toHaveValue('Catalan');
		const voice = page.locator('[data-contribute-data="cat"] [data-language-data-action]').first();
		await expect(voice).toHaveAttribute('data-language-data-action', 'cv_speak');
		const href = new URL((await voice.getAttribute('href')) ?? '');
		expect(href.origin + href.pathname).toBe(`${COMMON_VOICE}/ca/speak`);
	}
);

test(
	"someone whose language isn't in the picker can say which it is, and the request is stored for counting",
	{ tag: '@contribute' },
	async ({ page }) => {
		await openContribute(page);
		await pickLanguage(page, 'My language isn’t listed');

		const data = page.locator('[data-contribute-data="other"]');
		// Common Voice's full language list stays one click away, since it may already take the language.
		await expect(data.locator('[data-language-data-action="cv_languages"]')).toBeVisible();

		const form = data.locator('[data-contribute-missing]');
		await form.getByLabel('Your language').fill('Wolof (e2e)');
		const posted = page.waitForResponse(
			(r) => r.url().endsWith('/chat/api/contribute') && r.request().method() === 'POST'
		);
		await form.getByRole('button', { name: 'Tell us' }).click();
		const res = await posted;
		expect(res.request().postDataJSON()).toMatchObject({
			kind: 'data_interest',
			language: 'und',
			languageName: 'Wolof (e2e)'
		});
		expect(res.status(), 'the contribute API refused the missing-language request').toBe(200);
		await expect(data.locator('[data-contribute-missing-sent]')).toHaveText(
			'Thanks. We’ve counted you in for Wolof (e2e).'
		);
	}
);

test(
	'someone can name a model that does their language well, and the API stores it as a model suggestion',
	{ tag: '@contribute' },
	async ({ page }) => {
		await openContribute(page);
		await pickLanguage(page, 'Catalan');

		const data = page.locator('[data-contribute-data="cat"]');
		// The model question has its own link, so nobody has to offer data help first to find it.
		await data.getByRole('button', { name: 'Know a model that does Catalan well?' }).click();
		const form = data.locator('[data-language-data-interest]');
		const model = form.getByLabel('Know a model that does Catalan well?');
		await expect(model, 'the model link did not put the cursor in the model field').toBeFocused();
		await model.fill('Salamandra 7B (e2e)');
		const posted = page.waitForResponse(
			(r) => r.url().endsWith('/chat/api/contribute') && r.request().method() === 'POST'
		);
		await form.getByRole('button', { name: 'Suggest this model' }).click();
		const res = await posted;
		expect(res.request().postDataJSON()).toMatchObject({
			kind: 'model_suggestion',
			language: 'cat',
			model: 'Salamandra 7B (e2e)'
		});
		expect(res.status(), 'the contribute API refused the model suggestion').toBe(200);
		await expect(data.locator('[data-language-data-interest-sent]')).toHaveText(
			'Thanks. We’ll look into the model you suggested for Catalan.'
		);
	}
);

test(
	'typing in the language picker finds a language by a misspelling or its own name, and “My language isn’t listed” stays offered',
	{ tag: '@contribute' },
	async ({ page }) => {
		await openContribute(page);
		const input = page.locator('[data-contribute-language]');
		const missing = page.getByRole('option', { name: 'My language isn’t listed', exact: true });

		// Hydration can lag the server-rendered input, so retry until typing opens the list.
		await expect(async () => {
			await input.click();
			await input.fill('ctln');
			await expect(page.getByRole('option', { name: 'Catalan', exact: true })).toBeVisible({
				timeout: 2_000
			});
		}).toPass({ timeout: 20_000 });
		await expect(page.getByRole('option', { name: 'Polish', exact: true })).toHaveCount(0);
		await expect(missing, 'a search hid “My language isn’t listed”').toBeVisible();

		// Its own name, as the browser knows it (Chrome names Polish but not, say, Basque, in its own tongue).
		await input.fill('polski');
		await expect(page.getByRole('option', { name: 'Polish', exact: true })).toBeVisible();

		await input.fill('zzzz');
		await expect(page.getByText('No languages match.', { exact: false })).toBeVisible();
		await expect(missing, 'no match hid “My language isn’t listed”').toBeVisible();
		await missing.click();
		await expect(page.locator('[data-contribute-data="other"]')).toBeVisible();
		await expect(input).toHaveValue('My language isn’t listed');
	}
);

test(
	'the composer’s “still learning” panel offers each way to help as one tile, and the model tile takes a suggestion without leaving the chat',
	{ tag: ['@contribute', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		// Auto's draft reading, which notices the language, runs only while Auto is choosing.
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog
				.getByRole('button', { name: /start chatting|^skip$/i })
				.first()
				.click();
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			'Allillanchu, imaynallam kachkanki? Qusqu llaqtaman risaq paqarin, ima ruraytataq atiyman chaypi?'
		);
		// The first time Alpha notices a language it is still learning, its panel opens by itself
		// (clicking the pill now would close it).
		const help = page.locator('[data-language-gap-help]');
		await expect(help.getByRole('heading', { name: 'Help Alpha learn Quechua' })).toBeVisible({
			timeout: 30_000
		});
		const tiles = help.locator('[data-language-data-layout="tiles"]');
		await expect(tiles.locator('[data-language-data-action]')).toHaveCount(2);
		await expect(tiles.locator('[data-language-data-action="mdc_share"]')).toHaveAttribute(
			'target',
			'_blank'
		);

		// Back returns to the tiles, so trying a form costs nothing.
		await tiles.locator('[data-language-data-interest-open]').click();
		await expect(tiles.getByLabel('Email (optional)')).toBeFocused();
		await tiles.locator('[data-language-data-back]').click();
		await expect(tiles.locator('[data-language-data-model-open]')).toBeVisible();

		await tiles.locator('[data-language-data-model-open]').click();
		const model = tiles.getByLabel('Know a model that does Quechua well?');
		await expect(model).toBeFocused();
		await model.fill('Quechua model (e2e)');
		const posted = page.waitForResponse(
			(r) => r.url().endsWith('/api/contribute') && r.request().method() === 'POST'
		);
		await tiles.getByRole('button', { name: 'Suggest this model' }).click();
		const res = await posted;
		expect(res.request().postDataJSON()).toMatchObject({
			kind: 'model_suggestion',
			language: 'quz',
			model: 'Quechua model (e2e)'
		});
		expect(res.status(), 'the contribute API refused the model suggestion').toBe(200);
		await expect(tiles.locator('[data-language-data-interest-sent]')).toHaveText(
			'Thanks. We’ll look into the model you suggested for Quechua.'
		);
	}
);
