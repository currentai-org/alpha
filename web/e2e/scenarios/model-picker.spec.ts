// e2e-product: @chat
// e2e-area: @models @turn
import { test, expect, type Page } from './helpers/test';
import type { Response } from '@playwright/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { setFlagOverrides } from './helpers/flagOverride';
import { HF_PROVIDER_PIN } from '../../src/lib/chat/server/hfProviderPin';
import { catalog, orgs } from '../../src/lib/chat/routing/catalog';
import { startChattingPastWelcome } from './helpers/welcome';
import { sameServedModel } from '../../config/picker';

// F3 step 2 and A2 step 5 — "Choosing a model"; marked
// preview there because `model-picker` is scoped to env=preview.
//
// WHAT THIS WALKS. The picker lives in the composer now (CUR-967's ask): the model button in the message
// box opens the list. With the `auto-routing` flag off, as production has it, that list is exactly the
// model preference, so CUR-421's claim holds and is what this walks: what
// the picker offers and what actually answers are the same thing. Preview turned Auto on, which moves
// the list into a "Choose a model yourself" submenu and drops the mid-chat hint, so every test here
// pins it off (CUR-3923); the Auto menu has its own test at the end of this file, which pins it on.
//
// THE MEASUREMENT IS THE POINT OF TEST 2. The demo list says the person "can pick any of the models
// the gateway serves (14 models)". Two separate gates decide what they actually get: `model-picker`
// decides whether anything past the FIRST allowlist entry is offered at all, and MODEL_ALLOWLIST
// decides which entries are admissible. So a picker that opens and lists one model is not a broken
// picker — it is a correctly-working picker over a one-entry allowlist, and a spec that cannot tell
// those apart would send the next reader to the wrong file. The count is recorded rather than
// asserted against 14 (CUR-1683 carries the gap between the two numbers).
//
// THE FLAG IS READ LIVE, NOT FORCED. `model-picker` is deployment-plane (resolved once per instance
// in buildModelsFromCatalog), so the per-request override cookie other specs use cannot reach it —
// so setting one changes nothing (CUR-1703, CUR-245). What runs here is the
// flag as the preview actually has it: 100% on env=preview.

// The composer's model button. Its accessible name is "Model: <what is chosen>".
const PICKER_TRIGGER = /^Model:/;

/**
 * The settings POST that saves a model pick. Other saves share the route: the welcome banner posts
 * `{"welcomeModalSeen":true}` on first load, and a wait that matched it let a second tab open on the
 * previous model before the pick landed.
 */
function isPickSave(r: Response): boolean {
	if (r.request().method() !== 'POST' || !new URL(r.url()).pathname.endsWith('/settings'))
		return false;
	try {
		return (
			typeof (r.request().postDataJSON() as { activeModel?: unknown } | null)?.activeModel ===
			'string'
		);
	} catch {
		return false;
	}
}

// The settings surface, a literal path: the nav on every rendered page links `/chat/settings`.
const SETTINGS_PATH = '/chat/settings';

// A test that needs Auto sets its own override after this, and the later cookie replaces this one.
test.beforeEach(async ({ context, baseURL }) => {
	await setFlagOverrides(context, baseURL!, { 'auto-routing': false });
});

