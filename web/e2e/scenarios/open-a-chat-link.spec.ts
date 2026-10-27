// e2e-product: @chat
// e2e-area: @history
// Journey C1 (docs/journeys/c1-find-and-tidy-my-chats.md, CUR-2821): a chat link that can't open says
// why. A deleted chat's 404 already has its note (find-and-tidy-my-chats.spec.ts, step 5); these are
// the cut-off link, which the server answers 400, and a server error while opening a real chat.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { journeyStep } from './helpers/journeyStep';
import { accountButton, accountMenuItem } from './helpers/accountMenu';
import { startChattingPastWelcome } from './helpers/welcome';

test.use({ viewport: { width: 1280, height: 800 } });

// This test checks the note against the welcome's intro, so it meets the welcome itself rather than
// through the shared handler (SOL-343).
test.describe(() => {
	test.use({ welcome: 'show' });
	test(
		'a chat link with its tail cut off lands on the chat home with the unavailable note',
		{ tag: ['@preview-only', '@C1', '@CUR-2821'] },
		async ({ page }) => {
			test.setTimeout(90_000);
			await signInAsFreshUser(page);
			await journeyStep(page, 'C1', 8, async () => {
				// A real id is 24 hex characters; a paste that lost its tail is shorter, and the server answers 400.
				await page.goto('/chat/conversation/66f1c2a9b3e4', { waitUntil: 'load' });
				const note = page.getByText("That conversation isn't available in this session.");
				await expect(note, 'a cut-off link opened an empty new chat with nothing said').toBeVisible(
					{
						timeout: 15_000
					}
				);
				// A fresh account lands on Welcome to Alpha, and the note sat on top of its intro paragraph.
				await expectNoteClearOfWelcomeIntro(page, note);
			});
		}
	);

	// Logging out starts a guest session, which meets the welcome again, and the walkthrough
	// reaches the cut-off link from there (CUR-2883).
	test(
		'right after logging out, a cut-off chat link shows the unavailable note clear of the welcome intro',
		{ tag: ['@preview-only', '@C1', '@CUR-2883'] },
		async ({ page }) => {
			test.setTimeout(120_000);
			await signInAsFreshUser(page);
			const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await expect(welcome, 'a fresh account met no welcome').toBeVisible({ timeout: 20_000 });
			await startChattingPastWelcome(welcome);
			await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
			await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
				timeout: 15_000
			});
			await page.goto('/chat/conversation/66f1c2a9b3e4', { waitUntil: 'load' });
			const note = page.getByText("That conversation isn't available in this session.");
			await expect(note, 'a cut-off link opened an empty new chat with nothing said').toBeVisible({
				timeout: 15_000
			});
			await expectNoteClearOfWelcomeIntro(page, note);
		}
	);
});

/** The note and the welcome's intro paragraph are both on screen, and their boxes don't overlap. */
async function expectNoteClearOfWelcomeIntro(page: Page, note: Locator) {
	const intro = page
		.getByRole('dialog', { name: 'Welcome to Alpha' })
		.getByText('An AI assistant made by the public');
	await expect(intro).toBeVisible();
	const [a, b] = [await note.boundingBox(), await intro.boundingBox()];
	expect(a && b, 'the note or the intro has no box').toBeTruthy();
	const overlaps =
		a!.x < b!.x + b!.width &&
		b!.x < a!.x + a!.width &&
		a!.y < b!.y + b!.height &&
		b!.y < a!.y + a!.height;
	expect(overlaps, 'the unavailable note covers the Welcome to Alpha intro paragraph').toBe(false);
}

/**
 * Signs in a fresh account with one titled chat, lands on the chat home, and makes every GET of that
 * chat answer 500, so clicking its rail link opens the server-error card. Returns the chat's id and link.
 */
