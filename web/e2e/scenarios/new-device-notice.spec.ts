// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { setFlagOverrides } from './helpers/flagOverride';
import { readNewDeviceNotice } from './helpers/newDeviceNotice';

// Signing in from a device the account has not used before emails the account, naming the
// device and linking to Active sessions. The first device of a new account sends nothing, since there
// is nothing yet to compare it with.
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const FIREFOX_ON_WINDOWS =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

test.describe('new-device sign-in email', () => {
	test(
		'a sign-in from a second device emails the account its name and a link to Active sessions',
		{ tag: '@A1' },
		async ({ page, browser, baseURL }) => {
			const email = freshTestEmail();
			await setFlagOverrides(page.context(), baseURL!, { 'new-device-notice': true });
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			expect(
				await readNewDeviceNotice(DATABASE_URL!, email, 3_000),
				"the account's first device was mailed as if it were new"
			).toBeNull();

			const other = await browser.newContext({ baseURL, userAgent: FIREFOX_ON_WINDOWS });
			try {
				await setFlagOverrides(other, baseURL!, { 'new-device-notice': true });
				const otherPage = await other.newPage();
				await signInWithEmailOtp(otherPage, DATABASE_URL!, email, { skipPendingLabelCheck: true });

				const notice = await readNewDeviceNotice(DATABASE_URL!, email);
				expect(notice, 'no email after a sign-in from a new device').not.toBeNull();
				expect(notice!.text, 'the email does not name the device').toContain('Firefox on Windows');
				const link = notice!.text.match(/https?:\/\/\S+\/chat\/settings\/account/)?.[0];
				expect(link, 'the email has no link to Active sessions').toBeTruthy();

				await otherPage.goto(new URL(link!).pathname, { waitUntil: 'load' });
				await expect(
					otherPage.getByRole('heading', { name: 'Active sessions' }),
					'the link in the email does not open Active sessions'
				).toBeVisible({ timeout: 30_000 });
			} finally {
				await other.close();
			}
		}
	);

	// A device is the browser's own cookie, so a second browser on the same browser and system
	// is still a new device. The second context below keeps the default user agent, the same as the first.
	test(
		'a sign-in from a second browser with the same user agent as the first emails the account',
		{ tag: '@A1' },
		async ({ page, browser, baseURL }) => {
			const email = freshTestEmail();
			await setFlagOverrides(page.context(), baseURL!, { 'new-device-notice': true });
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			const firstAgent = await page.evaluate(() => navigator.userAgent);
			expect(
				(await page.context().cookies()).some((c) => c.name.includes('known_device')),
				'the first sign-in set no device cookie'
			).toBe(true);

			const other = await browser.newContext({ baseURL });
			try {
				await setFlagOverrides(other, baseURL!, { 'new-device-notice': true });
				const otherPage = await other.newPage();
				expect(await otherPage.evaluate(() => navigator.userAgent)).toBe(firstAgent);
				await signInWithEmailOtp(otherPage, DATABASE_URL!, email, { skipPendingLabelCheck: true });
				expect(
					await readNewDeviceNotice(DATABASE_URL!, email),
					'a second browser on the same browser and system signed in with no email'
				).not.toBeNull();
			} finally {
				await other.close();
			}
		}
	);

	test(
		'signing in again in the same browser sends nothing',
		{ tag: '@A1' },
		async ({ page, baseURL }) => {
			const email = freshTestEmail();
			await setFlagOverrides(page.context(), baseURL!, { 'new-device-notice': true });
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			// Drop the session and keep the device cookie, as signing out does.
			await page.context().clearCookies({ name: /session_token/ });
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			expect(
				await readNewDeviceNotice(DATABASE_URL!, email, 5_000),
				'the browser that signed in before was mailed about as a new device'
			).toBeNull();
		}
	);

	test(
		'with the flag off a sign-in from a second device sends nothing',
		{ tag: '@A1' },
		async ({ page, browser, baseURL }) => {
			const email = freshTestEmail();
			await setFlagOverrides(page.context(), baseURL!, { 'new-device-notice': false });
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });

			const other = await browser.newContext({ baseURL, userAgent: FIREFOX_ON_WINDOWS });
			try {
				await setFlagOverrides(other, baseURL!, { 'new-device-notice': false });
				await signInWithEmailOtp(await other.newPage(), DATABASE_URL!, email, {
					skipPendingLabelCheck: true
				});
				expect(
					await readNewDeviceNotice(DATABASE_URL!, email, 5_000),
					'a notice went out with new-device-notice off'
				).toBeNull();
				// The device cookie serves only the email, so it is not set while the email is off.
				const cookies = [...(await page.context().cookies()), ...(await other.cookies())];
				expect(
					cookies.filter((c) => c.name.includes('known_device')).map((c) => c.name),
					'a device cookie was set with new-device-notice off'
				).toEqual([]);
			} finally {
				await other.close();
			}
		}
	);
});
