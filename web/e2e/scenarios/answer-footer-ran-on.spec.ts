// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import { MEDIUM_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { backendDisplay } from '../../src/lib/chat/servingProvenance';

// The router load-balances one model across several hosts (Mistral Medium: Mistral's own API,
// Scaleway, OpenRouter), so no host configured for the model is true of every answer. Each answer's
// footer says where its own turn ran, read from the routing record stored with it, and says nothing
// about a host when the record names none.

type Stored = { id: string; routerMetadata?: { backend?: string } };

async function askAndRead(page: Page, modelId: string) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(pinnedChatEntry(modelId), { waitUntil: 'commit' });
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').fill('Name the capital of Japan in one sentence.');
	const conversationId = await sendOpensConversation(page);

	const message = page.locator('[data-message-role="assistant"]').first();
	await expect(turnDone(message), `the turn on ${modelId} never finished`).toBeVisible({
		timeout: 90_000
	});
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await message.getAttribute('data-message-id');
	const stored = body.json?.messages?.find((m) => m.id === id);
	expect(stored, `message ${id} is not in the stored conversation`).toBeTruthy();
	return { message, recorded: stored!.routerMetadata?.backend };
}

test(
	'a Mistral Medium answer’s footer names the host its own turn recorded, with its country',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const { message, recorded } = await askAndRead(page, MEDIUM_MODEL);
		const host = backendDisplay(recorded);
		expect(
			host,
			`the turn recorded ${recorded ?? 'no backend'}, which the catalog cannot name`
		).toBeTruthy();
		const ranOn = message.locator('[data-answer-ran-on]');
		await expect(ranOn, 'the footer does not say where this answer ran').toHaveText(
			`Ran on ${host}.`,
			{
				timeout: 15_000
			}
		);
		// Every host the router sends Medium to is in France; a footer naming another country is wrong.
		await expect(ranOn).toContainText('(France)');
	}
);

test(
	'an answer whose routing record names no host shows no host in its footer',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await installFaultInjectionHeader(page, 'provenance_host_stripped');
		const { message, recorded } = await askAndRead(page, MEDIUM_MODEL);
		expect(recorded, 'the fault did not reach the server: the turn still records a backend').toBe(
			undefined
		);
		await expect(message.locator('[data-how-made]')).toBeVisible({ timeout: 15_000 });
		await expect(
			message.locator('[data-answer-ran-on]'),
			'the footer names a host the turn never recorded'
		).toHaveCount(0);
	}
);
