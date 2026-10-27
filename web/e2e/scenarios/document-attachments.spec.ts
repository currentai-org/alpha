// e2e-product: @chat
// e2e-area: @composer @storage
import { test, expect, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// The abuse-match refusal names no reason on purpose, only the next step (CUR-3086).
const ABUSE_REFUSAL =
	"This file couldn't be added, so it was taken off. You can send your message without it.";

// A PDF dropped on the composer is read to text on the server (A6, CUR-987), screened with the
// turn, and answered from. The fixture's one fact, a 37 EUR taxi cap that applies only after 22:00,
// is in no model's training data, so an answer that states it has read the file.
// The second test is the flag-off contract: the composer refuses the PDF before anything is sent.
// The last two are the known-abuse image check on the pictures inside a PDF (embeddedImageScan.ts):
// with the scanner down the PDF is dropped with the try-again line, and a PDF carrying the
// placeholder bank's test image (web/hma/fly/, not abuse material) refuses the whole turn.
// With the input screen's guard unreachable (CUR-4101), the PDF turn is declined as couldn't-check,
// since the document's text rides that screen and must never reach the model unscreened.
// The text-only test is the workaround for accounts the full surface does not select
// (`document-text-only`, storage/documentTextOnly.ts): the same bank-image PDF is answered from its
// text, its picture is never opened, and My files holds only a .txt of the text, never the PDF.

const FIXTURE = join(import.meta.dirname, 'fixtures', 'expenses-policy.pdf');
const NAME = 'expenses-policy.pdf';
const BANK_IMAGE_PDF = join(import.meta.dirname, 'fixtures', 'garden-report-bank-image.pdf');
// 1,001 pages in 117 KB, one over the limit (CUR-3837). Generated, not a real document.
const TOO_MANY_PAGES_PDF = join(import.meta.dirname, 'fixtures', 'too-many-pages.pdf');
const CONVERSATION_POST = /\/chat\/conversation\/[a-f0-9]+$/;
// The PDF's condition on the taxi cap, written either way a model might put it.
const AFTER_TEN_PM = /22[:.]?00|10 ?p\.?m/i;

async function openChat(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

// Dragged onto the composer, the other way a person attaches; the first test uses the attach menu.
async function dropPdf(page: Page, path = FIXTURE, name = NAME) {
	const bytes = [...readFileSync(path)];
	const dataTransfer = await page.evaluateHandle(
		({ bytes, name }) => {
			const dt = new DataTransfer();
			dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
			return dt;
		},
		{ bytes, name }
	);
	await page
		.getByRole('form', { name: 'file dropzone' })
		.dispatchEvent('dragenter', { dataTransfer });
	const dropzone = page.getByText('Drop files to attach');
	await expect(dropzone).toBeVisible({ timeout: 10_000 });
	await dropzone.dispatchEvent('drop', { dataTransfer });
}

test(
	'a PDF dropped in chat is read, and the answer comes from what the document says',
	{ tag: ['@preview-only', '@A6', '@CUR-987', '@CUR-4102'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': true,
			// A minted @example.org account has agent mode on preview (CUR-1611). Off pins the turn to
			// the chat path this spec is about; auto routing of a document turn is unit-tested in
			// resolveAgentRoute.spec.ts.
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		const composer = await openChat(page);

		// Through the attach menu, the way a person finds it: the other tests drop the file instead.
		await journeyStep(page, 'A6', 6, async () => {
			await page.getByRole('button', { name: /^Add files and tools/ }).click();
			const chooser = page.waitForEvent('filechooser');
			await page.getByRole('menuitem', { name: 'Attach files' }).click();
			await (await chooser).setFiles(FIXTURE);
			await expect(
				page.getByText(NAME).first(),
				'the PDF chosen from the attach menu never showed as attached in the composer'
			).toBeVisible({ timeout: 10_000 });
			// The chip used to read the raw MIME type, "application/pdf", under the name.
			await expect(page.getByText('PDF document').first()).toBeVisible();
			await expect(page.getByText('application/pdf')).toHaveCount(0);

			await composer.fill(
				'According to the attached policy, how much is a taxi reimbursed, and when does that apply?'
			);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });

			const answer = page.locator('[data-message-role="assistant"]').last();
			// "37" alone also matches the generating timer ("· 37s"), so the amount has to carry its unit.
			await expect(
				answer,
				'the answer never stated the 37 EUR cap that only the PDF holds'
			).toContainText(/37\s?(EUR|euros?)|€\s?37/i, { timeout: 120_000 });
			await expect(
				answer,
				'the answer missed the after-22:00 condition from the PDF'
			).toContainText(AFTER_TEN_PM);
			// One answer in five said only "the attached policy", so the person couldn't tell
			// which file was read. Its file name or its own title ("Northwind Volunteers: Travel and
			// Expenses Policy") both name it.
			await expect(answer, 'the answer did not name the document it read').toContainText(
				/expenses[-_ ]?policy|northwind/i
			);
			// The model has echoed the </document> wrapper and run on into "}]}]}…", echoed the opening
			// tag and run on into "./cite]./cite]…", and echoed a bare "<document>" before the full stop, which
			// neither pattern matched.
			await expect(
				answer,
				'the answer ended in the echoed closing tag or a run of closing brackets'
			).not.toContainText(/\/document|[\]})]{4}/);
			await expect(
				answer,
				'the answer echoed our opening document tag or ran on into cite markers'
			).not.toContainText(/document name=|cite\]/);
			await expect(answer, 'the answer echoed a bare <document> tag').not.toContainText(
				/<document\b/
			);
		});
	}
);

