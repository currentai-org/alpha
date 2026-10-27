// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import type { BrowserContext } from '@playwright/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { faultInjectionHeaders, type FaultInjectionName } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// Under Auto, a Basque question went to ALIA 40B, which sent nothing for 45 s and ended on
// "took too long". With `auto-repick` on, a turn whose Auto-chosen
// model refuses or stays silent before any text is asked again of the model Auto chooses next, and the
// answer carries a note naming both. The spec refuses the first send with the `lane_rate_limited`
// fault (the 429 a model host's cap throws) and lets every later send through, so the re-pick reaches a
// real model. A hand pick is never re-picked, and with the flag off the error stands as before. The
// silent variant hangs every lane with `every_lane_hangs`, so the turn ends on Auto's own give-up
// rather than a thrown error, and the server's silent mark is what sends the browser to Auto again.
// While it waits, the live log says the model is slow to start, and the note naming both models shows
// as soon as Auto asks the second one.

const CHOICE_KEY = 'alpha:model-choice';
const SEND_PATH = /\/conversation\/[a-f0-9]+$/;
const QUESTION = 'What is the capital of Portugal? Answer in one sentence.';

/** Fails the first conversation send with `fault` (a 429 by default) and counts every send. */
async function refuseFirstSend(
	page: Page,
	faultName: FaultInjectionName = 'lane_rate_limited'
): Promise<{ sends: () => number }> {
	const fault = faultInjectionHeaders(faultName);
	let sends = 0;
	await page.route(
		(url) => SEND_PATH.test(url.pathname),
		(route) => {
			if (route.request().method() !== 'POST') return route.continue();
			sends += 1;
			return sends === 1
				? route.continue({ headers: { ...route.request().headers(), ...fault } })
				: route.continue();
		}
	);
	return { sends: () => sends };
}

/** Opens chat with the picker on `choice`; each test sets its own flags first. */
async function openChat(page: Page, context: BrowserContext, choice: string) {
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
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

type Stored = {
	id: string;
	from: string;
	content?: string;
	autoRoute?: { model: string; repickedFrom?: string };
};

async function storedAnswers(page: Page): Promise<Stored[]> {
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	return (body.json?.messages ?? []).filter((message) => message.from === 'assistant');
}

test(
	"CUR-4384: when Auto's choice refuses a question, Auto asks another model and the answer names both",
	{ tag: ['@F2', '@CUR-4384', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const { sends } = await refuseFirstSend(page);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'auto-repick': true });
		const composer = await openChat(page, context, 'auto');
		await composer.fill(QUESTION);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const note = page.locator('[data-auto-repicked]');
		await expect(
			note,
			'no note says Auto asked another model after its first choice refused'
		).toBeVisible({
			timeout: 120_000
		});
		// The note shows while the second model is still working, not only once its answer is in.
		expect(
			await page.locator('[data-live-line]').count(),
			'the note naming both models appeared only after the second answer finished'
		).toBeGreaterThan(0);
		await expect(note).toContainText("didn't start answering, so Auto asked");
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the re-picked answer never finished').toBeVisible({
			timeout: 120_000
		});
		await expect(answer.locator('.prose'), 'the re-picked answer is empty').toContainText(
			/Lisbon|Lisboa/i
		);
		expect(sends(), 'the page sent the question a number of times other than twice').toBe(2);

		const answers = await storedAnswers(page);
		const repicked = answers.find((message) => message.autoRoute?.repickedFrom);
		test.info().annotations.push({
			type: 'autoRoute',
			description: JSON.stringify(answers.map((a) => a.autoRoute))
		});
		expect(repicked, 'no stored answer records that Auto picked again').toBeTruthy();
		expect(repicked!.autoRoute!.model, 'Auto picked the model that had just refused').not.toBe(
			repicked!.autoRoute!.repickedFrom
		);
	}
);

