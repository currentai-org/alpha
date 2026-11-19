// e2e-product: @chat
// e2e-area: @settings @history
import { test, expect } from './helpers/test';
import type { Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { freshTestEmail } from './helpers/signIn';
import { chatEntry } from './helpers/chatEntry';
import { installCannedReplies } from './helpers/faultInjection';
import { accountMenuItem } from './helpers/accountMenu';

// A person who came from Open WebUI can take their history back. Starting at /chat, they open
// Settings → Account from the account menu and download "Move your conversations to Open WebUI": the
// file Open WebUI's Settings → Data Controls → Import Chats reads. Then the round trip: the importer
// (`pnpm import:open-webui <file> --as <email>`) brings that file into a fresh account on the
// same database this preview reads, its parity report must say every conversation and message arrived,
// and the fresh account's own download must hold the same conversations, branches, pin and archive.

test.use({ viewport: { width: 1280, height: 800 } });

type ChatFile = {
	title: string;
	pinned: boolean;
	archived: boolean;
	meta: { alpha_export?: { revision?: string } };
	chat: {
		history: {
			currentId: string | null;
			messages: Record<
				string,
				{ parentId: string | null; childrenIds: string[]; role: string; content: string }
			>;
		};
	};
}[];

type TreeNode = { role: string; content: string; children: TreeNode[] };

/** Each chat as title, pin, archive and message tree; ids differ between accounts, so they are left out. */
function shapeOf(file: ChatFile) {
	return file
		.map((c) => {
			const msgs = c.chat.history.messages;
			const node = (id: string): TreeNode => ({
				role: msgs[id].role,
				content: msgs[id].content,
				children: msgs[id].childrenIds.map(node)
			});
			const roots = Object.keys(msgs).filter((id) => msgs[id].parentId === null);
			return { title: c.title, pinned: c.pinned, archived: c.archived, tree: roots.map(node) };
		})
		.sort((a, b) => a.title.localeCompare(b.title));
}

/** From /chat, the account menu's Settings, then Account, then the Open WebUI row's download. */
async function downloadOpenWebUiFile(page: Page): Promise<ChatFile> {
	await page.goto(chatEntry(), { waitUntil: 'load' });
	await (await accountMenuItem(page, 'Settings', { timeout: 20_000 })).click();
	await page.getByRole('link', { name: 'Account', exact: true }).click();
	await expect(page).toHaveURL(/\/chat\/settings\/account$/, { timeout: 15_000 });
	const row = page.getByRole('link', {
		name: 'Download your conversations as a file Open WebUI can import'
	});
	await expect(row, 'every signed-in account is offered the Open WebUI row').toBeVisible({
		timeout: 15_000
	});
	await expect(row).toContainText('Settings, Data Controls, Import Chats');
	const [download] = await Promise.all([page.waitForEvent('download'), row.click()]);
	expect(download.suggestedFilename()).toMatch(/^chat-export-\d+\.json$/);
	const path = await download.path();
	if (!path) throw new Error('download event fired but Playwright kept no local copy');
	// A second click inside the ten-minute window would bounce back here, so the row says when instead.
	await expect(page.getByTestId('open-webui-row-locked')).toContainText(
		'You can download again after'
	);
	return JSON.parse(readFileSync(path, 'utf8')) as ChatFile;
}

async function conversationMessages(page: Page, id: string) {
	const res = await page.request.get(`/chat/api/v2/conversations/${id}`);
	expect(res.ok(), `reading the conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json: { messages: { from: string; content: string }[] } };
	return body.json.messages;
}

test(
	"the account page downloads Open WebUI's chat file, and the importer brings it into a fresh account with every branch, pin and archive at parity",
	{ tag: ['@preview-only', '@CUR-4860'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(360_000);
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl) {
			throw new Error(
				'SCENARIO_DATABASE_URL is unset: the importer has to write to the database this preview reads'
			);
		}
		await setFlagOverrides(context, baseURL!, {
			// The router sends some prompts to the agent; this test is about the file.
			'agent-mode': false
		});
		await signInAsFreshUser(page);
		const stamp = Date.now();
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const model = models[0]?.id ?? models[0]?.name;
		expect(model, 'the preview lists no model').toBeTruthy();

		// The fixture account: one conversation with two answers to its question (a retry), pinned...
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await installCannedReplies(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Suggest a name for a soup kitchen in one short sentence.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const branchedId = page.url().match(/\/conversation\/([a-f0-9]+)/)![1];
		const retry = page
			.locator('[data-message-role="assistant"]')
			.last()
			.getByRole('button', { name: 'Retry' });
		await expect(retry).toBeVisible({ timeout: 150_000 });
		await retry.click();
		await expect
			.poll(
				async () =>
					(await conversationMessages(page, branchedId)).filter(
						(m) => m.from === 'assistant' && m.content.trim()
					).length,
				{ message: 'the retry never stored a second answer', timeout: 150_000 }
			)
			.toBe(2);
		await expect(retry).toBeVisible({ timeout: 60_000 });
		const branchedTitle = `Branched ${stamp}`;
		for (const data of [{ title: branchedTitle }, { pinned: true }]) {
			const res = await page.request.patch(`/chat/api/v2/conversations/${branchedId}`, { data });
			expect(res.ok(), `PATCH ${JSON.stringify(data)} answered ${res.status()}`).toBe(true);
		}
		// ...and one archived, with no messages.
		const created = await page.request.post('/chat/conversation', { data: { model } });
		expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
		const { conversationId: archivedId } = (await created.json()) as { conversationId: string };
		const archivedTitle = `Archived ${stamp}`;
		for (const data of [{ title: archivedTitle }, { archived: true }]) {
			const res = await page.request.patch(`/chat/api/v2/conversations/${archivedId}`, { data });
			expect(res.ok(), `PATCH ${JSON.stringify(data)} answered ${res.status()}`).toBe(true);
		}

		const exported = await downloadOpenWebUiFile(page);
		const before = shapeOf(exported);
		expect(before.map((c) => [c.title, c.pinned, c.archived])).toEqual([
			[archivedTitle, false, true],
			[branchedTitle, true, false]
		]);
		expect(
			exported.every((c) => c.meta.alpha_export?.revision === 'b8f2c6d91a04'),
			'every chat names the Open WebUI revision it targets'
		).toBe(true);
		const question = before[1].tree;
		expect(question, 'the branched chat has one question at its root').toHaveLength(1);
		expect(question[0].role).toBe('user');
		expect(
			question[0].children.map((c) => c.role),
			'both answers travel, as siblings'
		).toEqual(['assistant', 'assistant']);

		// The round trip: the importer writes the file into a fresh account.
		const freshEmail = freshTestEmail();
		await signInAsFreshUser(page, freshEmail);
		const file = test.info().outputPath('chat-export.json');
		writeFileSync(file, JSON.stringify(exported));
		// The package script, run as an operator would; web/ is two levels up from this spec.
		const importer = ['import:open-webui', file, '--as', freshEmail, '--model', String(model)];
		const run = spawnSync('pnpm', importer, {
			cwd: fileURLToPath(new URL('../..', import.meta.url)),
			env: { ...process.env, DATABASE_URL: databaseUrl },
			encoding: 'utf8',
			timeout: 180_000
		});
		const report = `${run.stdout}\n${run.stderr}`;
		await test.info().attach('import-report.txt', { body: report, contentType: 'text/plain' });
		expect(run.status, `import:open-webui exited ${run.status}:\n${report}`).toBe(0);
		expect(report).toContain('PARITY');
		expect(report).toContain('conversations: 2 in, 2 imported, 0 updated, 0 unchanged, 0 skipped');
		expect(report).toContain('messages:      3 in, 3 stored, 0 skipped');
		expect(report).toContain('parity: OK');

		// The fresh account sees them: the pinned chat heads the rail, and its own download matches the first.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		const firstRow = page.locator('a[href*="/conversation/"]:visible').first();
		await expect(
			firstRow,
			"the imported pinned chat should head the fresh account's rail"
		).toContainText(branchedTitle, {
			timeout: 20_000
		});
		await expect(
			page.locator('a[href*="/conversation/"]:visible').filter({ hasText: archivedTitle })
		).toHaveCount(0);
		const after = shapeOf(await downloadOpenWebUiFile(page));
		expect(
			after,
			'the fresh account holds the same conversations, branches, pin and archive'
		).toEqual(before);
	}
);
