// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { openComposerTool, toolGroup } from './helpers/composerMenu';
import { warmupContext } from './helpers/warmup';

// The first web-searched answer in a conversation carries the "open gap · help build it"
// card, written in the browser's language (CUR-2394). An English browser asking
// in French or Spanish must not get the English card under the answer, where it
// would read as internal copy leaking into the reply (CUR-2377). The card shows only under an answer in its own
// language. Every test picks "Always" in the composer's Tools menu so the turn searches the web, which
// is the only turn the card can appear on; the English test is the control that proves the card can
// render on this deployment at all, without which the French test's "no card" would prove nothing.

type Stored = { id: string; webSearch?: { sources?: unknown[] } };

async function askWithWebSearch(page: Page, question: string, uiLanguage: 'en' | 'fr' = 'en') {
	const welcomeDialog = page.locator('[data-welcome]');
	await page.addLocatorHandler(welcomeDialog, async () => {
		await welcomeDialog.locator('[data-welcome-start]').click();
	});
	await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
	const composer = page.locator('[data-chat-input]');
	await composer.click({ timeout: 30_000 });

	// These controls follow the interface language, even when the question uses another language.
	const tool = uiLanguage === 'fr' ? 'Recherche web' : 'Web search';
	const group = toolGroup(page, tool);
	await openComposerTool(
		page,
		tool,
		{ timeout: 15_000 },
		uiLanguage === 'fr' ? /^Ajouter des fichiers et des outils/ : undefined
	);
	const always = group.getByRole('menuitemradio', {
		name: uiLanguage === 'fr' ? /^Toujours\b/ : /^Always\b/
	});
	await always.click();
	await expect(always, 'web search never moved to Always').toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');

	await composer.fill(question);
	await composer.press('Enter');
	const message = page.locator('[data-message-role="assistant"]').first();
	await expect(
		message.getByRole('button', {
			name: uiLanguage === 'fr' ? 'Réessayer' : 'Retry',
			exact: true
		}),
		`"${question}" never finished within 90s` + warmupContext()
	).toBeVisible({ timeout: 90_000 });
	await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await message.getAttribute('data-message-id');
	const stored = body.json?.messages?.find((m) => m.id === id);
	expect(
		stored?.webSearch?.sources?.length ?? 0,
		'the turn was set to Always search the web but grounded on no web sources, so the card had no turn to appear on'
	).toBeGreaterThan(0);
	return message;
}

test.describe('an English browser', () => {
	test.use({ locale: 'en-US' });

	test(
		'asking in French gets no English open-gap card under the French answer',
		{ tag: ['@A2', '@CUR-2377'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			const message = await askWithWebSearch(
				page,
				'Quelle est la capitale du Japon ? Réponds en une phrase.'
			);
			await expect(
				message.locator('[data-gap-invite]'),
				'an English "open gap · help build it" card sits under a French answer'
			).toHaveCount(0);
		}
	);

	test(
		'asking the same question in English still gets the open-gap card, in words for the person who asked',
		{ tag: ['@A2', '@F2', '@CUR-2377', '@CUR-2885'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			const message = await askWithWebSearch(
				page,
				'What is the capital of Japan? Answer in one sentence.'
			);
			await expect(
				message.locator('[data-gap-invite]'),
				'the first web-searched English answer lost its open-gap card'
			).toHaveCount(1, { timeout: 15_000 });
			// A card sentence like "The open stack still needs a Google-scale open web search index" reads as roadmap
			// copy under an answer about a mountain (CUR-2885).
			const card = message.locator('[data-gap-invite]');
			await expect(card).toContainText('No open search index covers the whole web yet.');
			await expect(card, 'the open-gap card still talks roadmap to the visitor').not.toContainText(
				/Google-scale|open stack/
			);
		}
	);
});

// The card a French browser gets is written in French (CUR-2394). The language heuristic ranks short
// French answers Spanish first, which can hide the card from French browsers, so this is
// the same one-sentence question the English-browser test asks in French.
test.describe('a French browser', () => {
	test.use({ locale: 'fr-FR' });

	test(
		'asking in French gets the open-gap card in French',
		{ tag: ['@A2', '@CUR-2394'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			const message = await askWithWebSearch(
				page,
				'Quelle est la capitale du Japon ? Réponds en une phrase.',
				'fr'
			);
			const card = message.locator('[data-gap-invite]');
			await expect(
				card,
				'the first web-searched French answer in a French browser got no open-gap card'
			).toHaveCount(1, { timeout: 15_000 });
			await expect(card, 'the open-gap card is not in French').toContainText(
				'Aider à la construire'
			);
			await expect(card).not.toContainText(/Open gap|Help build it|open stack/);
		}
	);
});