test(
	'with document attachments off, the composer refuses a PDF before anything is sent',
	{ tag: ['@preview-only', '@A6', '@CUR-987'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': false,
			// The text-only workaround would read the PDF; this test is the refusal with both off.
			'document-text-only': false
		});
		await signInAsFreshUser(page);
		await openChat(page);

		// The refusal is the chat's error banner (FileDropzone.svelte, CUR-2631), naming the refused type
		// in words (CUR-2839), where it used to list raw MIME types.
		await dropPdf(page);
		await expect(page.getByText(/application\//)).toHaveCount(0);
		await expect(
			page.getByText("This file type can't be attached here: PDF document."),
			'no refusal appeared for the dropped PDF'
		).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByText(NAME),
			'the PDF was attached even though document attachments are off'
		).toHaveCount(0);
	}
);

test(
	'with the scanner down, a dropped PDF is left out with the try-again line and the text is still answered',
	{ tag: ['@preview-only', '@A6', '@CUR-987', '@CUR-3405', '@CUR-3505'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const token = process.env.E2E_FAULT_INJECT_TOKEN;
		if (!token)
			throw new Error('E2E_FAULT_INJECT_TOKEN is not set, so the scanner-down fault cannot fire');
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': true,
			'agent-mode': false
		});
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
		await signInAsFreshUser(page);
		const composer = await openChat(page);
		// Row 9: the PDF can't be checked, so it is left out with a reason and the text answered.
		await journeyStep(page, 'A6', 9, async () => {
			await dropPdf(page);
			await expect(page.getByText(NAME).first()).toBeVisible({ timeout: 10_000 });

			await composer.fill(
				'According to the attached policy, how much is a taxi reimbursed? If nothing is attached, say "no file".'
			);
			await composer.press('Enter');
			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(
				turnDone(answer),
				'no finished answer: with the scanner down the text should still be answered' +
					warmupContext()
			).toBeVisible({ timeout: 120_000 });
			await expect(
				page.getByText("We couldn't check this file just now, so it wasn't added."),
				'the dropped PDF was not explained with the try-again line'
			).toBeVisible({ timeout: 15_000 });
			// The PDF stays in the sent message, marked not added, instead of vanishing from it.
			const sent = page.locator('[data-message-type="user"]').last();
			const leftOut = sent.locator('[data-left-out-file]');
			await expect(leftOut, 'the left-out PDF vanished from the sent message').toContainText(NAME);
			await expect(leftOut).toContainText('Not added');
			// And only as not added, never also as a sent attachment beside the note.
			await expect(
				sent.getByText(NAME),
				'the sent message shows the PDF as both sent and not added'
			).toHaveCount(1);
			await expect(
				answer,
				'the answer quoted the PDF, so an unchecked file reached the model'
			).not.toContainText(/37\s?(EUR|euros?)|€\s?37/i);
		});
	}
);

test(
	"CUR-4101: with the input screen's guard unreachable, a PDF turn is declined, never answered from the unscreened document",
	// @real-screen: the fault replaces the real screen's guard, and a PR preview otherwise stubs the screen.
	{ tag: ['@preview-only', '@real-screen', '@A6', '@CUR-987', '@CUR-4101'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const token = process.env.E2E_FAULT_INJECT_TOKEN;
		if (!token)
			throw new Error('E2E_FAULT_INJECT_TOKEN is not set, so the guard-down fault cannot fire');
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': true,
			'agent-mode': false
		});
		await page.route(CONVERSATION_POST, (route) =>
			route.request().method() === 'POST'
				? route.continue({
						headers: {
							...route.request().headers(),
							'x-e2e-fault-inject-token': token,
							'x-e2e-fault-inject': 'input_guard_unreachable'
						}
					})
				: route.continue()
		);
		await signInAsFreshUser(page);
		const composer = await openChat(page);
		await dropPdf(page);
		await expect(page.getByText(NAME).first()).toBeVisible({ timeout: 10_000 });

		await composer.fill('According to the attached policy, how much is a taxi reimbursed?');
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').last();
		// The document's text rides the turn's input screen (CUR-987 Q2), so a screen that cannot
		// answer closes the turn as couldn't-check rather than sending the text on unscreened.
		await expect(
			answer,
			"no couldn't-check decline: with the guard unreachable the PDF turn should be refused"
		).toContainText(/couldn['’]t finish the safety check/i, { timeout: 120_000 });
		await expect(
			answer,
			'the answer quoted the PDF, so unscreened document text reached the model'
		).not.toContainText(/37\s?(EUR|euros?)|€\s?37/i);
	}
);

test(
	'a PDF over the page limit is left out with a line naming the limit, and the text is still answered',
	{ tag: ['@preview-only', '@A6', '@CUR-3837', '@CUR-3405'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': true,
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		const composer = await openChat(page);
		const name = 'long-report.pdf';
		await dropPdf(page, TOO_MANY_PAGES_PDF, name);
		await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });

		await composer.fill('What is the capital of France? Answer in one word.');
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished answer: a PDF over the page limit should be left out and the text answered' +
				warmupContext()
		).toBeVisible({ timeout: 120_000 });
		await expect(
			page.getByText("This PDF has more than 1,000 pages, so it wasn't added."),
			'the long PDF was not explained with the page-limit line'
		).toBeVisible({ timeout: 15_000 });
		// The PDF stays in the sent message, marked not added, instead of vanishing from it.
		const leftOut = page
			.locator('[data-message-type="user"]')
			.last()
			.locator('[data-left-out-file]');
		await expect(leftOut, 'the long PDF vanished from the sent message').toContainText(name);
		await expect(leftOut).toContainText('Not added');
		await expect(answer, 'the question beside the long PDF was not answered').toContainText(
			/paris/i
		);
	}
);