async function openChatEntry(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

test(
	'the model picker lists what this deployment admits, and picking one makes it the model for the next chat',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openChatEntry(page);

		// Step 1. The control exists and says what it is for.
		const trigger = page.getByRole('button', { name: PICKER_TRIGGER });
		await expect(
			trigger,
			'no model control in the composer within 30s, so a person cannot choose which model answers'
		).toBeVisible({ timeout: 30_000 });

		// Step 2. It opens onto a list a person can read, and the list has a measurable size.
		await trigger.click();
		const options = page.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });
		const offered = await options.count();
		const names = await options.evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.modelId ?? '')
		);
		test
			.info()
			.annotations.push({ type: 'models offered', description: `${offered}: ${names.join(', ')}` });
		expect(
			names.filter((id) => !id.trim()),
			'an option rendered with an empty data-model-id, so the list holds a row that picks nothing'
		).toEqual([]);
		expect(
			names.length - new Set(names).size,
			`the picker offered the same model id more than once (${names.join(', ')})`
		).toBe(0);
		const labels = await options.allInnerTexts();
		expect(
			labels.filter((l) => !l.trim()),
			'every option has to name the model it selects — F3 rests on "every control is named"'
		).toEqual([]);
		// A row names the maker and never a host (CUR-3850). The planned host is not where
		// every answer runs, and X-ray reads that per turn. A host that also makes a listed model
		// (Mistral) is named as the maker, so only hosts that make nothing here count.
		const makers = new Set(catalog.map((m) => m.maker));
		const hostNames = [...new Set(catalog.flatMap((m) => (m.provider ? [m.provider] : [])))]
			.filter((id) => !makers.has(id))
			.map((id) => orgs[id].name);
		expect(
			labels.filter((l) => /runs on/i.test(l) || hostNames.some((h) => l.includes(h))),
			`a picker row names where the model runs (hosts: ${hostNames.join(', ')})`
		).toEqual([]);

		// Step 3. Picking is a CHOICE, not a navigation (CUR-1772). Skipped where only one model is admitted.
		if (offered < 2) {
			test.info().annotations.push({
				type: 'single model',
				description: `this deployment admits ${offered} model, so there is no second one to switch to. That is MODEL_ALLOWLIST, not the picker (CUR-1683)`
			});
			return;
		}
		const urlBefore = page.url();
		const previousId = await page
			.locator('[data-model-id][aria-checked="true"]')
			.first()
			.getAttribute('data-model-id');
		const other = page.locator('[data-model-id][aria-checked="false"]').first();
		const otherId = await other.getAttribute('data-model-id');
		const otherName = ((await other.innerText()).split('\n')[0] ?? '').trim();
		await other.click();

		// 3a. The button names what was picked; its accessible name carries the choice too.
		await expect(
			page.getByRole('button', { name: PICKER_TRIGGER }),
			`after picking ${otherId} the model button should name it`
		).toContainText(otherName, { timeout: 10_000 });
		// 3b. And it did NOT navigate.
		expect(page.url(), `picking ${otherId} moved the page to ${page.url()}`).toBe(urlBefore);
		// 3c. Reopened, the list marks the pick as the chosen one.
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		await expect(
			page.locator(`[data-model-id="${otherId}"]`),
			`the chosen marker did not move to ${otherId} after picking it`
		).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
		if (previousId) {
			await expect(
				page.locator(`[data-model-id="${previousId}"]`),
				`${previousId} is still marked chosen after picking ${otherId}, so the list shows two choices`
			).toHaveAttribute('aria-checked', 'false');
		}
		await page.keyboard.press('Escape');

		// 3d. The pick is a saved setting, not page state: it survives a reload.
		await page.reload({ waitUntil: 'commit' });
		const afterReload = page.getByRole('button', { name: PICKER_TRIGGER });
		await expect(
			afterReload,
			`after a reload the model button no longer names ${otherName}, so the pick was never saved`
		).toContainText(otherName, { timeout: 30_000 });
		// The screen-reader half: the button's name carries the choice, not a static label.
		await expect(afterReload).toHaveAccessibleName(`Model: ${otherName}`);
		await afterReload.click();
		await expect(
			page.locator(`[data-model-id="${otherId}"]`),
			`after a reload ${otherId} is no longer marked chosen`
		).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
		await page.keyboard.press('Escape');

		// Step 5. Per-model configuration is a developer tool: Settings does not name the picked model,
		// and its configuration page sends a visitor back to Settings rather than opening.
		await page.goto(SETTINGS_PATH, { waitUntil: 'commit' });
		await page.waitForURL(/\/settings\/personalization(\?|#|$)/, { timeout: 30_000 });
		await expect(page.getByRole('heading', { level: 1, name: 'Personalization' })).toBeVisible({
			timeout: 30_000
		});
		await expect(
			page.getByRole('link', { name: `Model: ${otherName}` }),
			'Settings offers a visitor the per-model configuration page, which is developer-only'
		).toHaveCount(0);
		await page.goto(`${SETTINGS_PATH}/${otherId}`, { waitUntil: 'commit' });
		await expect(
			page,
			`${otherId}'s configuration page opened for a visitor instead of returning to Settings`
		).toHaveURL(/\/settings\/personalization(\?|#|$)/, { timeout: 15_000 });
	}
);

// CUR-4683: Large 4 replaces Large 3 on the picker, under its own name with no preview mark, and a
// person picking it gets Large 4.
test(
	'the picker offers Mistral Large 4 by its plain name and no Mistral Large 3, and picking Large 4 makes it the model',
	{ tag: ['@preview-only', '@F3', '@CUR-4683'] },
	async ({ page }) => {
		test.setTimeout(60_000);
		await openChatEntry(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		const options = page.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });

		const labels = await options.allInnerTexts();
		expect(
			labels.filter((l) => /Large 3\b/.test(l)),
			'the picker still offers Mistral Large 3'
		).toEqual([]);
		await expect(
			page.locator('[data-model-id="mistral-large-2512"]'),
			'the picker still has a Large 3 row'
		).toHaveCount(0);
		const large4 = page.locator('[data-model-id="mistral-large-2610"]');
		await expect(large4, 'the picker does not offer Mistral Large 4').toBeVisible();
		await expect(large4).toContainText('Mistral Large 4');
		await expect(large4, 'Large 4 is still marked as a preview').not.toContainText(/preview/i);

		const saved = page.waitForResponse(
			(r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/settings'),
			{ timeout: 15_000 }
		);
		await large4.click();
		expect((await saved).ok(), 'picking Large 4 did not save').toBe(true);
		await expect(
			page.getByRole('button', { name: PICKER_TRIGGER }),
			'the model control does not name Large 4 after it was picked'
		).toHaveAttribute('aria-label', /Mistral Large 4/, { timeout: 10_000 });
	}
);

test(
	'picking a model makes the next turn be answered by that model, for every model offered',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page: firstPage }) => {
		// Two turns on a cold preview.
		test.setTimeout(240_000);
		await openChatEntry(firstPage);
		await firstPage.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		const options = firstPage.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });
		const offered = await options.evaluateAll((els) =>
			els.map((el) => ({
				id: (el as HTMLElement).dataset.modelId ?? '',
				name: ((el as HTMLElement).innerText.split('\n')[0] ?? '').trim()
			}))
		);
		test.info().annotations.push({
			type: 'models offered',
			description: offered.map((m) => m.id).join(', ')
		});
		expect(
			offered.length,
			`develop offers ${offered.length} model(s), so there is no choice for this test to check`
		).toBeGreaterThan(1);
		await firstPage.keyboard.press('Escape');

		// Every turn is started before any answer is awaited, one page per model in this guest's context,
		// so the test's time is the slowest turn rather than the sum of them (CUR-3181). A conversation is
		// served by the model it was created with (`conv.model`, conversation/[id]/+server.ts), so picking
		// the next model once this page's conversation exists cannot change the turn already started.
		const turns: Array<{ id: string; page: Page; conversationId: string }> = [];
		for (const { id, name } of offered) {
			const page = turns.length === 0 ? firstPage : await firstPage.context().newPage();
			await openChatEntry(page);
			await page.getByRole('button', { name: PICKER_TRIGGER }).click();
			// The pick is saved by a POST to /settings; a new chat created before it lands would start on
			// the previous model (CUR-245), so wait for the save.
			// Picking the model already chosen changes nothing, so it sends no save to wait for.
			const option = page.locator(`[data-model-id="${id}"]`);
			const saved =
				(await option.getAttribute('aria-checked')) === 'true'
					? null
					: page.waitForResponse(isPickSave, { timeout: 15_000 });
			await option.click();
			await expect(
				page.getByRole('button', { name: PICKER_TRIGGER }),
				`picking ${id} did not show on the model button, so the turn below would test the previous one`
			).toContainText(name, { timeout: 10_000 });
			if (saved) {
				expect((await saved).ok(), `the settings save after picking ${id} was refused`).toBe(true);
			}

			// The prompt carries a timestamp so no two turns share a body the gateway could answer from cache.
			const composer = page.getByLabel('Message AI Potluck');
			await composer.fill(`Quick check ${Date.now()}: reply with the single word "ready".`);
			await composer.press('Enter');
			await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
			if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
			turns.push({ id, page, conversationId });
		}

		await Promise.all(
			turns.map(async ({ id, page, conversationId }) => {
				const answer = page.locator('[data-message-role="assistant"]').last();
				await expect(
					answer.getByRole('button', { name: 'Copy to clipboard', exact: true }),
					`the turn after picking ${id} never finished within 60s` + warmupContext()
				).toBeVisible({ timeout: 60_000 });

				// What the reader sees: no `<answer>` wrapper (ALIA wraps its reply in one), and the asked-for
				// word survives to the end. A one-word reply with no reasoning is the case whose last characters
				// the untagged-reasoning hold dropped (CUR-2470).
				const shown = await answer.innerText();
				expect(shown, `the answer after picking ${id} shows a raw <answer> tag`).not.toMatch(
					/<\/?answer>/i
				);
				expect(shown, `the answer after picking ${id} lost the word it was asked for`).toMatch(
					/\bready\b/i
				);
				// CUR-3164: ALIA narrates the injection fence by its nonce ("a message inside the <Q_33024de9>
				// tags"). A model that shows no reasoning has no panel, and the check is about the panel's text.
				const reasoning = answer.getByRole('button', { name: 'Expand', exact: true });
				for (const toggle of await reasoning.all()) await toggle.click();
				expect(
					await answer.innerText(),
					`the reasoning after picking ${id} shows the injection fence's nonce`
				).not.toMatch(/Q_[0-9a-f]{8}/);

				// The measured half: `routerMetadata.model` is written from the gateway's response.
				let served: string | undefined;
				let provider: string | undefined;
				let failoverFrom: string | undefined;
				await expect
					.poll(
						async () => {
							const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
							const body = (await res.json()) as {
								json?: {
									messages?: Array<{
										from: string;
										routerMetadata?: { model?: string; provider?: string };
										failover?: { from?: string };
									}>;
								};
							};
							const last = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
							served = last?.routerMetadata?.model;
							provider = last?.routerMetadata?.provider;
							failoverFrom = last?.failover?.from;
							return served ?? '';
						},
						{
							message: `the turn after picking ${id} persisted no routerMetadata.model, so nothing records which model answered it`,
							timeout: 15_000
						}
					)
					.not.toBe('');
				// A pick that reached routing and then hit its lane's limit can hand off to an announced
				// backup, and the stored failover names the pick as the model it replaced. No lane asks for
				// another model (CUR-4383), so this branch is for a backup host serving the pick. A rate-limited key can be spent by a parallel
				// suite. That turn proves the pick was served to routing; a pick that was never used
				// has no failover from it and still fails here (CUR-2562).
				const failedOver =
					served?.toLowerCase() !== id.toLowerCase() &&
					failoverFrom?.toLowerCase() === id.toLowerCase();
				if (failedOver) {
					test.info().annotations.push({
						type: 'announced failover',
						description: `${id} handed the turn to ${served}`
					});
				} else {
					// CUR-4343: another host's name for the same weights (Scaleway's mistral-medium-3.5-128b for
					// mistral-medium-2604) is the pick served, not a substitute.
					expect(
						sameServedModel(id, served ?? ''),
						`picked ${id}, but the gateway reports ${served} answered the turn — the pick was recorded and not served`
					).toBe(true);
				}

				// A model with an HF provider pin is offered on the router's lane, so its text must have gone to
				// the pinned provider and no other the router could have picked (CUR-1683, CUR-2112). A
				// failed-over turn was served by the backup, whose provider says nothing about the pin.
				const pin = HF_PROVIDER_PIN[id.toLowerCase()];
				if (pin && !failedOver) {
					expect(
						provider?.toLowerCase(),
						`picked ${id}, pinned to ${pin}, but the router reports ${provider ?? 'no provider'} served it`
					).toBe(pin);
				}

				// The visible half: the answer footer names the same model, by its parameter size where the
				// id carries one (the part that tells the offered models apart). On a failed-over turn the footer
				// names Medium, so look for the backup badge instead. A size right after a letter is a
				// mixture-of-experts active count (`120B-A12B`), never the size the footer names.
				const size = [...id.matchAll(/(?<![a-z\d.])(\d+(?:\.\d+)?)b\b/gi)].at(-1)?.[1];
				const badge = answer.getByRole('button', { name: /How this answer was made/ });
				if (failedOver) {
					await expect(
						answer.locator('[title*="(backup — served in place of the primary model)"]'),
						`${id} failed over to ${served}, but the answer carries no backup badge`
					).toBeVisible({ timeout: 10_000 });
				} else if (size) {
					await expect(
						badge,
						`the answer footer does not name the ${size}B model, although the gateway reports ${id} served the turn`
					).toHaveAccessibleName(new RegExp(`\\b${size.replace('.', '\\.')}B\\b`, 'i'), {
						timeout: 10_000
					});
				} else {
					await expect(badge).not.toHaveText('', { timeout: 10_000 });
				}

				// Once a chat has started, the menu says a pick switches this chat from the next message on
				// (CUR-3190); the switch itself is walked in the test below.
				await page.getByRole('button', { name: PICKER_TRIGGER }).click();
				await expect(
					page.getByText('Pick another and your next message goes to it'),
					'the picker does not say a pick takes effect on the next message of this chat'
				).toBeVisible({ timeout: 10_000 });
				await page.keyboard.press('Escape');
			})
		);
	}
);

