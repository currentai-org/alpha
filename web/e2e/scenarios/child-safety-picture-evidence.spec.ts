// e2e-product: @chat
// e2e-area: @storage
import sharp from 'sharp';
import postgres from 'postgres';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { failIfStorageThrottled } from './helpers/storageThrottle';
import { STORAGE_POLL_INTERVALS } from './helpers/storagePoll';
import { sslFor } from './helpers/db';

// A chat picture is stored in My files before its turn is screened. When a turn is declined for child
// safety, the decline moves the picture into the owner's quarantine folder, kept for review, and the
// sender can no longer list it, open it by its old URL or see it when the chat is reopened.
//
// The decline is forced with `input_screen_declines_child_picture`, whose guard says yes to the child
// sexual content rule on any picture; `@real-screen` keeps the preview's stub screen from replacing it.
// The picture is a plain blue square: no real abuse imagery is
// ever used. Red when the decline leaves the picture in My files, when its output URL still serves it,
// when the reopened chat shows it, or when the decline's safety_events row names no quarantine copy.

const PICTURE = 'blue-square.png';

function databaseUrl(): string {
	const url = process.env.SCENARIO_DATABASE_URL;
	if (!url)
		throw new Error('SCENARIO_DATABASE_URL is not set: global-setup.ts should have caught this');
	return url;
}

test(
	'a picture in a turn declined for child safety leaves My files, its old URL answers 404, the reopened chat shows it only by name, and the decline names its quarantine copy',
	{ tag: ['@preview-only', '@A6', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'input_screen_declines_child_picture');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const png = await sharp({
			create: { width: 256, height: 256, channels: 3, background: '#1040d0' }
		})
			.png()
			.toBuffer();
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		// The picture's reference is the sha over its text decoding, as the app's sha256 util takes it.
		const sha = await composer.evaluate(
			async (el, { b64, name }) => {
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const file = new File([bytes], name, { type: 'image/png' });
				const data = new DataTransfer();
				data.items.add(file);
				el.dispatchEvent(
					new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
				);
				const digest = await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode(await file.text())
				);
				return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
			},
			{ b64: png.toString('base64'), name: PICTURE }
		);
		await expect(
			page.getByAltText(PICTURE).or(page.getByText(PICTURE)).first(),
			'the pasted picture was not attached, so this run never stored one'
		).toBeVisible({ timeout: 10_000 });
		await composer.fill('What colour is this square?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
		const conversationId = new URL(page.url()).pathname.split('/').pop()!;

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 90_000 });
		await expect(
			answer.getByText('Child safety'),
			'the turn was not declined under Child safety: the fault never reached the input screen'
		).toBeVisible({ timeout: 15_000 });

		// The decline's row names the quarantine copy, written only after the copy was stored. This is
		// also the proof the picture reached storage, so the absences below are not vacuous.
		const sql = postgres(databaseUrl(), { ssl: sslFor(databaseUrl()), max: 1 });
		try {
			await expect(async () => {
				const rows = await sql<{ evidence: string[] | null }[]>`
					select evidence from safety_events
					where conversation_id = ${conversationId} and kind = 'child_safety'`;
				expect(rows, 'no child-safety decline was logged for this conversation').toHaveLength(1);
				expect(
					rows[0].evidence ?? [],
					'the decline names no quarantine copy, so the picture was not kept for review'
				).toEqual([expect.stringMatching(/^users\/[^/]+\/quarantine\/\d+-blue-square\.png$/)]);
			}).toPass({ timeout: 30_000 });
		} finally {
			await sql.end();
		}

		// Not in My files: the listing the storage page and the attach-from-My-files picker both read.
		await failIfStorageThrottled(page);
		await expect(async () => {
			const res = await page.request.get('/chat/api/storage');
			expect(res.status(), 'the storage list endpoint did not answer 200').toBe(200);
			const paths = ((await res.json()) as { files: { path: string }[] }).files.map((f) => f.path);
			expect(
				paths.filter((p) => p.includes(`/conversations/${conversationId}/`)),
				'the declined picture is still in My files'
			).toEqual([]);
		}).toPass({ timeout: 30_000, intervals: STORAGE_POLL_INTERVALS });

		// Its old URL no longer serves it to the person who sent it.
		const output = `/chat/conversation/${conversationId}/output/${sha}`;
		expect(
			(await page.request.get(output)).status(),
			'the declined picture still downloads from its old URL'
		).toBe(404);

		// Reopened, the sent message names the picture as not added and shows no image.
		await page.reload();
		const question = page.locator('[data-message-type="user"]').last();
		await expect(
			question.locator('[data-left-out-file]').filter({ hasText: PICTURE }),
			'the reopened chat does not show the declined picture as a left-out file'
		).toBeVisible({ timeout: 30_000 });
		await expect(
			question.getByAltText(PICTURE),
			'the reopened chat still shows the declined picture'
		).toHaveCount(0);
	}
);
