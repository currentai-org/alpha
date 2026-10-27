// e2e-product: @chat
// e2e-area: @provenance
import { test, expect } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { openStepByStep } from './helpers/xray';
import { assistHostLabel } from '../../src/lib/chat/utils/trace/assistHost';

// A second opinion's takes recorded no host, so X-ray could not say where each panel model
// ran (CUR-3563). Each take now keeps its own call's routing record (backend, and the HF router's provider), and
// Step by step's second-opinion step names it. The contract: a real panel run stores a host on at
// least one take, and Step by step names each stored take's host, or says plainly it was not recorded.

const QUESTION = 'What is the capital of Australia?';

type Opinion = { modelShort: string; backend?: string; provider?: string };
type Stored = { id: string; opinions?: Opinion[] };

test(
	'after a second opinion, each stored take carries the host it ran on and Step by step names it',
	{ tag: ['@preview-only', '@CUR-3563', '@CUR-2203'] },
	async ({ page }) => {
		// One turn (90s) plus the panel (up to 120s), after up to 60s of setup.
		test.setTimeout(300_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(QUESTION);
		await composer.press('Enter');

		const answer = page.locator('[data-message-role="assistant"]').first();
		await expect(turnDone(answer), `"${QUESTION}" never finished`).toBeVisible({ timeout: 90_000 });
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		const messageId = (await answer.getAttribute('data-message-id')) ?? '';

		// The panel streams NDJSON; the response resolves once its last line, `done`, is written.
		const run = await page.request.post('/chat/api/second-opinion', {
			data: { conversationId, messageId },
			timeout: 120_000
		});
		expect(run.ok(), `the second opinion answered ${run.status()}`).toBe(true);
		const done = (await run.text())
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; available?: boolean })
			.find((e) => e.type === 'done');
		expect(done?.available, 'the panel finished without a second opinion').toBe(true);

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as { json?: { messages?: Stored[] } };
		const opinions = body.json?.messages?.find((m) => m.id === messageId)?.opinions ?? [];
		expect(opinions.length, 'no takes were stored on the answer').toBeGreaterThan(0);
		// Each take is headed by the model's name, never its checkpoint like "gemma-4-31B-it" (CUR-2203).
		for (const o of opinions) {
			expect(o.modelShort, `a take is headed by a checkpoint: ${o.modelShort}`).not.toMatch(
				/[/_]|-it$|-Instruct|-A3B/i
			);
		}
		expect(
			opinions.some((o) => assistHostLabel(o)),
			`no stored take records where it ran: ${JSON.stringify(opinions)}`
		).toBe(true);

		await page.reload({ waitUntil: 'commit' });
		const reloaded = page.locator(`[data-message-id="${messageId}"]`);
		await openStepByStep(page, reloaded, {
			disclosure: { timeout: 30_000 },
			tab: { timeout: 15_000 }
		});
		const step = page.locator('[data-step-id="second-opinion"]');
		for (const o of opinions) {
			const host = assistHostLabel(o);
			await expect(
				step,
				host
					? `Step by step does not say ${o.modelShort} ran on ${host}`
					: `Step by step does not say ${o.modelShort}'s host was not recorded`
			).toContainText(
				host ? `${o.modelShort} ran on ${host}.` : `Where ${o.modelShort} ran was not recorded.`,
				{ timeout: 15_000 }
			);
		}
	}
);
