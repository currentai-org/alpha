// e2e-product: @chat
// e2e-area: @admin
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from './helpers/test';
import { startChattingPastWelcome } from './helpers/welcome';

// Copy edit mode (src/lib/i18n/copyEdit): a teammate edits interface text in place on a dev or
// preview build and takes the edits away as a file. The contract walked here is the one that has to
// hold for that to be safe: the text changes where they clicked, the change survives a reload, and the
// file they download carries it, with the original text alongside for `pnpm i18n:apply`.

const HEADING = 'Alpha instructions';

async function startEditing(page: Page) {
	await page.goto('/chat/settings/personalization?edit-text', { waitUntil: 'load' });
	const start = page.locator('[data-copy-edit-start]');
	await expect(start, 'opening edit mode did not ask where changes are saved').toBeVisible({
		timeout: 20_000
	});
	await page.locator('[data-copy-edit-start-browser]').click();
	await expect(start).toBeHidden();
}

test(
	'text edited in place changes on the page, survives a reload, and is in the downloaded file',
	{ tag: '@copy-edit' },
	async ({ page }) => {
		await startEditing(page);
		const heading = page.getByRole('heading', { level: 2, name: HEADING });
		await expect(heading).toBeVisible({ timeout: 20_000 });

		// A click on the text opens its editor in place instead of doing what the page would do.
		await heading.click();
		const editor = page.locator('[data-copy-edit-editor] textarea');
		await expect(editor, 'clicking the heading opened no editor').toBeVisible();
		await expect(editor).toHaveValue(HEADING);
		await editor.fill('Your instructions for Alpha');
		await editor.press('Enter');
		await expect(editor).toBeHidden();

		await expect(
			page.getByRole('heading', { level: 2, name: 'Your instructions for Alpha' })
		).toBeVisible();
		await expect(
			page.locator('[data-copy-edit-change="settings_instructionsTitle"]')
		).toBeVisible();

		// Kept in this browser on every change: a reload brings the edit and the mode back.
		await page.reload({ waitUntil: 'load' });
		await expect(
			page.getByRole('heading', { level: 2, name: 'Your instructions for Alpha' })
		).toBeVisible({
			timeout: 20_000
		});
		await expect(page.locator('[data-copy-edit-panel]')).toBeVisible();

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.locator('[data-copy-edit-download]').click()
		]);
		const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
		expect(saved.format).toBe('alpha-copy-edits');
		expect(saved.edits.en.settings_instructionsTitle).toEqual({
			text: 'Your instructions for Alpha',
			original: HEADING
		});

		// Leaving the mode puts the shipped text back; the edit stays in the browser for next time.
		await page.locator('[data-copy-edit-exit]').click();
		await expect(page.locator('[data-copy-edit-panel]')).toBeHidden();
		await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible();
	}
);

// A translator edits the French interface the same way, and the file keys the edit under
// `fr`, which is where `pnpm i18n:apply` writes it back.
test(
	'French text edited in place changes on the page, survives a reload, and is in the file under fr',
	{ tag: ['@copy-edit', '@CUR-3660'] },
	async ({ page, context, baseURL }) => {
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: baseURL as string }]);
		// The welcome is in French too, so it is pressed by its data hook, not its English name.
		const welcome = page.getByRole('dialog').filter({ has: page.locator('[data-welcome-start]') });
		await page.addLocatorHandler(welcome, () => startChattingPastWelcome(welcome));
		const original = 'Instructions pour Alpha';
		const edited = 'Vos instructions pour Alpha';

		await startEditing(page);
		const heading = page.getByRole('heading', { level: 2, name: original });
		await expect(heading, 'the settings page is not in French').toBeVisible({ timeout: 20_000 });
		await heading.click();
		const editor = page.locator('[data-copy-edit-editor] textarea');
		await expect(editor, 'clicking the French heading opened no editor').toBeVisible();
		await expect(editor).toHaveValue(original);
		await editor.fill(edited);
		await editor.press('Enter');
		await expect(editor).toBeHidden();
		await expect(page.getByRole('heading', { level: 2, name: edited })).toBeVisible();

		await page.reload({ waitUntil: 'load' });
		await expect(page.getByRole('heading', { level: 2, name: edited })).toBeVisible({
			timeout: 20_000
		});

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.locator('[data-copy-edit-download]').click()
		]);
		const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
		expect(saved.edits.fr?.settings_instructionsTitle).toEqual({ text: edited, original });
		expect(saved.edits.en?.settings_instructionsTitle, 'the French edit landed under en').toBe(
			undefined
		);
	}
);

