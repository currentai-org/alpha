// e2e-product: @chat
// e2e-area: @history @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';
import { turnDone } from './helpers/turn';

// One conversation open in two tabs, both sending (CUR-2806). Every save of a turn used to write the
// conversation's whole message list from the copy that request loaded, so whichever save landed last
// erased the other tab's turn. `settlePendingAnswers` only waits 5 s for an earlier answer, so tab A
// is held with `latency_30s` (a 30 s answer that does arrive) to walk the case past that wait. Tab B
// answers on the real model inside A's wait, and A's late save must not take B's turn with it.
//
// Tab B names the last answer it had seen as its parent, but the server appends B's turn after tab
// A's, so the conversation reads as one thread with both turns in order and no "1 / 2" version
// control hiding either. Nothing being erased is read from the stored conversation, the record a
// reload renders from; the order is read from both tabs after a reload.

const CONVERSATION_PATH = /\/chat\/conversation\/([a-f0-9]+)/;
const SLOW_QUESTION = 'Tab A, held on purpose: name one mountain.';
const FAST_QUESTION = 'Tab B, sent while tab A waits: name one lake.';
const LATENCY_REPLY = /it is the latency fault/;
const START_CHATTING = /start chatting/i;

type StoredMessage = { id: string; from: string; content?: string; ancestors?: string[] };

async function storedMessages(page: Page, id: string): Promise<StoredMessage[]> {
	const res = await page.request.get(
		`${new URL(page.url()).origin}/chat/api/v2/conversations/${id}`
	);
	if (!res.ok()) return [];
	const body = (await res.json()) as {
		json?: { messages?: StoredMessage[] };
		messages?: StoredMessage[];
	};
	return body.json?.messages ?? body.messages ?? [];
}

async function send(page: Page, text: string): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(text);
	await composer.press('Enter');
}

async function expectOneThread(tab: Page): Promise<void> {
	await expect(tab.getByTestId('chat-error-toast')).toHaveCount(0);
	// A question carries data-message-type="user" (ChatMessage.svelte); only answers carry a role.
	const questions = tab.locator('[data-message-type="user"]');
	await expect(questions, 'the thread is not three questions: river, tab A, tab B').toHaveCount(3, {
		timeout: 15_000
	});
	await expect(
		questions,
		"the thread is not river, then tab A's question, then tab B's"
	).toContainText(['Name one river in Africa.', SLOW_QUESTION, FAST_QUESTION]);
	await expect(tab.getByRole('button', { name: 'Previous version' })).toHaveCount(0);
	const answers = tab.locator('[data-message-role="assistant"]');
	await expect(answers, 'the thread is not three turns: river, tab A, tab B').toHaveCount(3);
	await expect(answers.nth(1).getByText(LATENCY_REPLY)).toBeVisible();
	const answerB = answers.last();
	await expect(
		answerB.getByText(LATENCY_REPLY),
		"tab A's answer under tab B's question"
	).toHaveCount(0);
	await expect(answerB.getByText(/No provenance for this answer/)).toHaveCount(0);
}

test(
	'two tabs sending in one conversation keep both turns, even when one answer outlasts the save wait',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page: tabA }) => {
		test.setTimeout(180_000);
		const welcomeA = tabA.getByRole('dialog', { name: 'Welcome to Alpha' });
		await tabA.addLocatorHandler(welcomeA, async () => {
			await welcomeA.getByRole('button', { name: START_CHATTING }).click();
		});
		await tabA.goto(chatEntry(), { waitUntil: 'commit' });
		await send(tabA, 'Name one river in Africa.');
		await tabA.waitForURL(CONVERSATION_PATH, { timeout: 30_000 });
		const id = CONVERSATION_PATH.exec(tabA.url())![1];
		await expect(turnDone(tabA.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 60_000
		});

		const tabB = await tabA.context().newPage();
		const welcomeB = tabB.getByRole('dialog', { name: 'Welcome to Alpha' });
		await tabB.addLocatorHandler(welcomeB, async () => {
			await welcomeB.getByRole('button', { name: START_CHATTING }).click();
		});
		await tabB.goto(tabA.url(), { waitUntil: 'commit' });
		await expect(tabB.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		await installFaultInjectionHeader(tabA, 'latency_30s');
		await send(tabA, SLOW_QUESTION);
		await expect
			.poll(async () => (await storedMessages(tabA, id)).some((m) => m.content === SLOW_QUESTION), {
				message: "tab A's question was never saved, so tab B would not be racing it",
				timeout: 20_000
			})
			.toBe(true);

		await journeyStep(tabA, 'F2', 8, async () => {
			await send(tabB, FAST_QUESTION);
			await expect(
				turnDone(tabB.locator('[data-message-role="assistant"]').last()),
				"tab B's answer never finished"
			).toBeVisible({ timeout: 90_000 });
			// Any of tab A's answers: tab B's turn can reach tab A first and sit last (CUR-3054).
			// expectOneThread pins the order after the reload.
			await expect(
				tabA.locator('[data-message-role="assistant"]').filter({ hasText: LATENCY_REPLY }),
				"tab A's held answer never arrived"
			).toBeVisible({ timeout: 60_000 });

			await expect
				.poll(
					async () => {
						const messages = await storedMessages(tabA, id);
						const slowQ = messages.find((m) => m.from === 'user' && m.content === SLOW_QUESTION);
						const fastQ = messages.find((m) => m.from === 'user' && m.content === FAST_QUESTION);
						const fastA = fastQ
							? messages.find((m) => m.from === 'assistant' && m.ancestors?.at(-1) === fastQ.id)
							: undefined;
						return {
							slowQuestion: messages.some((m) => m.from === 'user' && m.content === SLOW_QUESTION),
							slowAnswer: messages.some(
								(m) => m.from === 'assistant' && LATENCY_REPLY.test(m.content ?? '')
							),
							fastQuestion: Boolean(fastQ),
							fastAnswerHasWords: Boolean(fastA?.content?.trim()),
							fastFollowsSlow: Boolean(slowQ && fastQ?.ancestors?.includes(slowQ.id))
						};
					},
					{ message: "a tab's turn was erased from the stored conversation", timeout: 15_000 }
				)
				.toEqual({
					slowQuestion: true,
					slowAnswer: true,
					fastQuestion: true,
					fastAnswerHasWords: true,
					fastFollowsSlow: true
				});
		});

		// After a reload each tab shows the one thread: tab A's turn, then tab B's, each question over
		// its own answer (CUR-2860), and no version control, since neither turn is a branch of the other.
		await tabB.reload();
		await expect(tabB.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
		await expectOneThread(tabB);

		await tabA.reload();
		await expect(tabA.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
		await expectOneThread(tabA);
	}
);
