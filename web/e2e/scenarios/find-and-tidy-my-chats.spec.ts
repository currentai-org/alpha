// e2e-product: @chat
// e2e-area: @history
// Journey C1 (docs/journeys/c1-find-and-tidy-my-chats.md): the history tools a person
// expects from Claude or ChatGPT. Three chats are created and titled through the API, so the walk
// costs no model turn; search, delete-one and delete-all are each driven through the UI and each
// checked again after a reload, which separates what the server kept from what the rail painted.
// Step 3, rename, is conversation-rename.spec.ts.
import { test, expect, type Locator, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { holdForRecording } from './helpers/recording';
import { signInAsFreshUser } from './helpers/session';
import { journeyStep } from './helpers/journeyStep';

test.use({ viewport: { width: 1280, height: 800 } });

async function createTitledChat(page: Page, model: string | undefined, title: string) {
	const created = await page.request.post('/chat/conversation', { data: { model } });
	expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
	const { conversationId } = (await created.json()) as { conversationId: string };
	const titled = await page.request.patch(`/chat/api/v2/conversations/${conversationId}`, {
		data: { title }
	});
	expect(titled.ok(), `PATCH title answered ${titled.status()}`).toBe(true);
	return conversationId;
}

test(
	'a signed-in person finds an old chat by searching, deletes it, then deletes the rest',
	{ tag: ['@preview-only', '@local-build', '@C1', '@CUR-2626'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);

		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const model = models[0]?.id ?? models[0]?.name;
		const titles = ['Tax return checklist', 'Lisbon trip ideas', 'Sourdough starter schedule'];
		const ids: string[] = [];
		for (const title of titles) ids.push(await createTitledChat(page, model, title));
		const [, , sourdoughId] = ids;

		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		const railLink = (id: string) => page.locator(`a[href$="/conversation/${id}"]:visible`);

		// Step 1: the earlier chats are in the rail, by title.
		await journeyStep(page, 'C1', 1, async () => {
			await page.goto(chatEntry(), { waitUntil: 'load' });
			for (const [i, id] of ids.entries()) {
				await expect(railLink(id)).toHaveText(titles[i], { timeout: 20_000 });
			}
			await holdForRecording(page);
		});

		// Step 2: Search chats finds one by a word from its title, and choosing it opens that chat.
		await journeyStep(page, 'C1', 2, async () => {
			await page.locator('button:visible', { hasText: 'Search chats' }).first().click();
			// The words travel in the body, never the URL, because request logs keep URLs (CUR-4546).
			const searched = page.waitForRequest((r) =>
				new URL(r.url()).pathname.endsWith('/api/conversations/search')
			);
			await page.getByRole('textbox', { name: 'Search chats' }).fill('sourdough');
			const searchRequest = await searched;
			expect(searchRequest.method()).toBe('POST');
			expect(new URL(searchRequest.url()).search).toBe('');
			expect(searchRequest.postDataJSON()).toMatchObject({ q: 'sourdough' });
			const result = page.getByRole('option', { name: /Sourdough starter schedule/ });
			await expect(result).toBeVisible();
			await expect(page.getByRole('option', { name: /Lisbon trip ideas/ })).toHaveCount(0);
			await holdForRecording(page);
			await result.click();
			await page.waitForURL(new RegExp(`/conversation/${sourdoughId}$`), { timeout: 20_000 });
		});

		// Step 4: delete that chat from its Conversation actions; the confirmation names it.
		await journeyStep(page, 'C1', 4, async () => {
			await railLink(sourdoughId).hover();
			await railLink(sourdoughId)
				.locator('xpath=..')
				.getByRole('button', { name: 'Conversation actions' })
				.click();
			await page.getByRole('menuitem', { name: 'Delete' }).click();
			const confirm = page.getByRole('dialog').filter({ hasText: 'Delete conversation' });
			await expect(confirm).toContainText('Sourdough starter schedule');
			await holdForRecording(page);
			await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
			await expect(railLink(sourdoughId)).toHaveCount(0, { timeout: 15_000 });

			await page.reload({ waitUntil: 'load' });
			await expect(railLink(ids[0])).toBeVisible({ timeout: 20_000 });
			await expect(railLink(sourdoughId)).toHaveCount(0);
		});

		// Step 5: the deleted chat's old link lands on the chat home with a plain note.
		await journeyStep(page, 'C1', 5, async () => {
			await page.goto(`/chat/conversation/${sourdoughId}`, { waitUntil: 'load' });
			await expect(page).not.toHaveURL(new RegExp(`/conversation/${sourdoughId}`));
			await expect(
				page.getByText("That conversation isn't available in this session.")
			).toBeVisible({
				timeout: 15_000
			});
			await holdForRecording(page);
		});

		// Step 6: Forget everything in Data & privacy clears the rest and keeps the account.
		await journeyStep(page, 'C1', 6, async () => {
			await page.goto('/chat/settings/data', { waitUntil: 'load' });
			await page.getByRole('button', { name: /^Forget everything/ }).click();
			await expect(page.getByRole('heading', { name: 'Forget everything?' })).toBeVisible({
				timeout: 10_000
			});
			await expect(page.getByText('You stay signed in, and your account stays.')).toBeVisible();
			await holdForRecording(page);
			await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
				timeout: 15_000
			});
			await expect(page.getByText('2 conversations')).toBeVisible();
			await holdForRecording(page);
			await page.getByRole('button', { name: 'Done' }).click();

			await page.goto(chatEntry(), { waitUntil: 'load' });
			for (const id of ids) await expect(railLink(id)).toHaveCount(0);
		});
		const session = (await (await page.request.get('/chat/api/v2/user')).json()) as {
			json: unknown;
		};
		expect(
			session.json,
			'a wipe that promised to keep the account signed the person out'
		).not.toBeNull();
	}
);

