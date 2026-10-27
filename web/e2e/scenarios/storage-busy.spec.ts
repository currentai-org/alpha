// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { installFaultInjectionHeader, installPageFaultHeader } from './helpers/faultInjection';
import { chatEntry } from './helpers/chatEntry';
import { STORAGE_POLL_INTERVALS } from './helpers/storagePoll';

// Hugging Face caps our one storage token at 3,000 Hub calls per 5 minutes, and when it
// throttles us the storage route used to answer 500 (CUR-3120). The `storage_hub_rate_limited` fault answers an
// upload the way Hugging Face does, through the real route, so this reads what a person sees: the
// busy line, a row that still offers Try again, and a retry that stores the file once it clears.

const STORAGE_POST = /\/chat\/api\/storage$/;

/** The status the storage endpoint answered for one text file set on the page's file input. Retried
 *  until the upload is actually sent, since a file set before hydration is silently dropped. */
async function uploadText(page: Page, name: string): Promise<number> {
	let status = 0;
	await expect(async () => {
		const uploaded = page.waitForResponse(
			(r) => r.request().method() === 'POST' && STORAGE_POST.test(new URL(r.url()).pathname),
			{ timeout: 10_000 }
		);
		await page
			.locator('input[type=file]')
			.first()
			.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('notes for later\n') });
		status = (await uploaded).status();
	}).toPass({ timeout: 45_000, intervals: STORAGE_POLL_INTERVALS });
	return status;
}

test(
	'when Hugging Face throttles storage, an upload says storage is busy and Try again stores it once it clears',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const fault = await installFaultInjectionHeader(page, 'storage_hub_rate_limited', STORAGE_POST);

		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});

		const name = 'meeting-notes.txt';
		try {
			const status = await uploadText(page, name);
			expect(status, `a throttled upload answered ${status}, not the busy 503`).toBe(503);
			await expect(page.getByText('Storage is busy right now. Try again in a minute.')).toBeVisible(
				{
					timeout: 15_000
				}
			);
			const retry = page.getByRole('button', { name: 'Try again' });
			await expect(retry, 'a busy refusal must stay retryable').toBeVisible();

			fault.disarm();
			const retried = page.waitForResponse(
				(r) => r.request().method() === 'POST' && STORAGE_POST.test(new URL(r.url()).pathname)
			);
			await retry.click();
			expect(
				(await retried).status(),
				'Try again after the limit cleared did not store the file'
			).toBe(201);
			await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
				timeout: 15_000
			});
		} finally {
			const res = await page.request.get('/chat/api/storage').catch(() => null);
			const files = res?.ok() ? ((await res.json()) as { files: { path: string }[] }).files : [];
			for (const f of files) {
				await page.request.delete(`/chat/api/storage/file?path=${encodeURIComponent(f.path)}`);
			}
		}
	}
);

// Deleting one chat lists its bucket folder first, and a throttled listing used to end the
// DELETE in a 500 with a generic "Couldn't delete" toast (CUR-3666). Under the same fault the rail now says
// storage is busy, the chat stays, and the same Delete works once the limit clears.
const CHAT_DELETE = /\/api\/v2\/conversations\/[a-f0-9]{24}$/;