test(
	'an edit that drops a {placeholder} the app fills in is refused, not saved',
	{ tag: '@copy-edit' },
	async ({ page }) => {
		await startEditing(page);
		await page.goto('/chat/settings/contribute', { waitUntil: 'load' });
		const intro = page.getByText('Alpha is a potluck', { exact: false });
		await expect(intro).toBeVisible({ timeout: 20_000 });

		// "Join the {org} community" keeps its {org}: the editor says so and refuses an edit without it.
		// The panel sits over the bottom of the page; collapsed, it uncovers the line.
		await page.getByRole('button', { name: 'Collapse panel' }).click();
		await page.getByText('Join the', { exact: false }).click();
		const editor = page.locator('[data-copy-edit-editor] textarea');
		await expect(editor).toHaveValue('Join the {org} community');
		await editor.fill('Join the community');
		await page.locator('[data-copy-edit-save]').click();
		await expect(page.locator('[data-copy-edit-editor] [role="alert"]')).toContainText('{org}');
		await expect(page.locator('[data-copy-edit-change="contribute_joinCommunity"]')).toHaveCount(0);
	}
);

test(
	'without edit mode, a click on text does what the page does',
	{ tag: '@copy-edit' },
	async ({ page }) => {
		await page.goto('/chat/settings/personalization', { waitUntil: 'load' });
		await expect(page.getByRole('heading', { level: 2, name: HEADING })).toBeVisible({
			timeout: 20_000
		});
		await page.getByRole('link', { name: 'Appearance', exact: true }).first().click();
		await expect(page).toHaveURL(/\/settings\/appearance$/);
		await expect(page.locator('[data-copy-edit-panel]')).toHaveCount(0);
	}
);

// The landing's retention note shares one paragraph with the serving line, so the click lands on the
// note's own words: edit mode finds the message under the caret. It was admin-overridable copy until
// CUR-3660 removed the admin copy editor; this keeps pinning that it is editable in place.
test(
	'the landing retention note, which shares a paragraph with the serving line, is editable in place',
	{ tag: '@copy-edit' },
	async ({ page }) => {
		await startEditing(page);
		// A first visit gets the welcome over the chat. In edit mode a plain click edits text, so it is
		// dismissed with Alt-click, the gesture that uses the page normally.
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click({ modifiers: ['Alt'] });
		});
		await page.goto('/chat', { waitUntil: 'load' });
		const note = page
			.locator('[data-chat-landing] p')
			.filter({ hasText: 'Conversations are deleted automatically after' });
		await expect(note).toBeVisible({ timeout: 20_000 });

		// The middle of the note's own words, not of the paragraph, which starts with the serving line.
		const at = await note.evaluate((p) => {
			const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const i = n.textContent?.indexOf('deleted automatically') ?? -1;
				if (i < 0) continue;
				const range = document.createRange();
				range.setStart(n, i);
				range.setEnd(n, i + 'deleted automatically'.length);
				const r = range.getClientRects()[0];
				return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
			}
			return null;
		});
		if (!at) throw new Error('the retention note has no text node with its words');
		await page.mouse.click(at.x, at.y);

		const editor = page.locator('[data-copy-edit-editor] textarea');
		await expect(editor, 'clicking the retention note opened no editor').toBeVisible();
		await expect(editor).toHaveValue(
			'Conversations are deleted automatically after {retentionDays} days of inactivity, and we don’t train AI on them.'
		);
		await editor.fill(
			'Conversations are removed after {retentionDays} days without use, and we don’t train AI on them.'
		);
		await editor.press('Enter');
		await expect(
			page.getByRole('main').getByText('Conversations are removed after 30 days without use')
		).toBeVisible();
		await expect(page.locator('[data-copy-edit-change="copy_landingPrivacyNote"]')).toBeVisible();
	}
);