test(
	"a PDF carrying the bank's test image refuses the turn, as the same photo sent alone would",
	{ tag: ['@preview-only', '@A6', '@CUR-987'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': true,
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		const composer = await openChat(page);
		const name = 'garden-report.pdf';
		await dropPdf(page, BANK_IMAGE_PDF, name);
		await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });

		// The client opts into prestream events, so the 422 arrives inside a 200 stream; Chromium keeps
		// no body for a streamed response, so the turn is fetched and fulfilled here to read it, as
		// csam-scan.spec.ts does for a photo.
		let turnBody = '';
		await page.route(CONVERSATION_POST, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const response = await route.fetch();
			turnBody = await response.text();
			await route.fulfill({ response, body: turnBody });
		});
		const question = 'What does the figure in this report show?';
		// Row 9: a picture inside the PDF matches the bank, so the whole turn is refused.
		await journeyStep(page, 'A6', 9, async () => {
			await composer.fill(question);
			await composer.press('Enter');
			await expect
				.poll(() => turnBody, {
					message:
						'the turn was not refused, so the picture inside the PDF was not matched against the bank',
					timeout: 60_000
				})
				.toMatch(/"statusCode":\s*422/);
			await expect(
				page.getByText(ABUSE_REFUSAL),
				'the refused turn showed no next step'
			).toBeVisible({ timeout: 15_000 });
			// A file left on the composer made a resend fail the same way.
			await expect(page.getByText(name), 'the refused PDF stayed on the composer').toHaveCount(0);
			await expect(
				page.locator('[data-message-role="assistant"]'),
				'a turn carrying a matched picture was answered'
			).toHaveCount(0);
		});
	}
);

test(
	'under document-text-only, a PDF is answered from its text and only a .txt of that text is stored',
	{ tag: ['@preview-only', '@A6', '@A3', '@CUR-987'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, {
			'document-attachments': false,
			'document-text-only': true,
			'agent-mode': false,
			// A3 row 17 opens My files to show what was kept.
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);
		const composer = await openChat(page);
		// The bank-image PDF on purpose: the full surface refuses this turn (the test above), so an
		// answer here shows the picture was never opened and only the text went on.
		const name = 'garden-report.pdf';
		// Row 6 for accounts on the text-only workaround: the PDF is answered from its text alone.
		await journeyStep(page, 'A6', 6, async () => {
			await dropPdf(page, BANK_IMAGE_PDF, name);
			await expect(
				page.getByText(name).first(),
				'the composer did not offer the PDF under document-text-only'
			).toBeVisible({ timeout: 10_000 });

			await composer.fill('What kind of report is attached? Answer in one short sentence.');
			await composer.press('Enter');
			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(
				answer,
				"the answer never named the garden report, so the PDF's text did not reach the model" +
					warmupContext()
			).toContainText(/garden/i, { timeout: 120_000 });
		});

		// A3 row 17: what Alpha keeps from an attached PDF is only its text, and My files shows it.
		await journeyStep(page, 'A3', 17, async () => {
			// My files gets the turn's copy in the background, so poll the listing until it lands.
			let paths: string[] = [];
			await expect
				.poll(
					async () => {
						const res = await page.request.get('/chat/api/storage');
						paths = res.ok()
							? ((await res.json()) as { files: { path: string }[] }).files.map((f) => f.path)
							: [];
						return paths.some((p) => p.endsWith(`${name}.txt`));
					},
					{ message: 'the text of the PDF never reached My files', timeout: 60_000 }
				)
				.toBe(true);
			expect(
				paths.filter((p) => p.endsWith('.pdf')),
				'the original PDF was stored under text-only'
			).toEqual([]);

			await page.goto('/chat/storage', { waitUntil: 'commit' });
			await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			await expect(
				page.getByText(`${name}.txt`).first(),
				'My files does not show the text copy of the PDF'
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(name, { exact: true })).toHaveCount(0);
		});
	}
);
