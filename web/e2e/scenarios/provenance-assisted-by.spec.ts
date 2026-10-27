// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import type { Locator } from '@playwright/test';
import { modelWithoutTools, pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { openStepByStep } from './helpers/xray';
import { openComposerTool, toolGroup } from './helpers/composerMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// A turn on develop is written by one model and helped by others (CUR-984): the search decision and the
// math-route planner each run on a model of their own. X-ray's "Step by step" used to name only the
// writer. With provenance-assisted-by on, the turn stores each helper as routerMetadata.assistedBy and
// the step list names it with the host it ran on.
//
// The turn uses Auto web search on a question about current events, so the search decision has to run
// and the turn reaches the web. The spec reads the helpers off the stored message rather than
// hard-coding a model id, since which model each side call runs on is per-environment config; it then
// checks that X-ray shows that same model and host. A turn that stored no search-decision helper fails
// here: either the flag is off on this deployment or the decider fell back, and both are worth a red.
//
// The safety screen and the title read the first message too, and a follow-up that needs its
// search query rewritten adds the rewrite model, so each must be stored with the host its own call
// reported (CUR-3563). A helper whose call reported no host is shown as "not recorded", never a configured host.
//
// The search decision is a side call only on the scaffolded harness. A native turn's model decides for
// itself (CUR-2275), so the turn is pinned to a model without tools, which always gets the scaffolded
// plan (CUR-4015).

type Assist = { role: string; model: string; provider?: string; backend?: string };
type Stored = {
	id: string;
	routerMetadata?: { assistedBy?: Assist[] };
	webSearch?: { sources?: unknown[] };
	searchAttempt?: unknown;
};

async function setWebSearch(page: Page, mode: RegExp) {
	const group = toolGroup(page, 'Web search');
	await openComposerTool(page, 'Web search', { timeout: 15_000 });
	const item = group.getByRole('menuitemradio', { name: mode });
	await item.click();
	await expect(item, `web search never moved to ${mode}`).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
}

async function openScaffoldedChat(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(pinnedChatEntry((await modelWithoutTools(page.request)).id), {
		waitUntil: 'commit'
	});
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

/** The stored helpers on one answer, read from the conversation the page is on. */
async function storedTurn(page: Page, answer: Locator): Promise<Stored | undefined> {
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await answer.getAttribute('data-message-id');
	return body.json?.messages?.find((m) => m.id === id);
}

test(
	'X-ray names the model that decided to search, and the host it ran on',
	// @real-screen: the preview stub screens with no model, so it stores no safety-screen helper.
	{ tag: ['@A5', '@CUR-984', '@real-screen'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const composer = await openScaffoldedChat(page);
		await setWebSearch(page, /^Auto\b/);

		const question = 'What were the main news headlines about the European Union this week?';
		await composer.fill(question);
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').first();
		await expect(
			turnDone(answer),
			`"${question}" never finished within 90s` + warmupContext()
		).toBeVisible({
			timeout: 90_000
		});
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const stored = await storedTurn(page, answer);
		expect(
			Boolean(stored?.webSearch?.sources?.length) || Boolean(stored?.searchAttempt),
			'the turn never engaged web search, so no search decision ran to be named'
		).toBe(true);

		const helpers = stored?.routerMetadata?.assistedBy ?? [];
		for (const role of ['safety-screen', 'title']) {
			expect(
				helpers.find((h) => h.role === role),
				`no ${role} helper stored on the first turn; assistedBy was ${JSON.stringify(helpers)}`
			).toBeTruthy();
		}
		test.info().annotations.push({ type: 'assistedBy', description: JSON.stringify(helpers) });
		const decider = helpers.find((h) => h.role === 'search-decision');
		expect(
			decider,
			`no search-decision helper stored; assistedBy was ${JSON.stringify(helpers)}. Either provenance-assisted-by is off here or the decider fell back`
		).toBeTruthy();
		expect(
			decider?.backend || decider?.provider,
			'the search-decision helper names no host'
		).toBeTruthy();

		await expectStepsNameHosts(page, answer, helpers);
	}
);

/** Opens X-ray's Step by step on `answer` and checks every stored helper has a step naming its model
 *  and the host its own call recorded. */
async function expectStepsNameHosts(page: Page, answer: Locator, helpers: Assist[]) {
	await openStepByStep(page, answer, {
		expanded: { timeout: 15_000 },
		disclosure: { timeout: 15_000 },
		tab: { timeout: 15_000 }
	});

	// Every stored helper gets its own step, naming the stored model and host.
	for (const helper of helpers) {
		const host = helper.provider || helper.backend || '';
		const step = page.locator(`[data-step-by-step] li[data-step-id="assist-${helper.role}"]`);
		await expect(step, `X-ray has no step for the ${helper.role} helper`).toHaveCount(1, {
			timeout: 15_000
		});
		await expect(step).toHaveAttribute('data-assist-model', helper.model);
		await expect(step).toHaveAttribute('data-assist-host', host);
		// The visible text names the recorded host in words, or says none was recorded.
		const label = (await step.getAttribute('data-assist-host-label')) ?? '';
		await expect(step, `the ${helper.role} step does not say where it ran`).toContainText(
			host ? `running on ${label}` : /where it ran was not recorded/i
		);
		// A call recorded at a host other than the HF router did not go through Hugging Face, whatever
		// provider it reported: the title's direct call to Mistral records provider "mistral".
		if (helper.backend && helper.backend !== 'router.huggingface.co') {
			await expect(
				step,
				`the ${helper.role} step credits Hugging Face for a call recorded at ${helper.backend}`
			).not.toContainText('via Hugging Face');
		}
	}
}

test(
	'a follow-up whose search query needs the earlier turn stores the rewrite model',
	{ tag: ['@A5', '@CUR-3563'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const composer = await openScaffoldedChat(page);
		// The first turn needs no search; the follow-up only makes sense with it, so its query is rewritten.
		await setWebSearch(page, /^Off\b/);
		const question = 'Which country hosted the 2022 FIFA World Cup?';
		await composer.fill(question);
		await composer.press('Enter');
		const first = page.locator('[data-message-role="assistant"]').first();
		await expect(
			turnDone(first),
			`"${question}" never finished within 30s` + warmupContext()
		).toBeVisible({ timeout: 30_000 });
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		await setWebSearch(page, /^Always\b/);
		const followUp = 'and which one hosted it before that?';
		await composer.fill(followUp);
		await composer.press('Enter');
		const second = page.locator('[data-message-role="assistant"]').nth(1);
		await expect(
			turnDone(second),
			`"${followUp}" never finished within 90s` + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		const helpers = (await storedTurn(page, second))?.routerMetadata?.assistedBy ?? [];
		test
			.info()
			.annotations.push({ type: 'assistedBy (follow-up)', description: JSON.stringify(helpers) });
		const rewrite = helpers.find((h) => h.role === 'query-rewrite');
		expect(
			rewrite,
			`no query-rewrite helper stored on the follow-up; assistedBy was ${JSON.stringify(helpers)}`
		).toBeTruthy();
		// The rewrite's host comes from its own call (onServed), so a stored entry with none means that
		// record was lost, not that the call ran nowhere.
		expect(
			rewrite?.backend || rewrite?.provider,
			`the query-rewrite helper names no host; assistedBy was ${JSON.stringify(helpers)}`
		).toBeTruthy();
		await expectStepsNameHosts(page, second, helpers);
	}
);
