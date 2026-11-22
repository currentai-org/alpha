// e2e-product: @chat
// e2e-area: @composer @storage
//
// On the self-host build (APP_SURFACE=chat, ALPHA_EDITION=selfhost, no PostHog, no classifier), a PDF and
// a Word file attached from the composer are read to text on the server and reach the model with the
// turn. Runs in mock-model-e2e.sh only (a build of the tree, and the chat-surface image in
// web-image.yml): the proof is the request the mock model received, read from aimock's journal, so the
// test checks what our server sent rather than how a model worded its answer. Each fixture's checked
// sentence is inside the file and not in its name, so finding it in the prompt means the server read
// the document.
import { test, expect, type Page } from './helpers/test';
import { join } from 'node:path';
import { chatEntry } from './helpers/chatEntry';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';

const FIXTURES = join(import.meta.dirname, 'fixtures');

// mock-model-e2e.sh points the app at aimock on loopback and exports that URL. @mock-only keeps every
// other run, which has no journal to read, from collecting this file (playwright.config.ts).
const MOCK_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/v1\/?$/, '');
const MOCK_JOURNAL = /^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK_BASE)
	? `${MOCK_BASE}/__aimock/journal`
	: null;

/** How many requests the mock model has received whose body holds `sentence`. */
async function requestsHolding(page: Page, sentence: string): Promise<number> {
	// No limit: aimock's limit counts from the oldest entry, so a capped read can miss this turn.
	expect(MOCK_JOURNAL, `OPENAI_BASE_URL is not aimock on loopback: ${MOCK_BASE}`).toBeTruthy();
	const res = await page.request.get(MOCK_JOURNAL!);
	expect(res.ok(), `aimock's journal answered ${res.status()}`).toBe(true);
	const entries = (await res.json()) as { path?: string; body?: unknown }[];
	return entries.filter(
		(e) => e.path?.endsWith('/chat/completions') && JSON.stringify(e.body).includes(sentence)
	).length;
}

const CASES = [
	{
		title: 'a PDF attached from the composer reaches the model as text',
		file: 'expenses-policy.pdf',
		kind: 'PDF document',
		sentence: 'Taxis are reimbursed up to 37 EUR per trip'
	},
	{
		title: 'a Word file attached from the composer reaches the model as text',
		file: 'allotment-rules.docx',
		kind: 'Word document',
		sentence: 'Each plot costs 12 EUR per season'
	}
];

test.describe(
	'documents on a self-hosted Alpha',
	{ tag: ['@root', '@mock-model', '@mock-only', '@A6'] },
	() => {
		for (const c of CASES) {
			test(c.title, async ({ page }) => {
				// The composer wait, a 90 s turn, and slack.
				test.setTimeout(180_000);
				await signInAsFreshUser(page);
				// The test fixture presses past the first-run welcome (helpers/test.ts, welcomeHandled).
				await page.goto(chatEntry(), { waitUntil: 'commit' });
				const composer = page.getByLabel('Message AI Potluck');
				await expect(composer).toBeVisible({ timeout: 30_000 });
				await composerHydrated(page);
				const before = await requestsHolding(page, c.sentence);

				// Through the attach menu, the way a person finds it.
				await page.getByRole('button', { name: /^Add files and tools/ }).click();
				const chooser = page.waitForEvent('filechooser');
				await page.getByRole('menuitem', { name: 'Attach files' }).click();
				await (await chooser).setFiles(join(FIXTURES, c.file));
				await expect(
					page.getByText(c.file).first(),
					`${c.file} chosen from the attach menu never showed as attached in the composer`
				).toBeVisible({ timeout: 10_000 });
				await expect(page.getByText(c.kind).first()).toBeVisible();

				await composer.fill('What does the attached file say?');
				await sendOpensConversation(page, { timeout: 60_000 });
				await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
					timeout: 90_000
				});

				expect(
					await requestsHolding(page, c.sentence),
					`no request to the model held "${c.sentence}", so the text of ${c.file} never reached it`
				).toBeGreaterThan(before);
			});
		}
	}
);
