// e2e-product: @chat
// e2e-area: @history
// Read-only share links, journey C1 steps 9 and 10. A signed-in person shares a chat from
// its Conversation actions, a stranger opens the link in a fresh, signed-out browser and reads it, and
// once the owner stops sharing from Data & privacy the link answers 404. The second test does the same
// with Forget everything in place of Stop sharing.
//
// The flag is forced the documented way (`setFlagOverrides`) on both browsers: the owner's to offer the
// menu row, and the reader's because a signed-out viewer reads the deployment snapshot of
// `share-links`, which is off on preview until the sequence turns it on.
import { test, expect, type Browser, type Page } from './helpers/test';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { turnDone } from './helpers/turn';
import { installCannedReplies, installFaultInjectionHeader } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';
import { holdForRecording } from './helpers/recording';
import { chooseFromRowMenu } from './helpers/sideRail';

test.use({ viewport: { width: 1280, height: 800 } });

/** Sends one turn and waits for the answer, so the snapshot has a question and an answer to show.
 *  `htmlPage` answers with one HTML page in a code block (`html_page_reply`) instead of the canned reply. */
async function chatWithOneTurn(page: Page, prompt: string, htmlPage = false): Promise<string> {
	if (htmlPage) await installFaultInjectionHeader(page, 'html_page_reply');
	else await installCannedReplies(page);
	await page.goto(chatEntry(), { waitUntil: 'load' });
	await composerHydrated(page);
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(prompt);
	const id = await sendOpensConversation(page);
	await expect(
		turnDone(page.locator('[data-message-role="assistant"]').last()),
		'the turn never finished, so there is nothing to share'
	).toBeVisible({ timeout: 120_000 });
	return id;
}

/** Shares the chat from the side rail's Conversation actions and returns the link the dialog shows. */
async function shareFromMenu(page: Page, id: string): Promise<string> {
	await chooseFromRowMenu(page, id, 'Share chat');
	const dialog = page.getByTestId('share-conversation-dialog');
	await expect(dialog).toContainText('without signing in');
	await dialog.getByRole('button', { name: 'Create link' }).click();
	const field = dialog.getByTestId('share-link-url');
	await expect(field).toHaveValue(/\/r\/[A-Za-z0-9_-]{24}$/, { timeout: 15_000 });
	const url = await field.inputValue();
	await holdForRecording(page);
	await page.keyboard.press('Escape');
	return url;
}

/** A fresh, signed-out browser context with the flag forced, as a stranger handed the link. */
async function strangerOpening(browser: Browser, baseURL: string, url: string, locale?: string) {
	const context = await browser.newContext({ baseURL, ...(locale ? { locale } : {}) });
	await setFlagOverrides(context, baseURL, { 'share-links': true });
	const page = await context.newPage();
	const response = await page.goto(url, { waitUntil: 'load' });
	return { context, page, status: response?.status() };
}

