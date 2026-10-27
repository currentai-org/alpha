// e2e-product: @chat
// e2e-area: @models
import { test, expect, type Page } from './helpers/test';
import type { Response } from '@playwright/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';
import { signInAsFreshUser } from './helpers/session';

// A model's measured weak spot (CUR-3911, CUR-420) shows as one quiet line in that
// model's details, and never on the picker row. Since the redesign the per-model Settings page
// is developer-only, so the line sits on the chat's empty state, under the sentence that names the
// picked model. A guest picks ALIA 40B in the composer and reads the sentence there; Mistral Medium 3.5,
// with none on record, shows no line. The sentences are the English ones in messages/en.json; ALIA's
// was reworded for a general visitor (CUR-4262), so the old prompt-injection wording must be gone.
//
// With `auto-routing` on, the composer's menu opens on Auto with the model rows one level down under
// "Choose a model yourself". A model picked there is still the person's model everywhere, so the pick
// must save and the empty state must name it; the `isPickSave` wait and the landing's model name hold
// that.

const PICKER_TRIGGER = /^Model:/;
const CHOOSE_YOURSELF = 'Choose a model yourself';
const ALIA = { id: 'BSC-LT/ALIA-40b-instruct', name: 'ALIA 40B' };
const MEDIUM = { id: 'mistral-medium-2604', name: 'Mistral Medium 3.5' };
const GLM = { id: 'zai-org/GLM-5.2', name: 'GLM 5.2' };
// The answer settings GLM 5.2 failed on the preview probe (modelWeakSpots.ts, CUR-4289).
const GLM_SETTINGS_WEAK_SPOT =
	'GLM 5.2 does not always follow these answer settings: Answer length: Short, Answer language.';
const ALIA_WEAK_SPOT = 'ALIA 40B is easier to talk into ignoring its rules than other models here.';
const ALIA_OLD_WEAK_SPOT =
	'often goes along with a message that tells it to ignore its instructions';
// Every sentence on record, so a picker row that shows any model's weak spot goes red.
const ALL_WEAK_SPOTS = [
	ALIA_WEAK_SPOT,
	'Bielik 11B v3 sometimes goes along with a message that tells it to ignore its instructions or take on a new role.',
	"SEA-LION v4 (Gemma) 27B may describe things that don't exist as if they were real, so check names and facts it gives you.",
	GLM_SETTINGS_WEAK_SPOT,
	'does not always follow these answer settings'
];

function isPickSave(r: Response): boolean {
	if (r.request().method() !== 'POST' || !new URL(r.url()).pathname.endsWith('/settings'))
		return false;
	try {
		return (
			typeof (r.request().postDataJSON() as { activeModel?: unknown } | null)?.activeModel ===
			'string'
		);
	} catch {
		return false;
	}
}

/** Opens the composer's model menu down to its model rows, through the Auto submenu when there is one. */
async function openPickerRows(page: Page) {
	await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
	const rows = page.locator('[data-model-id]');
	const submenu = page.getByRole('menuitem', { name: CHOOSE_YOURSELF });
	await expect(page.getByRole('menu').first(), 'the model menu did not open').toBeVisible({
		timeout: 10_000
	});
	if ((await submenu.count()) > 0) await submenu.click();
	await expect(rows.first(), 'the model menu lists no models').toBeVisible({ timeout: 10_000 });
	return rows;
}

async function pick(page: Page, model: { id: string; name: string }) {
	await openPickerRows(page);
	const row = page.locator(`[data-model-id="${model.id}"]`);
	await expect(row, `the picker does not offer ${model.name} here`).toBeVisible({
		timeout: 10_000
	});
	const saved = page.waitForResponse(isPickSave, { timeout: 15_000 });
	await row.click();
	await saved;
}

/** The chat's empty state, once it names the picked model rather than Auto. */
async function landingFor(page: Page, model: { id: string; name: string }) {
	const landing = page.locator('[data-chat-landing]');
	await expect(
		landing,
		`the empty state does not name ${model.name} after it was picked`
	).toContainText(model.name, { timeout: 15_000 });
	return landing;
}

test(
	'a model with a measured weak spot names it on the chat it was picked for in plain words, and the picker row and a model with none stay clean',
	{ tag: ['@preview-only', '@F2', '@CUR-3911', '@CUR-4262'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

		// The picker rows carry no weak-spot text, ALIA's or anyone's.
		const rows = await openPickerRows(page);
		const rowText = (await rows.allInnerTexts()).join('\n');
		for (const sentence of ALL_WEAK_SPOTS)
			expect(rowText, `a picker row shows a weak-spot sentence: ${sentence}`).not.toContain(
				sentence
			);
		await page.keyboard.press('Escape');

		await pick(page, ALIA);
		const line = (await landingFor(page, ALIA)).locator('[data-known-weak-spot]');
		await expect(line, `ALIA 40B's empty state shows no weak-spot line`).toBeVisible({
			timeout: 15_000
		});
		await expect(line).toContainText(ALIA_WEAK_SPOT);
		await expect(
			line,
			"ALIA 40B's line still uses the prompt-injection wording written for us"
		).not.toContainText(ALIA_OLD_WEAK_SPOT);
		await expect(
			line,
			"ALIA 40B's empty state shows another model's weak-spot sentence"
		).not.toContainText(ALL_WEAK_SPOTS[1]);

		// Why the line lives on the empty state: a guest who has ALIA's Settings address anyway is sent
		// back to Settings, and its nav offers no "Model: <name>" entry (developer-only).
		await page.goto(`/chat/settings/${ALIA.id}`, { waitUntil: 'commit' });
		await page.waitForURL((url) => !url.pathname.includes(ALIA.id), { timeout: 30_000 });
		await expect(
			page.getByRole('link', { name: 'Appearance' }).first(),
			'Settings did not render its section links'
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByRole('link', { name: `Model: ${ALIA.name}` }),
			"a guest's Settings offers the developer-only model page"
		).toHaveCount(0);

		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		await pick(page, MEDIUM);
		const landing = await landingFor(page, MEDIUM);
		await expect(
			landing.getByLabel('Message AI Potluck'),
			"Mistral Medium 3.5's empty state lost its composer"
		).toBeVisible({ timeout: 15_000 });
		await expect(
			landing.locator('[data-known-weak-spot]'),
			'Mistral Medium 3.5 has no weak spot on record but its empty state shows one'
		).toHaveCount(0);
	}
);

// A model that does not follow some answer settings says which, in the same quiet line, so a
// signed-in person who set them on "How Alpha answers" learns it before the answer ignores them.
test(
	'a signed-in person who picks a model that fails some answer settings sees which ones on its chat',
	{ tag: ['@preview-only', '@A4', '@CUR-4289'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Meet Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		await pick(page, GLM);
		const line = (await landingFor(page, GLM)).locator('[data-known-weak-spot]');
		await expect(line, "GLM 5.2's empty state shows no weak-spot line").toBeVisible({
			timeout: 15_000
		});
		await expect(line, "GLM 5.2's line does not name the answer settings it fails").toContainText(
			GLM_SETTINGS_WEAK_SPOT
		);
	}
);
