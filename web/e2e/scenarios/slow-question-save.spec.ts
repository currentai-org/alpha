// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import postgres from 'postgres';
import { sslFor } from './helpers/db';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { composerHydrated } from './helpers/composer';

// Keep asset loading in the browser: this regression measures the generation stream, and the
// development server serves many individual modules rather than the preview's bundled chunks.
test.use({ cacheStaticAssets: false });

// A row lock holds only this test's question save. The accepted stream must keep heartbeating
// while that save waits, or the browser's eight-second silence watchdog aborts a healthy turn.
test(
	'an accepted turn stays alive while its question waits for a database row lock',
	{ tag: ['@preview-only', '@stub-screen'] },
	async ({ page }) => {
		await page.addInitScript(() => {
			const state = { accepted: false, pulses: [] as number[] };
			Object.assign(window, { __questionSaveHeartbeats: state });
			const realFetch = window.fetch.bind(window);
			window.fetch = async (input, init) => {
				const response = await realFetch(input, init);
				const request = input instanceof Request ? input : null;
				const url = new URL(request ? request.url : String(input), location.href);
				if (
					url.origin === location.origin &&
					(init?.method ?? request?.method ?? 'GET').toUpperCase() === 'POST' &&
					/\/conversation\/[a-f0-9]+$/.test(url.pathname)
				) {
					const reader = response.clone().body!.getReader();
					void (async () => {
						const decoder = new TextDecoder();
						let buffered = '';
						for (;;) {
							const { value, done } = await reader.read();
							if (done) break;
							buffered += decoder.decode(value, { stream: true });
							const lines = buffered.split('\n');
							buffered = lines.pop()!;
							for (const line of lines) {
								if (!line.trim()) continue;
								const update = JSON.parse(line);
								if (update.type !== 'status' || update.status !== 'keepAlive') continue;
								// Every keep-alive counts, before acceptance as well as after: the conversation row
								// this spec locks can hold the turn ahead of acceptance (the prestream heartbeat,
								// `phase:starting`) or after it (the generation heartbeat), and the client's
								// watchdog is fed the same way by both.
								if (update.message === 'phase:accepted') state.accepted = true;
								state.pulses.push(performance.now());
							}
						}
					})().catch(() => {});
				}
				return response;
			};
		});
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id: string;
		}[];
		const created = await page.request.post('/chat/conversation', {
			data: { model: models[0].id }
		});
		expect(created.ok()).toBe(true);
		const { conversationId } = (await created.json()) as { conversationId: string };
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installCannedReplies(page);
		await page.goto(`/chat/conversation/${conversationId}`);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click();
		await composerHydrated(page);
		await composer.fill('Say hi in three words.');

		const databaseUrl = process.env.SCENARIO_DATABASE_URL!;
		const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
		let unlock!: () => void;
		let locked!: () => void;
		const hold = new Promise<void>((resolve) => (unlock = resolve));
		const acquired = new Promise<void>((resolve) => (locked = resolve));
		// The lock is taken as the turn's POST leaves the browser, not before Enter: when the composer's
		// model for this message differs from the conversation's, the page first switches the model with
		// a PATCH to the same row, and a lock held from the start catches that PATCH instead, so the turn
		// is never accepted and the poll below measures nothing.
		let transaction: Promise<unknown> | undefined;
		await page.route(
			(url) => /\/chat\/conversation\/[a-f0-9]+$/.test(url.pathname),
			async (route) => {
				if (route.request().method() === 'POST' && !transaction) {
					transaction = sql.begin(async (tx) => {
						await tx`select id from conversations where id = ${conversationId} for update`;
						locked();
						await hold;
					});
					await acquired;
				}
				// Falls through to the canned-reply route, which adds its header and sends the request on.
				return route.fallback();
			}
		);
		const reply = page.locator('[data-message-role="assistant"]').last();
		try {
			await composer.press('Enter');
			await acquired;
			await expect
				.poll(
					() =>
						page.evaluate(
							() =>
								(window as unknown as { __questionSaveHeartbeats: { pulses: number[] } })
									.__questionSaveHeartbeats.pulses.length
						),
					{
						message: 'the accepted stream went silent while the question save was locked',
						timeout: 15_000
					}
				)
				.toBeGreaterThanOrEqual(6);
			await expect(reply).not.toContainText('The connection dropped before a reply arrived.');
			unlock();
			await transaction;
			await expect(turnDone(reply)).toBeVisible({ timeout: 30_000 });
			await expect(reply.locator('.prose').first()).toContainText(/[A-Za-z]{2,}/);
		} finally {
			try {
				await test.info().attach('question-save-heartbeats', {
					body: JSON.stringify(
						await page.evaluate(
							() =>
								(window as unknown as { __questionSaveHeartbeats: unknown })
									.__questionSaveHeartbeats
						)
					),
					contentType: 'application/json'
				});
			} finally {
				unlock();
				await transaction;
				await sql.end({ timeout: 5 });
				await page.request.delete(`/chat/conversation/${conversationId}`);
			}
		}
	}
);
