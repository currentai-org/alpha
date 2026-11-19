// e2e-product: @chat
// e2e-area: @provenance
import { test, expect } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';

// A panelist that gives no take stays on the panel. `panelist_never_answers` ends the last
// listed panelist with no take and no model call, as an empty answer or a straggler does; the panel's
// header must still count it and name it with the no-response copy, not shrink to the takes that landed.
// Preview-only: production refuses the fault header.

const QUESTION = 'What is the capital of Australia?';

test(
	'a panelist that gives no take is counted in the second-opinion header and named as having no response in time',
	{ tag: ['@preview-only', '@CUR-4601'] },
	async ({ page }) => {
		test.setTimeout(300_000);
		// Armed on the panel's own request, not the chat send the helper defaults to.
		await installFaultInjectionHeader(
			page,
			'panelist_never_answers',
			/\/chat\/api\/second-opinion$/
		);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(QUESTION);
		await composer.press('Enter');

		const message = page.locator('[data-message-role="assistant"]').first();
		await expect(turnDone(message), `"${QUESTION}" never finished`).toBeVisible({
			timeout: 90_000
		});

		await message.getByRole('button', { name: 'Second opinion', exact: true }).click();
		const offer = page.locator('[data-xray-panel] [data-second-opinion-offer]');
		await offer.getByRole('button', { name: /Get a collective second opinion/ }).click();
		const verdict = offer.locator('[data-second-opinion-verdict]');
		await expect(verdict, 'the panel never returned a verdict').toBeVisible({ timeout: 120_000 });

		const unanswered = verdict.locator('[data-so-unanswered] li');
		await expect(unanswered, 'the silent panelist is not listed on the panel').toHaveCount(1);
		await expect(unanswered).toContainText('no response in time');

		// The header counts the listed panelists: the takes that landed plus the one that did not.
		const takesButton = verdict.getByRole('button', { name: /individual takes?/ });
		const takes = Number((await takesButton.innerText()).match(/\d+/)?.[0] ?? '1');
		await expect(verdict, 'the header does not count the silent panelist').toContainText(
			`${takes + 1} open models`
		);
	}
);