// C1 row 7: the chat was already deleted elsewhere (another tab, or a second click on a slow
// delete), so the server answers the rail's DELETE or PATCH with a real 404. The chat is deleted
// through the API first, which reaches that 404 without a stub.
async function openRailWithGoneChat(page: Page, title: string) {
	await signInAsFreshUser(page);
	const models = (await (await page.request.get('/chat/api/models')).json()) as {
		id?: string;
		name?: string;
	}[];
	const id = await createTitledChat(page, models[0]?.id ?? models[0]?.name, title);
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(chatEntry(), { waitUntil: 'load' });
	const link = page.locator(`a[href$="/conversation/${id}"]:visible`);
	await expect(link).toHaveText(title, { timeout: 20_000 });
	const gone = await page.request.delete(`/chat/api/v2/conversations/${id}`);
	expect(gone.ok(), `DELETE through the API answered ${gone.status()}`).toBe(true);
	await link.hover();
	await link.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
	return link;
}

test(
	'deleting a chat that is already gone takes it off the rail, with no raw error',
	{ tag: ['@preview-only', '@local-build', '@C1', '@CUR-2819'] },
	async ({ page }) => {
		const link = await openRailWithGoneChat(page, 'Bike repair notes');
		await journeyStep(page, 'C1', 7, async () => {
			await page.getByRole('menuitem', { name: 'Delete' }).click();
			const confirm = page.getByRole('dialog').filter({ hasText: 'Delete conversation' });
			const refused = page.waitForResponse(
				(r) => r.request().method() === 'DELETE' && r.url().includes('/api/v2/conversations/')
			);
			await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
			expect((await refused).status(), 'the second delete should meet a 404').toBe(404);
			// The chat is gone either way, which is what the person asked for: the row leaves and
			// nothing on screen reads like an error.
			await expect(link, 'the row of a chat that no longer exists stayed in the rail').toHaveCount(
				0,
				{ timeout: 10_000 }
			);
			await expect(page.getByTestId('chat-error-toast')).toHaveCount(0);
			await holdForRecording(page);
		});
	}
);

test(
	'renaming a chat that is already gone says so in a sentence and takes it off the rail',
	{ tag: ['@preview-only', '@local-build', '@C1', '@CUR-2819'] },
	async ({ page }) => {
		const link = await openRailWithGoneChat(page, 'Garden planting plan');
		await journeyStep(page, 'C1', 7, async () => {
			await page.getByRole('menuitem', { name: 'Rename' }).click();
			const dialog = page.getByRole('dialog', { name: 'Rename conversation' });
			await dialog.getByRole('textbox', { name: 'Title' }).fill('Vegetable beds');
			const refused = page.waitForResponse(
				(r) => r.request().method() === 'PATCH' && r.url().includes('/api/v2/conversations/')
			);
			await dialog.getByRole('button', { name: 'Save' }).click();
			expect((await refused).status(), 'the rename should meet a 404').toBe(404);
			const toast = page.getByTestId('chat-error-toast');
			await expect(toast).toHaveText('That conversation no longer exists.');
			await expect(link, 'the row of a chat that no longer exists stayed in the rail').toHaveCount(
				0,
				{ timeout: 10_000 }
			);
			await holdForRecording(page);
		});
	}
);

