// e2e-product: @chat
// e2e-area: @history
// Search, export and share read sealed chats in the browser. The server cannot open a
// sealed title or message, so:
//
// - Search chats opens the owner's sealed titles in the browser and matches them there. The chat it
//   must find is archived, so it is not in the sidebar's loaded rows, and its stored title is empty, so
//   the server's search cannot match it: only the browser's opened title can.
// - Settings → Account's download opens the sealed chats in the browser and writes their words into
//   the ZIP and the Open WebUI file.
// - Share chat says, in one line, that a readable copy leaves the browser; the link then shows the chat,
//   and the stored conversation row stays sealed.
//
// Sealing is the history-seal-writes flag, on for develop and its previews. The
// history key is made only where history-key-enrollment is on, so it is forced the documented way. A
// guest's chats are written unsealed, so every test signs in and turns encryption on in
// Settings first; every turn after that is sealed.
import { test, expect, type Page } from './helpers/test';
import { readFileSync } from 'node:fs';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { signInAsFreshUser } from './helpers/session';
import { turnOnEncryption } from './helpers/historyKey';
import { accountMenuItem } from './helpers/accountMenu';
import { chooseFromRowMenu } from './helpers/sideRail';
import { openArchive, readConversationDoc } from './helpers/exportArchive';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const KEY_ROUTE = chatPath('/api/v2/keys/history');

test.use({ viewport: { width: 1280, height: 800 } });

type StoredDoc = {
	title?: string;
	sealedTitle?: string;
	messages: { id: string; from: string; content?: string; sealed?: string }[];
};

async function storedDoc(id: string): Promise<StoredDoc> {
	return (await readConversationDoc(DATABASE_URL!, id)) as unknown as StoredDoc;
}

/** The stored row holds no copy of `canary`, and its later questions are sealed. */
async function expectSealed(id: string, canary: string) {
	const doc = await storedDoc(id);
	expect(JSON.stringify(doc), 'the canary reached the stored conversation row').not.toContain(
		canary
	);
	expect(
		doc.messages.some((m) => m.from === 'user' && m.sealed),
		'no question in the stored row is sealed'
	).toBe(true);
}

/** Sends one turn from the open page and returns the conversation's id once it has answered. */
async function sendOneTurn(page: Page, prompt: string): Promise<string> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(prompt);
	const id = await sendOpensConversation(page);
	await expect(
		turnDone(page.locator('[data-message-role="assistant"]').last()),
		'the turn never finished'
	).toBeVisible({ timeout: 120_000 });
	return id;
}

/** Waits until this browser's history key is stored. */
async function keyStored(page: Page) {
	await expect
		.poll(async () => (await page.request.get(KEY_ROUTE)).status(), {
			message: 'the history key was never stored',
			timeout: 30_000
		})
		.toBe(200);
}

/** A signed-in person with a history key (turned on in Settings with a recovery key), one sealed
 *  turn carrying `canary`, and that turn's conversation id. */
async function signedInWithSealedChat(page: Page, canary: string): Promise<string> {
	await signInAsFreshUser(page);
	await composerHydrated(page);
	await turnOnEncryption(page);
	await keyStored(page);
	await page.goto(chatEntry(), { waitUntil: 'load' });
	await composerHydrated(page);
	await installCannedReplies(page);
	const id = await sendOneTurn(page, `Sealed release check: where do ospreys winter? ${canary}`);
	await expectSealed(id, canary);
	return id;
}

test(
	"Search chats finds an archived chat by a word of its sealed title, which the server can't read",
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		const id = await signedInWithSealedChat(page, `canary-${Date.now().toString(36)}-search`);

		// The rename is sealed like the turn was; archiving takes the chat out of the sidebar's rows.
		const word = `heron${Date.now().toString(36)}`;
		const renamed = await page.request.patch(chatPath(`/api/v2/conversations/${id}`), {
			data: { title: `Notes ${word} plans` }
		});
		expect(renamed.ok(), `renaming answered ${renamed.status()}`).toBe(true);
		const doc = await storedDoc(id);
		expect(doc.sealedTitle, 'the renamed title was not sealed').toBeTruthy();
		expect(JSON.stringify(doc), 'the title word reached the stored row').not.toContain(word);
		const archived = await page.request.patch(chatPath(`/api/v2/conversations/${id}`), {
			data: { archived: true }
		});
		expect(archived.ok(), `archiving answered ${archived.status()}`).toBe(true);

		await page.goto(chatEntry(), { waitUntil: 'load' });
		await composerHydrated(page);
		await expect(page.locator(`a[href$="/conversation/${id}"]`)).toHaveCount(0);
		await page.getByRole('button', { name: 'Search chats' }).first().click();
		await page.getByRole('textbox', { name: 'Search chats' }).fill(word);
		// The "Ask Alpha: …" row repeats the query, so it is excluded: it is not a result.
		const hit = page.locator('[data-search-row]', { hasText: word, hasNotText: 'Ask Alpha' });
		await expect(hit, 'Search chats did not find the sealed title').toBeVisible({
			timeout: 30_000
		});
		await expect(hit.locator('[data-search-archived]')).toBeVisible();
		await hit.click();
		await expect(page).toHaveURL(new RegExp(`/conversation/${id}$`), { timeout: 20_000 });
	}
);

