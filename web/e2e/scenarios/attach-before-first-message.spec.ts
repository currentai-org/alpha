// e2e-product: @chat
// e2e-area: @composer
// A signed-in tester with agent on Auto could not attach a document in a new chat until they
// had sent a first message. This walks that exact start: a fresh account, agent
// on Auto, the empty composer of a new chat, Attach files from the + menu, and a first question only
// the file can answer.
import { test, expect } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { startChattingPastWelcome } from './helpers/welcome';
import { installModelReplay } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { failIfStorageThrottled } from './helpers/storageThrottle';

const ROTA = 'Volunteer rota\nSaturday: bake the bread\nSunday: wash the cups\n';

test(
	"with agent on Auto, a new chat's empty composer offers Attach files, and the first message's answer reads the file",
	{ tag: ['@preview-only', '@A6', '@CUR-4087'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await signInAsFreshUser(page);
		// The agent setting is a localStorage preference (stores/agentMode.ts), set before the app reads it.
		await page.addInitScript(() => localStorage.setItem('ap:agentMode', 'auto'));
		await installModelReplay(page);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		await failIfStorageThrottled(page);

		const tools = page.getByRole('button', { name: /^Add files and tools/ });
		await tools.click({ timeout: 30_000 });
		await expect(
			page.getByRole('menuitem', { name: /^Agent/ }),
			'the agent setting did not read Auto, so this is not the tester state'
		).toContainText('Auto');
		const attach = page.getByRole('menuitem', { name: /^Attach files/ });
		await expect(
			attach,
			"a new chat's empty composer offered no Attach files with agent on Auto"
		).toBeVisible();

		const chooser = page.waitForEvent('filechooser');
		await attach.click();
		await (
			await chooser
		).setFiles({ name: 'volunteer-rota.txt', mimeType: 'text/plain', buffer: Buffer.from(ROTA) });
		await expect(
			page.getByText('volunteer-rota.txt').first(),
			'the file chosen before the first message never showed as attached in the composer'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('According to the attached rota, what happens on Saturday?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });

		const answer = page.locator('[data-message-role="assistant"]').first();
		await expect(turnDone(answer), 'the first turn never finished').toBeVisible({
			timeout: 120_000
		});
		await expect(answer, 'the first answer did not read the file attached before it').toContainText(
			/bread/i
		);
	}
);
