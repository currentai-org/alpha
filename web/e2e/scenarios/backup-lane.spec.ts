// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { pinnedChatEntry } from './helpers/servedModel';
import { LARGE4_MODEL, MEDIUM_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { journeyStep } from './helpers/journeyStep';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// A person who picks a model is answered by that model, a retry of it, or an error, never by
// another model. Apertus's backup lanes used to ask for SEA-LION models, and Gemma
// answered a dozen Apertus turns in ten minutes on production. The `primary_lane_down` fault skips
// the primary lane on this one request, but only when another lane follows it (failover.ts,
// `!isLast`). On preview the backup host is the primary's own, so Apertus has one lane, the fault
// does not fire, and Apertus answers. Put a lane that asks for another model back behind Apertus and
// the fault fires, that model answers, and this goes red. Mistral Large 3 had the last permitted
// switch, to Medium, until that change removed it. Preview-only: the fault switch is never armed on
// production (faultInjection.ts).
const APERTUS = 'swiss-ai/apertus-v1.5-70b';
const ERROR_NOTICE = /took too long to respond|at capacity right now/i;

test(
	'with the Apertus primary lane down, the turn is answered by Apertus or ends on an error notice, never by another model, so no backup notice is rewritten to a second one',
	{ tag: ['@F2', '@preview-only', '@needs-apertus'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'primary_lane_down');
		await page.goto(pinnedChatEntry(APERTUS), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		// No maths in it: with math-routing on, a maths question goes to the route model and never reaches the
		// primary lane this fault takes down.
		await composer.fill(
			`Quick question ${Date.now()}: what is the capital of Switzerland? One word.`
		);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const reply = await journeyStep(page, 'F2', 3, async () => {
			const reply = page.locator('[data-message-role="assistant"]').last();
			// The error notice and its Retry button render together, so the either-locator matches two
			// elements on exactly the outcome this step waits for; .first() keeps strict mode from failing it.
			await expect(
				reply.getByRole('button', { name: 'Retry' }).or(reply.getByText(ERROR_NOTICE)).first(),
				'the turn never finished' + warmupContext()
			).toBeVisible({ timeout: 90_000 });
			return reply;
		});

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{
					from: string;
					content?: string;
					routerMetadata?: { model?: string };
					failover?: { from?: string; to?: string };
				}>;
			};
		};
		const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Apertus`
		).toBeUndefined();
		const served = (answer?.routerMetadata?.model ?? '').toLowerCase();
		expect(
			served === '' || served.includes('apertus'),
			`the turn records ${JSON.stringify(served)} as its served model, which is not the Apertus that was picked`
		).toBe(true);
		await expect(
			reply.locator('[title*="(backup — served in place of the primary model)"]'),
			'the answer carries a backup badge, so another model stood in for Apertus'
		).toHaveCount(0);
	}
);

type StoredTurn = {
	from: string;
	content?: string;
	routerMetadata?: { model?: string };
	failover?: { from?: string; to?: string };
};

// Large 3's 429 used to move the turn to Mistral Medium. The `primary_lane_rate_limited` fault
// throws the SDK's 429 from Large 3's own lane on every attempt, and unlike `primary_lane_down` it
// fires on a model with one lane, so the turn takes the path a real over-cap answer takes. Give Large 3
// a lane that asks for Medium again and Medium answers here, and this goes red.
test(
	'a rate-limited Large 4 turn ends on the busy notice naming Large 4, never answered by Mistral Medium',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'primary_lane_rate_limited');
		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		// No maths: a maths turn can route away from the lane this fault rate-limits.
		await composer.fill(`Busy check ${Date.now()}: what is the capital of Switzerland? One word.`);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const reply = await journeyStep(page, 'F2', 3, async () => {
			const reply = page.locator('[data-message-role="assistant"]').last();
			const busy = reply.getByText(/ is busy right now/);
			await expect(
				busy,
				'the turn did not end on the busy notice; if Medium answered, a lane to another model is back' +
					warmupContext()
			).toBeVisible({ timeout: 90_000 });
			await expect(
				busy,
				'the busy notice names another model than the Large 4 that was picked'
			).toContainText(/Large 4/);
			await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
			return reply;
		});

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as { json?: { messages?: StoredTurn[] } };
		const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Large 4`
		).toBeUndefined();
		expect(
			answer?.routerMetadata?.model ?? '',
			'the stored turn names Mistral Medium as the model that answered'
		).not.toMatch(/mistral-medium/i);
		await expect(
			reply.locator('[title*="(backup — served in place of the primary model)"]'),
			'the reply carries a backup badge, so another model stood in for Large 4'
		).toHaveCount(0);
	}
);

// a stream can end with `finish_reason: error` after it has opened and before any text, and the
// turn would end on an error. The `primary_stream_errors_once` fault fails
// Medium's first call that way. The lane is asked again, so the visitor gets an answer from Medium itself.
// Remove the same-lane retry and the turn ends on the error notice with its Retry button, and this goes red.
test(
	'a Mistral Medium stream that errors before any text is asked for again and answers from Medium, never an error or another model',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'primary_stream_errors_once');
		await page.goto(pinnedChatEntry(MEDIUM_MODEL), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		// No maths: a maths turn can route away from the lane this fault fails.
		await composer.fill(`Retry check ${Date.now()}: what is the capital of Switzerland? One word.`);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		// What the answer says is not the claim: a PR run replays a recording or a mock answer, so the text
		// is a model's on a record run and a mock's otherwise. The claim is that the turn answered at all.
		await journeyStep(page, 'F2', 3, async () => {
			await expect
				.poll(
					async () => {
						const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
						const body = (await res.json()) as { json?: { messages?: StoredTurn[] } };
						const last = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
						return (last?.content ?? '').trim().length;
					},
					{
						message:
							'the turn stored no answer; if it ended on an error notice, the stream error was not retried' +
							warmupContext(),
						timeout: 90_000
					}
				)
				.toBeGreaterThan(0);
		});

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as {
			json?: {
				messages?: (StoredTurn & {
					interrupted?: boolean;
					updates?: { type: string; status?: string }[];
				})[];
			};
		};
		const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		// A finished answer's footer carries its own Retry (regenerate) button, so that button is no sign of
		// an error. What marks an errored turn is the stored error status (deriveMessageStatus).
		expect(
			(answer?.updates ?? []).filter((u) => u.type === 'status' && u.status === 'error'),
			'the stored turn carries an error status, so the stream error reached the visitor'
		).toEqual([]);
		expect(answer?.interrupted ?? false, 'the stored turn is marked interrupted').toBe(false);
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Medium`
		).toBeUndefined();
		expect(
			answer?.routerMetadata?.model ?? MEDIUM_MODEL,
			'the stored turn names another model'
		).toMatch(/mistral-medium/i);
	}
);
