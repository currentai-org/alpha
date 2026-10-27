// e2e-product: @chat
// e2e-area: @auth @turn
import { test, expect, type Page } from './helpers/test';
import { pinnedChatEntry } from './helpers/servedModel';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { journeyStep } from './helpers/journeyStep';
import { installFaultInjectionHeader, type FaultInjectionName } from './helpers/faultInjection';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';

// A signed-in account takes a different turn path from a guest (the native harness,
// CUR-2734), and every F2 and C3 spec ran as a guest (CUR-2807). These walk the same outcomes once more as a
// fresh signed-in account: a first answer, a rate-limited Large 3, a timed-out turn, and Retry after
// a failed send. The faults are preview-only (faultInjection.ts), and so is the test session
// (helpers/session.ts).

const LARGE4 = LARGE4_MODEL;
const CONVERSATION_PATH = /\/conversation\/([a-f0-9]+)/;
const START_CHATTING = /start chatting/i;

type StoredMessage = {
	from: string;
	content?: string;
	routerMetadata?: { model?: string };
	failover?: { from?: string; to?: string };
};

async function signedInAt(page: Page, path: string, fault?: FaultInjectionName) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await welcomeDialog.getByRole('button', { name: START_CHATTING }).click();
	});
	await signInAsFreshUser(page);
	const armed = fault ? await installFaultInjectionHeader(page, fault) : undefined;
	await page.goto(path, { waitUntil: 'commit' });
	return armed;
}

async function send(page: Page, text: string): Promise<string> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(text);
	await composer.press('Enter');
	await page.waitForURL(CONVERSATION_PATH, { timeout: 30_000 });
	return CONVERSATION_PATH.exec(page.url())![1];
}

async function storedAnswer(page: Page, id: string): Promise<StoredMessage | undefined> {
	const res = await page.request.get(`/chat/api/v2/conversations/${id}`);
	const body = (await res.json()) as { json?: { messages?: StoredMessage[] } };
	return (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
}

test(
	'signed in, a first message gets an answer with words, credited to the model that wrote it',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signedInAt(page, '/chat');
		const id = await send(page, 'Name one river in Europe.');

		await journeyStep(
			page,
			'F2',
			3,
			async () => {
				const reply = page.locator('[data-message-role="assistant"]').last();
				await expect(
					turnDone(reply),
					'the signed-in turn never finished' + warmupContext()
				).toBeVisible({
					timeout: 90_000
				});
				await expect(
					reply.getByRole('alert'),
					'the signed-in turn ended on a failure notice'
				).toHaveCount(0);
				const answer = await storedAnswer(page, id);
				expect(answer?.content?.trim() ?? '', 'the stored answer has no words in it').not.toBe('');
				expect(
					answer?.routerMetadata?.model ?? '',
					'the stored answer names no model, so the badge cannot say who wrote it'
				).not.toBe('');
				await expect(
					reply.locator('[data-how-made]'),
					'the answer carries no line naming the model that wrote it'
				).toBeVisible();
			},
			'signed in'
		);
	}
);

test(
	'signed in, a rate-limited Large 4 turn ends on the busy notice, never answered by Mistral Medium (CUR-4383)',
	{ tag: ['@F2', '@preview-only', '@CUR-4383'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signedInAt(page, pinnedChatEntry(LARGE4), 'primary_lane_rate_limited');
		const id = await send(
			page,
			`CUR-4383 signed-in busy ${Date.now()}: what is the capital of Switzerland? One word.`
		);

		const reply = page.locator('[data-message-role="assistant"]').last();
		const busy = reply.getByText(/ is busy right now/);
		await expect(
			busy,
			'the turn did not end on the busy notice; if Medium answered, a lane to another model is back' +
				warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await expect(
			busy,
			'the busy notice names another model than the Large 4 that was picked'
		).toContainText(/Large 4/);
		const answer = await storedAnswer(page, id);
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Large 4`
		).toBeUndefined();
		expect(
			answer?.routerMetadata?.model ?? '',
			'the stored turn names Mistral Medium as the model that answered'
		).not.toMatch(/mistral-medium/i);
	}
);

test(
	'signed in, a timed-out turn shows one error, in the turn itself, with one Retry',
	{ tag: ['@F2', '@C3', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await signedInAt(page, '/chat', 'generation_timeout');
		await send(page, 'Name one fruit.');

		await journeyStep(
			page,
			'C3',
			3,
			async () => {
				// The notice names the model that ran out of time, so match the sentence after it (CUR-3295).
				const timedOut = /took too long to respond\. Please try again\./;
				const reply = page.locator('[data-message-role="assistant"]').last();
				await expect(
					reply.getByText(timedOut),
					'the forced timeout never surfaced in the signed-in turn'
				).toBeVisible({ timeout: 90_000 });
				await expect(
					page.getByText(timedOut),
					'the timeout message is shown more than once'
				).toHaveCount(1);
				await expect(page.getByTestId('chat-error-toast')).toHaveCount(0);
				await expect(
					page.getByRole('button', { name: 'Retry' }),
					'more than one Retry is offered for one failed turn'
				).toHaveCount(1);
				await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
			},
			'signed in'
		);
	}
);

test(
	'signed in, pressing Retry after a failed send brings one fresh answer, with the question shown once',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const fault = await signedInAt(page, '/chat', 'chat_500');
		const question = 'What is the tallest mountain in Wales?';
		await send(page, question);

		const notice = page.locator('[data-message-role="assistant"]').last().getByRole('alert');
		await expect(
			notice,
			'the first send did not fail: the fault header did not reach the server'
		).toContainText(/The connection dropped before a reply arrived/, { timeout: 90_000 });
		fault?.disarm();

		await journeyStep(
			page,
			'F2',
			7,
			async () => {
				await notice.getByRole('button', { name: 'Retry' }).click();
				const reply = page.locator('[data-message-role="assistant"]').last();
				await expect(
					turnDone(reply),
					'Retry never brought a finished answer' + warmupContext()
				).toBeVisible({
					timeout: 90_000
				});
				await expect(
					reply.getByRole('alert'),
					'the answer after Retry ended on a notice'
				).toHaveCount(0);
				await expect(
					page.locator('[data-message-type="user"]').filter({ hasText: question }),
					'Retry left the question on the page twice, or lost it'
				).toHaveCount(1);
				await expect(
					page.locator('[data-message-role="assistant"]'),
					'Retry left a second answer bubble beside the first'
				).toHaveCount(1);
			},
			'signed in'
		);
	}
);
