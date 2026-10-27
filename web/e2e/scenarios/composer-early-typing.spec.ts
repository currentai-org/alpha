// e2e-product: @chat
// e2e-area: @composer
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated, sendOpensConversation } from './helpers/composer';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// The reports were reloads by a visitor who had already closed "Welcome to Alpha". A fresh account
// gets that dialog server-rendered with its button disabled until load, so it is closed on a normal
// load first and the setting saved; the held reload then renders /chat the way that visitor saw it.
async function dismissMeetAlpha(page: Page) {
	await page.goto('/chat');
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await welcomeDialog.waitFor({ timeout: 30_000 });
	const saved = page.waitForResponse(
		(r) => /\/chat\/settings$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'
	);
	await welcomeDialog.getByRole('button', { name: /start chatting/i }).click();
	await saved;
}

async function holdClientBundle(page: Page) {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/_app/immutable/entry/**', async (route) => {
		await held;
		await route.continue();
	});
	return release;
}

// A signed-in visitor reloaded /chat, typed at once, and the text vanished about
// three seconds later, when the page finished loading. The client bundle is held back here so the
// server-rendered box is on screen with no app behind it, which is the window the visitor typed in.
// Either the box keeps what it showed, or it never showed anything: what it must not do is accept
// text and then drop it.
test(
	'text typed into the composer before /chat has loaded is kept once it loads, never shown and then dropped, and text typed after sends',
	{ tag: ['@preview-only', '@CUR-3311'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		await dismissMeetAlpha(page);
		const release = await holdClientBundle(page);

		await page.goto('/chat', { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.waitFor({ state: 'attached', timeout: 30_000 });
		await composer.focus();
		await page.keyboard.type('typed while loading');
		const shown = await composer.inputValue();

		release();
		await composerHydrated(page, { timeout: 60_000 });
		await expect(
			composer,
			`the box showed "${shown}" while loading and lost it once the page loaded`
		).toHaveValue(shown);

		await composer.fill('typed after loading');
		await expect(composer, 'typing after load does not land in the box').toHaveValue(
			'typed after loading'
		);
		// A visitor's Enter in that window sent nothing, so typing that lands is not enough:
		// the same text has to go out as the first message of a new conversation.
		await sendOpensConversation(page, { timeout: 60_000 });
		await expect(
			page.getByText('typed after loading', { exact: true }).first(),
			'the conversation opened without the message that was sent'
		).toBeVisible({ timeout: 30_000 });
	}
);

// Same window, second surface: a prompt example clicked about five seconds after a reload
// did nothing, because the server-rendered button had no handler yet. A click then must not look
// accepted and vanish, so the button is disabled until the app can act on it.
test(
	'a prompt example cannot be clicked before /chat has loaded, so a click is never silently dropped',
	{ tag: ['@preview-only', '@CUR-3311'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		await dismissMeetAlpha(page);
		const release = await holdClientBundle(page);

		await page.goto('/chat', { waitUntil: 'commit' });
		await page.getByText('Prompt examples:').waitFor({ timeout: 30_000 });
		const example = page
			.getByText('Prompt examples:')
			.locator('xpath=following-sibling::button[1]');
		await expect(
			example,
			'a prompt example looks clickable before its click handler exists'
		).toBeDisabled();

		release();
		await composerHydrated(page, { timeout: 60_000 });
		await expect(example, 'the prompt example stays disabled after the page loaded').toBeEnabled();
	}
);
