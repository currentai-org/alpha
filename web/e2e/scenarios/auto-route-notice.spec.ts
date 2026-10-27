// e2e-product: @chat
// e2e-area: @models
import { test, expect, type Page } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { orgs } from '../../src/lib/chat/routing/catalog';

// Two pieces of the composer's model picker while Auto is choosing.
//
// THE NOTICE. Auto reads the draft as the person types and can change the pill ("Auto" becomes
// "Auto · Catalan", or mid-chat the model the message goes to). Each such change plays the pill's
// one-shot `route-notice` once, so a switch made while typing isn't missed. The pill carries
// `data-noticing` while it plays and drops it on animationend. The notice can come and go between two
// of Playwright's polls, so a MutationObserver installed before typing records every change of the
// attribute together with the animation the browser was running at that moment: the spec asserts the
// keyframes actually ran, not only that an attribute appeared. Under reduced motion no notice plays.
//
// THE CREDIT. With `clef-routing` on, Auto's explanation in the open picker credits Clef: an
// open-weight model from Cloudflare, published on Hugging Face, each named with its logo and a link out
// (OrgMention). Logos are served from this app, never hotlinked. Off, nothing names Clef.
//
// Both flags read per request (flagEnabledOr), so the override cookie reaches them. The credit renders
// from the flag alone and doesn't wait on Clef answering; the notice follows the on-device read, so
// neither depends on the router being reachable.

const PICKER_TRIGGER = /^Model:/;
// A Catalan question: the on-device read names Catalan from its words alone.
const CATALAN_DRAFT = 'Bon dia, com puc arribar a la platja des de la estació de tren?';

async function openChatEntry(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await welcomeDialog
			.getByRole('button', { name: /start chatting|^skip$/i })
			.first()
			.click();
	});
	await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

/** Records each change of the pill's `data-noticing`, with the pill's running animation at that moment. */
async function recordNotices(page: Page) {
	await page.locator('[data-model-pill]').waitFor({ timeout: 30_000 });
	await page.evaluate(() => {
		const pill = document.querySelector<HTMLElement>('[data-model-pill]')!;
		const log: { noticing: boolean; animation: string; label: string }[] = [];
		(window as unknown as { __notices: typeof log }).__notices = log;
		new MutationObserver(() =>
			log.push({
				noticing: pill.hasAttribute('data-noticing'),
				animation: getComputedStyle(pill).animationName,
				label: pill.textContent?.trim() ?? ''
			})
		).observe(pill, { attributes: true, attributeFilter: ['data-noticing'] });
	});
}

const notices = (page: Page) =>
	page.evaluate(
		() =>
			(
				window as unknown as {
					__notices: { noticing: boolean; animation: string; label: string }[];
				}
			).__notices
	);

test(
	'with Auto choosing, a new read of the draft plays the pill notice once, and it clears when the animation ends',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		await openChatEntry(page);
		const pill = page.getByRole('button', { name: PICKER_TRIGGER });
		await expect(pill, 'with Auto on and no draft the pill reads plain "Auto"').toHaveText('Auto', {
			timeout: 30_000
		});
		await recordNotices(page);

		await page.getByLabel('Message AI Potluck').pressSequentially(CATALAN_DRAFT, { delay: 20 });
		await expect(pill, 'the on-device read named the draft Catalan on the pill').toContainText(
			/Catal/,
			{ timeout: 15_000 }
		);
		// The notice ends by itself: the attribute is gone once the keyframes finish.
		await expect(
			pill,
			'the notice never cleared, so animationend did not reach the pill'
		).not.toHaveAttribute('data-noticing', /.*/, { timeout: 5_000 });

		const log = await notices(page);
		const started = log.filter((n) => n.noticing);
		expect(
			started.length,
			`the pill's notice never played (log: ${JSON.stringify(log)})`
		).toBeGreaterThan(0);
		expect(
			started.map((n) => n.animation),
			'data-noticing was set but the browser ran no ds-route-notice keyframes on the pill'
		).toContain('ds-route-notice');
		expect(
			log.filter((n) => !n.noticing).length,
			`every notice that started has to clear (log: ${JSON.stringify(log)})`
		).toBe(started.length);
	}
);

test(
	'under reduced motion a new read of the draft changes the pill without playing the notice',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		await openChatEntry(page);
		const pill = page.getByRole('button', { name: PICKER_TRIGGER });
		await expect(pill).toHaveText('Auto', { timeout: 30_000 });
		await recordNotices(page);

		await page.getByLabel('Message AI Potluck').pressSequentially(CATALAN_DRAFT, { delay: 20 });
		// The read landed, so the absence below is not a read that never happened.
		await expect(pill).toContainText(/Catal/, { timeout: 15_000 });
		expect(
			await notices(page),
			'the notice played though the person asked for reduced motion'
		).toEqual([]);
	}
);

test(
	'with Clef reading drafts, the open picker credits it as an open-weight model from Cloudflare, published on Hugging Face',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'clef-routing': true });
		await openChatEntry(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		const menu = page.getByRole('menu');
		const credit = menu.locator('[data-clef-credit]');
		await expect(credit, 'Clef reads drafts here and the picker does not credit it').toBeVisible({
			timeout: 10_000
		});
		await expect(credit).toContainText(
			'Clef is an open-weight model from Cloudflare, published on Hugging Face.'
		);

		const cloudflare = credit.getByRole('link', { name: 'Cloudflare' });
		await expect(cloudflare).toHaveAttribute('href', orgs.cloudflare.url!);
		await expect(cloudflare).toHaveAttribute('target', '_blank');
		const huggingface = credit.getByRole('link', { name: 'Hugging Face' });
		// The model card of the size that read the draft: the full model before any read.
		await expect(huggingface).toHaveAttribute(
			'href',
			/^https:\/\/huggingface\.co\/Cloudflare\/clef(-flash)?$/
		);
		await expect(huggingface).toHaveAttribute('target', '_blank');

		// Each org shows its own logo, served by this app (the privacy panels promise no third-party requests).
		const logos = await credit.locator('img').evaluateAll((imgs) =>
			imgs.map((img) => {
				const el = img as HTMLImageElement;
				return { src: el.getAttribute('src'), loaded: el.complete && el.naturalWidth > 0 };
			})
		);
		expect(logos).toEqual([
			{ src: orgs.cloudflare.logo, loaded: true },
			{ src: orgs.huggingface.logo, loaded: true }
		]);
	}
);

test(
	'with Clef off, the open picker names no Clef: the draft is read on the device only',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'clef-routing': false });
		await openChatEntry(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		const menu = page.getByRole('menu');
		// Auto's explanation rendered, so the absence below is not a half-rendered menu.
		await expect(menu.locator('[data-how-we-chose]')).toBeVisible({ timeout: 10_000 });
		await expect(menu.locator('[data-clef-credit]')).toHaveCount(0);
	}
);
