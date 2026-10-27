// e2e-product: @chat
// e2e-area: @history @settings
import { test, expect } from './helpers/test';
import postgres from 'postgres';
import { chatEntry } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { holdForRecording } from './helpers/recording';
import { installCannedReplies } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// A3 row 20 (CUR-2799): Forget everything in one tab while a second tab still shows the chat. The
// second tab's composer is live, so a send from it could bring the wiped conversation back. The send
// route loads the conversation before anything else and answers 404 when it is gone
// (`conversation/[id]/+server.ts` → `loadConversation`). This walks it: the stale tab's send is
// refused, nothing is stored under the old id, and neither tab lists the chat afterwards.

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;

async function conversationRows(id: string): Promise<number> {
	const sql = postgres(DATABASE_URL!, { ssl: 'require', max: 1 });
	try {
		const rows = await sql<
			{ n: number }[]
		>`select count(*)::int as n from conversations where id = ${id}`;
		return rows[0].n;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

test(
	'a send from a second tab after Forget everything in the first does not bring the chat back',
	{ tag: ['@A3'] },
	async ({ page, context }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored rows cannot be read'
		).toBeTruthy();
		test.setTimeout(180_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await welcomeDialog
			.getByRole('button', { name: /start chatting/i })
			.click({ timeout: 8_000 })
			.catch(() => {});
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });
		await installCannedReplies(page);

		const prompt = `A3 two-tab scenario ${Date.now()}: this chat must stay forgotten`;
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(prompt);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationUrl = page.url();
		const id = new URL(conversationUrl).pathname.split('/').pop()!;
		// Nothing may still be streaming when the wipe runs (data-portability.spec.ts, CUR-1638).
		await expect(
			page
				.locator('[data-message-role="assistant"]')
				.last()
				.getByRole('button', { name: 'Copy to clipboard', exact: true })
		).toBeVisible({ timeout: 60_000 });
		expect(await conversationRows(id), 'the chat was never stored').toBe(1);

		// The second tab, open on the same chat, same session.
		const stale = await context.newPage();
		await stale.goto(conversationUrl, { waitUntil: 'commit' });
		await expect(stale.getByText(prompt)).toBeVisible({ timeout: 30_000 });

		// The first tab forgets everything.
		await page.goto('/chat/settings/data', { waitUntil: 'commit' });
		await page.getByRole('button', { name: /^Forget everything/ }).click({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 15_000
		});
		expect(await conversationRows(id), 'Forget everything left the chat stored').toBe(0);

		await journeyStep(stale, 'A3', 20, async () => {
			// The client reads the send's body as a stream, so the browser keeps no copy for
			// `response.text()`. Fetch it here instead and hand the client the same bytes.
			const sent: { value?: { status: number; body: string } } = {};
			await stale.route(
				(url) => url.pathname.endsWith(`/conversation/${id}`),
				async (route) => {
					if (route.request().method() !== 'POST') return route.fallback();
					const response = await route.fetch();
					const body = await response.text();
					sent.value = { status: response.status(), body };
					await route.fulfill({ response, body });
				}
			);
			const staleComposer = stale.getByLabel('Message AI Potluck');
			await staleComposer.fill('sent from the tab that still shows the forgotten chat');
			await staleComposer.press('Enter');
			await expect.poll(() => sent.value, { timeout: 60_000 }).toBeDefined();
			// The client asks for pre-stream events (`x-prestream-events`), so the route answers 200 at once
			// and reports a failed conversation load inside the stream as a status update carrying the
			// 404 (`prestreamFailureUpdate`). A send that went through would stream an answer instead.
			expect(
				sent.value!.status === 404 || /"statusCode":\s*404/.test(sent.value!.body),
				`the stale tab’s send was accepted into the forgotten chat (HTTP ${sent.value!.status}): ${sent.value!.body.slice(0, 300)}`
			).toBe(true);
			await stale.unrouteAll({ behavior: 'ignoreErrors' });
			await holdForRecording(stale);

			// Reloading the stale tab's address finds nothing to show.
			await stale.goto(conversationUrl, { waitUntil: 'commit' });
			await expect(stale).not.toHaveURL(/\/chat\/conversation\//, { timeout: 30_000 });
			await expect(stale.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
			await expect(stale.getByText(prompt), 'the forgotten chat is listed again').toHaveCount(0);
			await holdForRecording(stale);
		});

		expect(await conversationRows(id), 'the stale tab’s send brought the chat back').toBe(0);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(prompt), 'the first tab lists the forgotten chat').toHaveCount(0);
	}
);
