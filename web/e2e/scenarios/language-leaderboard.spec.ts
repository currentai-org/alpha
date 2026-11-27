// e2e-product: @chat @site
// e2e-area: @models
import { expect, test } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';

// the public language leaderboard. A visitor reaches it from the composer's Language panel,
// picks a language, switches to one model across languages, and opens the evidence behind a score.
// The checks are the page's rules, not today's numbers, so a new benchmark import keeps them green:
// an unmeasured row never shows a percentage, a measured one always does, a small sample says so,
// and the model view lists every language the language picker offers.

test(
	'the language leaderboard opens from the Language panel; unmeasured rows never show a %, measured rows show their evidence',
	{ tag: ['@preview-only'] },
	async ({ page, context }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog
				.getByRole('button', { name: /start chatting|^skip$/i })
				.first()
				.click();
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Language: how Alpha picks a model for yours' }).click();
		const panel = page.locator('[data-language-support-panel]');
		await expect(panel).toBeVisible({ timeout: 15_000 });

		const opened = context.waitForEvent('page');
		await panel.getByRole('link', { name: 'See each model’s score in every language' }).click();
		const board = await opened;
		await board.waitForLoadState('domcontentloaded');
		// Chat serves the leaderboard itself: its scores, models and components are all chat's.
		await expect(board).toHaveURL(/\/(chat\/)?languages(\?|$)/);
		await expect(board).not.toHaveURL(/\/alpha\/languages/);
		await expect(board.locator('[data-language-leaderboard]')).toBeVisible({ timeout: 30_000 });

		// Language view: pick Catalan and check every row against the rules.
		// The language picker searches with typos: "ctln" finds Catalan.
		const languageInput = board.locator('[data-leaderboard-language-select]');
		await languageInput.click();
		await languageInput.press('ControlOrMeta+a');
		await languageInput.pressSequentially('ctln');
		await board.getByRole('option', { name: /^Catalan/ }).click();
		await expect(board).toHaveURL(/language=cat/);
		const rows = board.locator('[data-leaderboard-list="language"] [data-leaderboard-row]');
		await expect(rows.first()).toBeVisible();
		for (const row of await rows.all()) {
			const status = await row.getAttribute('data-status');
			const score = row.locator('[data-leaderboard-score]');
			if (status === 'not-measured') {
				await expect(score).toHaveText('Not measured yet');
				await expect(score).not.toContainText('%');
			} else {
				await expect(score).toHaveText(/^\d{1,3}%/);
			}
			if (status === 'too-few') await expect(row).toContainText('Too few questions to compare');
		}

		// The evidence behind a measured score opens from its row and links to the run.
		const measured = board
			.locator(
				'[data-leaderboard-list="language"] [data-leaderboard-row]:not([data-status="not-measured"])'
			)
			.first();
		await measured.locator('[data-leaderboard-details-toggle]').click();
		const details = measured.locator('[data-leaderboard-details]');
		await expect(details).toContainText(/\d+ of \d+ questions/);
		await expect(details.getByRole('link')).toHaveAttribute('href', /^https:\/\//);

		// Model view keeps the language in the URL and lists every language the picker offers.
		await board.getByRole('tab', { name: 'By model' }).click();
		await expect(board).toHaveURL(/view=model/);
		await expect(board).toHaveURL(/language=cat/);
		const modelInput = board.locator('[data-leaderboard-model-select]');
		await modelInput.click();
		await modelInput.press('ControlOrMeta+a');
		await modelInput.pressSequentially('bielik');
		await board.getByRole('option', { name: 'Bielik 11B v3' }).click();
		await expect(board).toHaveURL(/model=bielik-11b/);
		await board.getByRole('tab', { name: 'By language' }).click();
		await languageInput.fill('');
		await board.getByRole('button', { name: 'Show languages' }).click();
		const languageCount = await board.getByRole('option').count();
		await board.keyboard.press('Escape');
		await board.getByRole('tab', { name: 'By model' }).click();
		await expect(
			board.locator('[data-leaderboard-list="model"] [data-leaderboard-row]')
		).toHaveCount(languageCount);

		// The way to help is at the top, pointed at Alpha's Contribute page.
		await expect(board.locator('[data-leaderboard-contribute-link]')).toHaveAttribute(
			'href',
			/settings\/contribute/
		);

		// A link shared before the move still opens the leaderboard on the language it named.
		await board.goto('/alpha/languages?view=language&language=cat', {
			waitUntil: 'domcontentloaded'
		});
		await expect(board).toHaveURL(/\/(chat\/)?languages\?view=language&language=cat$/);
		await expect(
			board.locator('[data-leaderboard-list="language"] [data-leaderboard-row]').first()
		).toBeVisible({ timeout: 30_000 });
	}
);
