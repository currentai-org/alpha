// An Open WebUI install moves onto the composed self-host stack. The importer
// (`node build/cli/import-open-webui.mjs`, web/src/lib/chat/server/openWebUiImport/) runs inside the
// stack's own web container as the published image ships it, so it writes the stack's Postgres and its
// `files` volume exactly as a forker's run would;
// then a browser signs the imported person in and finds their history.
//
//   1. SQLite fixture (the 0.12.0 head revision, built by the importer's own test builder) imported twice:
//      the first run stores everything, the second imports and updates nothing and still reports parity.
//   2. The same rows in a Postgres database beside Alpha's: imported once, every conversation and file is
//      already present (the two readers agree on idempotence keys and fingerprints), and twice, still nothing new.
//   3. One new chat is added to Alice's SQLite install and the importer rerun: it imports only that chat and
//      leaves the five already imported alone.
//   4. Sign-in as the imported account, the chats (the new one included) in the sidebar, the imported
//      conversation whose first message carried files shows them, and one of them opens from My files.
//   5. On the stack's two endpoints, Auto keeps a routine turn on the first and sends a large task to the
//      frontier model AUTO_LARGE_TASK_MODEL names.
//
// Sign-in is by email code read from the stack's database (selfhost-stack.ts says how).
//
// Run by the source repository's self-host CI after the walk:
//   cd web && pnpm exec playwright test --config=e2e/owui-migrate.config.ts
// Environment: OWUI_BASE_URL (default http://localhost:3000), SELFHOST_DIR (default ../selfhost, relative to web/),
// SELFHOST_COMPOSE_PROFILE (default local), POSTGRES_PASSWORD (default alpha), OWUI_MODEL (the model id
// conversations are stored under; default compose's local alias).
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compose, dismissWelcome, psql, signInByEmailCode } from './selfhost-stack';
import {
	PG_COLUMN_TYPES,
	FIXTURE_FILE_BYTES,
	buildFixture
} from '../src/lib/chat/server/openWebUiImport/__tests__/owuiFixture';

