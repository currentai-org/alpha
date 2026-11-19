// e2e-product: @chat
// e2e-area: @history
// An enrolled owner's new chat stores its preprompt sealed; the server decides from enrollment, never
// from the request (stage 4c). An account with a history key and saved Personalization instructions starts a chat whose
// preprompt carries a canary; the stored row holds no copy of the canary, and two turns go through. The
// turns need the conversation fetch to hand the sealed preprompt back even though the personal
// instructions win over it: the browser opens it and posts it with each turn, and a turn without it is
// refused.
//
// Sealing is the history-seal-writes flag; with it off, or with the create route not
// sealing, the canary is stored in plaintext and the row check fails. The history key is made only where
// the history-key-enrollment flag is on, so it is forced the documented way (`setFlagOverrides`).
import { test, expect } from './helpers/test';
import postgres from 'postgres';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { freshAccountWithHistoryKey } from './helpers/historyKey';
import { setFlagOverrides } from './helpers/flagOverride';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { sslFor } from './helpers/db';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;

/** The conversation's stored row as text, and whether its preprompt is sealed. */
async function storedConversation(id: string): Promise<{ text: string; sealedPreprompt: boolean }> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		const rows = await sql<
			{ doc: { sealedPreprompt?: string } }[]
		>`select doc from conversations where id = ${id}`;
		expect(rows.length, 'the conversation was never stored').toBe(1);
		return {
			text: JSON.stringify(rows[0].doc),
			sealedPreprompt: Boolean(rows[0].doc.sealedPreprompt)
		};
	} finally {
		await sql.end({ timeout: 5 });
	}
}

test(
	"an enrolled owner's new chat stores its preprompt sealed, and continues for two turns under personal instructions",
	{ tag: ['@preview-only', '@CUR-4962'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(360_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		// An account with a history key: a guest's chats are not sealed.
		await freshAccountWithHistoryKey(page);
		const composer = page.getByLabel('Message AI Potluck');

		// Personalization instructions, which win over the chat's own preprompt on every turn.
		const saved = await page.request.post(chatPath('/settings'), {
			data: { customPrompts: { '*': 'Keep every answer to one short paragraph.' } },
			// The chat's CSRF hook checks Origin; send the page's own, as its fetch would.
			headers: { origin: new URL(page.url()).origin }
		});
		expect(saved.ok(), 'the personal instructions did not save').toBe(true);

		// The new chat's preprompt carries the canary, as a per-model custom prompt would.
		const canary = `canary-${Date.now().toString(36)}-quince-semaphore`;
		await page.route('**/chat/conversation', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
			await route.continue({
				postData: JSON.stringify({ ...body, preprompt: `Mention the word ${canary} once.` })
			});
		});

		// A fresh landing page: the server seals from the owner's enrollment, whatever this tab holds.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await composerHydrated(page);
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is a good name for a rowing boat?');
		const id = await sendOpensConversation(page);
		await expect(
			turnDone(page.locator('[data-message-role="assistant"]').last()),
			'the first turn under a sealed preprompt did not finish'
		).toBeVisible({ timeout: 120_000 });

		const stored = await storedConversation(id);
		expect(stored.sealedPreprompt, 'the new chat has no sealed preprompt').toBe(true);
		expect(stored.text, 'the preprompt is stored in plaintext').not.toContain(canary);

		// The second turn posts the opened preprompt again, from the conversation the page reloaded.
		await composer.click({ timeout: 30_000 });
		await composer.fill('And one more name, please.');
		await composer.press('Enter');
		const answers = page.locator('[data-message-role="assistant"]');
		await expect(answers, 'the second turn did not land as a second answer').toHaveCount(2, {
			timeout: 60_000
		});
		await expect(
			turnDone(answers.last()),
			'the second turn under a sealed preprompt did not finish'
		).toBeVisible({ timeout: 120_000 });
		const after = await storedConversation(id);
		expect(after.text, 'a turn wrote the preprompt back in plaintext').not.toContain(canary);
	}
);