test(
	"CUR-4384: when Auto's choice stays silent until its give-up, Auto asks another model and the answer names both",
	{ tag: ['@F2', '@CUR-4384', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const { sends } = await refuseFirstSend(page, 'every_lane_hangs');
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'auto-repick': true });
		const composer = await openChat(page, context, 'auto');
		await composer.fill(QUESTION);
		const sentAt = Date.now();
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		// While the first choice is silent, the live log says so before the give-up runs out.
		const note = page.locator('[data-auto-repicked]');
		const slow = page.getByTestId('live-slow-start');
		await expect(slow, 'the live log never said the model was slow to start').toBeVisible({
			timeout: 60_000
		});
		await expect(slow).toContainText('slow to start');
		await expect(slow).toContainText('Auto will ask another model');
		expect(
			await note.count(),
			'the slow-to-start line came only after Auto had already asked again'
		).toBe(0);

		await expect(
			note,
			'no note says Auto asked another model after its first choice stayed silent'
		).toBeVisible({
			timeout: 120_000
		});
		// The note shows while the second model is still working, not only once its answer is in.
		expect(
			await page.locator('[data-live-line]').count(),
			'the note naming both models appeared only after the second answer finished'
		).toBeGreaterThan(0);
		const silentForMs = Date.now() - sentAt;
		test.info().annotations.push({ type: 'silentForMs', description: String(silentForMs) });
		// A thrown error re-picks within a second or two; only a give-up waits this long.
		expect(silentForMs, 'Auto asked again before any give-up could have run out').toBeGreaterThan(
			5_000
		);
		await expect(note).toContainText("didn't start answering, so Auto asked");
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the re-picked answer never finished').toBeVisible({
			timeout: 120_000
		});
		await expect(answer.locator('.prose'), 'the re-picked answer is empty').toContainText(
			/Lisbon|Lisboa/i
		);
		expect(sends(), 'the page sent the question a number of times other than twice').toBe(2);

		const answers = await storedAnswers(page);
		const repicked = answers.find((message) => message.autoRoute?.repickedFrom);
		test.info().annotations.push({
			type: 'autoRoute',
			description: JSON.stringify(answers.map((a) => a.autoRoute))
		});
		expect(repicked, 'no stored answer records that Auto picked again').toBeTruthy();
		expect(
			repicked!.autoRoute!.model,
			'Auto picked the model that had just stayed silent'
		).not.toBe(repicked!.autoRoute!.repickedFrom);
	}
);

test(
	'CUR-4384: a hand-picked model that refuses ends on its own error, and no other model is asked',
	{ tag: ['@F2', '@CUR-4384', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		const { sends } = await refuseFirstSend(page);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'auto-repick': true });
		const composer = await openChat(page, context, 'mistral-medium');
		await composer.fill(QUESTION);
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the refused turn never offered Retry').toBeVisible({
			timeout: 90_000
		});
		await expect(page.locator('[data-auto-repicked]'), 'a hand pick was re-picked').toHaveCount(0);
		expect(sends(), 'the page asked again after a hand pick refused').toBe(1);
	}
);

test(
	"CUR-4384: with auto-repick off, Auto's refused turn ends on its error as before",
	{ tag: ['@F2', '@CUR-4384', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		const { sends } = await refuseFirstSend(page);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'auto-repick': false });
		const composer = await openChat(page, context, 'auto');
		await composer.fill(QUESTION);
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the refused turn never offered Retry').toBeVisible({
			timeout: 90_000
		});
		await expect(
			page.locator('[data-auto-repicked]'),
			'Auto picked again with the flag off'
		).toHaveCount(0);
		expect(sends(), 'the page asked again with the flag off').toBe(1);
	}
);

// On www, Auto's news answers on Large 4 ended "couldn't answer" because the router answered
// 404 for its entry, and Auto picked again only on a 429 or silence. The first send now fails with the
// router's 404 (`lane_not_found`) before any text, and Auto asks another model, as it does for a 429.
test(
	"CUR-4629: when Auto's choice fails with the router's 404 before any text, Auto asks another model and the answer names both",
	{ tag: ['@F2', '@CUR-4629', '@CUR-4384', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const { sends } = await refuseFirstSend(page, 'lane_not_found');
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'auto-repick': true });
		const composer = await openChat(page, context, 'auto');
		await composer.fill(QUESTION);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const note = page.locator('[data-auto-repicked]');
		await expect(note, 'no note says Auto asked another model after the 404').toBeVisible({
			timeout: 120_000
		});
		await expect(note).toContainText("didn't start answering, so Auto asked");
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the re-picked answer never finished').toBeVisible({
			timeout: 120_000
		});
		await expect(answer.locator('.prose'), 'the re-picked answer is empty').toContainText(
			/Lisbon|Lisboa/i
		);
		expect(sends(), 'the page sent the question a number of times other than twice').toBe(2);

		const answers = await storedAnswers(page);
		const repicked = answers.find((message) => message.autoRoute?.repickedFrom);
		test.info().annotations.push({
			type: 'autoRoute',
			description: JSON.stringify(answers.map((a) => a.autoRoute))
		});
		expect(repicked, 'no stored answer records that Auto picked again').toBeTruthy();
		expect(repicked!.autoRoute!.model, 'Auto picked the model that had just answered 404').not.toBe(
			repicked!.autoRoute!.repickedFrom
		);
	}
);

test(
	"CUR-4629: a hand-picked model that fails with the router's 404 ends on its own error, and no other model is asked",
	{ tag: ['@F2', '@CUR-4629', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		const { sends } = await refuseFirstSend(page, 'lane_not_found');
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true, 'auto-repick': true });
		const composer = await openChat(page, context, 'mistral-medium');
		await composer.fill(QUESTION);
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the failed turn never offered Retry').toBeVisible({
			timeout: 90_000
		});
		await expect(page.locator('[data-auto-repicked]'), 'a hand pick was re-picked').toHaveCount(0);
		expect(sends(), 'the page asked again after a hand pick failed').toBe(1);
	}
);
