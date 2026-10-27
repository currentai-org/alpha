// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// While status.aipotluck.org reports a problem, /chat says so above the conversation and
// links there (CUR-4062). The `status_page_degraded` fault makes /chat/api/status answer `degraded` for this page
// alone. That drives the banner on a day when status.aipotluck.org itself reads operational.
const STATUS_API = /\/chat\/api\/status$/;

test.describe('the incident banner follows the status page', { tag: ['@F2', '@CUR-4062'] }, () => {
	test('while the status page reports a problem, /chat shows a banner linking to it, and dismissing hides it', async ({
		page
	}) => {
		// The welcome covers the page from first paint, banner included.
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, () => startChattingPastWelcome(welcome));
		await installFaultInjectionHeader(page, 'status_page_degraded', STATUS_API, 'GET');
		await page.goto(chatEntry(), { waitUntil: 'domcontentloaded' });

		const banner = page.locator('[data-status-banner="degraded"]');
		await expect(
			banner,
			'no banner: the fault never reached /chat/api/status, or the banner did not render its answer'
		).toBeVisible({ timeout: 30_000 });
		await expect(banner).toContainText("Part of Alpha isn't working properly right now");
		const link = banner.getByRole('link', { name: 'Status page' });
		await expect(link).toHaveAttribute('href', 'https://status.aipotluck.org');
		await expect(link).toHaveAttribute('target', '_blank');

		await banner.getByRole('button', { name: 'Dismiss' }).click();
		await expect(banner).toBeHidden();
	});

	// The contract for an ordinary page load: the banner says what the real status page says, so it
	// shows during a real incident and never otherwise. Read from Better Stack directly, not from our
	// proxy, so a proxy that always answers operational goes red here during an incident.
	test('without a fault, the banner shows exactly when the real status page reports a problem', async ({
		page,
		request
	}) => {
		// A status page that does not answer reads as unknown (null) through our proxy too.
		const real = await request.get('https://status.aipotluck.org/index.json');
		const state = real.ok()
			? ((await real.json()).data.attributes.aggregate_state as string)
			: null;

		const proxied = page.waitForResponse((r) => STATUS_API.test(new URL(r.url()).pathname));
		await page.goto(chatEntry(), { waitUntil: 'domcontentloaded' });
		const res = await proxied;
		expect(res.status()).toBe(200);
		// The proxy holds each answer for up to a minute. A spec run in the minute the page changes state
		// can read the old one.
		expect((await res.json()).state).toBe(state);

		const banner = page.locator('[data-status-banner]');
		if (state === 'operational' || state === null) await expect(banner).toHaveCount(0);
		else await expect(banner).toBeVisible();
	});
});
