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
	await context.addInitScript(recordHeldPanel);
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
 * Records when a Working… held-reasoning panel first enters the page. A replayed ALIA reply arrives
 * whole in about 14 ms, so the panel is mounted and gone between two polls of a visibility check; an
 * observer installed before the send sees it however briefly it stays.
 */
function recordHeldPanel() {
	const w = window as unknown as { __heldPanelAt?: number };
	new MutationObserver(() => {
		if (w.__heldPanelAt) return;
		const panel = document.querySelector('[data-testid="held-reasoning"]');
		if (panel?.textContent?.includes('Working…')) w.__heldPanelAt = Date.now();
	}).observe(document, { childList: true, subtree: true, characterData: true });
}

/** When the Working… panel first appeared, in ms since the epoch, or 0 while it has not. */
async function heldPanelAt(page: Page): Promise<number> {
	return page.evaluate(() => (window as unknown as { __heldPanelAt?: number }).__heldPanelAt ?? 0);
}

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
	'a picked ALIA turn opens the reasoning panel while its reasoning is held, and stores none of it as the answer',
	{ tag: ['@F2', '@CUR-3942'] },
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
			.poll(() => heldPanelAt(page), {
				message: 'no Working… reasoning panel opened while ALIA reasoned' + warmupContext(),
				timeout: 30_000
			})
			.toBeGreaterThan(0);
		const panelMs = (await heldPanelAt(page)) - sentAt;
		test.info().annotations.push({
			type: 'held-reasoning panel ms after send',
			description: String(panelMs)
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
		expect(
			answerText.length,
			'the stored ALIA turn has no answer outside its reasoning'
		).toBeGreaterThan(0);
		// No time bound here: the panel opens on ALIA's first held chunk, which comes after the first
		// message creates its conversation and navigates (~3 s on a preview), then the input gate,
		// retrieval, the maths planner and the gateway's first byte. Most preview runs replay ALIA, so the
		// time mostly measures our own pipeline. It is recorded above; on www it is compared with a Large 3
		// turn's first text (CUR-3942 Done when).
	}
);
