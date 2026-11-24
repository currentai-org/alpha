// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import type { BrowserContext, Locator } from '@playwright/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// ALIA opens its reasoning with no `<think>` and ends it with a bare `</think>`, so the server
// holds its output back until that tag (UntaggedReasoningHold) to keep the reasoning out of the answer.
// Nothing reached the page while it held: a visitor who picked ALIA saw no text and no reasoning
// panel for 5-36 s. The server now says the reasoning is held, without its text, and the page opens the
// reasoning panel for the wait. The stored answer is still built from released tokens alone.
//
// ALIA opens with an explicit `<think>`, so the hold releases at once
// and the reasoning streams under its tag, shown as it arrives (4-5 s after send on a preview deployment). Either path ends the blank wait, so the turn passes when either shows first.

type Stored = { id: string; content: string };

// The device's picker choice (routing/choice.ts): `auto`, or a catalog id picked from the list.
const CHOICE_KEY = 'alpha:model-choice';

async function openChat(page: Page, context: BrowserContext, choice: string) {
	await context.addInitScript(
		([key, value]) => {
			try {
				localStorage.setItem(key, value);
			} catch {
				/* storage unavailable */
			}
		},
		[CHOICE_KEY, choice] as const
	);
	await context.addInitScript(recordFirstShown);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// The stored pick is the subject, so the chat enters unpinned: the prod profile's `/chat/models/<id>`
	// entry would send to production's default and ALIA would never answer.
	await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

/**
 * Records when the turn first shows the visitor something: the Working… held-reasoning panel, or the
 * first text of the reply (reasoning that streams under its own `<think>`). A replayed ALIA
 * reply arrives whole in about 14 ms, so the panel is mounted and gone between two polls of a visibility
 * check; an observer installed before the send sees it however briefly it stays.
 */
function recordFirstShown() {
	const w = window as unknown as {
		__shownAt?: number;
		__shownBy?: string;
		__shownText?: string;
		__shownSettled?: boolean;
	};
	new MutationObserver(() => {
		if (w.__shownSettled) return;
		const streamedText = () =>
			document.querySelector('[data-message-role="assistant"] .prose')?.textContent ?? '';
		// The time is the first letter's; the text keeps growing until it has 20 letters or digits, so a
		// one-word first chunk ("The", "A") cannot match the start of the reasoning by chance.
		if (w.__shownBy === 'streamed') {
			const text = streamedText();
			w.__shownText = text.trim().slice(0, 200);
			w.__shownSettled = text.replace(/[^\p{L}\p{N}]+/gu, '').length >= 20;
			return;
		}
		if (w.__shownAt) return;
		const panel = document.querySelector('[data-testid="held-reasoning"]');
		if (panel?.textContent?.includes('Working…')) {
			w.__shownAt = Date.now();
			w.__shownBy = 'held';
			w.__shownSettled = true;
			return;
		}
		const text = streamedText();
		// A letter or digit, so a lone '…' or '-' never counts as shown and the reasoning check below
		// always has something to compare.
		if (/[\p{L}\p{N}]/u.test(text)) {
			w.__shownAt = Date.now();
			w.__shownBy = 'streamed';
			w.__shownText = text.trim().slice(0, 200);
		}
	}).observe(document, { childList: true, subtree: true, characterData: true });
}

/** When the turn first showed something, in ms since the epoch (0 while it has not), and by which path. */
async function firstShown(page: Page): Promise<{ at: number; by: string; text: string }> {
	return page.evaluate(() => {
		const w = window as unknown as { __shownAt?: number; __shownBy?: string; __shownText?: string };
		return { at: w.__shownAt ?? 0, by: w.__shownBy ?? '', text: w.__shownText ?? '' };
	});
}

/** Letters and digits only, lower-cased, so rendered markdown compares with its stored source. */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The stored answer, read from the conversation the page is on. */
async function storedTurn(page: Page, answer: Locator): Promise<Stored | undefined> {
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await answer.getAttribute('data-message-id');
	return body.json?.messages?.find((m) => m.id === id);
}

test(
	'a picked ALIA turn ends its blank wait within 30 s, with the held-reasoning panel or its streamed text, and stores none of its reasoning as the answer',
	{ tag: ['@F2', '@needs-alia'] },
	async ({ page, context }) => {
		test.setTimeout(150_000);
		const composer = await openChat(page, context, 'alia-40b');
		await composer.fill(
			'Explica en dos frases por qué el cielo es azul y por qué los atardeceres son rojos.'
		);
		const sentAt = Date.now();
		await composer.press('Enter');

		const answer = page.locator('[data-message-role="assistant"]').first();
		const heldPanel = answer.getByTestId('held-reasoning');
		await expect
			.poll(async () => (await firstShown(page)).at, {
				message:
					'neither a Working… panel nor any streamed text showed while ALIA reasoned' +
					warmupContext(),
				timeout: 30_000
			})
			.toBeGreaterThan(0);
		const shown = await firstShown(page);
		test.info().annotations.push({
			type: `first shown (${shown.by}) ms after send`,
			description: String(shown.at - sentAt)
		});

		await expect(
			turnDone(answer),
			'the ALIA turn never finished within 120s' + warmupContext()
		).toBeVisible({
			timeout: 120_000
		});
		await expect(heldPanel, 'the held-reasoning panel outlived the turn').toHaveCount(0);

		const stored = await storedTurn(page, answer);
		expect(stored, 'the answer was not found in the stored conversation').toBeTruthy();
		const content = stored?.content ?? '';
		// Released reasoning is folded into an opening <think> block; anything else that closes a think
		// block means reasoning reached the answer text.
		if (content.includes('</think>')) {
			expect(
				content.trimStart().startsWith('<think>'),
				'reasoning stored outside its think block'
			).toBe(true);
		}
		const answerText = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
		// A streamed first show counts only if what showed was reasoning. Had the page shown nothing until
		// the answer began, its first text would be the answer's, and that is the blank wait.
		if (shown.by === 'streamed') {
			const reasoning = content.match(/^\s*<think>([\s\S]*?)<\/think>/)?.[1] ?? '';
			// Read again now the turn is done: the first read came at the first letter, before the
			// observer had grown the text to the 20 letters compared here.
			const settled = await firstShown(page);
			// The stored reasoning has to begin with it: the first 20 letters or digits shown, which a
			// first chunk of the answer will not share with the reasoning's opening.
			expect(
				plain(reasoning).startsWith(plain(settled.text).slice(0, 20)),
				`the first text shown ("${settled.text.slice(0, 60)}") was not the start of ALIA's reasoning`
			).toBe(true);
		}
		expect(
			answerText.length,
			'the stored ALIA turn has no answer outside its reasoning'
		).toBeGreaterThan(0);
		// No time bound here: the panel opens on ALIA's first held chunk, which comes after the first
		// message creates its conversation and navigates (~3 s on a preview), then the input gate,
		// retrieval, the maths planner and the gateway's first byte. Most preview runs replay ALIA, so the
		// time mostly measures our own pipeline. It is recorded above; on www it is compared with a Large 3
		// turn's first text (Done when).
	}
);