/** The model that served each assistant turn, and the model a failed-over turn replaced. */
async function servedTurns(page: Page, conversationId: string) {
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	const body = (await res.json()) as {
		json?: {
			messages?: Array<{
				from: string;
				routerMetadata?: { model?: string };
				failover?: { from?: string };
			}>;
		};
	};
	return (body.json?.messages ?? [])
		.filter((m) => m.from === 'assistant')
		.map((m) => ({
			model: m.routerMetadata?.model?.toLowerCase() ?? '',
			failoverFrom: m.failover?.from?.toLowerCase()
		}));
}

/** A turn answered by `id`, or handed by `id` to an announced backup (CUR-2562): either way `id` was used. */
const answeredAs = (turn: { model: string; failoverFrom?: string } | undefined, id: string) =>
	!!turn && (sameServedModel(id, turn.model) || turn.failoverFrom === id.toLowerCase());

async function send(page: Page, text: string, answers: number) {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(`${text} ${Date.now()}: reply with the single word "ready".`);
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const assistant = page.locator('[data-message-role="assistant"]');
	await expect(assistant, `answer ${answers} never appeared` + warmupContext()).toHaveCount(
		answers,
		{
			timeout: 60_000
		}
	);
	await expect(
		assistant.last().getByRole('button', { name: 'Copy to clipboard', exact: true }),
		`answer ${answers} never finished within 60s` + warmupContext()
	).toBeVisible({ timeout: 60_000 });
	return page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
}

