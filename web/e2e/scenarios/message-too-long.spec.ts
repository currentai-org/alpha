// e2e-product: @chat
// e2e-area: @composer @turn
import { test, expect, type Page } from './helpers/test';
import { apertusLast, pinnedChatEntry, type ServedModel } from './helpers/servedModel';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';
import { UPSTREAM_UNANSWERED_ANNOTATION } from './helpers/upstreamAdvisory';

// A message longer than the model can read must not go out, come back as the gateway's
// context-length 400, and end on "couldn't answer this time. Press Retry", which would resend the same
// message and fail the same way. The server refuses it before calling and says to shorten it
// (CUR-2893).
//
// Reaching the refusal from the product takes a self-hosted model, whose lanes serve 32000 tokens,
// and a paste dense enough to be over it: 100,000 CJK characters are 300,000 bytes, which the
// refusing count reads as 60,000 tokens. English text at the paste cap fits (about 20,500 tokens
// measured), so it is never refused; fitHistory.spec.ts pins that side.

// The gateway's self-hosted families, named by the ids /chat/api/v2/models lists (harnessProfiles.ts).
const SELF_HOSTED = /apertus|sea-lion|bielik|alia/i;

async function selfHostedModel(page: Page): Promise<ServedModel> {
	const res = await page.request.get('/chat/api/v2/models');
	expect(res.ok(), `/chat/api/v2/models answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: ServedModel[] } | ServedModel[];
	const models = Array.isArray(body) ? body : (body.json ?? []);
	const pick = apertusLast(models).find((m) => SELF_HOSTED.test(m.id));
	expect(
		pick,
		`no self-hosted model offered here (${models.map((m) => m.id).join(', ')}), so no message can be over its context`
	).toBeTruthy();
	return pick!;
}

async function pasteAndSend(page: Page, paste: string, question: string) {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.evaluate((el, text) => {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		el.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
		);
	}, paste);
	await expect(
		page.getByText('Pasted Content').first(),
		'the paste did not become a chip, so the message is not the size this test is named for'
	).toBeVisible({ timeout: 10_000 });
	await composer.fill(question);
	await composer.press('Enter');
}

test(
	'a message over the model context is refused up front with "shorten it", never "press Retry"',
	{ tag: ['@CUR-2893', '@CUR-3731', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		const model = await selfHostedModel(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry(model.id), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		const paste = '春眠不覚暁処処聞啼鳥夜来風雨声花落知多少'.repeat(5_000);
		expect(paste.length).toBe(100_000);
		await composer.evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, paste);
		await expect(
			page.getByText('Pasted Content').first(),
			'the paste did not become a chip, so the message is not the size this test is named for'
		).toBeVisible({ timeout: 10_000 });
		await composer.fill('How many characters are in what I pasted?');
		const sentAt = Date.now();
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByText(`This message is too long for ${model.displayName} to read`),
			`no refusal on ${model.id}; "couldn't answer this time" here means the message went to the model and overflowed` +
				warmupContext()
		).toBeVisible({ timeout: 180_000 });
		// Refused before the input screen, so it does not wait on 126 guard calls. The wait
		// above keeps its old ceiling, and this is the bound the fix is held to.
		const refusedAfter = Date.now() - sentAt;
		expect(
			refusedAfter,
			`the refusal took ${Math.round(refusedAfter / 1000)} s, so the message waited on the input screen`
		).toBeLessThan(30_000);
		await expect(reply).not.toContainText(/couldn't answer this time/);
		await expect(reply).not.toContainText(/maximum context length/);
		// The planner reads text only (CUR-3011), so on this paste it would stamp "Total: 1 characters
		// (arithmetic checked by code)" above the refusal. A turn carrying a file is not planned.
		await expect(
			reply,
			'a count the planner made up without seeing the paste is stamped as checked'
		).not.toContainText(/arithmetic checked by code/);
	}
);

type StoredAnswer = { historyLeftOut?: number; routerMetadata?: { model?: string } };

// The assistant messages as the server stored them, read from the conversation the page is on.
async function storedAnswers(page: Page): Promise<StoredAnswer[]> {
	const id = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!id) throw new Error(`could not read a conversation id out of ${page.url()}`);
	const res = await page.request.get(`/chat/api/v2/conversations/${id}`);
	expect(res.ok(), `/chat/api/v2/conversations/${id} answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as {
		json?: { messages?: Array<StoredAnswer & { from: string }> };
	};
	return (body.json?.messages ?? []).filter((m) => m.from === 'assistant');
}

// The other half: a chat that grows past the context leaves its oldest exchanges out and answers,
// with a note under the answer saying so. Two English pastes at the cap are ~20,500 real tokens each,
// so the first turn fits a 32000-token lane whole and the second cannot carry the first along.
const SCREEN_UNFINISHED = /couldn't finish the safety check/;

async function growPastContext(page: Page, modelId: string) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(pinnedChatEntry(modelId), { waitUntil: 'commit' });

	const doc = (word: string) =>
		`The ${word} report is filed on time. `.repeat(2_800).slice(0, 100_000);
	const answers = page.locator('[data-message-role="assistant"]');
	const note = page.getByText('Older messages were left out');

	await pasteAndSend(page, doc('first'), 'In one word, which report is this?');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	// Any word in the answer's own prose will do: the question names "report", but a model may
	// answer "Repetitive confirmation.". The bubble outside `.prose` carries the
	// live "is working" log, which would match a bare word before any answer exists.
	await expect(
		answers.first().locator('.prose').first(),
		'the first turn wrote nothing' + warmupContext()
	).toContainText(/[A-Za-z]{2,}/, { timeout: 180_000 });
	await expect(
		page.getByRole('button', { name: 'Stop generating' }),
		'the first turn never finished'
	).toBeHidden({
		timeout: 120_000
	});
	await expect(answers.first()).not.toContainText(/couldn't answer this time/);
	// A 100k paste is 117 guard calls, and on the shared guard the screen gives up on most of them
	// (CUR-3749). The decline is prose too, so without this the red would blame the fitting.
	await expect(
		answers.first(),
		"the input screen didn't finish the first 100k paste, so nothing here reached the fitting (CUR-3749)"
	).not.toContainText(SCREEN_UNFINISHED);
	await expect(note, 'a chat that fits must not carry the note').toHaveCount(0);

	await pasteAndSend(page, doc('second'), 'In one word, which report is this?');
	const second = answers.nth(1);
	await expect(
		second.getByRole('button', { name: 'Retry' }),
		'the second turn never finished' + warmupContext()
	).toBeVisible({ timeout: 180_000 });
	await expect(
		second,
		"the input screen didn't finish the second 100k paste, so nothing here reached the fitting (CUR-3749)"
	).not.toContainText(SCREEN_UNFINISHED);
	const backup = second.locator('[title*="(backup — served in place of the primary model)"]');
	const servedBy = (await backup.count()) > 0 ? 'the backup lane' : 'the primary lane';
	test.info().annotations.push({ type: 'second turn served by', description: servedBy });
	return { second, servedBy };
}

test(
	'a chat grown past the model context answers with a note that older messages were left out',
	{ tag: ['@CUR-2893', '@preview-only', '@stub-screen'] },
	async ({ page }) => {
		test.setTimeout(420_000);
		const model = await selfHostedModel(page);
		const { second, servedBy } = await growPastContext(page, model.id);
		// A missing note has three causes, and each assertion below names one, so a red says whose it
		// is without anyone reading the page snapshot: the lane failed the turn, the server never left
		// anything out, or the server did and the page dropped the note.
		await expect(
			second,
			`the lane failed ${model.id}'s second turn (served by ${servedBy}): a provider fault, not the fitting`
		).not.toContainText(/couldn't answer this time|maximum context length/);
		const stored = await storedAnswers(page);
		// The note goes out with the answer's first token (generate.ts), so a lane that answered nothing
		// stores no note and no served model. That is the lane's capacity, not the fitting: say so, and
		// mark it so the gallery reads it as an upstream that did not answer (upstreamAdvisory.ts).
		if (!stored.at(-1)?.routerMetadata?.model) {
			test.info().annotations.push({
				type: UPSTREAM_UNANSWERED_ANNOTATION,
				description: `${model.id} stored no served model on the second turn`
			});
			throw new Error(
				`${model.id} answered nothing on the second turn (served by ${servedBy}, no served model stored): a capacity miss on that lane, which says nothing about the history fitting`
			);
		}
		expect(
			stored.at(-1)?.historyLeftOut ?? 0,
			`the server left nothing out of ${model.id}'s second turn (served by ${servedBy}, stored model ${stored.at(-1)?.routerMetadata?.model ?? 'unknown'}): the history fitting or this model's context size is wrong`
		).toBeGreaterThan(0);
		await expect(
			second.getByText('Older messages were left out'),
			`the server stored historyLeftOut=${stored.at(-1)?.historyLeftOut} on ${model.id}'s second turn, but the page shows no note: the client dropped it`
		).toBeVisible();
	}
);
