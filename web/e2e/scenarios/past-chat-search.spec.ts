// e2e-product: @chat
// e2e-area: @settings
// Past-chat search (CUR-4576). A signed-in person switches "Search my past chats" on in Settings →
// Personalization, tells Alpha a made-up name in one chat, then asks for it in a new chat. The answer
// has to carry the name, which exists nowhere but in the first chat, and the note under it has to link
// that chat. The name is fresh per run, so no earlier run's chat and no model's training can supply it.
//
// @no-replay: the search result the model reads names the first chat's URL, which is new every run, so
// no recorded answer can ever match and a replayed run would only ever see the mock. It runs live on
// develop pushes and nightly, and on a PR through one-spec.yml.
import { randomBytes } from 'node:crypto';
import { test, expect } from './helpers/test';
import { answerShapeEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

test(
	'with past-chat search switched on, a new chat answers from an earlier one and links it under the answer',
	{ tag: ['@preview-only', '@no-replay', '@CUR-4576'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await setFlagOverrides(context, baseURL!, { 'past-chat-search': true });
		await signInAsFreshUser(page);

		// 1. Switch it on in Settings, and wait for the save to land.
		await page.goto(chatPath('/settings/personalization'), { waitUntil: 'load' });
		const toggle = page.getByRole('switch', { name: 'Search my past chats' });
		await expect(toggle, 'Personalization offers no past-chat search switch').toBeVisible({
			timeout: 20_000
		});
		await expect(toggle, 'past-chat search is on before the person chose it').not.toBeChecked();
		const saved = page.waitForResponse(
			(r) => r.request().method() === 'POST' && /\/settings\/?$/.test(new URL(r.url()).pathname),
			{ timeout: 15_000 }
		);
		await toggle.click();
		await expect(toggle).toBeChecked();
		expect((await saved).ok(), 'the switch did not save').toBe(true);

		// 2. The first chat holds the fact.
		const bikeName = `Velo${randomBytes(3).toString('hex')}`;
		await page.goto(answerShapeEntry(), { waitUntil: 'load' });
		const composer = page.getByLabel('Message AI Potluck');
		// Typed before hydration, the text sits in the server-rendered box while the app's draft stays
		// empty, and Enter sends nothing.
		await composerHydrated(page);
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Please note this: my bicycle is called ${bikeName}, and it is green.`);
		const firstId = await sendOpensConversation(page);
		const first = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(first), 'the first chat never finished its answer').toBeVisible({
			timeout: 120_000
		});

		// 3. A new chat asks for it.
		await page.goto(answerShapeEntry(), { waitUntil: 'load' });
		await composerHydrated(page);
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			'In an earlier chat I told you what my bicycle is called. What is its name? Search my past chats.'
		);
		const secondId = await sendOpensConversation(page);
		expect(secondId, 'the second question landed in the first chat').not.toBe(firstId);
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the second chat never finished its answer').toBeVisible({
			timeout: 150_000
		});
		await expect(
			answer,
			'the answer does not carry the name told only in the earlier chat'
		).toContainText(bikeName);
		const note = answer.getByTestId('past-chats-note');
		await expect(note, 'the answer has no note saying it used past chats').toBeVisible();
		await expect(note).toContainText('Used your past chats');
		await note.getByRole('button', { name: /What.s this/ }).click();
		await expect(
			note.locator(`a[href$="/conversation/${firstId}"]`),
			'the note does not link the chat the answer came from'
		).toBeVisible();
	}
);
