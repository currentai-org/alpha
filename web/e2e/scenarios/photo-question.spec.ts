// e2e-product: @chat
// e2e-area: @composer
import sharp from 'sharp';
import { test, expect, type Page } from './helpers/test';
import { chatEntry, MEDIUM_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { turnDone } from './helpers/turn';
import { holdForRecording } from './helpers/recording';
import { signInAsFreshUser } from './helpers/session';
import { freshTestEmail } from './helpers/signIn';
import { journeyStep } from './helpers/journeyStep';
import { recordMeasurement } from './helpers/measurement';
import { setFlagOverrides } from './helpers/flagOverride';
import { pinnedChatEntry } from './helpers/servedModel';
import { startChattingPastWelcome } from './helpers/welcome';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { phonePhotoJpeg } from './helpers/phonePhoto';

// A6 step "send a photo" (CUR-454). The default model reads images; a catalog entry with no
// modality field offered no image type, so a pasted or dropped photo was dropped
// before it reached the turn. The picture is drawn here, a blue circle on yellow, so the expected
// answer comes from the fixture rather than from a model. On preview `multimodal` is on for team
// accounts only (CUR-2725), so these tests sign in as an @example.org test account, which the flag
// selects; production has it off for everyone, so this stays @preview-only.
//
// The first test pastes the photo, the way a person pastes a screenshot. The second presses the
// composer's attach button and chooses the photo from the file picker (CUR-2725). The third drops it
// onto the chat, which goes through the dropzone's own type check rather than the paste handler.

// A made-up wordmark (CUR-3616): the photo question below asks for a brand, and on the plain shapes the
// model, given no logo, named one anyway ("the flag of Sweden"). With a word to read, the picture
// really does answer the question, and the answer can be checked for it.
const LOGO_WORD = 'ZORVEX';
async function logoPng(): Promise<Buffer> {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
		<rect width="512" height="512" fill="#ffffff"/>
		<circle cx="256" cy="200" r="110" fill="#1040d0"/>
		<text x="256" y="420" font-family="DejaVu Sans, Arial, sans-serif" font-size="88" font-weight="bold"
			text-anchor="middle" fill="#111111">${LOGO_WORD}</text>
	</svg>`;
	return sharp(Buffer.from(svg)).png().toBuffer();
}

async function shapesPng(): Promise<Buffer> {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
		<rect width="512" height="512" fill="#f5d000"/>
		<circle cx="256" cy="256" r="160" fill="#1040d0"/>
	</svg>`;
	return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pasteImage(page: Page, name: string, type: string, bytes: Buffer): Promise<void> {
	await page.getByLabel('Message AI Potluck').evaluate(
		(el, { name, type, b64 }) => {
			const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const data = new DataTransfer();
			data.items.add(new File([raw], name, { type }));
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		},
		{ name, type, b64: bytes.toString('base64') }
	);
}

/**
 * Pastes like `pasteImage`, then returns the milliseconds from the paste event to the first frame
 * `selector` is on the page, or null if it never shows within `opts.timeout`. Timed in the page: the
 * photo's 8 MB of base64 crosses CDP and is decoded before the event, and a clock on the test side
 * or the recording would count that as the app's delay (CUR-2905).
 */
async function pasteImageTimed(
	page: Page,
	name: string,
	type: string,
	bytes: Buffer,
	selector: string,
	opts: { timeout: number }
): Promise<number | null> {
	return page.getByLabel('Message AI Potluck').evaluate(
		(el, { name, type, b64, selector, limitMs }) => {
			const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const data = new DataTransfer();
			data.items.add(new File([raw], name, { type }));
			const pastedAt = performance.now();
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
			return new Promise<number | null>((resolve) => {
				// The rAF timestamp is the frame's start, which can precede `pastedAt` and gave
				// negative durations, so read the same clock `pastedAt` came from.
				const poll = () => {
					const now = performance.now();
					if (document.querySelector(selector)) resolve(now - pastedAt);
					else if (now - pastedAt > limitMs) resolve(null);
					else requestAnimationFrame(poll);
				};
				requestAnimationFrame(poll);
			});
		},
		{ name, type, b64: bytes.toString('base64'), selector, limitMs: opts.timeout }
	);
}

async function askAndReadAnswer(page: Page) {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill('What colour is the circle in this picture? Answer with one word.');
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const answer = page.locator('[data-message-role="assistant"]').last();
	await expect(
		turnDone(answer),
		'no finished answer to the photo question' + warmupContext()
	).toBeVisible({ timeout: 90_000 });
	return answer;
}

async function openChat(page: Page, email?: string, entry: string = chatEntry()): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await signInAsFreshUser(page, email);
	await page.goto(entry, { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

/** The ids of listed models this browser's visitor may send an image to, per /chat/api/models. */
async function modelsTakingImages(page: Page): Promise<string[]> {
	const res = await page.request.get('/chat/api/models');
	expect(res.status()).toBe(200);
	const list = (await res.json()) as Array<{ id: string; multimodal: boolean }>;
	return list.filter((m) => m.multimodal).map((m) => m.id);
}

// `multimodal` is on for everyone on preview (CUR-3979, reversing CUR-2725's team-only rule), so a
// guest meets the same image input a team account does. The off path is asserted in
// attachment-limits.spec.ts and custodial-storage.spec.ts, which force the flag off.
test(
	'a guest on preview is offered a model that takes images, and a pasted photo asks them to sign in rather than attaching',
	{ tag: ['@A6', '@preview-only', '@CUR-2725', '@CUR-3979'] },
	async ({ page }) => {
		await page.goto('/chat', { waitUntil: 'commit' });
		expect(
			(await modelsTakingImages(page)).length,
			'a guest was offered no model that takes images, though multimodal is on for everyone on preview'
		).toBeGreaterThan(0);

		// What a guest actually meets: a pasted photo never becomes a chip, and the composer asks them to
		// sign in, since guests cannot attach files (guest-uploads.spec.ts).
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		await pasteImage(page, 'guest-shapes.png', 'image/png', await shapesPng());
		await expect(
			page.getByTestId('attachment-refusal'),
			'a guest pasting a photo was not asked to sign in'
		).toContainText('Sign in to attach files.', { timeout: 10_000 });
		await expect(
			page.getByAltText('guest-shapes.png'),
			'a photo a guest pasted was attached, though guests cannot attach files'
		).toHaveCount(0);
		await holdForRecording(page);

		await signInAsFreshUser(page);
		expect(
			(await modelsTakingImages(page)).length,
			'a team test account was offered no model that takes images'
		).toBeGreaterThan(0);
	}
);

test(
	'a pasted photo reaches the model: asked the colour of the circle, the answer says blue, and a follow-up still sees it',
	{ tag: ['@A6', '@preview-only', '@CUR-454'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await openChat(page);

		const composer = page.getByLabel('Message AI Potluck');
		await journeyStep(page, 'A6', 5, async () => {
			await composer.evaluate(
				(el, b64) => {
					const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
					const data = new DataTransfer();
					data.items.add(new File([bytes], 'shapes.png', { type: 'image/png' }));
					el.dispatchEvent(
						new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
					);
				},
				(await shapesPng()).toString('base64')
			);
			await expect(
				// An image chip is a thumbnail whose alt text is the file name (UploadedFile.svelte).
				page.getByAltText('shapes.png').or(page.getByText('shapes.png')).first(),
				'the pasted photo was not attached: no model on this deployment is registered as reading images, so image types are not accepted (CUR-454)'
			).toBeVisible({ timeout: 10_000 });
			await holdForRecording(page);

			await composer.fill('What colour is the circle in this picture? Answer with one word.');
			await composer.press('Enter');

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(
				turnDone(answer),
				'no finished answer to the photo question' + warmupContext()
			).toBeVisible({
				timeout: 90_000
			});
			await expect(
				answer,
				'the answer does not name the circle as blue, so the model did not see the photo'
			).toContainText(/blue/i);
		});
		await holdForRecording(page);

		// A follow-up attaches nothing new, but the turn still carries the photo, so it must stay on the
		// model that reads it. The agent's /route classifier sent image questions to the agent, which
		// never receives the image (CUR-454).
		const assistant = page.locator('[data-message-role="assistant"]');
		const answersBefore = await assistant.count();
		await composer.fill('And what colour is the background? Answer with one word.');
		await composer.press('Enter');
		const followUp = assistant.nth(answersBefore);
		await expect(
			turnDone(followUp),
			'no finished answer to the follow-up about the photo' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await expect(
			followUp,
			'the follow-up does not name the background as yellow, so the second turn lost the photo'
		).toContainText(/yellow/i);
		await holdForRecording(page);
	}
);

// When the input screen doesn't finish, the decline says "send it again", and the only Retry
// was the footer's unlabelled icon, so a visitor retyped the question and went looking for the photo
// again (CUR-3739). The decline now carries a labelled Retry, and pressing it answers from the same photo.
test(
	'CUR-3739: a photo turn the safety check could not finish offers a labelled Retry that answers from the same photo',
	{ tag: ['@A6', '@preview-only', '@CUR-3739', '@real-screen'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await openChat(page);
		const fault = await installFaultInjectionHeader(page, 'input_screen_unfinished');

		await pasteImage(page, 'shapes.png', 'image/png', await shapesPng());
		await expect(
			page.getByAltText('shapes.png').or(page.getByText('shapes.png')).first(),
			'the pasted photo was not attached, so this turn carries no photo to retry'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('What colour is the circle in this picture? Answer with one word.');
		const sent = page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/conversation\/[a-f0-9]+$/.test(new URL(res.url()).pathname),
			{ timeout: 60_000 }
		);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		expect(
			(await sent).headers()['x-fault-injected'],
			'the server did not apply input_screen_unfinished, so the screen finished and this turn tests nothing'
		).toBe('input_screen_unfinished');

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			answer,
			'the turn was not declined as could-not-check' + warmupContext()
		).toContainText(/couldn['’]t finish the safety check/i, { timeout: 120_000 });
		await expect(answer, 'the badge still names the screen').toContainText(
			"Couldn't check this message"
		);
		const retry = answer.getByRole('alert').getByRole('button', { name: 'Retry' });
		await expect(
			retry,
			'the could-not-check decline offers no labelled Retry, so the visitor has to retype and re-attach'
		).toHaveText('Retry');
		await holdForRecording(page);

		fault.disarm();
		await retry.click();
		const retried = page.locator('[data-message-role="assistant"]').last();
		await expect(
			retried,
			'Retry brought back the could-not-check decline with the fault disarmed'
		).not.toContainText(/couldn['’]t finish the safety check/i, { timeout: 120_000 });
		await expect(turnDone(retried), 'no finished answer after Retry' + warmupContext()).toBeVisible(
			{ timeout: 90_000 }
		);
		await expect(
			retried,
			'the retried answer does not name the circle as blue, so Retry did not carry the photo'
		).toContainText(/blue/i);
		await holdForRecording(page);
	}
);

test(
	'the attach button takes a photo from the file picker, and the answer says what is in it',
	{ tag: ['@A6', '@preview-only', '@CUR-2725'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await openChat(page);

		await journeyStep(page, 'A6', 5, async () => {
			const attach = page.getByRole('button', { name: /^Add files and tools/ });
			await expect(
				attach,
				'no attach button: it shows only where the server takes images for this model (CUR-2725)'
			).toBeVisible({ timeout: 10_000 });
			await attach.click();
			const chooser = page.waitForEvent('filechooser');
			await page.getByRole('menuitem', { name: 'Attach files' }).click();
			await (
				await chooser
			).setFiles({
				name: 'shapes.png',
				mimeType: 'image/png',
				buffer: await shapesPng()
			});

			await expect(
				page.getByAltText('shapes.png').or(page.getByText('shapes.png')).first(),
				'the chosen photo was not attached'
			).toBeVisible({ timeout: 10_000 });
			await holdForRecording(page);

			const composer = page.getByLabel('Message AI Potluck');
			await composer.fill('What colour is the circle in this picture? Answer with one word.');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(
				turnDone(answer),
				'no finished answer to the photo question' + warmupContext()
			).toBeVisible({ timeout: 90_000 });
			await expect(
				answer,
				'the answer does not name the circle as blue, so the model did not see the chosen photo'
			).toContainText(/blue/i);
		});
		await holdForRecording(page);
	}
);

// The composer offers jpeg, png, webp and gif, the types a browser can draw as a thumbnail,
// so an avif or a bmp was refused by name (CUR-3073). The browser now redraws either as a JPEG before the type
// check. The two circles differ in colour, so an answer naming both shows the model saw both photos.
async function shapesRaw(circle: string): Promise<{ data: Buffer; width: number; height: number }> {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
		<rect width="256" height="256" fill="#f5d000"/>
		<circle cx="128" cy="128" r="80" fill="${circle}"/>
	</svg>`;
	const { data, info } = await sharp(Buffer.from(svg))
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

/** A 24-bit BMP of `circle` on yellow. sharp writes no BMP, so the file is laid out here. */
async function shapesBmp(circle: string): Promise<Buffer> {
	const { data, width, height } = await shapesRaw(circle);
	const row = Math.ceil((width * 3) / 4) * 4;
	const out = Buffer.alloc(54 + row * height);
	out.write('BM', 0, 'ascii');
	out.writeUInt32LE(out.length, 2);
	out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14);
	out.writeInt32LE(width, 18);
	out.writeInt32LE(height, 22);
	out.writeUInt16LE(1, 26);
	out.writeUInt16LE(24, 28);
	out.writeUInt32LE(row * height, 34);
	for (let y = 0; y < height; y++) {
		// Rows run bottom-up, pixels as blue, green, red.
		const dst = 54 + (height - 1 - y) * row;
		for (let x = 0; x < width; x++) {
			const src = (y * width + x) * 3;
			out[dst + x * 3] = data[src + 2];
			out[dst + x * 3 + 1] = data[src + 1];
			out[dst + x * 3 + 2] = data[src];
		}
	}
	return out;
}

test(
	'an avif and a bmp from the file picker are redrawn as photos the model reads, and the answer names both circles',
	{ tag: ['@A6', '@preview-only', '@CUR-3073'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await openChat(page);

		const { data, width, height } = await shapesRaw('#1040d0');
		const avif = await sharp(data, { raw: { width, height, channels: 3 } })
			.avif()
			.toBuffer();
		const attach = page.getByRole('button', { name: /^Add files and tools/ });
		await expect(
			attach,
			'no attach button: photos are not offered to this account (CUR-2725)'
		).toBeVisible({
			timeout: 10_000
		});
		await attach.click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Attach files' }).click();
		await (
			await chooser
		).setFiles([
			{ name: 'blue.avif', mimeType: 'image/avif', buffer: avif },
			{ name: 'red.bmp', mimeType: 'image/bmp', buffer: await shapesBmp('#d01010') }
		]);

		// A redrawn photo is renamed to .jpg, and its chip is a thumbnail with that name as alt text.
		for (const name of ['blue.jpg', 'red.jpg']) {
			await expect(
				page.getByAltText(name),
				`${name} has no thumbnail chip: the browser did not redraw the photo, so it was refused by type`
			).toBeVisible({ timeout: 15_000 });
		}
		await holdForRecording(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Each picture has a circle. Name the colour of the circle in each one.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer to the two-photo question' + warmupContext()
		).toBeVisible({
			timeout: 90_000
		});
		await expect(answer, 'the answer does not name the avif circle as blue').toContainText(/blue/i);
		await expect(answer, 'the answer does not name the bmp circle as red').toContainText(/red/i);
		await holdForRecording(page);
	}
);

// Some pickers, and the Chrome extension's upload, hand the browser an avif or a bmp with no type at
// all. Playwright fills in a type from the name when given an empty one, so these files are built in
// the page and set on the input directly, the way such a picker leaves them.
test(
	'an avif and a bmp the picker hands over with no type still get thumbnails, or a refusal that names them',
	{ tag: ['@A6', '@preview-only', '@CUR-3073'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openChat(page);

		const { data, width, height } = await shapesRaw('#1040d0');
		const avif = await sharp(data, { raw: { width, height, channels: 3 } })
			.avif()
			.toBuffer();
		const bmp = await shapesBmp('#d01010');
		await expect(
			page.getByRole('button', { name: /^Add files and tools/ }),
			'no attach button: photos are not offered to this account (CUR-2725)'
		).toBeVisible({ timeout: 10_000 });

		const types = await page.getByLabel('Upload file').evaluate(
			(input: HTMLInputElement, files: { name: string; base64: string }[]) => {
				const dt = new DataTransfer();
				for (const f of files) {
					const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
					dt.items.add(new File([bytes], f.name, { type: '' }));
				}
				input.files = dt.files;
				const seen = Array.from(input.files).map((f) => f.type);
				input.dispatchEvent(new Event('change', { bubbles: true }));
				return seen;
			},
			[
				{ name: 'blue.avif', base64: avif.toString('base64') },
				{ name: 'red.bmp', base64: bmp.toString('base64') }
			]
		);
		expect(types, 'the files reached the input with a type, so this tests nothing').toEqual([
			'',
			''
		]);

		// A refusal names the type by extension ("AVIF file"), since the file carries none.
		for (const [jpg, label] of [
			['blue.jpg', 'AVIF'],
			['red.jpg', 'BMP']
		]) {
			await expect(
				page
					.getByAltText(jpg)
					.or(page.getByText(new RegExp(`can't be attached here: .*${label}`, 'i'))),
				`the ${label} with no type was dropped silently: no thumbnail and no refusal naming it`
			).toBeVisible({ timeout: 15_000 });
		}
		await holdForRecording(page);
	}
);

test(
	'a HEIC this browser cannot open is refused by name with the photo types that work, and a photo still attaches after it',
	{ tag: ['@A6', '@preview-only', '@CUR-3073'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openChat(page);

		const attach = page.getByRole('button', { name: /^Add files and tools/ });
		await expect(
			attach,
			'no attach button: photos are not offered to this account (CUR-2725)'
		).toBeVisible({
			timeout: 10_000
		});
		// Chromium has no HEIC decoder, so this file can only be refused. The bytes are a HEIC's header.
		const pick = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
			await attach.click();
			const chooser = page.waitForEvent('filechooser');
			await page.getByRole('menuitem', { name: 'Attach files' }).click();
			await (await chooser).setFiles(file);
		};
		await pick({
			name: 'IMG_0001.heic',
			mimeType: 'image/heic',
			buffer: Buffer.from('000000186674797068656963000000006d696631', 'hex')
		});
		await expect(
			page.getByText(/can't be attached here: HEIC/i),
			'the HEIC was not refused by name'
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByText(/JPEG, PNG, WebP or GIF/),
			'the refusal does not say which photo types work'
		).toBeVisible();
		await expect(
			page.getByAltText('IMG_0001.heic'),
			'the refused HEIC still sits in the composer'
		).toHaveCount(0);

		await pick({ name: 'shapes.png', mimeType: 'image/png', buffer: await shapesPng() });
		await expect(
			page.getByAltText('shapes.png'),
			'a photo picked after the refused HEIC was not attached, so the refusal broke the composer'
		).toBeVisible({ timeout: 10_000 });
	}
);

// A team account (CUR-2725): every other photo test signs in on example.org, so nothing showed that the
// staff-domain condition in the flag's targeting reaches a real team sign-in. No flag override:
// the attach button has to come from the flag's own targeting, on the model a visitor gets by default.
test(
	'a currentai.org team account gets the attach button on Mistral Medium 3.5 with no flag override, and the answer names the photo',
	{ tag: ['@A6', '@preview-only', '@CUR-2725'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await openChat(page, freshTestEmail('currentai.org'), `/chat/models/${MEDIUM_MODEL}`);

		const attach = page.getByRole('button', { name: /^Add files and tools/ });
		await expect(
			attach,
			'no attach button for a currentai.org account: the multimodal flag does not select its domain'
		).toBeVisible({ timeout: 10_000 });
		await attach.click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Attach files' }).click();
		await (
			await chooser
		).setFiles({ name: 'shapes.png', mimeType: 'image/png', buffer: await shapesPng() });
		await expect(
			page.getByAltText('shapes.png').or(page.getByText('shapes.png')).first(),
			'the chosen photo was not attached'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('What colour is the circle in this picture? Answer with one word.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer to the photo question' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await expect(
			answer,
			'the answer does not name the circle as blue, so the model did not see the chosen photo'
		).toContainText(/blue/i);
		await holdForRecording(page);
	}
);

test(
	'a photo dropped onto the chat is attached through the dropzone, and the answer says what is in it',
	{ tag: ['@A6', '@preview-only', '@CUR-454'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await openChat(page);

		await journeyStep(page, 'A6', 5, async () => {
			const dataTransfer = await page.evaluateHandle(
				(b64) => {
					const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
					const dt = new DataTransfer();
					dt.items.add(new File([raw], 'shapes.png', { type: 'image/png' }));
					return dt;
				},
				(await shapesPng()).toString('base64')
			);
			await page
				.getByRole('form', { name: 'file dropzone' })
				.dispatchEvent('dragenter', { dataTransfer });
			const dropzone = page.getByText('Drop files to attach');
			await expect(dropzone, 'dragging a file over the chat showed no dropzone').toBeVisible({
				timeout: 10_000
			});
			await dropzone.dispatchEvent('drop', { dataTransfer });

			await expect(
				page.getByAltText('shapes.png').or(page.getByText('shapes.png')).first(),
				"the dropped photo was not attached: the dropzone accepts only the current model's types, and image types join them only when the model reads images (CUR-454)"
			).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(/Some file type not supported/)).toHaveCount(0);
			await holdForRecording(page);

			const answer = await askAndReadAnswer(page);
			await expect(
				answer,
				'the answer does not name the circle as blue, so the model did not see the dropped photo'
			).toContainText(/blue/i);
		});
		await holdForRecording(page);
	}
);

test(
	"the sent photo stays on screen when the turn ends: drawn from the browser's own copy, never re-downloaded",
	{ tag: ['@A6', '@preview-only', '@CUR-2761'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await openChat(page);
		await pasteImage(page, 'shapes.png', 'image/png', await shapesPng());
		await expect(page.getByAltText('shapes.png').first()).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('What colour is the circle in this picture? Answer with one word.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const thumb = page.locator('[data-message-type="user"] img[alt="shapes.png"]').first();
		await expect(thumb).toBeVisible({ timeout: 15_000 });

		// Every frame from here on, note whether the thumbnail is drawn and where its pixels come from.
		await page.evaluate(() => {
			const w = window as unknown as { __thumb: { t: number; src: string; drawn: boolean }[] };
			w.__thumb = [];
			const t0 = performance.now();
			const tick = () => {
				const img = document.querySelector<HTMLImageElement>(
					'[data-message-type="user"] img[alt="shapes.png"]'
				);
				w.__thumb.push({
					t: performance.now() - t0,
					src: img ? img.src.slice(0, 5) : 'none',
					drawn: !!img && img.complete && img.naturalWidth > 0
				});
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		const sent = await thumb.elementHandle();

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer to the photo question' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		// The turn-end reload replaces the message, thumbnail included (CUR-2761). Wait for that, then
		// for the replacement to be drawn.
		await expect
			.poll(() => sent?.evaluate((n) => n.isConnected), {
				message: 'the turn-end reload never replaced the sent message',
				timeout: 30_000
			})
			.toBe(false);
		await expect
			.poll(() => thumb.evaluate((n: HTMLImageElement) => n.complete && n.naturalWidth > 0), {
				timeout: 15_000
			})
			.toBe(true);
		await holdForRecording(page);

		const samples = await page.evaluate(
			() => (window as unknown as { __thumb: { t: number; src: string; drawn: boolean }[] }).__thumb
		);
		expect(
			samples.filter((s) => s.src !== 'data:' && s.src !== 'none').map((s) => s.src),
			'the thumbnail was fetched from the server again instead of drawn from the copy the browser sent'
		).toEqual([]);
		let gap = 0;
		let longestGap = 0;
		for (let i = 1; i < samples.length; i++) {
			gap = samples[i].drawn ? 0 : gap + (samples[i].t - samples[i - 1].t);
			longestGap = Math.max(longestGap, gap);
		}
		expect(
			longestGap,
			'the thumbnail was missing or blank for a visible moment after the turn ended'
		).toBeLessThan(150);
	}
);

test(
	'a 6 MB phone photo, over the 3 MB message limit, is shrunk in the browser, attached, and read',
	{ tag: ['@A6', '@preview-only', '@CUR-2633'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		// The chat opens first: the recording starts with the page, so a photo built before it would
		// show as a blank tab the gallery grades as the site's load time (CUR-2784).
		await openChat(page);
		const photo = await phonePhotoJpeg();
		expect(
			photo.length,
			'the fixture is no longer a 6 MB phone photo, so this tests something smaller'
		).toBeGreaterThan(6_000_000);
		await journeyStep(page, 'A6', 5, async () => {
			// The shrink takes seconds, and the composer said nothing until it finished (CUR-2905).
			const placeholderMs = await pasteImageTimed(
				page,
				'IMG_4032.jpg',
				'image/jpeg',
				photo,
				'[data-testid="preparing-photo"]',
				{ timeout: 2_000 }
			);
			if (placeholderMs !== null) {
				recordMeasurement({
					name: 'Paste to "Preparing photo…" on screen',
					value: Math.round(placeholderMs),
					unit: 'ms',
					detail: 'timed in the page, from the paste event to the first frame with the chip'
				});
			}
			expect(
				placeholderMs,
				'nothing showed the paste had landed within a second of it, while the photo was being shrunk'
			).not.toBeNull();
			expect(placeholderMs!).toBeLessThan(1_000);
			const preparing = page.getByText('Preparing photo…');
			await expect(
				page.getByAltText('IMG_4032.jpg').or(page.getByText('IMG_4032.jpg')).first(),
				'the phone photo was not attached; at full size it is over the 3 MB per-message limit'
			).toBeVisible({ timeout: 15_000 });
			await expect(preparing, 'the placeholder stayed after the photo was attached').toHaveCount(0);
			await expect(page.getByText(/Attachments can add up to/)).toHaveCount(0);
			await holdForRecording(page);

			const answer = await askAndReadAnswer(page);
			await expect(
				answer,
				'the answer does not name the circle as blue, so the model did not see the shrunk photo'
			).toContainText(/blue/i);
		});
		await holdForRecording(page);
	}
);

test(
	'a photo attached on the empty composer is gone after New chat, so it never rides into the next question',
	{ tag: ['@A6', '@preview-only', '@CUR-3052'] },
	async ({ page }) => {
		await openChat(page);
		await pasteImage(page, 'shapes.png', 'image/png', await shapesPng());
		const chip = page.getByAltText('shapes.png').first();
		await expect(chip, 'the pasted photo never showed as attached').toBeVisible({
			timeout: 10_000
		});

		// The empty composer is already the new-chat page, so this press navigates nowhere; the
		// attachment has to be dropped all the same (CUR-3052).
		await page
			.getByRole('complementary', { name: 'Conversations' })
			.getByRole('link', { name: /new chat/i })
			.first()
			.click();
		await expect(
			page.getByAltText('shapes.png'),
			'New chat kept the photo attached, so the next question would send it along (CUR-3052)'
		).toHaveCount(0, { timeout: 5_000 });
		await holdForRecording(page);
	}
);

// The empty chat centres its greeting and composer, and the photo row grows the composer,
// so attaching a photo moved the message box out from under the person about to type (CUR-3617). Measured as
// the box's top edge before the paste and once the photo shows; a few pixels of rounding pass.
// On a window too short to hold the box still, the greeting's heading must stay on screen.
async function attachLeavesTheBoxInPlace(page: Page, name: string, pinned: boolean) {
	await openChat(page);
	const box = page.getByLabel('Message AI Potluck');
	const top = async () => (await box.boundingBox())?.y ?? Number.NaN;
	// The landing settles (fonts, the model line) before the baseline is read.
	let before = await top();
	await expect
		.poll(
			async () => {
				const now = await top();
				const steady = Math.abs(now - before) < 1;
				before = now;
				return steady;
			},
			{ timeout: 10_000, intervals: [300] }
		)
		.toBe(true);
	// The free space around the centred block, which decides whether the lift alone can absorb the row.
	const landingStyle = () =>
		page.evaluate(() => {
			const landing = document.querySelector<HTMLElement>('[data-testid="chat-scroll"] .my-auto');
			if (!landing) return null;
			const computed = getComputedStyle(landing);
			return {
				free: parseFloat(computed.marginTop) + parseFloat(computed.marginBottom),
				transform: landing.style.transform || null,
				marginTop: landing.style.marginTop || null,
				marginBottom: landing.style.marginBottom || null
			};
		});
	const centring = (await landingStyle())?.free ?? Number.NaN;

	await pasteImage(page, 'shapes.png', 'image/png', await shapesPng());
	await expect(
		page.getByAltText('shapes.png').first(),
		'the pasted photo never showed as attached'
	).toBeVisible({
		timeout: 10_000
	});
	const shift = async () => Math.round(Math.abs((await top()) - before));
	// Where the correction went, for a failure to say: how far the column could scroll and did, the
	// block's inline correction, and whether the document scrolled instead of the column.
	const geometry = async () => {
		const scroll = await page.evaluate(() => {
			const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]');
			return {
				scrollTop: scroller?.scrollTop,
				scrollHeight: scroller?.scrollHeight,
				clientHeight: scroller?.clientHeight,
				docScroll: document.scrollingElement?.scrollTop,
				innerHeight: window.innerHeight
			};
		});
		return JSON.stringify({ centringBefore: centring, ...scroll, ...(await landingStyle()) });
	};
	// How far the greeting's heading sits below the column's top edge; negative means it is cut off.
	const headingGap = () =>
		page.evaluate(() => {
			const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]');
			const heading = scroller?.querySelector('[data-chat-landing] h2');
			if (!scroller || !heading) return Number.NaN;
			return Math.round(heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
		});
	// The box holds still, unless holding it would scroll the greeting away: then the column stops
	// with the heading at its top edge and the box takes the rest of the row.
	await expect
		.poll(
			async () => {
				const moved = await shift();
				const gap = await headingGap();
				return moved <= 4 || (gap >= 0 && gap <= 20)
					? 'held'
					: `moved ${moved}px, heading ${gap}px below the top`;
			},
			{
				message: `the message box moved when the photo attached (top was ${Math.round(before)}px; ${await geometry()})`,
				timeout: 3_000
			}
		)
		.toBe('held')
		.finally(async () => {
			const after = await geometry();
			test.info().annotations.push({ type: 'landing geometry after attach', description: after });
			console.log(`[CUR-3617] landing geometry after attach, ${name}: ${after}`);
			await recordMeasurement({
				name: `Message box moved when the photo attached, ${name}`,
				value: await shift(),
				unit: 'px'
			});
		});
	expect(
		await headingGap(),
		`the greeting's heading was scrolled out of view when the photo attached (${await geometry()})`
	).toBeGreaterThanOrEqual(0);
	if (pinned) {
		// The case this window exists for: some centring room, too little for the lift alone, so the
		// block is pinned and the column scrolls. A window outside that band passes without testing it.
		const after = await geometry();
		expect(
			centring,
			`this window left no centring room, so it never tests the pinned path (${after})`
		).toBeGreaterThan(4);
		expect(
			(await landingStyle())?.marginTop,
			`the lift alone absorbed the row, so this window never tests the pinned path (${after})`
		).not.toBeNull();
	}
	await holdForRecording(page);
}

test(
	'attaching a photo on the empty chat leaves the message box where it was (CUR-3617)',
	{ tag: ['@A6', '@preview-only', '@CUR-3617'] },
	async ({ page }) => attachLeavesTheBoxInPlace(page, 'on a window the greeting fills', false)
);

test.describe('on a window with some centring room, less than the photo row needs', () => {
	// The landing's free space is about the window height less 566 px (measured on preview),
	// and the attachment row inside the composer adds 72 px, so the block pins only when that free space
	// is under 72 px. 620 leaves about 54 px: some room, less than the row.
	test.use({ viewport: { width: 1280, height: 620 } });
	test(
		'attaching a photo on the empty chat leaves the message box where it was, with the block pinned and the column scrolled (CUR-3617)',
		{ tag: ['@A6', '@preview-only', '@CUR-3617'] },
		async ({ page }) => attachLeavesTheBoxInPlace(page, 'with some centring room', true)
	);
});

// A large photo takes seconds to shrink, and the picker used to hand focus back to the
// box only once it was ready, so typing straight after choosing it landed on nothing (CUR-3197). And Enter
// while it was still shrinking would send the text without the photo. Typed with the keyboard, not
// `fill`, because `fill` focuses the box itself and would hide the first defect.
test(
	'typing straight after choosing a large photo lands in the box, and Enter sends the text with the photo',
	{ tag: ['@A6', '@preview-only', '@CUR-3197'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const photo = await phonePhotoJpeg();
		await openChat(page);

		await page.getByRole('button', { name: /^Add files and tools/ }).click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Attach files' }).click();
		await (
			await chooser
		).setFiles({ name: 'phone-photo.jpg', mimeType: 'image/jpeg', buffer: photo });

		const question = 'What colour is the circle in this picture? Answer with one word.';
		await page.keyboard.type(question);
		await page.keyboard.press('Enter');

		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, {
			timeout: 60_000
		});
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer to the photo question' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await holdForRecording(page);

		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		type Stored = { from: string; content: string; files?: unknown[] };
		const body = (await res.json()) as { json?: { messages?: Stored[] }; messages?: Stored[] };
		const sent = (body.json?.messages ?? body.messages ?? []).find((m) => m.from === 'user');
		expect(sent?.content, 'the typed question did not reach the sent message').toBe(question);
		expect(
			sent?.files?.length ?? 0,
			'the question was sent without the photo chosen just before it (CUR-3197)'
		).toBe(1);
	}
);

test(
	'a question about an attached photo is answered from the photo, with no web search, and names the logo it shows (CUR-3616)',
	{ tag: ['@A6', '@preview-only', '@CUR-3192', '@CUR-3616'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		// The picture answers this question, so a search here is the defect and not a judgement call.
		// Every model that reads photos is on the native plan (CUR-4015): the model decides whether to
		// search, told by the photo-search section of its prompt. The gate is forced on so a turn that
		// does ask it still has to decline.
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		await page.addInitScript(() => {
			const w = window as unknown as { __liveLines?: string[] };
			w.__liveLines = [];
			new MutationObserver(() => {
				for (const log of document.querySelectorAll(
					'[data-message-role="assistant"] [aria-live="polite"]'
				)) {
					for (const line of (log as HTMLElement).innerText.split('\n')) {
						const t = line.trim();
						if (t && !w.__liveLines!.includes(t)) w.__liveLines!.push(t);
					}
				}
			}).observe(document, { childList: true, subtree: true, characterData: true });
		});
		// Pinned to the model www serves. A ticket-branch preview defaults to Mistral Small 4, which no
		// visitor is offered, and which misses the printed wordmark too often (CUR-3861).
		await openChat(page, undefined, pinnedChatEntry(MEDIUM_MODEL));
		await pasteImage(page, 'logo.png', 'image/png', await logoPng());
		await expect(
			page.getByAltText('logo.png').first(),
			'the pasted photo never showed as attached'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('What brand is the logo in this picture?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer to the photo question' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await holdForRecording(page);
		await expect(
			answer,
			`the answer does not name the ${LOGO_WORD} wordmark in the photo, so it was not read from the picture (CUR-3616)`
		).toContainText(new RegExp(LOGO_WORD, 'i'));

		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		type Stored = {
			id: string;
			webSearch?: { sources?: unknown[] };
			searchAttempt?: { searched: boolean };
		};
		const body = (await res.json()) as { json?: { messages?: Stored[] } };
		const id = await answer.getAttribute('data-message-id');
		const stored = body.json?.messages?.find((m) => m.id === id);
		expect(
			stored,
			`the page shows message ${id}, which is not in the stored conversation`
		).toBeTruthy();
		expect(
			stored!.webSearch,
			`a question about the attached photo grounded on ${stored!.webSearch?.sources?.length} web sources (CUR-3192)`
		).toBeUndefined();
		expect(
			stored!.searchAttempt?.searched ?? false,
			'a question about the attached photo made a round-trip to the search engines (CUR-3192)'
		).toBe(false);
		const liveLines = await page.evaluate(
			() => (window as unknown as { __liveLines?: string[] }).__liveLines ?? []
		);
		expect(
			liveLines.some((l) => /searching (our documents and )?the web/i.test(l)),
			`the live log said the web was being searched on a photo question: ${JSON.stringify(liveLines)}`
		).toBe(false);
	}
);

test(
	'CUR-3506 CUR-3402: a photo question sent from a new chat stays on screen with its photo in every frame from send to answer',
	{ tag: ['@A6', '@preview-only', '@CUR-3506', '@CUR-3402'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await openChat(page);
		// The phone photo, shrunk to under 3 MB in the browser, takes many frames to encode for sending,
		// which is the window the question used to be missing from.
		await pasteImage(page, 'IMG_4032.jpg', 'image/jpeg', await phonePhotoJpeg());
		await expect(
			page.getByAltText('IMG_4032.jpg').or(page.getByText('IMG_4032.jpg')).first(),
			'the phone photo was not attached'
		).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('Preparing photo…')).toHaveCount(0);

		const question = 'What colour is the circle in this picture? Answer with one word.';
		// One sample per painted frame, in the page: from the first frame that shows the question, count
		// every later frame that shows no bubble holding it (CUR-3506), and every frame whose bubble holds
		// the question but not its photo (CUR-3402). A client-side navigation keeps this window, so the
		// sampler sees the landing page's bubble hand over to the conversation page's.
		await page.evaluate(
			({ q, name }) => {
				const w = window as unknown as {
					__bubble: { seen: boolean; lost: number; bare: number; frames: number };
				};
				w.__bubble = { seen: false, lost: 0, bare: 0, frames: 0 };
				const tick = () => {
					const holding = [...document.querySelectorAll('[data-message-type="user"]')].filter(
						(el) => el.textContent?.includes(q)
					);
					const shown = holding.length > 0;
					w.__bubble.frames++;
					if (shown) {
						w.__bubble.seen = true;
						// A sent photo is an image named by its alt text in the bubble's "Attached files" row
						// (ChatMessage.svelte, alpha-ds attachment Card).
						const withPhoto = holding.some((el) =>
							[...el.querySelectorAll('[aria-label="Attached files"] img')].some(
								(img) => img.getAttribute('alt') === name
							)
						);
						if (!withPhoto) w.__bubble.bare++;
					} else if (w.__bubble.seen) w.__bubble.lost++;
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			},
			{ q: question, name: 'IMG_4032.jpg' }
		);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer to the photo question' + warmupContext()
		).toBeVisible({
			timeout: 90_000
		});

		const bubble = await page.evaluate(
			() =>
				(
					window as unknown as {
						__bubble: { seen: boolean; lost: number; bare: number; frames: number };
					}
				).__bubble
		);
		expect(
			bubble.seen,
			`the question never showed as a sent bubble in ${bubble.frames} frames`
		).toBe(true);
		expect(
			bubble.lost,
			`the sent question left the thread for ${bubble.lost} of ${bubble.frames} frames before the answer finished`
		).toBe(0);
		expect(
			bubble.bare,
			`the sent question showed without its photo for ${bubble.bare} of ${bubble.frames} frames`
		).toBe(0);
		await expect(
			page
				.locator('[data-message-type="user"]')
				.last()
				.getByLabel('Attached files')
				.getByAltText('IMG_4032.jpg'),
			'the sent question does not carry its photo'
		).toBeVisible();
		await holdForRecording(page);
	}
);
