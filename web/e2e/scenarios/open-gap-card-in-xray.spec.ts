// e2e-product: @chat
// e2e-area: @provenance
import type { Locator } from '@playwright/test';
import { test, expect, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { openComposerTool, toolGroup } from './helpers/composerMenu';
import { warmupContext } from './helpers/warmup';

// The "open gap · help build it" invitation for the web-search index shows only inside X-ray, never
// under an ordinary answer. Under the answer it read as internal copy leaking into the
// reply, in English under French and Spanish answers and under answers that had nothing to do with
// search. X-ray's "This answer" tab is where a person asks what went into the answer, so the gap the
// web search runs into belongs there.
//
// Each test sets web search to Always so the turn grounds on web sources, the only turn that offers
// this gap, and checks the stored turn really did: without sources, "no card under the answer" would
// prove nothing. The visitor then opens X-ray the way the product offers it, from the answer's own
// "How this was made" link.

type Stored = { id: string; webSearch?: { sources?: unknown[] } };

async function askWithWebSearch(page: Page, question: string, uiLanguage: 'en' | 'fr') {
	const welcomeDialog = page.locator('[data-welcome]');
	await page.addLocatorHandler(welcomeDialog, async () => {
		await welcomeDialog.locator('[data-welcome-start]').click();
	});
	await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
	const composer = page.locator('[data-chat-input]');
	await composer.click({ timeout: 30_000 });

	// These controls follow the interface language.
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
		message.getByRole('button', { name: uiLanguage === 'fr' ? 'Réessayer' : 'Retry', exact: true }),
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
		'the turn was set to Always search the web but grounded on no web sources, so it offers no open gap to look for'
	).toBeGreaterThan(0);
	return message;
}

/** Opens X-ray on `message` from its "How this was made" link and returns X-ray's "This answer" tab. */
async function openThisAnswer(page: Page, message: Locator) {
	await message.locator('[data-how-made]').click({ timeout: 15_000 });
	const panel = page.locator('[data-xray-panel]');
	await expect(panel, 'X-ray did not open from the answer\'s "How this was made" link').toBeVisible(
		{
			timeout: 15_000
		}
	);
	// The tab names are not translated yet; "This answer" is X-ray's default tab either way.
	await panel.getByRole('tab', { name: 'This answer' }).click({ timeout: 10_000 });
	return panel;
}

test.describe('an English browser', () => {
	test.use({ locale: 'en-US' });

	test(
		"the first web-searched answer carries no open-gap card under it, and X-ray's This answer tab offers it",
		{ tag: ['@A2'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			const message = await askWithWebSearch(
				page,
				'What is the capital of Japan? Answer in one sentence.',
				'en'
			);
			await expect(
				page.locator('[data-gap-invite]'),
				'an open-gap card shows on the page before X-ray is opened, so it still sits under the answer'
			).toHaveCount(0);

			const panel = await openThisAnswer(page, message);
			const card = panel.getByRole('note', { name: 'An open gap in the stack' });
			await expect(
				card,
				"X-ray's This answer tab has no open-gap card for a web-searched answer"
			).toBeVisible({
				timeout: 15_000
			});
			await expect(
				message.locator('[data-gap-invite]'),
				'opening X-ray put the open-gap card under the answer as well'
			).toHaveCount(0);

			// Plain words for the person who asked, not roadmap copy.
			await expect(card).toContainText('No open search index covers the whole web yet.');
			await expect(card, 'the open-gap card still talks roadmap to the visitor').not.toContainText(
				/Google-scale|open stack/
			);
			// An invitation, not a fact about the answer: no provenance line inside it, and its
			// sentence stops before the call to action.
			await expect(
				card.locator('[title*="served via"], [data-provenance]'),
				'the open-gap note contains the provenance line, so the two read as one readout'
			).toHaveCount(0);
			expect(
				(await card.innerText()).replace(/\s+/g, ' '),
				'the gap sentence runs straight into its call to action with no stop between them'
			).toMatch(/\.\s*Help build it/);

			// The one action opens the contribution form.
			await card.getByRole('button', { name: /Help build it/ }).click();
			await expect(
				page.locator('[data-contribute]'),
				'"Help build it" in X-ray did not open the Get involved form'
			).toBeVisible({ timeout: 10_000 });
		}
	);
});

// The card follows the browser's language, in X-ray as it did under the answer.
test.describe('a French browser', () => {
	test.use({ locale: 'fr-FR' });

	test(
		'a French web-searched answer carries no open-gap card under it, and X-ray offers it in French',
		{ tag: ['@A2'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			const message = await askWithWebSearch(
				page,
				'Quelle est la capitale du Japon ? Réponds en une phrase.',
				'fr'
			);
			await expect(
				page.locator('[data-gap-invite]'),
				'an open-gap card sits under a French answer'
			).toHaveCount(0);

			const panel = await openThisAnswer(page, message);
			const card = panel.locator('[data-gap-invite]');
			await expect(card, 'X-ray has no open-gap card for a French web-searched answer').toBeVisible(
				{
					timeout: 15_000
				}
			);
			await expect(card, 'the open-gap card in X-ray is not in French').toContainText(
				'Aider à la construire'
			);
			await expect(card).not.toContainText(/Open gap|Help build it|open stack/);
		}
	);
});
