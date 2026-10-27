// e2e-product: @chat
// e2e-area: @composer
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { plusButton } from './helpers/composerMenu';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// Guests cannot attach files . Where sign-in is offered, every way of attaching asks a
// guest to sign in instead: Attach files in the + menu leads to sign-in, and a file dropped or pasted
// is not attached and the composer says to sign in. The server refuses a guest's file too
// (parseRequest.spec.ts). Production's guest flags are forced on, so the ask is what stands between a
// guest and a file, not a shut flag. A fresh browser context is a guest.

test.beforeEach(async ({ context, baseURL }) => {
	await setFlagOverrides(context, baseURL!, {
		multimodal: true,
		'document-attachments': true,
		'agent-mode': false
	});
});

async function openAsGuest(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

test(
	"a guest's Attach files asks them to sign in and leads to sign-in, with no file picker behind it",
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(60_000);
		await openAsGuest(page);
		await expect(
			page.getByLabel('Upload file'),
			'a guest had a file picker behind the menu, so a file could still be chosen'
		).toHaveCount(0);

		await plusButton(page).click();
		const row = page.getByRole('menuitem', { name: /^Attach files/ });
		await expect(row, 'the + menu offered a guest nothing to attach with').toBeVisible({
			timeout: 10_000
		});
		await expect(row, 'the row did not tell the guest to sign in').toContainText(
			'Sign in to attach files.'
		);
		await row.click();
		await expect(page, 'choosing Attach files as a guest did not lead to sign-in').toHaveURL(
			/\/login\?next=%2Fchat/,
			{ timeout: 15_000 }
		);
	}
);

test(
	'a file a guest drops or pastes is not attached, and the composer asks them to sign in',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(60_000);
		const composer = await openAsGuest(page);
		const notice = page.getByTestId('attachment-refusal');

		const dataTransfer = await page.evaluateHandle(() => {
			const dt = new DataTransfer();
			dt.items.add(
				new File(['Saturday: bake the bread\n'], 'guest-rota.txt', { type: 'text/plain' })
			);
			return dt;
		});
		const conversation = page.getByRole('main', { name: 'Chat', exact: true });
		await conversation.dispatchEvent('dragenter', { dataTransfer });
		await expect(
			page.getByText('Drop files to attach'),
			'dragging a file showed a guest no drop target, so a drop would vanish without a word'
		).toBeVisible({ timeout: 10_000 });
		await conversation.dispatchEvent('drop', { dataTransfer });
		await expect(notice, 'a guest drop was not answered with the sign-in ask').toContainText(
			'Sign in to attach files.',
			{ timeout: 10_000 }
		);
		await expect(notice.getByRole('button', { name: 'Sign in' })).toBeVisible();
		await expect(page.getByText('guest-rota.txt'), 'a guest drop was attached').toHaveCount(0);

		await notice.getByRole('button', { name: 'Dismiss' }).click();
		await expect(notice).toHaveCount(0);
		await composer.evaluate((el) => {
			const data = new DataTransfer();
			data.items.add(new File(['meeting notes'], 'guest-notes.txt', { type: 'text/plain' }));
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		});
		await expect(
			notice,
			'a guest paste of a file was not answered with the sign-in ask'
		).toContainText('Sign in to attach files.', { timeout: 10_000 });
		await expect(page.getByText('guest-notes.txt'), 'a guest paste was attached').toHaveCount(0);

		await notice.getByRole('button', { name: 'Sign in' }).click();
		await expect(page, 'Sign in on the notice did not lead to sign-in').toHaveURL(
			/\/login\?next=/,
			{
				timeout: 15_000
			}
		);
	}
);

// The composer's ask is the visible half (CUR-3997); the server holds the line for a request that
// skips the composer. A guest starts a chat, then posts that conversation a turn with a text file
// the way a script would. The same guest's long paste is typed text, not an attachment (CUR-1895),
// so it still sends with attachments on.
test(
	"a guest's crafted send with a file is refused 403 and asked to sign in, while a guest's long paste still sends",
	{ tag: ['@preview-only', '@A6', '@CUR-3997'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const composer = await openAsGuest(page);
		await installCannedReplies(page);
		const assistant = page.locator('[data-message-role="assistant"]');

		const filler = 'This paragraph is office filler about the quarterly supply order. '.repeat(70);
		expect(filler.length).toBeGreaterThan(4000);
		await composer.evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, filler);
		await expect(
			page.getByText('Pasted Content').first(),
			'the long paste did not turn into a chip, so this test is not exercising the paste path'
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByTestId('attachment-refusal'),
			"a guest's long paste was refused as if it were a file"
		).toHaveCount(0);
		await composer.fill('Summarise the pasted text in one line.');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expect(
			turnDone(assistant.last()),
			"a guest's long paste was not answered, so the sign-in gate caught typed text"
		).toBeVisible({ timeout: 60_000 });

		const convPath = new URL(page.url()).pathname;
		const form = new FormData();
		form.set('data', JSON.stringify({ inputs: 'what does this file say?' }));
		form.append(
			'files',
			new File(
				[Buffer.from('Saturday: bake the bread\n').toString('base64')],
				'base64;guest-rota.txt',
				{
					type: 'text/plain'
				}
			)
		);
		const response = await page.request.post(convPath, {
			multipart: form,
			// The chat's CSRF hook checks Origin; send the page's own, as its fetch would.
			headers: { origin: new URL(page.url()).origin }
		});
		expect(
			response.status(),
			"a guest's crafted send with a file was not refused for sign-in"
		).toBe(403);
		expect(await response.text()).toContain('Sign in to attach files.');
	}
);
