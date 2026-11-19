// e2e-product: @chat
// e2e-area: @history
// The edges stage 4 of sealed history left on plaintext assumptions.
//
// - A turn sent before the previous turn's reload has not opened what that turn sealed. The server
//   refuses its history with a 409 that names the cause, and the page reopens the chat and sends once
//   more, so two turns in a row both answer without a reload.
// - Settings' usage counts sum a sealed message's stored length, since its `content` is stored empty.
// - A guest's Forget everything empties the guest's history key slot, so the guest can enroll a new key.
//
// Sealing is the history-seal-writes flag, on for develop and its previews. The
// history key is made only where history-key-enrollment is on, so it is forced the documented way.
import { test, expect, type Page } from './helpers/test';
import postgres from 'postgres';
import { Encrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { freshAccountWithHistoryKey } from './helpers/historyKey';
import { setFlagOverrides } from './helpers/flagOverride';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { sslFor } from './helpers/db';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const KEY_ROUTE = chatPath('/api/v2/keys/history');
const USAGE_ROUTE = chatPath('/api/v2/user/usage');
// Long enough that the post-turn reload cannot land before the next send.
const RELOAD_HOLD_MS = 6_000;

type StoredMessage = { id: string; from: string; sealed?: string; chars?: number };

async function storedMessages(id: string): Promise<StoredMessage[]> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		const rows = await sql<
			{ doc: { messages: StoredMessage[] } }[]
		>`select doc from conversations where id = ${id}`;
		expect(rows.length, 'the conversation was never stored').toBe(1);
		return rows[0].doc.messages;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

const answers = (page: Page) => page.locator('[data-message-role="assistant"]');

async function send(page: Page, text: string): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(text);
	await composer.press('Enter');
}

test(
	'two turns sent without a reload both answer, and usage counts the sealed turns',
	{ tag: ['@preview-only', '@CUR-4961'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		// An account with a history key: a guest's chats are not sealed.
		await freshAccountWithHistoryKey(page);

		// The first turn is sealed to the account's key; the reload opens the chat with it.
		const prompts = [`Sealed readers check ${Date.now()}: name one river in Wales`];
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(prompts[0]);
		await sendOpensConversation(page);
		await expect(turnDone(answers(page).last())).toBeVisible({ timeout: 120_000 });
		const id = new URL(page.url()).pathname.split('/').pop()!;
		await page.reload({ waitUntil: 'load' });
		await composerHydrated(page);

		// Hold every read of this conversation, so the reload that follows a turn is still on its way
		// when the next turn is sent: that turn goes without the bodies the server just sealed.
		await page.route(new RegExp(`/api/v2/conversations/${id}(\\?|$)`), async (route) => {
			await new Promise((resolve) => setTimeout(resolve, RELOAD_HOLD_MS));
			await route.continue().catch(() => {});
		});
		const posts: string[] = [];
		page.on('request', (req) => {
			if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith(`/conversation/${id}`))
				posts.push(req.url());
		});

		prompts.push(`Second question ${Date.now().toString(36)}: and one in Scotland?`);
		await send(page, prompts[1]);
		await expect(answers(page)).toHaveCount(2, { timeout: 30_000 });
		await expect(turnDone(answers(page).nth(1))).toBeVisible({ timeout: 120_000 });

		const before = posts.length;
		prompts.push(`Third question ${Date.now().toString(36)}: and one in Ireland?`);
		await send(page, prompts[2]);
		await expect(answers(page)).toHaveCount(3, { timeout: 30_000 });
		await expect(
			turnDone(answers(page).nth(2)),
			'the turn sent before the reload did not answer'
		).toBeVisible({ timeout: 120_000 });
		await expect(
			page.getByText(/unlock this chat to continue it|does not match this chat/)
		).toHaveCount(0);
		// The first send went without the second turn's sealed bodies and was refused; the page reopened
		// the chat and sent once more. One post would mean the race this checks never happened.
		expect(posts.length - before, 'the third turn was not refused and resent once').toBe(2);

		const stored = await storedMessages(id);
		const answered = stored.filter((m) => m.from === 'assistant');
		expect(answered.length, 'a turn is missing from the stored row').toBe(3);
		const sealedQuestions = stored.filter((m) => m.from === 'user' && m.sealed);
		expect(sealedQuestions.length, 'the later questions were not sealed').toBeGreaterThanOrEqual(2);
		for (const m of sealedQuestions) {
			expect(m.chars, `sealed question ${m.id} has no stored length`).toBeGreaterThan(0);
		}

		// Usage counts every question's characters, sealed or not: at least what was typed. Read as empty,
		// the sealed questions would bring it down to the first question's length.
		await page.unroute(new RegExp(`/api/v2/conversations/${id}(\\?|$)`));
		const usage = await page.request.get(USAGE_ROUTE);
		expect(usage.status()).toBe(200);
		const { totals } = (await usage.json()) as { totals: { characters: number } };
		expect(totals.characters, 'usage left out the sealed questions').toBeGreaterThanOrEqual(
			prompts.reduce((n, p) => n + p.length, 0)
		);
	}
);

/** A wrapped history key the route accepts: an age file, a fresh hybrid recipient, and the wrap
 *  format today's browser declares. */
async function historyKeyBody(): Promise<{ wrapped: string; recipient: string; format: 2 }> {
	const recipient = await identityToRecipient(await generateHybridIdentity());
	const e = new Encrypter();
	e.addRecipient(await identityToRecipient(await generateHybridIdentity()));
	const wrapped = await e.encrypt(JSON.stringify({ v: 1, test: 'CUR-4961' }));
	return { wrapped: Buffer.from(wrapped).toString('base64'), recipient, format: 2 };
}

test(
	"a guest's Forget everything lets the guest enroll a new history key",
	{ tag: ['@preview-only', '@CUR-4961'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		// The guest's silent enrollment is not what this tests, and the key route does not read the flag.
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': false });
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await composerHydrated(page);

		const first = await historyKeyBody();
		expect(
			(await page.request.put(KEY_ROUTE, { data: first })).status(),
			"the guest's first key was not stored"
		).toBe(201);
		const second = await historyKeyBody();
		expect(
			(await page.request.put(KEY_ROUTE, { data: second })).status(),
			'a different recipient replaced a stored key without a reset'
		).toBe(409);

		await page.goto(chatPath('/settings/data'), { waitUntil: 'commit' });
		await page.getByRole('button', { name: /^Forget everything/ }).click({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 30_000
		});

		expect(
			(await page.request.get(KEY_ROUTE)).status(),
			"the guest's old history key outlived Forget everything"
		).toBe(404);
		const stored = await page.request.put(KEY_ROUTE, { data: second });
		expect(
			stored.status(),
			`the guest's new history key was refused: ${(await stored.text()).slice(0, 200)}`
		).toBe(201);
		expect((await (await page.request.get(KEY_ROUTE)).json()).recipient).toBe(second.recipient);
	}
);
