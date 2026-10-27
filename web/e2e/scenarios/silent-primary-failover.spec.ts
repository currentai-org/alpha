// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { pinnedChatEntry } from './helpers/servedModel';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// When the primary lane stalls without sending headers, nothing throws, so the failover ladder
// waited on it and the output screen's 25s deadline ended the turn with "at capacity" (CUR-2315) (CUR-2316).
// The `primary_lane_hangs` fault reproduces the stall on one request;
// `failover-on-silent-lane` moves the turn to a next lane after 12s, when there is one.
//
// A picked model is answered by itself, a retry of itself, or not at all (CUR-3936). Apertus has no
// cross-model backup lane. On preview the
// backup host is the primary's own, so Apertus has one lane and a stall ends on an error notice.
// Mistral Large 3's Medium lane was the last cross-model backup, removed in CUR-4383. Preview-only: the fault switch is never armed on production.
const APERTUS = 'swiss-ai/apertus-v1.5-70b';
const AT_CAPACITY = /at capacity right now/i;
const TIMED_OUT = /took too long to respond/i;
const ERROR_NOTICE = /took too long to respond|at capacity right now/i;

async function askWithSilentPrimary(page: Page, label: string, model = APERTUS) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await installFaultInjectionHeader(page, 'primary_lane_hangs');
	await page.goto(pinnedChatEntry(model), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	// No maths in it: with math-routing on, a maths question goes to the route model and never reaches
	// the primary lane this fault stalls (CUR-2198).
	await composer.fill(`${label} ${Date.now()}: what is the capital of Switzerland? One word.`);
	const sentAt = Date.now();
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
	const reply = page.locator('[data-message-role="assistant"]').last();
	return { reply, conversationId, sentAt };
}

async function storedAnswer(page: Page, conversationId: string) {
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	const body = (await res.json()) as {
		json?: {
			messages?: Array<{
				from: string;
				content?: string;
				routerMetadata?: { model?: string };
				failover?: { from?: string; to?: string; reason?: string };
			}>;
		};
	};
	return (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
}

// The fault stalls the first lane, which for Apertus is its only one (CUR-3939). Its last lane gives up
// at 45s (harnessProfiles.ts `silentGiveUpMs`, CUR-4403), so the turn ends on the timeout notice
// before Apertus's own 60s watchdog. Put a substitute lane back behind it and the substitute
// answers, and this goes red on the failover record.
const GIVE_UP_BOUND_MS = 59_000;
test(
	'a stalled Apertus primary is answered by Apertus or ends on an error notice, never by another model',
	{ tag: ['@F2', '@preview-only', '@CUR-2316', '@CUR-3936', '@CUR-3939', '@needs-apertus'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'failover-on-silent-lane': true });
		const { reply, conversationId, sentAt } = await askWithSilentPrimary(
			page,
			'CUR-3936 silent primary'
		);

		await journeyStep(page, 'F2', 6, async () => {
			await expect(
				// The timeout notice carries its own Retry, so both halves can match at once.
				reply.getByRole('button', { name: 'Retry' }).or(reply.getByText(ERROR_NOTICE)).first(),
				'the turn never finished' + warmupContext()
			).toBeVisible({ timeout: 90_000 });
			const elapsedMs = Date.now() - sentAt;
			test.info().annotations.push({ type: 'turn ms', description: String(elapsedMs) });
			await expect(
				reply,
				'the silent Apertus turn ended on something other than the timeout notice'
			).toContainText(TIMED_OUT);
			expect(
				elapsedMs,
				`the silent turn took ${elapsedMs}ms to end, so it waited for the 60s watchdog rather than the give-up`
			).toBeLessThan(GIVE_UP_BOUND_MS);
		});
		const answer = await storedAnswer(page, conversationId);
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Apertus`
		).toBeUndefined();
		const served = (answer?.routerMetadata?.model ?? '').toLowerCase();
		expect(
			served === '' || served.includes('apertus'),
			`the turn records ${JSON.stringify(served)} as its served model, which is not the Apertus that was picked`
		).toBe(true);
	}
);

// The off position, pinned to Large 4: the
// stall runs to the route's own generation watchdog and ends the turn on its timeout notice. Until
// CUR-2341 the output screen's 25s window ended it first with "at capacity"; that window now opens at
// the first token, and a lane that never sends one is the watchdog's to end.
// With the flag off this fault gets a 15s watchdog instead of 45s (CUR-2757, watchdogDeadlineMs).
test(
	'with failover-on-silent-lane off, the same stall ends on the timeout notice and the backup never answers',
	{ tag: ['@F2', '@preview-only', '@CUR-2316', '@CUR-2341'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'failover-on-silent-lane': false });
		const { reply, conversationId } = await askWithSilentPrimary(
			page,
			'CUR-2316 control',
			LARGE4_MODEL
		);

		await expect(
			reply,
			"with the flag off the stall should run to the route's generation watchdog and end on its timeout notice" +
				warmupContext()
		).toContainText(TIMED_OUT, { timeout: 90_000 });
		await expect(
			reply,
			"the stall ended on the output screen's at-capacity notice, which no longer bounds the wait for a first token (CUR-2341)"
		).not.toContainText(AT_CAPACITY);
		const answer = await storedAnswer(page, conversationId);
		expect(
			answer?.failover,
			'the backup lane answered with the flag off, so this control no longer shows the stall'
		).toBeUndefined();
	}
);

// A model that sends nothing answers nobody, the same as one answering 429, so the tab marks it
// busy the moment its turn ends on the timeout notice (busyHere.ts) (CUR-4098). The visitor meets the note on their
// next new chat, which is a client-side navigation and keeps the tab's mark. The failed chat keeps a live
// composer and picker (CUR-4494), so the test waits for the new chat's page before opening a picker:
// one opened on the old page is torn down mid-click. The server's three-in-a-row mark is unit-tested in
// failover.spec.ts instead: it is shared by everyone on the preview, so a fault-injected stall never
// counts toward it.
test(
	"after a picked Apertus goes silent, its row in the next new chat's picker says it is busy",
	{ tag: ['@F2', '@preview-only', '@CUR-4098', '@needs-apertus'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'failover-on-silent-lane': true,
			'auto-routing': true
		});
		const { reply } = await askWithSilentPrimary(page, 'Quick question');
		await expect(
			reply,
			'the silent Apertus turn never ended on the timeout notice' + warmupContext()
		).toContainText(TIMED_OUT, { timeout: 90_000 });

		await page.getByRole('link', { name: /^New chat/ }).click();
		await expect(page, 'New chat never left the failed conversation').not.toHaveURL(
			/\/conversation\//,
			{
				timeout: 30_000
			}
		);
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		await page.getByRole('button', { name: /^Model:/ }).click({ timeout: 30_000 });
		await page.getByRole('menuitem', { name: 'Choose a model yourself' }).click();
		await expect(
			page.locator(`[data-model-id="${APERTUS}"]`).locator('[data-model-busy]'),
			'the Apertus row carries no busy note after its turn went silent in this tab'
		).toBeVisible();
	}
);