const base = (process.env.OWUI_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const pgPassword = process.env.POSTGRES_PASSWORD ?? 'alpha';
const model = process.env.OWUI_MODEL ?? 'qwen2.5-0.5b-instruct';
const REMOTE_DIR = '/tmp/owui-src';
const PG_SOURCE_URL = `postgresql://alpha:${pgPassword}@db:5432/owui_src`;
// Alice is the fixture's admin with three chats; the first holds the two attachments.
const ALICE = 'alice@example.org';
const ATTACHED_CHAT = 'Potluck basics';
const NEW_CHAT_TITLE = 'Potluck follow-up';

/** The importer as an operator runs it: the image's bundled CLI, inside the web container, with the stack's own env. */
function runImporter(source: string, env: Record<string, string> = {}): string {
	const report = compose(
		[
			'exec',
			'web',
			'node',
			'build/cli/import-open-webui.mjs',
			source,
			'--data-dir',
			REMOTE_DIR,
			'--model',
			model
		],
		{ env: { HOME: '/tmp', ...env } }
	);
	// The parity report names every skipped row and file with its reason; printed so a failed count
	// in CI says why, not only that.
	console.log(report);
	return report;
}

interface Counts {
	conversationsIn: number;
	imported: number;
	updated: number;
	unchanged: number;
	skipped: number;
	filesIn: number;
	filesImported: number;
	filesUnchanged: number;
	parityOk: boolean;
}

/** Sums the parity report's per-person lines (report.ts formatReport) into totals. */
function counts(report: string): Counts {
	const sum = (re: RegExp, group: number) =>
		[...report.matchAll(re)].reduce((n, m) => n + Number(m[group]), 0);
	const conv =
		/conversations:\s+(\d+) in, (\d+) imported, (\d+) updated, (\d+) unchanged, (\d+) skipped/g;
	const files = /files:\s+(\d+) in, (\d+) imported, (\d+) unchanged/g;
	return {
		conversationsIn: sum(conv, 1),
		imported: sum(conv, 2),
		updated: sum(conv, 3),
		unchanged: sum(conv, 4),
		skipped: sum(conv, 5),
		filesIn: sum(files, 1),
		filesImported: sum(files, 2),
		filesUnchanged: sum(files, 3),
		parityOk: /^parity: OK$/m.test(report)
	};
}

const lit = (v: unknown, type: string) =>
	v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'::text::${type}`;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The SQLite fixture's rows as SQL for a Postgres database, with the column types an Open WebUI install there has. */
function postgresFixtureSql(sqlitePath: string): string {
	const lite = new DatabaseSync(sqlitePath, { readOnly: true });
	try {
		const out: string[] = [];
		for (const [table, columns] of Object.entries(PG_COLUMN_TYPES)) {
			const cols = Object.entries(columns);
			out.push(`CREATE TABLE ${q(table)} (${cols.map(([c, t]) => `${q(c)} ${t}`).join(', ')});`);
			for (const row of lite.prepare(`SELECT * FROM "${table}"`).all() as Record<
				string,
				unknown
			>[]) {
				out.push(
					`INSERT INTO ${q(table)} (${cols.map(([c]) => q(c)).join(', ')}) VALUES (${cols.map(([c, t]) => lit(row[c], t)).join(', ')});`
				);
			}
		}
		return out.join('\n');
	} finally {
		lite.close();
	}
}

/** What the serial tests hand on to the files test at the end. */
const runs: {
	sqliteFirst?: Counts;
	sqliteSecond?: Counts;
	postgres: Counts[];
	conversationUrl: string;
	statePath: string;
} = { postgres: [], conversationUrl: '', statePath: join(tmpdir(), 'owui-migrate-alice.json') };

test.describe.serial('Open WebUI install migrates onto the composed self-host stack', () => {
	let sqlitePath: string;

	test.beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owui-migrate-'));
		sqlitePath = join(dir, 'webui.db');
		buildFixture(sqlitePath).close();
		mkdirSync(join(dir, 'uploads'));
		for (const [name, bytes] of Object.entries(FIXTURE_FILE_BYTES))
			writeFileSync(join(dir, 'uploads', name), bytes);
		// The install's DATA_DIR (webui.db beside uploads/) goes into the web container, where the importer reads it.
		compose(['cp', dir, `web:${REMOTE_DIR}`]);
		// `docker compose cp` keeps the runner's uid and mkdtemp's 0700 mode, which the image's user (uid
		// 1000) cannot enter, so the copy is handed to it the way an operator's mounted install would be.
		// The image has no chown (distroless), so Node does it, as root.
		compose([
			'exec',
			'-u',
			'root',
			'web',
			'node',
			'-e',
			'const fs = require("fs"), path = require("path"), d = process.argv[1]; fs.chownSync(d, 1000, 1000); for (const f of fs.readdirSync(d, { recursive: true })) fs.chownSync(path.join(d, f), 1000, 1000)',
			REMOTE_DIR
		]);
	});

	test('SQLite source: the first run stores everything and the second imports nothing new', () => {
		const first = counts(runImporter(`${REMOTE_DIR}/webui.db`));
		expect(first.conversationsIn, 'the fixture holds 6 chats').toBe(6);
		expect(
			first.imported,
			"every chat with a known owner is imported (the ghost user's chat is skipped with a reason)"
		).toBe(5);
		expect(first.skipped).toBe(1);
		runs.sqliteFirst = first;
		expect(first.parityOk, 'first run: parity: OK').toBe(true);

		const second = counts(runImporter(`${REMOTE_DIR}/webui.db`));
		expect(second.imported, 'second run imports no conversation').toBe(0);
		expect(second.updated, 'second run updates no conversation').toBe(0);
		expect(
			second.unchanged,
			'every conversation the first run stored is found and left alone'
		).toBe(first.imported);
		runs.sqliteSecond = second;
		expect(second.parityOk, 'second run: parity: OK').toBe(true);
	});

	test('Postgres source: the same install read from Postgres finds everything already imported, twice', () => {
		psql('postgres', 'DROP DATABASE IF EXISTS owui_src;');
		psql('postgres', 'CREATE DATABASE owui_src;');
		psql('owui_src', postgresFixtureSql(sqlitePath));
		for (const run of ['first', 'second']) {
			const c = counts(runImporter(PG_SOURCE_URL));
			expect(c.conversationsIn, `${run} Postgres run reads all 6 chats`).toBe(6);
			expect(c.imported, `${run} Postgres run imports no conversation`).toBe(0);
			expect(c.updated, `${run} Postgres run updates no conversation`).toBe(0);
			expect(c.unchanged, `${run} Postgres run finds all 5 imported chats unchanged`).toBe(5);
			expect(c.skipped, `${run} Postgres run skips the ghost user's chat`).toBe(1);
			runs.postgres.push(c);
			expect(c.parityOk, `${run} Postgres run: parity: OK`).toBe(true);
		}
	});

	test('SQLite source: one new chat added to the install is the only one a rerun imports', () => {
		// The fixture module's addChat takes a host-side handle, but the install's webui.db is the copy inside the
		// web container, so the same two inserts (a chat row and its chat_message rows, the shape addChat and
		// insertChatRows write) run there with the container's node:sqlite. `at` is later than every fixture row.
		const at = 1_760_001_000;
		const script = `
			const { DatabaseSync } = require('node:sqlite');
			const [path, title, at] = process.argv.slice(1);
			const db = new DatabaseSync(path);
			const t = Number(at);
			db.prepare('INSERT INTO chat (id, user_id, title, chat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
				.run('chat-a4', 'u-alice', title, JSON.stringify({ title }), t, t + 100);
			const ins = db.prepare('INSERT INTO chat_message (id, chat_id, user_id, role, parent_id, content, files, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
			ins.run('chat-a4-n1', 'chat-a4', 'u-alice', 'user', null, JSON.stringify('What should I bring next time?'), null, null, t + 1, t + 1);
			ins.run('chat-a4-n2', 'chat-a4', 'u-alice', 'assistant', 'n1', JSON.stringify('Something that travels well.'), null, 'fixture-model', t + 2, t + 2);
			db.close();
		`;
		compose([
			'exec',
			'web',
			'node',
			'-e',
			script,
			`${REMOTE_DIR}/webui.db`,
			NEW_CHAT_TITLE,
			String(at)
		]);

		const rerun = counts(runImporter(`${REMOTE_DIR}/webui.db`));
		expect(rerun.conversationsIn, 'the install now holds 7 chats').toBe(7);
		expect(rerun.imported, 'the rerun imports only the new chat').toBe(1);
		expect(rerun.updated, 'the rerun updates no chat').toBe(0);
		expect(rerun.unchanged, 'the five chats already imported are left alone').toBe(5);
		expect(rerun.skipped, "the ghost user's chat is still skipped").toBe(1);
		expect(rerun.parityOk, 'rerun after a new chat: parity: OK').toBe(true);
	});

	test('the imported person signs in, sees the chat in the sidebar and opens the conversation', async ({
		browser
	}) => {
		const context = await browser.newContext({
			baseURL: base,
			viewport: { width: 1280, height: 900 }
		});
		try {
			// The session must be the imported account, not a new one.
			await signInByEmailCode(context.request, base, ALICE);

			const page = await context.newPage();
			await dismissWelcome(page);
			await page.goto('/', { waitUntil: 'domcontentloaded' });
			const link = page.getByRole('link', { name: ATTACHED_CHAT }).first();
			await expect(link, 'the imported chat is listed in the sidebar').toBeVisible({
				timeout: 60_000
			});
			await expect(
				page.getByRole('link', { name: NEW_CHAT_TITLE }).first(),
				'the chat added before the rerun is listed in the sidebar'
			).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: test.info().outputPath('sidebar.png'), fullPage: true });

			// The web container was recreated on Open WebUI's names alone (OPENAI_BASE_URL empty), so the
			// models it serves came through OPENAI_API_BASE_URLS: the llama model's id is the contract, in the
			// models list the page is built from and in the composer's model switcher.
			const llamaModel = process.env.OWUI_EXPECT_MODEL ?? 'qwen2.5-0.5b-instruct';
			const res = await page.request.get('/chat/api/v2/models');
			expect(res.ok(), `/chat/api/v2/models answered ${res.status()}`).toBe(true);
			const body = (await res.json()) as { json?: { id: string }[] } | { id: string }[];
			const served = (Array.isArray(body) ? body : (body.json ?? [])).map((m) => m.id);
			expect(
				served,
				`a stack configured only with OPENAI_API_BASE_URLS serves the llama model ${llamaModel}`
			).toContain(llamaModel);
			const switcher = page.getByRole('button', { name: /^Model:/ });
			await expect(switcher, 'the composer has a model switcher').toBeVisible({ timeout: 30_000 });
			await switcher.click();
			// The stack runs with Auto on, so the model rows sit behind the "Choose a model yourself" submenu.
			const chooseYourself = page.getByRole('menuitem', { name: 'Choose a model yourself' });
			await expect(chooseYourself, 'the switcher offers choosing a model yourself').toBeVisible({
				timeout: 10_000
			});
			await chooseYourself.click();
			await expect(
				page.locator(`[data-model-id="${llamaModel}"]`).first(),
				`the operator's own model ${llamaModel} has a row in the composer's model switcher`
			).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: test.info().outputPath('switcher.png'), fullPage: true });
			await page.keyboard.press('Escape');

			await link.click();
			await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(
				page.locator('[data-message-type="user"]').filter({ hasText: 'What is a potluck?' })
			).toBeVisible({ timeout: 30_000 });
			await expect(page.locator('[data-message-role="assistant"]').first()).toContainText(
				'shared meal'
			);
			await page.screenshot({ path: test.info().outputPath('conversation.png'), fullPage: true });
			runs.conversationUrl = page.url();
			await context.storageState({ path: runs.statePath });
		} finally {
			await context.close();
		}
	});

	// The stack serves two endpoints, the llama model and a stand-in frontier model, and the smoke names the
	// frontier one in AUTO_LARGE_TASK_MODEL. Auto ranks only catalogued models, so neither is one it can rank:
	// a routine first turn must stay on the first endpoint's model, a large task must go to the frontier one,
	// and that chat must stay there for a routine follow-up (escalate-only),
	// read from each conversation's stored model and, for the frontier, its fixed answer.
	test('Auto keeps a routine turn on the first endpoint and sends a large task to the frontier endpoint', async ({
		browser
	}) => {
		const llamaModel = process.env.OWUI_EXPECT_MODEL ?? 'qwen2.5-0.5b-instruct';
		const frontier = 'frontier-stub';
		// The hard draft routing.spec.ts and the auto-route X-ray scenario grade large.
		const LARGE_TASK =
			'Compare the tradeoffs between event sourcing and a plain relational schema for an invoicing system with about two million invoices a year. Explain why each choice affects auditing, corrections and reporting, evaluate which one a small team should pick, and design a migration from the relational schema if they later need event sourcing. What breaks first? What would you measure? How would you roll it back?';
		const context = await browser.newContext({
			baseURL: base,
			viewport: { width: 1280, height: 900 }
		});
		try {
			await signInByEmailCode(context.request, base, ALICE);
			const page = await context.newPage();
			await dismissWelcome(page);

			const res = await page.request.get('/chat/api/v2/models');
			const body = (await res.json()) as { json?: { id: string }[] } | { id: string }[];
			const served = (Array.isArray(body) ? body : (body.json ?? [])).map((m) => m.id);
			expect(served, "the stack serves both endpoints' models").toEqual(
				expect.arrayContaining([llamaModel, frontier])
			);

			/** Sends `text` from a new chat and returns the model the conversation was started on. */
			const startChat = async (text: string, shot: string) => {
				await page.goto('/', { waitUntil: 'domcontentloaded' });
				const composer = page.getByRole('textbox', { name: /^Message/ }).first();
				await composer.click({ timeout: 60_000 });
				await composer.fill(text);
				await composer.press('Enter');
				await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
				const id = new URL(page.url()).pathname.split('/').pop()!;
				const conv = await page.request.get(`/chat/api/v2/conversations/${id}`);
				expect(conv.ok(), `GET the conversation answered ${conv.status()}`).toBe(true);
				const raw = (await conv.json()) as { json?: { model?: string }; model?: string };
				await page.screenshot({ path: test.info().outputPath(shot), fullPage: true });
				return raw.json?.model ?? raw.model;
			};

			expect(
				await startChat('What is a potluck?', 'auto-routine.png'),
				"a routine turn stays on the first endpoint's model"
			).toBe(llamaModel);
			expect(
				await startChat(LARGE_TASK, 'auto-large.png'),
				'a large task goes to the model AUTO_LARGE_TASK_MODEL names'
			).toBe(frontier);
			// The stub's answer is a fixed string, so the stored answer says which endpoint served the turn.
			const largeId = new URL(page.url()).pathname.split('/').pop()!;
			await expect(async () => {
				const conv = await page.request.get(`/chat/api/v2/conversations/${largeId}`);
				const raw = (await conv.json()) as {
					json?: { messages?: { from?: string; content?: string }[] };
				};
				const answers = (raw.json?.messages ?? []).filter((m) => m.from === 'assistant');
				expect(
					answers.map((m) => m.content ?? '').join(' '),
					'the frontier endpoint answered the large task'
				).toContain('Answered by the frontier stub.');
			}).toPass({ timeout: 60_000 });
			// Escalate-only: a chat that moved to the frontier model stays there for its follow-ups, so the
			// model that wrote the answer answers questions about it, and its prompt cache is kept.
			const composer = page.getByRole('textbox', { name: /^Message/ }).first();
			await composer.fill('Thanks!');
			const followUp = page.waitForResponse(
				(r) =>
					r.request().method() === 'POST' &&
					new URL(r.url()).pathname.endsWith(`/conversation/${largeId}`),
				{ timeout: 60_000 }
			);
			await composer.press('Enter');
			expect((await followUp).ok(), 'the follow-up was sent').toBe(true);
			const after = await page.request.get(`/chat/api/v2/conversations/${largeId}`);
			const afterRaw = (await after.json()) as { json?: { model?: string } };
			expect(afterRaw.json?.model, 'a routine follow-up keeps the chat on the frontier model').toBe(
				frontier
			);
			await page.screenshot({
				path: test.info().outputPath('auto-large-answer.png'),
				fullPage: true
			});
		} finally {
			await context.close();
		}
	});

	// Last on purpose: files go through the upload path's safety scan, which refuses every file when no
	// scanner is configured (custodialStorage.ts, CsamScannerUnconfiguredError). Kept apart so that
	// refusal reads as its own failure and the chat, parity and sign-in checks above still report.
	test('files: the three owned files are stored once, found again on every rerun, and the message shows them', async ({
		browser
	}) => {
		expect(
			runs.sqliteFirst?.filesImported,
			"the three owned files are stored; the orphan's is skipped"
		).toBe(3);
		expect(runs.sqliteSecond?.filesImported, 'second SQLite run uploads no file').toBe(0);
		expect(runs.sqliteSecond?.filesUnchanged, 'second SQLite run finds all 3 stored files').toBe(3);
		for (const c of runs.postgres) {
			expect(c.filesImported, 'a Postgres run uploads no file').toBe(0);
			expect(c.filesUnchanged, 'a Postgres run finds all 3 stored files').toBe(3);
		}
		const context = await browser.newContext({ baseURL: base, storageState: runs.statePath });
		try {
			const page = await context.newPage();
			await dismissWelcome(page);
			await page.goto(runs.conversationUrl, { waitUntil: 'domcontentloaded' });
			const attached = page.getByLabel('Attached files').first();
			await expect(attached, 'the message that carried files shows them').toBeVisible({
				timeout: 30_000
			});
			await expect(attached, 'the markdown upload is there by name').toContainText(/menu\.md/);

			// The same imported file opens from My files, its bytes read back from the stack's store.
			// The importer files it as documents/owui-<id>-menu.md (openWebUiImport/files.ts importedPath), and
			// My files names a row by that basename; the anchored pattern leaves out the menu.md.txt sidecar.
			const menuKey = Object.keys(FIXTURE_FILE_BYTES).find((k) => k.endsWith('_menu.md'));
			expect(menuKey, 'the fixture install holds menu.md').toBeTruthy();
			const menuText = new TextDecoder().decode(FIXTURE_FILE_BYTES[menuKey!]);
			await page.goto('/storage', { waitUntil: 'domcontentloaded' });
			await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			await page
				.getByRole('button', { name: /^Open owui-[A-Za-z0-9]+-menu\.md$/ })
				.click({ timeout: 30_000 });
			const preview = page.getByTestId('file-preview');
			await expect(
				preview,
				'the imported menu.md opens from My files with the bytes the Open WebUI install held'
			).toContainText(menuText, { timeout: 30_000 });
			await page.screenshot({
				path: test.info().outputPath('my-files-preview.png'),
				fullPage: true
			});
		} finally {
			await context.close();
		}
	});
});