test(
	'picking another model mid-chat answers the next message with it in the same conversation, and only that conversation',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page }) => {
		// A visitor picks another model mid-chat, and the conversation (CUR-3190)
		// carries on without starting again. Four turns on a cold preview, two of them concurrent.
		test.setTimeout(300_000);
		await openChatEntry(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		const options = page.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });
		const offered = await options.evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.modelId ?? '')
		);
		expect(
			offered.length,
			`this deployment offers ${offered.length} model(s), so there is nothing to switch to`
		).toBeGreaterThan(1);
		const [first, second] = offered as [string, string];

		// Start on the first model. The pick is saved by a POST to /settings, which a new chat reads.
		// Picking the model already chosen changes nothing, so it sends no save to wait for.
		const firstOption = page.locator(`[data-model-id="${first}"]`);
		const saved =
			(await firstOption.getAttribute('aria-checked')) === 'true'
				? null
				: page.waitForResponse(isPickSave, { timeout: 15_000 });
		await firstOption.click();
		if (saved) {
			expect((await saved).ok(), `the settings save after picking ${first} was refused`).toBe(true);
		}

		// An older conversation on the same model, started in a second tab, for the "only that
		// conversation" half below.
		const other = await page.context().newPage();
		await openChatEntry(other);
		const otherId = await send(other, 'A separate chat', 1);
		await other.close();

		// The chat the switch happens in: one answer from the first model.
		const chatId = await send(page, 'Hello', 1);

		// Mid-chat, pick the second model. The menu says what that does, and the pick shows as chosen
		// with the switch spelled out.
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		await expect(
			page.getByText('Pick another and your next message goes to it'),
			'a started chat does not say a pick applies to its next message'
		).toBeVisible({ timeout: 10_000 });
		await page.locator(`[data-model-id="${second}"]`).click();
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		await expect(
			page.locator(`[data-model-id="${second}"]`),
			`after picking ${second} mid-chat the list does not mark it chosen`
		).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
		await expect(
			page.locator('[data-model-next-switch]'),
			`after picking ${second} mid-chat the menu does not say the next message goes to it`
		).toBeVisible();
		await page.keyboard.press('Escape');

		// The next message stays in this conversation and is answered by the second model; the first
		// answer keeps the model that wrote it.
		expect(await send(page, 'Hello again', 2), 'the switch started a new conversation').toBe(
			chatId
		);
		let turns: Awaited<ReturnType<typeof servedTurns>> = [];
		await expect
			.poll(async () => (turns = await servedTurns(page, chatId)).filter((t) => t.model).length, {
				message: 'the two turns did not both persist routerMetadata.model',
				timeout: 15_000
			})
			.toBe(2);
		expect(
			answeredAs(turns[0], first),
			`the first answer was served by ${turns[0]?.model}, not ${first}`
		).toBe(true);
		expect(
			answeredAs(turns[1], second),
			`picked ${second} mid-chat, but the next answer was served by ${turns[1]?.model}`
		).toBe(true);

		// The first answer was served by the model it was sent to, so its footer names that
		// model plainly, not "(backup)" as it would if judged against the conversation's new model, on the live page
		// and after a reload. A first turn that really did fail over is the one case the label is right (CUR-3234).
		if (!turns[0]?.failoverFrom) {
			const firstFooter = page
				.locator('[data-message-role="assistant"]')
				.first()
				.locator('[data-answer-footer]');
			await expect(firstFooter, 'the first answer has no footer').toBeVisible({ timeout: 15_000 });
			await expect(
				firstFooter,
				`after switching to ${second}, the answer ${first} wrote is labelled as a backup`
			).not.toContainText('(backup)');
			await page.reload();
			await expect(firstFooter).toBeVisible({ timeout: 30_000 });
			await expect(
				firstFooter,
				`after a reload, the answer ${first} wrote is labelled as a backup`
			).not.toContainText('(backup)');
		}

		// Opening the older conversation in the same tab (a client-side navigation, so the picker is the
		// same component) does not carry the pick over: it shows its own model and answers with it.
		await page.locator(`a[href$="/conversation/${otherId}"]`).first().click({ timeout: 15_000 });
		await page.waitForURL(new RegExp(`/conversation/${otherId}`), { timeout: 15_000 });
		await page.getByRole('button', { name: PICKER_TRIGGER }).click();
		await expect(
			page.locator(`[data-model-id="${first}"]`),
			`the older chat runs on ${first}, but its picker marks another model chosen`
		).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
		await expect(page.locator('[data-model-next-switch]')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await send(page, 'Back to the separate chat', 2);
		await expect
			.poll(async () => (turns = await servedTurns(page, otherId)).filter((t) => t.model).length, {
				message: "the older chat's second turn persisted no routerMetadata.model",
				timeout: 15_000
			})
			.toBe(2);
		expect(
			answeredAs(turns[1], first),
			`the pick made in another chat switched this one: its answer came from ${turns[1]?.model}, not ${first}`
		).toBe(true);
	}
);

