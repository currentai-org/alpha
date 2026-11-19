// e2e-product: @chat
// e2e-area: @settings @history
import postgres from 'postgres';
import { test, expect } from './helpers/test';
import { readFileSync } from 'node:fs';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { chatEntry, CONVERSATION_URL } from './helpers/chatEntry';
import { installCannedReplies, installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';
import { sendOpensConversation } from './helpers/composer';
import { turnDone } from './helpers/turn';
import { sslFor } from './helpers/db';

// Conversation expiry: on the official instance everything a person makes is deleted 30 days
// after it was created. Before anything is deleted, the person has to be told, and the way out has to be
// one click away. With the `conversation-expiry` flag on, the composer carries a preview line whose
// "Export yours" link lands on Settings → Account, where the Open WebUI row downloads every
// conversation, and the chat's header counts down its days left. From day 23 the conversation also shows
// "This chat is deleted on <date>" with Export and Continue in a new chat, which puts a summary of the
// chat in a new chat's composer and stores nothing until it is sent. With the flag off, none of it
// shows. The deleting half is covered against real Postgres in db/__tests__/conversationExpiry.spec.ts.
//
// The banner tests age a real conversation by moving its `created_at` back in the preview database. A
// conversation older than the deployment's expiry launch counts from launch day, so they first set the
// launch marker to a day long past. Each PR preview has its own database branch, and the marker does
// nothing while the preview's flag is off (nothing is swept); a flag-off cron run clears it.

test.use({ viewport: { width: 1280, height: 800 } });

const LAUNCH_KEY = 'conversation-expiry-launched-at';
const LONG_AGO_LAUNCH = '2026-01-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

test(
	'with conversation expiry on, a chat shows its days left and the preview line reaches the Open WebUI export in one click',
	{ tag: ['@preview-only', '@A3', '@CUR-4990'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'conversation-expiry': true,
			// The router sends some prompts to the agent; this test is about the notice.
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, () => startChattingPastWelcome(welcomeDialog));
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await installCannedReplies(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Suggest a name for a community garden in one short sentence.');
		await sendOpensConversation(page);
		await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 120_000
		});

		// A conversation started today has the whole window left, and is far from the banner.
		const badge = page.locator('[data-conversation-expiry]').first();
		await expect(badge, 'the chat header shows no days-left badge').toBeVisible({
			timeout: 15_000
		});
		await expect(badge).toContainText('30 days left');
		await expect(page.locator('[data-guest-retention]')).toHaveCount(0);
		await expect(page.getByTestId('conversation-expiry-banner')).toHaveCount(0);

		const line = page.getByTestId('conversation-expiry-line');
		await expect(line, 'the composer carries no preview line').toBeVisible();
		await expect(line).toContainText('deleted 30 days after they start');

		await line.getByRole('link', { name: 'Export yours' }).click();
		await expect(page).toHaveURL(/\/settings\/account#your-data$/, { timeout: 15_000 });
		const row = page.getByRole('link', {
			name: 'Download your conversations as a file Open WebUI can import'
		});
		await expect(row, 'the export link lands where the Open WebUI row is').toBeVisible({
			timeout: 15_000
		});
		const [download] = await Promise.all([page.waitForEvent('download'), row.click()]);
		expect(download.suggestedFilename()).toMatch(/^chat-export-\d+\.json$/);
		const path = await download.path();
		if (!path) throw new Error('download event fired but Playwright kept no local copy');
		const chats = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
		expect(chats, 'the file holds the conversation just made').toHaveLength(1);
	}
);

test(
	'with conversation expiry off, a signed-in chat shows no countdown, no preview line and no banner',
	{ tag: ['@preview-only', '@A3', '@CUR-4990'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'conversation-expiry': false,
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, () => startChattingPastWelcome(welcomeDialog));
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await installCannedReplies(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Suggest a name for a community garden in one short sentence.');
		await sendOpensConversation(page);
		await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 120_000
		});

		// The composer is up, so the line would be beside it if it rendered.
		await expect(composer).toBeVisible();
		await expect(page.getByTestId('conversation-expiry-line')).toHaveCount(0);
		await expect(page.locator('[data-conversation-expiry]')).toHaveCount(0);
		await expect(page.getByTestId('conversation-expiry-banner')).toHaveCount(0);
	}
);

