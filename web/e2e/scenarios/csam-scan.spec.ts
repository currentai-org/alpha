// e2e-product: @chat
// e2e-area: @composer @storage
import { test, expect, type Page } from './helpers/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { holdForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import { STORAGE_POLL_INTERVALS } from './helpers/storagePoll';
import { failIfStorageThrottled } from './helpers/storageThrottle';
import { startChattingPastWelcome } from './helpers/welcome';

// The abuse-match refusal names no reason on purpose, only the next step (CUR-3086).
const ABUSE_REFUSAL =
	"This file couldn't be added, so it was taken off. You can send your message without it.";

// My files' known-CSAM check, walked on a live preview against the placeholder bank
// deployed on Fly (web/hma/fly/). test-bank-match.png is the one image that bank holds; test-bank-
// clean.png is an unrelated image PDQ does not match. Neither is abuse material: the bank is a
// placeholder until the real one arrives (CUR-713).
//
// Three outcomes, each read from the screen and from the account's own listing:
//   - a clean image uploads and is listed,
//   - the bank's image is refused with a no-retry line and never listed (it goes to quarantine),
//   - with the scanner down, an image is refused with the try-again line and nothing is stored.
// Chat runs the same check on a turn's images (parseRequest.ts), so the last two tests send a photo in
// chat: the bank's image refuses the whole turn, and with the scanner down the photo is dropped with
// the try-again line while the text is still answered. The scanner-down tests use the `csam_scanner_down` fault, because a live preview's scanner cannot be pointed
// at nothing from a spec.

const FIXTURES = fileURLToPath(new URL('../../hma/fly/', import.meta.url));
const CLEAN = readFileSync(`${FIXTURES}test-bank-clean.png`);
const MATCH = readFileSync(`${FIXTURES}test-bank-match.png`);

/** The status the storage endpoint answered for one image set on the page's file input, and its
 *  `Retry-After`. Retried until the upload request is actually sent, since a file set before hydration
 *  is silently dropped. */
async function uploadImage(
	page: Page,
	name: string,
	buffer: Buffer
): Promise<{ status: number; retryAfter: string | null }> {
	let status = 0;
	let retryAfter: string | null = null;
	await failIfStorageThrottled(page);
	await expect(async () => {
		const uploaded = page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/chat/api/storage'),
			{ timeout: 10_000 }
		);
		await page
			.locator('input[type=file]')
			.first()
			.setInputFiles({ name, mimeType: 'image/png', buffer });
		const res = await uploaded;
		status = res.status();
		retryAfter = res.headers()['retry-after'] ?? null;
	}).toPass({ timeout: 45_000, intervals: STORAGE_POLL_INTERVALS });
	return { status, retryAfter };
}

/** Why a clean image got a status other than 201. Two different 503s reach here: the scanner being
 *  unreachable, and Hugging Face throttling preview's shared storage token, which `storageFailure`
 *  answers with `Retry-After` (CUR-3120). The second says nothing about the scanner or the PR. */
function cleanUploadFailure({ status, retryAfter }: { status: number; retryAfter: string | null }) {
	if (status === 503 && retryAfter !== null)
		return `a clean image answered 503 with Retry-After ${retryAfter}: Hugging Face throttled preview's storage token (CUR-3189), not the scanner. Rerun once the throttle window has passed`;
	if (status === 503)
		return 'a clean image answered 503 with no Retry-After, so the deployment has no reachable scanner and every upload is refused';
	return `a clean image answered ${status}`;
}

async function listedNames(page: Page): Promise<string[]> {
	const res = await page.request.get('/chat/api/storage');
	expect(res.status(), 'the storage list endpoint did not answer 200').toBe(200);
	return ((await res.json()) as { files: { path: string }[] }).files.map(
		(f) => f.path.split('/').pop() ?? ''
	);
}

