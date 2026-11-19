// e2e-product: @chat
// e2e-area: @history
// The prompt behind a sealed answer, rebuilt from what the browser opens (stage 5b of
//). The server cannot open
// a sealed message, so XRAY's "This answer" tab opens the chat in this browser and posts the opened
// words; the server checks each against its stored MAC and renders the prompt from them.
//
// A signed-in person turns encryption on in Settings first, so the first turn is sealed; the stored row is read
// first to prove the canary is not in it, then the prompt view must show it. A real model answers,
// since the footer's "How this answer was made" names the model that served, which a canned reply has
// none of.
import { test, expect, type Page } from './helpers/test';
import { chatPath, LARGE4_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { turnDone } from './helpers/turn';
import { signInAsFreshUser } from './helpers/session';
import { turnOnEncryption } from './helpers/historyKey';
import { readConversationDoc } from './helpers/exportArchive';
import { openXrayTab } from './helpers/xray';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const KEY_ROUTE = chatPath('/api/v2/keys/history');

test.use({ viewport: { width: 1280, height: 800 } });

type StoredDoc = { messages: { from: string; sealed?: string }[] };

/** Waits until this browser's history key is stored. */
async function keyStored(page: Page) {
	await expect
		.poll(async () => (await page.request.get(KEY_ROUTE)).status(), {
			message: 'the history key was never stored',
			timeout: 30_000
		})
		.toBe(200);
}

test(
	"XRAY shows the prompt behind a sealed answer, opened in the browser, though the stored row can't be read",
	{ tag: ['@preview-only', '@CUR-4964'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			// The router sends some prompts to the agent; this test is about the chat turn.
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		await composerHydrated(page);
		await turnOnEncryption(page);
		await keyStored(page);

		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'load' });
		await composerHydrated(page);
		const canary = `canary-egret-${Date.now().toString(36)}`;
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Sealed prompt check ${canary}: in one sentence, what do egrets eat?`);
		const id = await sendOpensConversation(page);
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 120_000 });

		const doc = (await readConversationDoc(DATABASE_URL!, id)) as unknown as StoredDoc;
		expect(JSON.stringify(doc), 'the canary reached the stored conversation row').not.toContain(
			canary
		);
		expect(
			doc.messages.some((m) => m.from === 'user' && m.sealed),
			'the question was not stored sealed'
		).toBe(true);

		// As a person would: the answer's "How this answer was made", then "This answer".
		await openXrayTab(page, answer, 'This answer', {
			disclosure: { timeout: 20_000 },
			tab: { timeout: 15_000 }
		});
		const view = page.locator('[data-xray-panel] [data-prompt-view]');
		await view.getByRole('button', { name: 'Show the prompt' }).click({ timeout: 15_000 });
		// A refusal shows its reason in place of the prompt, so either outcome settles this wait.
		await expect(
			view.locator('[data-prompt-text], [data-prompt-error]'),
			'the prompt view never answered'
		).toBeVisible({ timeout: 30_000 });
		await expect(
			view.locator('[data-prompt-error]'),
			'the prompt view refused the sealed chat'
		).toHaveCount(0);
		await expect(
			view.locator('[data-prompt-text]'),
			'the prompt view does not show the opened question'
		).toContainText(canary);
	}
);