test(
	'a model with an HF provider pin in the allowlist is offered in the picker',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page }) => {
		// Preview's MODEL_ALLOWLIST names zai-org/GLM-5.2, which only the HF router serves. The
		// picker offers it from that lane because HF_PROVIDER_PIN says which provider receives its text.
		// Without that lane the id matches nothing in the gateway catalog and silently drops out of the list (CUR-1683).
		test.setTimeout(60_000);
		await openChatEntry(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		const options = page.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });
		const ids = await options.evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.modelId ?? '')
		);
		expect(
			ids.filter((id) => HF_PROVIDER_PIN[id.toLowerCase()]),
			`the picker offers ${ids.join(', ')}, none of them a pinned HF model, so the router lane is not reaching the list`
		).not.toEqual([]);
	}
);

// The model menu has no "Compare every model" link to the routing lab (CUR-3252). The lab is
// a developer page now (Settings → Model routing, Dev badge), so the menu links to it for nobody, Auto
// on or off. auto-routing reads per request (flagEnabledOr), so the override cookie reaches it.
test(
	'the model menu offers no link to the routing lab, with Auto on: the lab is a developer page',
	{ tag: ['@preview-only', '@F3', '@CUR-3252'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		await openChatEntry(page);
		await page.getByRole('button', { name: PICKER_TRIGGER }).click({ timeout: 30_000 });
		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible({ timeout: 10_000 });
		// The menu is populated, so the absence below is not an empty or half-rendered menu. With Auto on
		// the model rows sit in the Choose model submenu, so the top level's radio items are Auto (and
		// Last used mid-chat).
		await expect(menu.getByRole('menuitemradio').first()).toBeVisible({ timeout: 10_000 });
		await expect(
			menu.locator('a[href$="/settings/routing"]'),
			'Auto is on and the model menu links to the routing lab'
		).toHaveCount(0);
	}
);

// The menu link was not the only way in (CUR-3252). Settings listed Model routing whenever
// Auto was on, and the page answered at its URL for anyone. The lab is developer-only now (the local
// dev server or an admin), so a guest on a deployed build gets neither the entry nor the page.
const LAB_ENTRY = { name: 'Model routing', exact: true };

test(
	'a guest cannot reach the routing lab with Auto on: no Settings entry, and its URL redirects to Settings',
	{ tag: ['@preview-only', '@F3', '@CUR-3252'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		const res = await page.request.get('/chat/settings/routing', {
			maxRedirects: 0,
			timeout: 30_000
		});
		expect(res.status(), 'a guest asked for /chat/settings/routing and was not redirected').toBe(
			302
		);
		expect(
			new URL(res.headers()['location'] ?? '', baseURL).pathname,
			'the lab redirect went somewhere other than Settings'
		).toBe('/chat/settings');
		// A browser that follows the link lands on Settings itself, not a blank or error page.
		await page.goto('/chat/settings/routing', { waitUntil: 'load' });
		await expect(page, 'a guest who opened the lab URL did not land on Settings').toHaveURL(
			// /chat/settings redirects on to its first section (Personalization); anywhere in Settings but the lab passes.
			(url) => url.pathname.startsWith('/chat/settings') && !url.pathname.includes('/routing'),
			{
				timeout: 30_000
			}
		);
		await page.goto('/chat/settings/contribute', { waitUntil: 'load' });
		// The nav is rendered, so the absence below is not an empty or half-loaded nav.
		await expect(page.getByRole('link', { name: 'Contribute' }).first()).toBeVisible({
			timeout: 30_000
		});
		await expect(
			page.getByRole('link', LAB_ENTRY),
			'a guest with Auto on sees Model routing in Settings'
		).toHaveCount(0, { timeout: 30_000 });
	}
);

// The picker's OFF behaviour cannot be driven from the per-request override cookie (CUR-1703):
// model-picker is deployment-plane only (fixed distinctId, resolved once per instance in
// buildModelsFromCatalog), so a cookie can't reach an already-built registry, and preview runs the
// flag 100% on. The logic that matters (offeredModels() truncating to one entry when the picker is
// off) is a pure function, unit-tested in modelGates.spec.ts.
//
// On production, where the flag is off, the trigger renders its "Models" placeholder and opens to
// exactly one entry. Driving that needs a deployment whose live flag is off, which means the suite's
// production leg (`--grep-invert @preview-only`), and there is no prod-only tag yet to keep it out of
// the preview legs. Unbuilt on purpose (CUR-1709).
