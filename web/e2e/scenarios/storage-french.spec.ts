// e2e-product: @chat
// e2e-area: @storage @settings
import { readFileSync } from 'node:fs';
import { test, expect } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';

// A French visitor reads Settings → Storage in French. The section's headings and
// disclosure labels were keys with no French, so French showed "Make a new bucket", "Recommended"
// and "How connecting works". The expected text comes from the French catalog itself, so the spec
// follows a copy edit, and it also refuses the English a missing key falls back to.
const fr = JSON.parse(
	readFileSync(new URL('../../messages/fr.json', import.meta.url), 'utf8')
) as Record<string, string>;
const en = JSON.parse(
	readFileSync(new URL('../../messages/en.json', import.meta.url), 'utf8')
) as Record<string, string>;

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: baseURL as string }]);
	await setFlagOverrides(context, baseURL!, {
		'custodial-storage-view': true,
		'storage-locations': true
	});
});

test(
	'Settings > Storage in French shows the new-bucket choice, its Recommended badge and the connecting help in French, none of the English it used to show',
	{ tag: ['@preview-only', '@A2', '@CUR-4395'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await signInAsFreshUser(page);
		// Reached through the settings nav, the way a visitor gets there.
		await page.goto('/chat/settings', { waitUntil: 'commit' });
		await page.locator('a[href$="/chat/settings/storage"]').first().click({ timeout: 30_000 });
		const section = page.getByTestId('storage-link-section');
		await expect(section).toBeVisible({ timeout: 30_000 });

		await expect(section.getByRole('heading', { level: 3 })).toHaveText([
			fr.storage_connectNewTitle,
			fr.storage_orLinkExisting
		]);
		const connectChoice = section.getByTestId('storage-connect-choice');
		await expect(connectChoice).toContainText(fr.storage_recommended);
		await connectChoice.getByRole('button', { name: fr.storage_connectHow }).click();
		await expect(section.getByTestId('storage-connect-how')).toBeVisible();

		const shown = (await section.innerText()).toLowerCase();
		for (const key of [
			'storage_connectNewTitle',
			'storage_recommended',
			'storage_connectHow',
			'storage_connectNewHelp'
		]) {
			expect(fr[key], `${key} has its own French text`).not.toBe(en[key]);
			expect(shown, `the English of ${key} is not on the page`).not.toContain(
				en[key].toLowerCase()
			);
		}
	}
);