test(
	'a shared chat opens signed out in a fresh browser, and after Stop sharing the link is gone',
	{ tag: ['@preview-only', '@C1'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'share-links': true });
		await signInAsFreshUser(page);
		const prompt = `Share-link check ${Date.now()}: name one glacier in the Alps`;
		const id = await chatWithOneTurn(page, prompt);
		// A link is listed under the chat's title at the moment it was shared. A canned-reply run titles
		// the chat with the prompt's first words; a run with canned replies off (the gallery) lets a model
		// name it, so name it here and the list has one title to look for either way.
		const title = prompt.split(':')[0];
		const renamed = await page.request.patch(chatPath(`/api/v2/conversations/${id}`), {
			data: { title }
		});
		expect(renamed.ok(), `PATCH conversation answered ${renamed.status()}`).toBe(true);

		const url = await journeyStep(page, 'C1', 9, () => shareFromMenu(page, id));

		const reader = await strangerOpening(browser, baseURL!, url);
		try {
			expect(reader.status, 'the link did not open for a signed-out reader').toBe(200);
			const shared = reader.page.getByTestId('shared-chat');
			await expect(
				shared.locator('[data-from="user"]').getByText(prompt),
				'the shared chat does not show the question'
			).toBeVisible({
				timeout: 20_000
			});
			await expect(shared.locator('[data-from="assistant"]')).toHaveCount(1);
			await expect(reader.page.getByTestId('shared-chat-notice')).toContainText('read-only');
			await expect(reader.page.locator('meta[name="robots"]')).toHaveAttribute(
				'content',
				/noindex/
			);
			// The reader is a stranger: the owner's rail is not theirs to see.
			await expect(reader.page.locator(`a[href$="/conversation/${id}"]`)).toHaveCount(0);
			await holdForRecording(reader.page);

			await journeyStep(page, 'C1', 10, async () => {
				await page.goto(chatPath('/settings/data'), { waitUntil: 'load' });
				const list = page.getByTestId('shared-links');
				await expect(list.getByRole('link', { name: title })).toBeVisible({
					timeout: 20_000
				});
				await holdForRecording(page);
				await list.getByRole('button', { name: /^Stop sharing/ }).click();
				await expect(list.getByText("You haven't shared any chats.")).toBeVisible({
					timeout: 15_000
				});
			});

			const again = await reader.page.reload({ waitUntil: 'load' });
			expect(again?.status(), 'the revoked link still opens').toBe(404);
			await expect(reader.page.getByText(prompt)).toHaveCount(0);
		} finally {
			await reader.context.close();
		}
	}
);

test(
	'a stranger whose browser is in French is told in French that an AI model wrote the answers',
	{ tag: ['@preview-only', '@C1'] },
	async ({ page, context, browser, baseURL }) => {
		// EU AI Act Art. 50: the disclosure is made at first interaction, and opening a shared link is a
		// stranger's first interaction with Alpha. A notice in a language they may not read discloses
		// nothing, so the read-only notice follows the browser's language like the rest of the chrome.
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'share-links': true });
		await signInAsFreshUser(page);
		const id = await chatWithOneTurn(
			page,
			`Share-link language check ${Date.now()}: name one lake`
		);
		const url = await shareFromMenu(page, id);

		const reader = await strangerOpening(browser, baseURL!, url, 'fr-FR');
		try {
			expect(reader.status, 'the link did not open for a signed-out reader').toBe(200);
			const notice = reader.page.getByTestId('shared-chat-notice');
			await expect(
				notice,
				'the read-only notice does not say in French that an AI wrote the answers'
			).toContainText(/un modèle d.IA, (?:et )?(?:non|pas) (?:par )?une personne/, {
				timeout: 20_000
			});
			await expect(notice).not.toContainText('an AI model, not a person');
		} finally {
			await reader.context.close();
		}
	}
);

test(
	'Forget everything leaves no live share link for the account',
	{ tag: ['@preview-only', '@C1'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'share-links': true });
		await signInAsFreshUser(page);
		const prompt = `Share-link wipe check ${Date.now()}: name one river in Spain`;
		const id = await chatWithOneTurn(page, prompt);
		const url = await shareFromMenu(page, id);

		const before = await strangerOpening(browser, baseURL!, url);
		try {
			expect(before.status, 'the link did not open before the wipe').toBe(200);
		} finally {
			await before.context.close();
		}

		await page.goto(chatPath('/settings/data'), { waitUntil: 'load' });
		await page.getByRole('button', { name: /^Forget everything/ }).click();
		await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 15_000
		});

		const after = await strangerOpening(browser, baseURL!, url);
		try {
			expect(after.status, 'a link survived Forget everything').toBe(404);
			await expect(after.page.getByText(prompt)).toHaveCount(0);
		} finally {
			await after.context.close();
		}
		const listed = await page.request.get(chatPath('/api/v2/shares'));
		expect(listed.ok()).toBe(true);
		expect(((await listed.json()) as { shares: unknown[] }).shares).toEqual([]);
	}
);

