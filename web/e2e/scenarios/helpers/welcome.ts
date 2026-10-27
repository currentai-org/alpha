import { expect, type Locator } from '@playwright/test';

/**
 * The body of every spec's "Welcome to Alpha" locator handler: press Start chatting once the dialog can take it.
 *
 * The dialog is server-rendered with its buttons disabled until hydration (`WelcomeModal.svelte`, `ready`).
 * A plain `click()` from the handler on that disabled button retries, and Playwright re-intercepts the
 * retry for the very handler that is running, so the click waits on itself until the test ends and the
 * context teardown then times out (every
 * assertion passed, the test failed on "locator.click: Test ended"). Waiting for the button to enable is
 * not enough on its own: an enabled button can still fail the stable or receives-events check while the
 * dialog animates in, and that retry re-enters the handler the same way.
 * Every locator action re-enters, `locator.evaluate` included.
 * So once it is enabled, the press is a DOM click sent through `page.evaluate`,
 * which goes through no locator and so cannot re-enter. The dialog can also close on its own while we wait, once
 * the settings load marks it seen, and then there is nothing to press.
 */
export async function startChattingPastWelcome(welcomeDialog: Locator): Promise<void> {
	const start = welcomeDialog.getByRole('button', { name: /start chatting/i });
	await expect(async () => {
		if (!(await welcomeDialog.isVisible())) return;
		expect(
			await start.isEnabled({ timeout: 1_000 }),
			'Start chatting is still disabled (not hydrated)'
		).toBe(true);
	}).toPass({ timeout: 20_000 });
	if (!(await welcomeDialog.isVisible())) return;
	const page = welcomeDialog.page();
	// Start chatting also saves `welcomeModalSeen`. Waiting for that save keeps it from landing in the
	// middle of a test's own settings change.
	const seenSaved = page
		.waitForResponse((r) => r.url().endsWith('/settings') && r.request().method() === 'POST', {
			timeout: 5_000
		})
		.catch(() => {});
	await page.evaluate(() =>
		document.querySelector<HTMLButtonElement>('[data-welcome-start]')?.click()
	);
	// The welcome hands over only once its close animation has finished (`onOpenChangeComplete`), and
	// the handover moves focus into the composer. Playwright resumes the test as soon as the dialog
	// hides, so without this wait the focus move lands after the test's next step and closes a menu it
	// just opened or a drop it just started. The wait goes through
	// `waitForFunction`, which no locator handler intercepts. A page with no composer to focus lets it
	// time out quietly.
	await page
		.waitForFunction(
			() =>
				!document.querySelector('[data-welcome]') && document.activeElement?.tagName === 'TEXTAREA',
			undefined,
			{ timeout: 5_000 }
		)
		.catch(() => {});
	await seenSaved;
}
