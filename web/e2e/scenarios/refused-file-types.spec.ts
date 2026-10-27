// e2e-product: @chat
// e2e-area: @turn
// The server stored any file type a request sent (CUR-3832). The composer offers images, text, PDF and
// Word only, but a script posting a 7z went straight to storage, and nothing scanned it, because the
// picture check has no way into an archive it does not open. This spec forces the production guest
// flags on the preview, starts a real chat signed in (guests cannot attach files at all, so a guest's
// turn with a file is refused before its type is read: guest-uploads.spec.ts), then posts that
// conversation a turn with a 7z the way a script would. The turn must still be answered, and the answer must carry the line a person
// would read about the file.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { signInAsFreshUser } from './helpers/session';

const REFUSED_LINE = "This kind of file can't be added here, so it wasn't added.";
// The six-byte 7z signature and a header's worth of zeros: enough for the server to sniff it as 7z.
const SEVEN_ZIP = Buffer.from('377abcaf271c000400000000000000000000000000000000', 'hex');

test.beforeEach(async ({ context, baseURL }) => {
	// www's guest profile (pnpm flags:matrix): photos on for anonymous visitors.
	await setFlagOverrides(context, baseURL!, {
		multimodal: true,
		'custodial-storage-view': true,
		'attachment-allowance': false
	});
});

test(
	'a signed-in turn carrying a 7z is answered, the archive is not stored, and the answer says why',
	{ tag: ['@preview-only', '@CUR-3832'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What can you help me with?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const convPath = new URL(page.url()).pathname;
		const answers = page.locator('[data-message-role="assistant"]');
		// A turn sent while the first is still saving is refused on its own account (CUR-2667).
		await expect(turnDone(answers.last())).toBeVisible({ timeout: 60_000 });

		// The turn names its parent, as the page's own send does; with none the route cannot place it
		// in the conversation and answers 500. A stale id is re-pointed to the newest message.
		const parent = await answers.last().getAttribute('data-message-id');
		expect(parent, 'the first answer carries no message id to reply under').toBeTruthy();

		const form = new FormData();
		form.set('data', JSON.stringify({ id: parent, inputs: 'What is in the attached file?' }));
		form.append(
			'files',
			new File([SEVEN_ZIP.toString('base64')], 'base64;archive.7z', {
				type: 'application/x-7z-compressed'
			})
		);
		const response = await page.request.post(convPath, {
			multipart: form,
			// The chat's CSRF hook checks Origin; send the page's own, as its fetch would.
			headers: { origin: new URL(page.url()).origin }
		});
		expect(response.status(), 'a turn with a 7z was refused outright, not answered').toBe(200);

		await page.reload();
		await expect(answers).toHaveCount(2, { timeout: 30_000 });
		await expect(turnDone(answers.last())).toBeVisible({ timeout: 30_000 });
		await expect(
			answers.last().getByText(REFUSED_LINE),
			'the answer to a turn with a 7z did not say the file was not added'
		).toBeVisible();
		// The sent message keeps the 7z's name as a "Not added" chip, and only there (CUR-3405); it is
		// never shown, or stored, as an attachment.
		const sent = page.locator('[data-message-type="user"]').last();
		await expect(
			sent.locator('[data-left-out-file]'),
			'the sent message does not mark the 7z as not added'
		).toContainText('archive.7z');
		await expect(page.getByText('archive.7z'), 'the 7z was kept on the conversation').toHaveCount(
			1
		);
	}
);