// C1 row 6, refused: the server answers Forget everything with its 502, whose message says
// nothing was cleared. The modal used to hedge ("may not be fully cleared") over that body in code font.
test(
	'a Forget everything the server refuses says nothing was cleared, in a sentence, and keeps the chats',
	{ tag: ['@preview-only', '@local-build', '@C1', '@CUR-2822'] },
	async ({ page }) => {
		await signInAsFreshUser(page);
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const id = await createTitledChat(
			page,
			models[0]?.id ?? models[0]?.name,
			'Bread proofing times'
		);
		await page.route(
			(url) => url.pathname.endsWith('/api/v2/conversations'),
			(route) =>
				route.request().method() === 'DELETE'
					? route.fulfill({
							status: 502,
							contentType: 'application/json',
							body: JSON.stringify({
								message:
									"We couldn't delete your uploaded files, so nothing was cleared. Please try again."
							})
						})
					: route.fallback()
		);
		await journeyStep(page, 'C1', 6, async () => {
			await page.goto('/chat/settings/data', { waitUntil: 'load' });
			await page.getByRole('button', { name: /^Forget everything/ }).click();
			await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
			const dialog = page.getByRole('dialog').filter({ hasText: "Couldn't clear your data" });
			await expect(
				dialog.getByText(/nothing was cleared/),
				"the modal didn't pass on the server's own sentence"
			).toBeVisible({ timeout: 15_000 });
			await expect(dialog.getByText('may not be fully cleared')).toHaveCount(0);
			await expect(dialog.getByText(/[{}]/)).toHaveCount(0);
			await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
			await holdForRecording(page);
			await dialog.getByRole('button', { name: 'Close' }).click();
		});
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await expect(
			page.locator(`a[href$="/conversation/${id}"]:visible`),
			'a refused wipe still took the chat'
		).toBeVisible({ timeout: 20_000 });
	}
);

/**
 * WCAG contrast ratio between an element's colour and the first opaque background behind it,
 * walking up the tree. Colours are read back through a canvas, so OKLCH and light-dark() tokens
 * resolve to sRGB.
 */
async function contrastAgainstBackground(target: Locator): Promise<number> {
	return target.evaluate((el) => {
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

// Inside the chat's design-system root the legacy bridge resolves gray-100/200/300 to
// near-black in dark mode, so the dialog's `dark:text-gray-200` title read 1.07:1 on its panel.
test(
	"CUR-4218: the delete-conversation dialog's title, close × and Cancel label meet 4.5:1 contrast in dark mode",
	{ tag: ['@preview-only', '@C1', '@CUR-4218'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme: 'dark' });
		await signInAsFreshUser(page);
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const id = await createTitledChat(page, models[0]?.id ?? models[0]?.name, 'Bike repair notes');
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'load' });
		const link = page.locator(`a[href$="/conversation/${id}"]:visible`);
		await expect(link).toHaveText('Bike repair notes', { timeout: 20_000 });
		await link.hover();
		await link.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		const confirm = page.getByRole('dialog').filter({ hasText: 'Delete conversation' });
		await expect(confirm).toBeVisible({ timeout: 10_000 });
		// The dialog portals into its own design-system root; it has to be the dark one for this
		// check to mean anything.
		await expect(
			page.locator('.ds-portal-host', { has: confirm }),
			'the delete dialog did not open in dark mode'
		).toHaveClass(/\bdark\b/);

		// Text is held to AA's 4.5:1. The close × is a non-text graphic, where AA asks 3:1, but it is
		// held to 4.5:1 too: it is the dialog's only icon and the grader could not find it.
		for (const [what, target] of [
			['the title', confirm.getByRole('heading', { name: 'Delete conversation' })],
			['the close ×', confirm.getByRole('button', { name: 'Close' }).locator('svg')],
			['the Cancel label', confirm.getByRole('button', { name: 'Cancel', exact: true })]
		] as const) {
			await expect
				.poll(() => contrastAgainstBackground(target), {
					message: `${what} of the delete dialog is below 4.5:1 against its panel in dark mode`
				})
				.toBeGreaterThanOrEqual(4.5);
		}
	}
);
