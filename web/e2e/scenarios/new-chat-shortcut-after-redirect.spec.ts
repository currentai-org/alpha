// e2e-product: @chat
// e2e-area: @history
import { test, expect, type Page } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { sendOpensConversation } from './helpers/composer';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// The chat shell's mount awaits a redirect when the URL carries `?model=` or `?unavailable=`
// (a conversation this visitor can't open). The new-chat shortcut's cleanup used to be registered after
// that await, which throws lifecycle_outside_component and leaves Ctrl/Cmd+Shift+O dead for the load.
// Each test lands through one of those URLs, sends a turn so the page is a conversation, and checks
// the shortcut takes it back to a new chat with no page error on the way.

type ServedModel = { id: string };

async function firstServedModel(page: Page): Promise<string> {
	const res = await page.request.get('/chat/api/v2/models');
	expect(res.ok(), `/chat/api/v2/models answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: ServedModel[] } | ServedModel[];
	const models = Array.isArray(body) ? body : (body.json ?? []);
	expect(models.length, 'the models list is empty').toBeGreaterThan(0);
	return models[0].id;
}

async function shortcutOpensNewChatAfterLanding(page: Page, query: string) {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(err.message));
	await installCannedReplies(page);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});

	await page.goto(`${CHAT_ENTRY}?${query}`, { waitUntil: 'commit' });
	await expect(page, 'the landing query was never cleared').not.toHaveURL(
		/[?&](model|unavailable)=/,
		{
			timeout: 30_000
		}
	);
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill('What is the capital of France? Answer in one sentence.');
	const conversationId = await sendOpensConversation(page);
	await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
		timeout: 90_000
	});

	await page.keyboard.press('ControlOrMeta+Shift+O');
	await expect(
		page,
		'Ctrl/Cmd+Shift+O did not leave the conversation for a new chat'
	).not.toHaveURL(new RegExp(conversationId), { timeout: 15_000 });
	expect(errors, 'the page threw while loading or handling the shortcut').toEqual([]);
}

test('after landing from a conversation the visitor cannot open (?unavailable=1), the page throws nothing and Ctrl/Cmd+Shift+O opens a new chat', async ({
	page
}) => {
	test.setTimeout(180_000);
	await shortcutOpensNewChatAfterLanding(page, 'unavailable=1');
});

test('after landing from a ?model= link, the page throws nothing and Ctrl/Cmd+Shift+O opens a new chat', async ({
	page
}) => {
	test.setTimeout(180_000);
	const model = await firstServedModel(page);
	await shortcutOpensNewChatAfterLanding(page, `model=${encodeURIComponent(model)}`);
});