async function openStorage(
	page: Page,
	context: import('@playwright/test').BrowserContext,
	baseURL: string
) {
	await setFlagOverrides(context, baseURL, {
		'custodial-storage-view': true
	});
	await signInAsFreshUser(page);
	await page.goto('/chat/storage', { waitUntil: 'commit' });
	await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
		timeout: 30_000
	});
}

test(
	'a clean image is stored, and the hash bank image is refused and never listed',
	{ tag: ['@preview-only', '@A6', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await openStorage(page, context, baseURL!);

		try {
			const clean = await uploadImage(page, 'garden.png', CLEAN);
			expect(clean.status, cleanUploadFailure(clean)).toBe(201);
			expect(await listedNames(page)).toContain('garden.png');

			// A3 row 15: a file Alpha can't store is refused in plain words and never reaches My files.
			// The row shows the server's own reason for a 422 (CUR-4662), which for a hash match is
			// guard.ts's neutral line and never names the check that matched.
			await journeyStep(page, 'A3', 15, async () => {
				const { status: matchStatus } = await uploadImage(page, 'holiday.png', MATCH);
				expect(
					matchStatus,
					`the hash bank's own image answered ${matchStatus}, so the known-CSAM check did not match it`
				).toBe(422);
				await expect(page.getByText('This file could not be uploaded.')).toBeVisible({
					timeout: 15_000
				});
				// The same file would be refused again, so the row offers Remove and never Try again (CUR-2450).
				await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
				await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
				expect(
					await listedNames(page),
					"a matched image is listed, so it reached the person's files rather than quarantine"
				).not.toContain('holiday.png');
			});
		} finally {
			// The clean image is a real file in the bucket; the fresh account is removed by the e2e cleanup.
			const res = await page.request.get('/chat/api/storage').catch(() => null);
			const files = res?.ok() ? ((await res.json()) as { files: { path: string }[] }).files : [];
			for (const f of files) {
				await page.request.delete(`/chat/api/storage/file?path=${encodeURIComponent(f.path)}`);
			}
		}
	}
);

test(
	'CUR-3591: with the scanner down, My files refuses an image in the same words as chat and stores nothing',
	{ tag: ['@preview-only', '@A6', '@A3', '@CUR-3591'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const token = process.env.E2E_FAULT_INJECT_TOKEN;
		if (!token)
			throw new Error('E2E_FAULT_INJECT_TOKEN is not set, so the scanner-down fault cannot fire');
		await openStorage(page, context, baseURL!);

		await page.route(
			(url) => url.pathname.endsWith('/chat/api/storage'),
			(route) =>
				route.request().method() === 'POST'
					? route.continue({
							headers: {
								...route.request().headers(),
								'x-e2e-fault-inject-token': token,
								'x-e2e-fault-inject': 'csam_scanner_down'
							}
						})
					: route.continue()
		);

		// A3 row 16: with the scanner down, nothing unscanned is stored and the row offers a retry.
		await journeyStep(page, 'A3', 16, async () => {
			const { status } = await uploadImage(page, 'garden.png', CLEAN);
			expect(
				status,
				`with the scanner down an image answered ${status}, so it was not refused`
			).toBe(503);
			// Chat says this same line for the same outage (csamScan.ts's UPLOAD_NOT_SCANNED_MESSAGE).
			await expect(
				page.getByText(
					"We couldn't check this file just now, so it wasn't added. Please try again in a minute."
				)
			).toBeVisible({ timeout: 15_000 });
			// A scanner outage passes, so this row keeps its retry.
			await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
			expect(await listedNames(page), 'an unscanned image was stored').not.toContain('garden.png');
		});
	}
);

const CONVERSATION_POST = /\/chat\/conversation\/[a-f0-9]+$/;

/** A signed-in team account on an empty chat, with a photo pasted into the composer and its chip shown. */
async function pastePhotoInChat(page: Page, name: string, buffer: Buffer) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// `multimodal` is team-only on preview, and signInAsFreshUser mints an @example.org team account.
	await signInAsFreshUser(page);
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.evaluate(
		(el, { name, b64 }) => {
			const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const data = new DataTransfer();
			data.items.add(new File([raw], name, { type: 'image/png' }));
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		},
		{ name, b64: buffer.toString('base64') }
	);
	await expect(
		page.getByAltText(name).or(page.getByText(name)).first(),
		'the photo was not attached in chat, so no screening could be exercised'
	).toBeVisible({ timeout: 10_000 });
	return composer;
}

test(
	"in chat, the hash bank's image refuses the whole turn, and the question stays in the composer",
	{ tag: ['@preview-only', '@A6', '@CUR-2382'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		// Chromium keeps no body for a streamed response, so the turn is fetched and fulfilled here to read
		// its refusal event. The client opts into prestream events, so the 422 arrives inside a 200 stream.
		let turnBody = '';
		await page.route(CONVERSATION_POST, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const response = await route.fetch();
			turnBody = await response.text();
			await route.fulfill({ response, body: turnBody });
		});
		const composer = await pastePhotoInChat(page, 'holiday.png', MATCH);
		await holdForRecording(page);

		const sent = page.waitForResponse(
			(r) => r.request().method() === 'POST' && CONVERSATION_POST.test(new URL(r.url()).pathname),
			{ timeout: 60_000 }
		);
		const question = 'What is in this picture?';
		// Row 9: a photo that matches the bank is refused, and the question survives it.
		await journeyStep(page, 'A6', 9, async () => {
			await composer.fill(question);
			await composer.press('Enter');
			await sent;
			// Poll the body the route captured rather than awaiting `response.finished()`: on a fulfilled
			// route that event can be missed, and it has no timeout of its own, so it can sit out
			// the whole test timeout with the refusal already on screen.
			await expect
				.poll(() => turnBody, {
					message: "the bank's image was not refused in chat",
					timeout: 30_000
				})
				.toMatch(/"statusCode":\s*422/);
			await expect(
				page.getByText(ABUSE_REFUSAL),
				'the refused turn showed no next step'
			).toBeVisible({ timeout: 15_000 });
			// A file left on the composer made a resend fail the same way.
			await expect(
				page.getByAltText('holiday.png').or(page.getByText('holiday.png')),
				'the refused photo stayed on the composer'
			).toHaveCount(0);
			await expect(
				page.locator('[data-message-role="assistant"]'),
				'a turn carrying a matched image was answered'
			).toHaveCount(0);
			await expect(composer, 'the refused question was lost instead of kept').toHaveValue(question);
		});
		await holdForRecording(page);
	}
);

test(
	'in chat with the scanner down, the photo is dropped with the try-again line and the text is still answered',
	{ tag: ['@preview-only', '@A6', '@CUR-2382'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const token = process.env.E2E_FAULT_INJECT_TOKEN;
		if (!token)
			throw new Error('E2E_FAULT_INJECT_TOKEN is not set, so the scanner-down fault cannot fire');
		await page.route(CONVERSATION_POST, (route) =>
			route.request().method() === 'POST'
				? route.continue({
						headers: {
							...route.request().headers(),
							'x-e2e-fault-inject-token': token,
							'x-e2e-fault-inject': 'csam_scanner_down'
						}
					})
				: route.continue()
		);
		const composer = await pastePhotoInChat(page, 'garden.png', CLEAN);
		// Row 9: the photo can't be checked, so it is dropped with a reason and the text answered.
		await journeyStep(page, 'A6', 9, async () => {
			await composer.fill('Reply with the single word: ready.');
			await composer.press('Enter');

			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(
				turnDone(answer),
				'no finished answer: with the scanner down the text should still be answered' +
					warmupContext()
			).toBeVisible({ timeout: 90_000 });
			await expect(answer, 'the text of the turn was not answered').toContainText(/ready/i);
			await expect(
				page.getByText("We couldn't check this file just now, so it wasn't added."),
				'the dropped photo was not explained with the try-again line'
			).toBeVisible({ timeout: 15_000 });
		});
		await holdForRecording(page);
	}
);
