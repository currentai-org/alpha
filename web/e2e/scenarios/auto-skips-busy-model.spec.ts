// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import type { BrowserContext, TestInfo } from '@playwright/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { setFlagOverrides } from './helpers/flagOverride';
import {
	installBusyScopeHeader,
	installCannedReplies,
	runModelProbe
} from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// A model can refuse every call for hours, and the only thing that used to mark it busy was three
// visitors in a row failing on it. The warm cron now probes every picker model and
// marks a model busy on the first probe it fails, with no visitor turn at all. This spec makes one model's
// lanes refuse every call (`every_lane_rate_limited`) for one probe, then checks what a visitor gets: Auto sends the same
// question elsewhere and says the model is busy, the picker lists the model as unavailable right now,
// and a hand pick of it stays on it and says so before sending.
//
// The model is whichever one Auto picks for the question on this deployment, read from a first, healthy
// send, so the spec needs no particular model to be served. Its marks live under a scope of its own
// (`x-e2e-busy-scope`, modelBusy.ts), so no other visitor of the preview sees them.

const CHOICE_KEY = 'alpha:model-choice';
const PICKER_TRIGGER = /^Model:/;
const QUESTION = 'What is the capital of France? Answer in one sentence.';

type StoredConversation = {
	json?: {
		model?: string;
		messages?: { id: string; from?: string; autoRoute?: { model: string } }[];
	};
};

async function openChat(
	page: Page,
	context: BrowserContext,
	baseURL: string,
	scope: string,
	choice: string
) {
	await setFlagOverrides(context, baseURL, { 'auto-routing': true });
	await context.addInitScript(
		([key, value]) => {
			try {
				localStorage.setItem(key, value);
			} catch {
				/* storage unavailable */
			}
		},
		[CHOICE_KEY, choice] as const
	);
	await installBusyScopeHeader(page, scope);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

/** Sends the composer's draft and returns the gateway id the stored conversation ran on. */
async function sendAndReadModel(page: Page): Promise<string> {
	const conversationId = await sendOpensConversation(page);
	const answer = page.locator('[data-message-role="assistant"]').last();
	await expect(turnDone(answer)).toBeVisible({ timeout: 90_000 });
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const model = ((await res.json()) as StoredConversation).json?.model;
	expect(model, 'the stored conversation names no model').toBeTruthy();
	return model!;
}

/**
 * Opens the chat on Auto under a fresh busy scope, sends QUESTION once while every model is healthy to
 * learn which model Auto picks for it, then runs one warm probe on that model with every lane refusing.
 * Returns the model the probe marked busy. No visitor turn fails on the way.
 */
async function markAutosPickBusy(
	page: Page,
	context: BrowserContext,
	baseURL: string,
	testInfo: TestInfo,
	scope = `cur4042-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`,
	refusal: 429 | 402 = 429
): Promise<string> {
	const canned = await installCannedReplies(page);
	const composer = await openChat(page, context, baseURL, scope, 'auto');
	await composer.fill(QUESTION);
	const picked = await sendAndReadModel(page);
	const verdict = await runModelProbe(page, {
		model: picked,
		scope,
		refuse: true,
		fault: refusal === 402 ? 'every_lane_payment_required' : 'every_lane_rate_limited'
	});
	testInfo.annotations.push({
		type: 'probe',
		description: JSON.stringify({ scope, picked, canned, verdict })
	});
	expect(
		verdict,
		`the probe did not go red on lanes that answered ${refusal} to every call`
	).toMatchObject({
		ok: false,
		reason: `http-${refusal}`
	});
	return picked;
}

test(
	'one warm probe on a model whose lanes refuse every call marks it busy with no visitor turn, and Auto sends the same question to another model and says the first is busy',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }, testInfo) => {
		test.setTimeout(240_000);
		const picked = await markAutosPickBusy(page, context, baseURL!, testInfo);

		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		const fresh = page.getByLabel('Message AI Potluck');
		await fresh.click({ timeout: 30_000 });
		await fresh.fill(QUESTION);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		await expect(
			page.locator('[data-routing-why]'),
			"Auto's explanation does not say its first choice is busy: the probe's mark never reached the page"
		).toContainText('but it’s busy right now', { timeout: 30_000 });
		await page.keyboard.press('Escape');
		const routed = await sendAndReadModel(page);
		testInfo.annotations.push({ type: 'busy-pick', description: routed });
		expect(
			routed.toLowerCase(),
			'Auto sent the question to the model the probe marked busy'
		).not.toBe(picked.toLowerCase());
	}
);