test(
	'with share-links off, a chat offers no Share chat row and the share routes answer 404',
	{ tag: ['@preview-only', '@C1'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'share-links': false });
		await signInAsFreshUser(page);
		// POST /conversation refuses a body with no model, so take the first one the deployment lists.
		const models = (await (await page.request.get(chatPath('/api/models'))).json()) as {
			id?: string;
			name?: string;
		}[];
		const created = await page.request.post(chatPath('/conversation'), {
			data: { model: models[0]?.id ?? models[0]?.name }
		});
		expect(created.ok(), `POST /conversation answered ${created.status()}`).toBe(true);
		const { conversationId: id } = (await created.json()) as { conversationId: string };
		await page.request.patch(chatPath(`/api/v2/conversations/${id}`), {
			data: { title: 'Not for sharing' }
		});

		await page.goto(chatEntry(), { waitUntil: 'load' });
		const row = page.locator(`a[href$="/conversation/${id}"]:visible`);
		await expect(row).toHaveText('Not for sharing', { timeout: 20_000 });
		await row.hover();
		await row.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
		await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Share chat' })).toHaveCount(0);
		await page.keyboard.press('Escape');

		const share = await page.request.post(chatPath(`/api/v2/conversations/${id}/share`), {
			data: {}
		});
		expect(share.status(), 'the share API answered with the flag off').toBe(404);

		await page.goto(chatPath('/settings/data'), { waitUntil: 'load' });
		await expect(page.getByRole('heading', { name: 'Forget everything' })).toBeVisible({
			timeout: 20_000
		});
		await expect(page.getByTestId('shared-links')).toHaveCount(0);

		const reader = await browser.newContext({ baseURL });
		try {
			await setFlagOverrides(reader, baseURL!, { 'share-links': false });
			const viewer = await reader.newPage();
			const response = await viewer.goto(chatPath('/r/AAAAAAAAAAAAAAAAAAAAAAAA'), {
				waitUntil: 'load'
			});
			expect(response?.status(), 'the viewer answered with the flag off').toBe(404);
		} finally {
			await reader.close();
		}
	}
);

test(
	"a shared chat's HTML page opens as code, and its script runs only once the reader picks Preview",
	{ tag: ['@preview-only'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'share-links': true });
		await signInAsFreshUser(page);
		const prompt = `Shared page check ${Date.now()}: make me a page with a Wave button`;
		const id = await chatWithOneTurn(page, prompt, true);
		const url = await shareFromMenu(page, id);

		// strangerOpening's context takes Playwright's default 1280x720 viewport: desktop width.
		const reader = await strangerOpening(browser, baseURL!, url);
		try {
			expect(reader.status, 'the link did not open for a signed-out reader').toBe(200);
			const shared = reader.page.getByTestId('shared-chat');
			await expect(
				shared.locator('pre code').filter({ hasText: '<!doctype html>' }),
				"the shared answer does not show the page's code"
			).toBeVisible({ timeout: 20_000 });
			await expect(
				reader.page.locator('iframe'),
				'the page was put in a frame before the reader asked for it'
			).toHaveCount(0);
			await expect(reader.page).not.toHaveTitle('script ran');
			await holdForRecording(reader.page);

			await shared.getByRole('button', { name: 'Preview HTML' }).click();
			const frameEl = reader.page.locator('iframe[title="HTML Preview"]');
			await expect(frameEl, 'Preview opened no frame').toBeVisible({ timeout: 15_000 });
			const frame = await (await frameEl.elementHandle())!.contentFrame();
			expect(frame, 'the preview frame has no document').not.toBeNull();
			await expect(frame!.getByRole('button', { name: 'Wave' })).toBeVisible({ timeout: 15_000 });
			await expect
				.poll(() => frame!.evaluate(() => document.title), {
					message: "the page's script did not run after Preview",
					timeout: 15_000
				})
				.toBe('script ran');
			await expect(reader.page).not.toHaveTitle('script ran');
		} finally {
			await reader.context.close();
		}
	}
);