test(
	'when Hugging Face throttles storage, deleting a chat says storage is busy, keeps it, and a retry deletes it',
	{ tag: ['@preview-only', '@A3', '@CUR-3666'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const created = await page.request.post('/chat/conversation', {
			data: { model: models[0]?.id ?? models[0]?.name }
		});
		expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
		const { conversationId: id } = (await created.json()) as { conversationId: string };
		const title = 'Allotment watering rota';
		const titled = await page.request.patch(`/chat/api/v2/conversations/${id}`, {
			data: { title }
		});
		expect(titled.ok(), `PATCH title answered ${titled.status()}`).toBe(true);

		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		const fault = await installFaultInjectionHeader(
			page,
			'storage_hub_rate_limited',
			CHAT_DELETE,
			'DELETE'
		);
		await page.goto(chatEntry(), { waitUntil: 'load' });
		const link = page.locator(`a[href$="/conversation/${id}"]:visible`);
		await expect(link).toHaveText(title, { timeout: 20_000 });

		const deleteFromRail = async () => {
			await link.hover();
			await link.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
			await page.getByRole('menuitem', { name: 'Delete' }).click();
			const confirm = page.getByRole('dialog').filter({ hasText: 'Delete conversation' });
			const answered = page.waitForResponse(
				(r) => r.request().method() === 'DELETE' && CHAT_DELETE.test(new URL(r.url()).pathname)
			);
			await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
			return (await answered).status();
		};

		expect(await deleteFromRail(), 'a throttled delete did not answer the busy 503').toBe(503);
		await expect(page.getByTestId('chat-error-toast')).toHaveText(
			"Storage is busy right now, so this chat wasn't deleted. Try again in a minute."
		);
		await expect(link, 'a delete that failed took the chat off the rail').toHaveText(title);

		fault.disarm();
		expect(await deleteFromRail(), 'Delete after the limit cleared did not delete the chat').toBe(
			200
		);
		await expect(link).toHaveCount(0, { timeout: 10_000 });
	}
);

// The My files page lists the bucket while it renders, and a throttled listing used to read
// as "The list didn't load" (CUR-3680). Under the fault the page names the throttle and keeps Try again, and the
// same button loads the list once the page's own request no longer carries the fault.
test(
	'when Hugging Face throttles storage, My files says storage is busy and Try again loads the list',
	{ tag: ['@preview-only', '@A3', '@CUR-3680'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		await installPageFaultHeader(page, 'storage_hub_rate_limited', '/chat/storage');

		await page.goto('/chat/storage', { waitUntil: 'load' });
		const unavailable = page.getByRole('heading', {
			name: "Alpha can't show your files right now"
		});
		await expect(unavailable).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByText(/^Storage is busy right now\. Try again in a minute\./)
		).toBeVisible();

		// Try again lists through /chat/api/storage, which the page-navigation fault does not reach.
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(unavailable, 'Try again did not load the list once storage answered').toBeHidden({
			timeout: 20_000
		});
	}
);

// Forget everything deletes the person's files first, and a throttled delete used to answer
// "try again" with no word on why, so an immediate retry failed for minutes (CUR-3680). It now says storage is
// busy, clears nothing, and the same Try again clears everything once the limit lifts.
const WIPE = /\/chat\/api\/v2\/conversations$/;

test(
	'when Hugging Face throttles storage, Forget everything says storage is busy, clears nothing, and Try again clears it',
	{ tag: ['@preview-only', '@A3', '@CUR-3680'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const created = await page.request.post('/chat/conversation', {
			data: { model: models[0]?.id ?? models[0]?.name }
		});
		expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
		const { conversationId: id } = (await created.json()) as { conversationId: string };

		const fault = await installFaultInjectionHeader(
			page,
			'storage_hub_rate_limited',
			WIPE,
			'DELETE'
		);
		await page.goto('/chat/settings/data', { waitUntil: 'load' });
		await page.getByRole('button', { name: /^Forget everything/ }).click();
		await expect(page.getByRole('heading', { name: 'Forget everything?' })).toBeVisible({
			timeout: 10_000
		});
		const wiped = () =>
			page.waitForResponse(
				(r) => r.request().method() === 'DELETE' && WIPE.test(new URL(r.url()).pathname)
			);
		const busy = wiped();
		await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
		expect((await busy).status(), 'a throttled wipe did not answer the busy 503').toBe(503);
		await expect(
			page.getByText(
				'Storage is busy right now, so nothing was cleared. Try again in a few minutes.'
			)
		).toBeVisible({ timeout: 10_000 });
		const kept = await page.request.get(`/chat/api/v2/conversations/${id}`);
		expect(kept.status(), 'a refused wipe still deleted the chat').toBe(200);

		fault.disarm();
		const cleared = wiped();
		await page.getByRole('button', { name: 'Try again' }).click();
		expect((await cleared).status(), 'Try again after the limit cleared did not wipe').toBe(200);
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 15_000
		});
	}
);