test(
	'the picker shows a probe-marked model as unavailable right now, and a hand pick of it stays on it and says so before sending',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }, testInfo) => {
		test.setTimeout(240_000);
		const picked = await markAutosPickBusy(page, context, baseURL!, testInfo);

		await page.reload({ waitUntil: 'commit' });
		// A click on the server-rendered picker before hydration opens nothing, and the wait for its menu item
		// then times out.
		await composerHydrated(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		await page.getByRole('menuitem', { name: 'Choose a model yourself' }).click();
		const row = page.locator(`[data-model-id="${picked}"]`);
		const note = row.locator('[data-model-unavailable]');
		await expect(note, 'the busy model is not shown as unavailable in the picker').toBeVisible();
		await expect(note).toContainText('Unavailable right now');
		await testInfo.attach('picker-with-unavailable-model', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
		await row.click();
		const notice = page.locator('[data-model-unavailable-notice]');
		await expect(notice, 'no notice before sending to the hand-picked busy model').toBeVisible();
		await expect(notice).toContainText('is unavailable right now');
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		await page.getByRole('menuitem', { name: 'Choose a model yourself' }).click();
		await expect(
			page.locator(`[data-model-id="${picked}"]`),
			'the hand pick of the busy model was moved'
		).toHaveAttribute('aria-checked', 'true');
	}
);

// A host can answer every call of a pinned provider with 402 "Pay-as-you go is not enabled", and
// a probe that logged that as inconclusive would keep offering a model whose every turn fails. One probe whose lanes all answer that 402 must
// mark the model busy, the way a 429 does, and the picker must show it unavailable.
test(
	'one warm probe on a model whose host answers 402 payment required marks it unavailable in the picker',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }, testInfo) => {
		test.setTimeout(240_000);
		const scope = `cur4814-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
		const picked = await markAutosPickBusy(page, context, baseURL!, testInfo, scope, 402);

		await page.reload({ waitUntil: 'commit' });
		// A click on the server-rendered picker before hydration opens nothing, and the wait for its menu item
		// then times out.
		await composerHydrated(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		await page.getByRole('menuitem', { name: 'Choose a model yourself' }).click();
		const note = page.locator(`[data-model-id="${picked}"]`).locator('[data-model-unavailable]');
		await expect(
			note,
			'a model whose host refuses payment is still offered as available'
		).toBeVisible();
		await expect(note).toContainText('Unavailable right now');
	}
);

// ALIA 40B's host answers "at capacity" until a benchmark run ends, and Auto must take
// it back once it answers steadily, with no deploy, flag flip or reload. One probe with every lane
// refusing marks Auto's pick down. One answered probe leaves it busy, so a lane answering every other
// call stays out of Auto; CLEAR_AFTER in a row clear it. The tab that was already open re-reads the
// marks (`/chat/api/busy`, once a minute) and Auto's explanation stops naming the model as busy.
const CLEAR_AFTER = 3; // modelBusy.ts; a spec cannot import server code
test(
	'a model marked down stays busy after one successful warm check and returns to Auto in an already open tab after three in a row, with no reload',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }, testInfo) => {
		test.setTimeout(300_000);
		const scope = `cur4629-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
		const picked = await markAutosPickBusy(page, context, baseURL!, testInfo, scope);

		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(QUESTION);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		const why = page.locator('[data-routing-why]');
		await expect(
			why,
			'the probe-marked model was not named busy before it recovered'
		).toContainText('but it’s busy right now', { timeout: 30_000 });
		await page.keyboard.press('Escape');

		const first = await runModelProbe(page, { model: picked, scope, refuse: false });
		expect(first, 'the first recovery probe did not answer').toMatchObject({ ok: true });
		// installBusyScopeHeader's route adds the scope; no-store so the tab's cached read can't answer.
		const busyNow = await page.evaluate(async () => {
			const res = await fetch('/chat/api/busy', { cache: 'no-store' });
			return res.ok ? await res.json() : { status: res.status };
		});
		testInfo.annotations.push({
			type: 'busy-after-one-answer',
			description: JSON.stringify(busyNow)
		});
		expect(
			JSON.stringify(busyNow),
			'one answered probe cleared the busy mark (CUR-4742: it takes three in a row)'
		).toContain(picked);

		for (let i = 1; i < CLEAR_AFTER; i++) {
			const recovered = await runModelProbe(page, { model: picked, scope, refuse: false });
			testInfo.annotations.push({ type: 'recovery-probe', description: JSON.stringify(recovered) });
			expect(recovered, `recovery probe ${i + 1} did not answer`).toMatchObject({ ok: true });
		}
		const clearedAt = Date.now();

		// No reload from here on: the open tab must notice by itself.
		await expect
			.poll(
				async () => {
					await page.getByRole('button', { name: PICKER_TRIGGER }).click();
					const text = (await why.textContent()) ?? '';
					await page.keyboard.press('Escape');
					return text.includes('busy right now');
				},
				{
					message:
						'the open tab still routed around the model a minute and a half after it answered',
					timeout: 100_000,
					intervals: [5_000]
				}
			)
			.toBe(false);
		testInfo.annotations.push({
			type: 'back-in-auto-after-ms',
			description: String(Date.now() - clearedAt)
		});
		const routed = await sendAndReadModel(page);
		expect(routed.toLowerCase(), 'Auto did not send the question to the recovered model').toBe(
			picked.toLowerCase()
		);
	}
);