async function aChatThatWillNotOpen(page: Page) {
	await signInAsFreshUser(page);
	const models = (await (await page.request.get('/chat/api/models')).json()) as {
		id?: string;
		name?: string;
	}[];
	const created = await page.request.post('/chat/conversation', {
		data: { model: models[0]?.id ?? models[0]?.name }
	});
	expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
	const { conversationId } = (await created.json()) as { conversationId: string };
	const titled = await page.request.patch(`/chat/api/v2/conversations/${conversationId}`, {
		data: { title: 'Garden plan' }
	});
	expect(titled.ok(), `PATCH title answered ${titled.status()}`).toBe(true);

	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(chatEntry(), { waitUntil: 'load' });
	const link = page.locator(`a[href$="/conversation/${conversationId}"]:visible`);
	await expect(link).toBeVisible({ timeout: 20_000 });

	// Opening from the rail loads in the browser, so the stubbed 500 is what the page's load sees.
	await page.route(`**/chat/api/v2/conversations/${conversationId}?*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ status: 500, body: '{"message":"Internal Error"}' })
			: route.fallback()
	);
	await page.route(`**/chat/api/v2/conversations/${conversationId}`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ status: 500, body: '{"message":"Internal Error"}' })
			: route.fallback()
	);
	return { conversationId, link };
}

test(
	'a server error opening a chat says it could not be opened, and keeps the link to retry',
	{ tag: ['@preview-only', '@C1', '@CUR-2821'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const { conversationId, link } = await aChatThatWillNotOpen(page);
		await journeyStep(page, 'C1', 8, async () => {
			await link.click();
			await expect(
				page.getByText("That conversation couldn't be opened right now."),
				'a server error opening the chat said nothing, or dropped the visitor on an empty chat'
			).toBeVisible({ timeout: 15_000 });
			await expect(page, 'the link was dropped, so a reload cannot retry it').toHaveURL(
				new RegExp(`/conversation/${conversationId}`)
			);
			await expect(page.getByText('Internal Error')).toHaveCount(0);
		});
	}
);

/**
 * WCAG contrast ratio between an element's text colour and the first opaque background behind it.
 * Colours are read back through a canvas, so OKLCH and light-dark() tokens resolve to sRGB.
 */
async function textContrast(page: Page, selector: string): Promise<number> {
	return page.locator(selector).evaluate((el) => {
		const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
		const rgba = (css: string) => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = '#000';
			ctx.fillStyle = css;
			ctx.fillRect(0, 0, 1, 1);
			return [...ctx.getImageData(0, 0, 1, 1).data];
		};
		const luminance = ([r, g, b]: number[]) =>
			[r, g, b]
				.map((c) => c / 255)
				.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
				.reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
		let bg: number[] | null = null;
		for (let node: Element | null = el; node && !bg; node = node.parentElement) {
			const fill = rgba(getComputedStyle(node).backgroundColor);
			if (fill[3] === 255) bg = fill;
		}
		const [a, b] = [luminance(rgba(getComputedStyle(el).color)), luminance(bg ?? [255, 255, 255])];
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	});
}

test(
	'CUR-3409: the server-error card shows its status and message at readable contrast',
	{ tag: ['@preview-only', '@C1', '@CUR-3409'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const { link } = await aChatThatWillNotOpen(page);
		await link.click();
		const card = page.getByTestId('chat-error-card');
		await expect(card.getByText("That conversation couldn't be opened right now.")).toBeVisible({
			timeout: 15_000
		});
		// AA asks 4.5:1 of body text; the 503 heading is large text, but holding it to the same bar
		// keeps the status from fading into the panel the way the grader saw it.
		// The chat follows the system theme until the person picks one, so check both.
		for (const colorScheme of ['dark', 'light'] as const) {
			await page.emulateMedia({ colorScheme });
			for (const [what, selector] of [
				['the status heading', '[data-testid="chat-error-card"] h1'],
				['the message', '[data-testid="chat-error-card"] h2']
			] as const) {
				await expect
					.poll(() => textContrast(page, selector), {
						message: `${what} in the ${colorScheme} theme is below 4.5:1 against its panel`
					})
					.toBeGreaterThanOrEqual(4.5);
			}
		}
	}
);
