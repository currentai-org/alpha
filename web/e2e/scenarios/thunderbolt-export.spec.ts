// e2e-product: @chat
// e2e-area: @settings
import { test, expect } from './helpers/test';
import { readFileSync } from 'node:fs';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { chatEntry } from './helpers/chatEntry';
import { installCannedReplies } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// The account page offers the same conversations as a file Thunderbird's Thunderbolt imports
// (Settings → Preferences → Data → Import Data) (CUR-2407). Thunderbolt's importer refuses a file whose `format`
// or `schemaVersion` differs, writes rows by id, renders a message from `parts`, and orders a thread by
// its UUIDv7 ids, so those are what this checks on the file a person actually downloads.

test(
	'the Thunderbolt row is absent and its route 404s while the thunderbolt-export flag is off',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'data-export': true, 'thunderbolt-export': false });
		await signInAsFreshUser(page);

		expect((await page.request.get('/chat/api/v2/export/thunderbolt')).status()).toBe(404);
		await page.goto('/chat/settings/account', { waitUntil: 'commit' });
		await expect(
			page.getByRole('link', {
				name: 'Download a ZIP of your conversations, files, and where each answer came from'
			}),
			'the ZIP row is on, so the page has finished rendering the data section'
		).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByRole('link', {
				name: 'Download your conversations as a file Thunderbolt can import'
			})
		).toHaveCount(0);
	}
);

test(
	'the account page downloads a conversation as a thunderbolt-export file Thunderbolt can import',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'data-export': true,
			'thunderbolt-export': true,
			// The router sends some prompts to the agent; this test is about the download (CUR-2343).
			'agent-mode': false
		});
		await signInAsFreshUser(page);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);
		await welcomeDialog
			.getByRole('button', { name: /start chatting/i })
			.click({ timeout: 8_000 })
			.catch(() => {});
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		const prompt = 'Suggest a name for a walking club in one short sentence.';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(prompt);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		// The file is built from what is stored, so the answer has to be finished first.
		await expect(
			page.locator('[data-message-role="assistant"]').last().getByRole('button', { name: 'Retry' })
		).toBeVisible({ timeout: 150_000 });

		await page.goto('/chat/settings/account', { waitUntil: 'commit' });
		const row = page.getByRole('link', {
			name: 'Download your conversations as a file Thunderbolt can import'
		});
		await expect(row, 'thunderbolt-export is forced on, so the row must be offered').toBeVisible({
			timeout: 15_000
		});
		await expect(row).toContainText('Nothing is sent to Thunderbolt until you import it there.');

		const [download] = await Promise.all([page.waitForEvent('download'), row.click()]);
		expect(download.suggestedFilename()).toMatch(/^thunderbolt-export-\d{4}-\d{2}-\d{2}\.json$/);
		const downloadPath = await download.path();
		if (!downloadPath) throw new Error('download event fired but Playwright kept no local copy');
		const file = JSON.parse(readFileSync(downloadPath, 'utf8'));
		// A second click inside the ten-minute window would bounce back here, so the row says when instead.
		await expect(page.getByTestId('thunderbolt-row-locked')).toContainText(
			'You can download again after'
		);

		expect(file).toMatchObject({ format: 'thunderbolt-export', schemaVersion: 1 });
		expect(file.user.id, 'our account id stays out of the file, as it does in the ZIP').toBe('');
		const { chat_threads: threads, chat_messages: messages } = file.tables;
		expect(threads).toHaveLength(1);
		const uuidv7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(threads[0].id).toMatch(uuidv7);

		const live = messages.filter((m: { deletedAt: string | null }) => m.deletedAt === null);
		expect(live.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
		for (const m of live) {
			expect(m.id).toMatch(uuidv7);
			expect(m.chatThreadId).toBe(threads[0].id);
		}
		// Thunderbolt shows a thread in id order, so the question's id must sort before its answer's.
		expect(live[0].id < live[1].id).toBe(true);
		expect(live[1].parentId).toBe(live[0].id);
		// Thunderbolt renders from parts, never from content.
		expect(live[0].parts).toEqual([{ type: 'text', text: prompt }]);
		expect(live[1].parts[0].type).toBe('text');
		expect(live[1].parts[0].text.length).toBeGreaterThan(0);
		expect(live[1].metadata.alpha.aiGenerated).toBe(true);
	}
);
