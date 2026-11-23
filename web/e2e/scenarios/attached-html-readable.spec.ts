// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// an HTML file attached in chat went to the model as raw markup, nav and cookie banner
// included, because text/html matched the text/* allowlist. Readability now runs on every HTML file
// (its `readable-extract` flag is retired), so only the article reaches the model. The nav carries one codeword and the article another,
// so the answer can only list both if the page arrived raw.
test(
	'an attached web page reaches the model as its article: the nav codeword never appears in the answer',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		// One real turn, waited on for up to 120s, after up to 60s of setup.
		test.setTimeout(240_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await signInAsFreshUser(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		// Fixed, not random: a PR run answers from a recording keyed on the request, so the page must be
		// the same bytes every run (record it once with the `scenarios:record` label).
		const tag = 'T7Q4';
		const navWord = `ZK-NAV-${tag}`;
		const bodyWord = `ZK-BODY-${tag}`;
		const article = Array.from(
			{ length: 6 },
			(_, i) =>
				`<p>Port Tessaly's harbour log, entry ${i + 1}: the high tide arrived forty minutes early, and the harbourmaster asked small boats to stay moored until Thursday while the sea wall is inspected.</p>`
		).join('\n');
		const html = `<!doctype html><html><head><title>Port Tessaly tides</title></head><body>
<nav><a href="/">Home</a> <a href="/news">News</a> <span>${navWord}</span></nav>
<div class="cookie-banner">We use cookies to improve your visit. Accept all?</div>
<article><h1>Port Tessaly tides</h1>
<p>Field code ${bodyWord} marks this report.</p>
${article}
</article>
<footer>Copyright Port Tessaly Gazette. Contact us.</footer>
</body></html>`;
		const name = `tessaly-${tag.toLowerCase()}.html`;

		await expect(async () => {
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({ name, mimeType: 'text/html', buffer: Buffer.from(html) });
			await expect(page.getByText(name).first()).toBeVisible({ timeout: 5_000 });
		}).toPass({ timeout: 45_000 });
		await composer.fill(
			'List every code in the attached document that starts with "ZK-", exactly as written, one per line. If there are none, say NONE.'
		);
		await composer.press('Enter');

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'the turn with the web page attached did not finish'
		).toBeVisible({
			timeout: 120_000
		});
		await expect(answer, 'the article text did not reach the model').toContainText(bodyWord);
		await expect(
			answer,
			'the nav reached the model, so the page went in as raw markup and Readability never ran'
		).not.toContainText(navWord);
	}
);
