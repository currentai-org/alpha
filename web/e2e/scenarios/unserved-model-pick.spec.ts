// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { startChattingPastWelcome } from './helpers/welcome';

// A model the person picked that isn't in the served list resolved to nothing, and the
// landing page then sent to its own default, so ALIA or Bielik picked while out of service answered as
// Mistral with no sign the pick was ignored. Now the send stops and says so. Command A is the pick here
// because the catalog lists it with no gateway id, so no deployment serves it.

const CHOICE_KEY = 'alpha:model-choice';
const UNSERVED = 'cohere-command-a';
const QUESTION = 'What is the capital of Austria? One word.';

test(
	'a picked model that is not served stops the send, says so, and keeps the draft, with no conversation made',
	{ tag: ['@F2'] },
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

// The same rule on a model link. `/chat/models/<id>` for a model the registry doesn't list
// showed the registry's first model in its place and sent the turn there: a hand-picked ALIA link,
// opened while the registry briefly lacked ALIA, was answered by Mistral Medium and its X-ray said
// Mistral AI in France. The id below is listed by no deployment, so the link always takes that path.
const UNLISTED_LINK_MODEL = 'example-org/unlisted-model-for-cur-3936';

test(
	'a model link to a model the registry does not list stops the send and names it, with no conversation made on another model',
	{ tag: ['@F2'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const created: string[] = [];
		page.on('request', (req) => {
			if (req.method() === 'POST' && /\/chat\/conversation\/?$/.test(new URL(req.url()).pathname))
				created.push(req.postData() ?? '');
		});
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry(UNLISTED_LINK_MODEL), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(QUESTION);
		await composer.press('Enter');

		await expect(
			page.getByText(
				`${UNLISTED_LINK_MODEL} isn't available right now. Pick another model and send again.`
			),
			'no error named the linked model: the send went to the default model, or failed some other way'
		).toBeVisible({ timeout: 30_000 });
		await expect(composer, 'the typed question was not put back in the composer').toHaveValue(
			QUESTION
		);
		await expect(
			page.locator('[data-message-role="assistant"]'),
			'an answer appeared for a linked model nobody serves'
		).toHaveCount(0);
		expect(page.url(), 'the page moved to a conversation').not.toMatch(/\/conversation\/[a-f0-9]+/);
		expect(created, 'a conversation was created on another model for the linked pick').toEqual([]);
	}
);