test(
	'a chat 24 days old shows the delete-date banner with Export and Continue, and one 10 days old does not',
	{ tag: ['@preview-only', '@A3', '@CUR-4990'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');
		await setFlagOverrides(context, baseURL!, {
			'conversation-expiry': true,
			'agent-mode': false
		});
		const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
		try {
			await sql`
				insert into config (key, doc) values (${LAUNCH_KEY}, ${sql.json({ value: LONG_AGO_LAUNCH })})
				on conflict (key) do update set doc = excluded.doc
			`;
			const [marker] = await sql<{ value: string }[]>`
				select doc->>'value' as value from config where key = ${LAUNCH_KEY}
			`;
			expect(
				Date.parse(marker.value),
				`this preview's expiry launch (${marker.value}) is too recent for a 24-day-old chat to be near its date`
			).toBeLessThan(Date.now() - 25 * DAY);

			await signInAsFreshUser(page);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, () => startChattingPastWelcome(welcomeDialog));
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await installCannedReplies(page);
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('Plan a three-day bike trip along a river, briefly.');
			const id = await sendOpensConversation(page);
			await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
				timeout: 120_000
			});

			// The app reads `createdAt` from the stored doc, and the sweep from the column: move both.
			const age = async (days: number) => {
				const iso = new Date(Date.now() - days * DAY).toISOString();
				await sql`
					update conversations
					set created_at = ${iso}, doc = jsonb_set(doc, '{createdAt}', ${sql.json({ $dt: iso })})
					where id = ${id}
				`;
			};
			const banner = page.getByTestId('conversation-expiry-banner');
			const badge = page.locator('[data-conversation-expiry]').first();

			await age(10);
			await page.reload({ waitUntil: 'load' });
			await expect(badge, 'a 10-day-old chat shows no days-left badge').toContainText(
				'20 days left',
				{ timeout: 30_000 }
			);
			await expect(banner, 'the banner showed 20 days before the date').toHaveCount(0);

			await age(24);
			await page.reload({ waitUntil: 'load' });
			await expect(badge).toContainText('6 days left', { timeout: 30_000 });
			await expect(banner, 'a 24-day-old chat shows no delete-date banner').toBeVisible();
			// The date as this browser writes it, six days on.
			const date = await page.evaluate(
				(ms) =>
					new Date(Date.now() + ms).toLocaleDateString('en', { day: 'numeric', month: 'long' }),
				6 * DAY
			);
			await expect(banner).toContainText(`This chat is deleted on ${date}`);
			await expect(banner.getByRole('link', { name: 'Export' })).toHaveAttribute(
				'href',
				/\/api\/v2\/export\/open-webui$/
			);
			await expect(banner.getByRole('button', { name: 'Continue in a new chat' })).toBeVisible();
			await expect(page).toHaveURL(CONVERSATION_URL);
		} finally {
			await sql.end({ timeout: 5 });
		}
	}
);

test(
	'Continue in a new chat opens a new chat whose composer holds an editable summary, storing nothing and leaving the old chat unchanged',
	{ tag: ['@preview-only', '@A3', '@CUR-4990'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');
		await setFlagOverrides(context, baseURL!, {
			'conversation-expiry': true,
			'agent-mode': false
		});
		const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
		try {
			await sql`
				insert into config (key, doc) values (${LAUNCH_KEY}, ${sql.json({ value: LONG_AGO_LAUNCH })})
				on conflict (key) do update set doc = excluded.doc
			`;
			await signInAsFreshUser(page);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, () => startChattingPastWelcome(welcomeDialog));
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await installCannedReplies(page);
			// The summary call answers with fixed text, as a canned turn does: this checks our flow, not a model.
			await installFaultInjectionHeader(page, 'canned_reply', /\/continue$/);
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('Help me choose between two used cars, briefly.');
			const id = await sendOpensConversation(page);
			await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
				timeout: 120_000
			});
			const iso = new Date(Date.now() - 24 * DAY).toISOString();
			await sql`
				update conversations
				set created_at = ${iso}, doc = jsonb_set(doc, '{createdAt}', ${sql.json({ $dt: iso })})
				where id = ${id}
			`;
			const stored = async () =>
				(
					await sql<{ messages: string; held: string }[]>`
						select (doc->'messages')::text as messages,
							(select count(*) from conversations o where o.user_id = c.user_id)::text as held
						from conversations c where id = ${id}
					`
				)[0];
			const before = await stored();
			expect(before.held, 'the fresh account holds more than the one chat').toBe('1');

			await page.reload({ waitUntil: 'load' });
			const banner = page.getByTestId('conversation-expiry-banner');
			await expect(banner).toBeVisible({ timeout: 30_000 });
			const continued = page.waitForResponse(
				(r) => /\/continue$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'
			);
			await banner.getByRole('button', { name: 'Continue in a new chat' }).click();
			expect((await continued).status(), 'the summary request failed').toBe(200);

			// A new chat: the entry page, not a conversation, with the summary in the composer to edit.
			await expect(page).not.toHaveURL(CONVERSATION_URL, { timeout: 30_000 });
			await expect(composer).toHaveValue(/Continuing an earlier conversation/, { timeout: 15_000 });
			await composer.press('End');
			await composer.pressSequentially(' Also: budget 8000.');
			await expect(composer, 'the summary cannot be edited').toHaveValue(/budget 8000\.$/);

			const after = await stored();
			expect(after.held, 'Continue stored a new chat before it was sent').toBe('1');
			expect(after.messages, "Continue changed the old chat's messages").toBe(before.messages);
		} finally {
			await sql.end({ timeout: 5 });
		}
	}
);
