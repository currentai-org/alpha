// e2e-product: @chat
// e2e-area: @provenance
import { test, expect } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';

// Second opinion could not be found among an answer's actions (CUR-4187):
// it rendered only at the foot of X-ray's Step by step. The answer now carries a Second opinion action
// that opens X-ray there, so this starts from the answer, never from the X-ray tabs, and holds out for
// the panel's verdict on the page and on the stored message.

const QUESTION = 'What is the capital of Australia?';

type Stored = { id: string; verdict?: { agreement?: string } };

test(
	"an answer's Second opinion action opens the offer in X-ray, and the panel returns a verdict that is stored on the answer",
	{ tag: ['@preview-only', '@CUR-4187'] },
	async ({ page }) => {
		// One turn (up to 90s) and one panel fan-out (30-50s, up to 120s), after setup.
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

		const message = page.locator('[data-message-role="assistant"]').first();
		await expect(turnDone(message), `"${QUESTION}" never finished`).toBeVisible({
			timeout: 90_000
		});

		await message.getByRole('button', { name: 'Second opinion', exact: true }).click();
		await expect(
			page.getByRole('tab', { name: 'Step by step' }),
			'the action opened X-ray on another tab than Step by step'
		).toHaveAttribute('aria-selected', 'true');
		const offer = page.locator('[data-xray-panel] [data-second-opinion-offer]');
		await expect(offer, 'Step by step shows no second-opinion offer').toBeInViewport({
			timeout: 15_000
		});

		await offer.getByRole('button', { name: /Get a collective second opinion/ }).click();
		await expect(
			offer.locator('[data-second-opinion-verdict]'),
			'the panel never returned a verdict on the answer'
		).toBeVisible({ timeout: 120_000 });

		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		const id = await message.getAttribute('data-message-id');
		await expect
			.poll(
				async () => {
					const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
					if (!res.ok()) return `conversation read answered ${res.status()}`;
					const body = (await res.json()) as { json?: { messages?: Stored[] } };
					return body.json?.messages?.find((m) => m.id === id)?.verdict?.agreement ?? 'no verdict';
				},
				{ message: 'the verdict was not stored on the answer', timeout: 15_000 }
			)
			.toMatch(/^(high|mixed|low)$/);
	}
);