test(
	'the account download writes a sealed chat into the ZIP and the Open WebUI file, opened in the browser',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			// The router sends some prompts to the agent; this test is about the files.
			'agent-mode': false
		});
		const canary = `canary-kestrel-${Date.now().toString(36)}`;
		await signedInWithSealedChat(page, canary);

		// From /chat, the account menu's Settings, then Account, as a person would.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await (await accountMenuItem(page, 'Settings', { timeout: 20_000 })).click();
		const summary = page.waitForResponse((r) => r.url().endsWith('/api/v2/export/summary'));
		await page.getByRole('link', { name: 'Account', exact: true }).click();
		await expect(page).toHaveURL(/\/chat\/settings\/account$/, { timeout: 15_000 });
		const counts = (await (await summary).json()) as { sealed?: number };
		expect(counts.sealed, 'the export summary counts no sealed chat').toBeGreaterThan(0);

		const zipRow = page.getByRole('link', {
			name: 'Download a ZIP of your conversations, files, and where each answer came from'
		});
		const [zipDownload] = await Promise.all([
			page.waitForEvent('download', { timeout: 60_000 }),
			zipRow.click()
		]);
		const zipPath = await zipDownload.path();
		if (!zipPath) throw new Error('download event fired but Playwright kept no local copy');
		const archive = openArchive(readFileSync(zipPath));
		expect(
			archive['conversations.json'],
			'conversations.json is missing the sealed chat'
		).toContain(canary);
		const readable = Object.entries(archive).filter(
			([name]) => name.startsWith('conversations/') && name.endsWith('.md')
		);
		expect(
			readable.some(([, text]) => text.includes(canary)),
			'no readable copy in the ZIP holds the sealed chat'
		).toBe(true);

		const owuiRow = page.getByRole('link', {
			name: 'Download your conversations as a file Open WebUI can import'
		});
		const [owuiDownload] = await Promise.all([
			page.waitForEvent('download', { timeout: 60_000 }),
			owuiRow.click()
		]);
		const owuiPath = await owuiDownload.path();
		if (!owuiPath) throw new Error('download event fired but Playwright kept no local copy');
		expect(
			readFileSync(owuiPath, 'utf8'),
			'the Open WebUI file is missing the sealed chat'
		).toContain(canary);
	}
);

test(
	'a shared sealed chat opens at its link after the disclosure, and the stored row stays sealed',
	{ tag: ['@preview-only'] },
	async ({ page, context, browser, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			'share-links': true,
			'agent-mode': false
		});
		const canary = `canary-osprey-${Date.now().toString(36)}`;
		const id = await signedInWithSealedChat(page, canary);

		await chooseFromRowMenu(page, id, 'Share chat');
		const dialog = page.getByTestId('share-conversation-dialog');
		await expect(
			dialog.getByTestId('share-sealed-disclosure'),
			'sharing a sealed chat said nothing about the readable copy'
		).toContainText('readable copy', { timeout: 15_000 });
		await dialog.getByRole('button', { name: 'Create link' }).click();
		const field = dialog.getByTestId('share-link-url');
		await expect(field).toHaveValue(/\/r\/[A-Za-z0-9_-]{24}$/, { timeout: 20_000 });
		const url = await field.inputValue();
		await page.keyboard.press('Escape');

		// A stranger in a fresh, signed-out browser reads the chat at the link.
		const stranger = await browser.newContext({ baseURL });
		try {
			await setFlagOverrides(stranger, baseURL!, { 'share-links': true });
			const reader = await stranger.newPage();
			const response = await reader.goto(url, { waitUntil: 'load' });
			expect(response?.status()).toBe(200);
			await expect(
				reader.getByText(canary).first(),
				'the link does not show the sealed chat'
			).toBeVisible({
				timeout: 20_000
			});
		} finally {
			await stranger.close();
		}

		await expectSealed(id, canary);
	}
);
