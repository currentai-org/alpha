// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { startChattingPastWelcome } from './helpers/welcome';

// A model the person picked that isn't in the served list resolved to nothing, and the
// landing page then sent to its own default, so ALIA or Bielik picked while out of service answered as
// Mistral with no sign the pick was ignored (CUR-4073). Now the send stops and says so. Command A is the pick here
// because the catalog lists it with no gateway id, so no deployment serves it.

const CHOICE_KEY = 'alpha:model-choice';
const UNSERVED = 'cohere-command-a';
const QUESTION = 'What is the capital of Austria? One word.';

test(
	'CUR-4073: a picked model that is not served stops the send, says so, and keeps the draft, with no conversation made',
	{ tag: ['@F2', '@CUR-4073'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		await context.addInitScript(
			([key, value]) => {
				try {
					localStorage.setItem(key, value);
				} catch {
					/* storage unavailable */
				}
			},
			[CHOICE_KEY, UNSERVED] as const
		);
		const created: string[] = [];
		page.on('request', (req) => {
			if (req.method() === 'POST' && /\/chat\/conversation\/?$/.test(new URL(req.url()).pathname))
				created.push(req.url());
		});
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(QUESTION);
		await composer.press('Enter');

		await expect(
			page.getByText("Command A isn't available right now. Pick another model and send again."),
			'no error named the unserved pick: the send went to another model, or failed some other way'
		).toBeVisible({ timeout: 30_000 });
		await expect(composer, 'the typed question was not put back in the composer').toHaveValue(
			QUESTION
		);
		await expect(
			page.locator('[data-message-role="assistant"]'),
			'an answer appeared for a pick nobody serves'
		).toHaveCount(0);
		expect(page.url(), 'the page moved to a conversation').not.toMatch(/\/conversation\/[a-f0-9]+/);
		expect(created, 'a conversation was created for a pick nobody serves').toEqual([]);
	}
);
