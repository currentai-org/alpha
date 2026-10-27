// e2e-product: @chat @site
// e2e-area: @provenance
import { test, expect } from './helpers/test';
import { CHAT_ENTRY, LARGE4_MODEL } from './helpers/chatEntry';
import type { Page } from './helpers/test';
import { pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { backendHost, backendIsSwiss, laneVendor } from '../../src/lib/chat/servingProvenance';
import { backendOrg } from '../../src/lib/chat/routing/catalog';

// The model row describes the model that answered (CUR-2287), so each test pins the model whose
// stack it asserts rather than inheriting whatever a target's default is (CUR-2283).
const APERTUS = 'swiss-ai/apertus-v1.5-70b';
const LARGE_4 = LARGE4_MODEL;

// Sends one short turn on `modelId` and returns the X-Ray model row, opening the panel if it is shut.
// The answer wait comes from the caller, whose own budget has to cover it (see check:scenario-budgets),
// and is passed as `{ timeout }` so the deadline stays a visible literal at each call site.
async function answeredModelRow(page: Page, modelId: string, answerWait: { timeout: number }) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(pinnedChatEntry(modelId), { waitUntil: 'commit' });

	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill('Name the capital of France in one short sentence.');
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden(answerWait);
	await expectServedBy(page, modelId);

	// X-ray opens on this answer from its footer; the rows are on "The stack" tab.
	await page
		.locator('[data-message-role="assistant"]')
		.last()
		.getByRole('button', { name: /How this answer was made/ })
		.click();
	await page.getByRole('tab', { name: 'The stack' }).click();
	const card = page.locator('li[data-product-id="foundation-model"]');
	await expect(card, 'the model row is not marked as used by this answer').toHaveAttribute(
		'data-used',
		'true',
		{ timeout: 15_000 }
	);
	await openRow(page, 'foundation-model');
	return card;
}

// The X-Ray describes the model that served, so a turn that failed over to a backup shows the backup's
// row and every Large 3 assertion below reads as an X-Ray bug. Read the stored failover record first and
// name it, so a red here says the lane went silent rather than that the card is wrong (CUR-3345).
async function expectServedBy(page: Page, modelId: string) {
	const id = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!id) throw new Error(`could not read a conversation id out of ${page.url()}`);
	const res = await page.request.get(`/chat/api/v2/conversations/${id}`);
	const body = (await res.json()) as {
		json?: {
			messages?: Array<{
				from: string;
				failover?: { from?: string; to?: string; cause?: string; reason?: string };
			}>;
		};
	};
	const failover = (body.json?.messages ?? [])
		.filter((m) => m.from === 'assistant')
		.at(-1)?.failover;
	if (failover) {
		test
			.info()
			.annotations.push({ type: 'served by backup', description: JSON.stringify(failover) });
	}
	expect(
		failover,
		`${modelId} did not serve this turn: it failed over to ${failover?.to} (${failover?.cause}), so the X-Ray rightly describes the backup`
	).toBeUndefined();
}

// A row's detail (its links) opens on tap.
async function openRow(page: Page, id: string) {
	const header = page.locator(`li[data-product-id="${id}"]`).getByRole('button').first();
	if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
}

// The X-Ray card for the model row sent "See on the gap map" to the top of /map in the same tab,
// throwing the conversation away, and its Hugging Face link opened the Apertus v1 card while the
// badge named 1.5. The card now opens the product's own catalog page in a new tab. The link goes
// through /product/stack/<row>, which resolves the row against the gap map database when
// clicked, so where it LANDS is the contract, not its href.
test.describe('x-ray card links', () => {
	test.use({ viewport: { width: 1280, height: 800 } });
	test(
		"the model row's gap-map link opens Apertus's own page in a new tab, and its Hugging Face link is the 1.5 card",
		{ tag: ['@F3', '@needs-apertus'] },
		async ({ page, context }) => {
			// Sends a real turn and waits up to 90s for it, after up to 60s of setup (CUR-1633's budget check).
			test.setTimeout(180_000);
			const card = await answeredModelRow(page, APERTUS, { timeout: 90_000 });
			const mapLink = card.getByRole('link', { name: /see on the gap map/i });
			await expect(mapLink, 'the model row shows no gap-map link once opened').toBeVisible({
				timeout: 15_000
			});
			await expect(mapLink).toHaveAttribute('target', '_blank');
			const mapHref = await mapLink.getAttribute('href');
			const landing = await page.request.get(mapHref ?? '', { maxRedirects: 0 });
			expect(landing.status(), `${mapHref} did not redirect`).toBe(307);
			expect(
				landing.headers()['location'],
				"the model row's gap-map link does not land on Apertus's catalog page"
			).toBe('/product/apertus');
			await expect(card.getByRole('link', { name: 'HuggingFace' })).toHaveAttribute(
				'href',
				'https://huggingface.co/swiss-ai/Apertus-v1.5-70B'
			);

			// Our own Stack X-Ray card links to the chat on THIS origin. It used to point at production's
			// /chat from every preview.
			await openRow(page, 'stack-provenance');
			await openRow(page, 'sovereign-compute');
			await expect(
				page
					.locator('li[data-product-id="stack-provenance"]')
					.getByRole('link', { name: 'Stack X-Ray' }),
				"the Stack X-Ray card's link leaves this deployment for production"
			).toHaveAttribute('href', '/chat');
			// The safety card's maker name, "Mistral AI", went to our own policy page (CUR-1745). It now goes
			// to Mistral like every other maker, and our page is a separate link that says it is ours.
			await openRow(page, 'trust-and-safety');
			const safetyCard = page.locator('li[data-product-id="trust-and-safety"]');
			await expect(
				safetyCard.getByRole('link', { name: 'Mistral AI', exact: true }),
				"the safety card's maker name does not link to the maker"
			).toHaveAttribute('href', 'https://mistral.ai');
			const ownPolicy = safetyCard.getByRole('link', { name: 'Our Trust & Safety policy' });
			await expect(ownPolicy, 'the safety card has no link to our own policy').toHaveAttribute(
				'href',
				'/trust-and-safety'
			);
			expect(
				(await page.request.get('/trust-and-safety')).ok(),
				'/trust-and-safety did not load'
			).toBe(true);
			const computeCard = page.locator('li[data-product-id="sovereign-compute"]');
			// The compute row claims the answer ran in Switzerland, so it is lit exactly when the
			// backend this turn recorded is on the Swiss allowlist (CUR-1883). Apertus reaches several backends through
			// the gateway, so the expectation is read from the turn, and either direction can be the one met.
			const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
			const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
			const body = (await res.json()) as {
				json?: { messages?: Array<{ from: string; routerMetadata?: { backend?: string } }> };
			};
			const backend = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)
				?.routerMetadata?.backend;
			const swiss = backendIsSwiss(backend);
			test.info().annotations.push({
				type: 'served backend',
				description: `${backend ?? 'none recorded'} (${swiss ? 'Swiss' : 'not Swiss'})`
			});
			// The gateway's Apertus group reaches several Swiss hosts (CSCS, Infomaniak, Phoeniqs), and the
			// card names whichever served, by its catalog org (CUR-4587). Expecting CSCS text on every Swiss
			// turn failed whenever another host answered.
			const servedOrg = backendOrg(backendHost(backend))?.org;
			const cscs = servedOrg?.id === 'cscs';
			if (swiss && !cscs) {
				await expect(
					computeCard,
					`the compute row is dark although ${backend} is a Swiss backend`
				).toHaveAttribute('data-used', 'true');
				await expect(computeCard).toContainText(`hosted by ${servedOrg?.name} in Switzerland`, {
					timeout: 15_000
				});
				await expect(
					computeCard,
					`the compute card says CSCS hosted a turn served by ${backend}`
				).not.toContainText('Lugano');
			} else if (swiss) {
				await expect(
					computeCard,
					`the compute row is dark although ${backend} is a Swiss backend`
				).toHaveAttribute('data-used', 'true');
				// A product that is its own maker is named once, not "X by X". The card must be expanded
				// first, or the negative check below would pass on a collapsed card.
				await expect(computeCard).toContainText('Swiss National Supercomputing Centre', {
					timeout: 15_000
				});
				await expect(
					computeCard,
					'the compute card repeats its name as its own maker'
				).not.toContainText(
					'Swiss National Supercomputing Centre by Swiss National Supercomputing Centre'
				);
				// The compute card's only way out was its name, underlined on hover alone, so the
				// A5 grader read it as a component with nothing behind it (CUR-1783). It now carries a visible CSCS link.
				const cscsLink = computeCard.getByRole('link', { name: 'CSCS', exact: true });
				await expect(cscsLink, 'the compute card shows no visible link to CSCS').toBeVisible();
				await expect(cscsLink).toHaveAttribute('href', 'https://cscs.ch');
				await expect(cscsLink).toHaveAttribute('target', '_blank');
			} else {
				await expect(
					computeCard,
					`the compute row claims Swiss compute for a turn served by ${backend ?? 'an unrecorded backend'}`
				).not.toHaveAttribute('data-used', 'true');
				await expect(
					computeCard,
					`the compute card says CSCS hosted a turn served by ${backend ?? 'an unrecorded backend'}`
				).not.toContainText('hosted by CSCS in Lugano');
			}

			const conversationUrl = page.url();
			const [popup] = await Promise.all([context.waitForEvent('page'), mapLink.click()]);
			await popup.waitForLoadState('domcontentloaded');
			expect(new URL(popup.url()).pathname).toBe('/product/apertus');
			await expect(popup.getByRole('heading', { level: 1 })).toContainText(/apertus/i);
			expect(page.url(), 'following the link navigated the chat tab away').toBe(conversationUrl);
		}
	);

	test(
		"a Mistral Large 4 answer's X-Ray names Large 4 by Mistral AI; sent straight to La Plateforme it lights no gateway or compute row and names La Plateforme on each, and sent through a router it never says direct (CUR-3966, CUR-4577)",
		{ tag: ['@F3', '@CUR-2287', '@CUR-2850', '@CUR-3966', '@CUR-4577'] },
		async ({ page }) => {
			// Sends a real turn and waits up to 90s for it, after up to 60s of setup (CUR-1633's budget check).
			test.setTimeout(180_000);
			const card = await answeredModelRow(page, LARGE_4, { timeout: 90_000 });
			const mapLink = card.getByRole('link', { name: /see on the gap map/i });
			await expect(mapLink, 'the model row shows no gap-map link once opened').toBeVisible({
				timeout: 15_000
			});
			await expect(card).toContainText('Mistral Large 4');
			await expect(card).toContainText('Mistral AI');
			await expect(card, 'the model row still describes Apertus').not.toContainText(
				/apertus|swiss national ai/i
			);
			// Large 4's weights are not on Hugging Face yet, so no card is claimed (identity.ts).
			await expect(
				card.getByRole('link', { name: 'HuggingFace' }),
				'the model row links a Hugging Face card Large 4 does not have'
			).toHaveCount(0);
			const mapHref = await mapLink.getAttribute('href');
			const landing = await page.request.get(mapHref ?? '', { maxRedirects: 0 });
			expect(landing.status(), `${mapHref} did not redirect`).toBe(307);
			expect(
				landing.headers()['location'],
				"the model row's gap-map link lands on another model's page"
			).not.toBe('/product/apertus');

			// Which host the turn was SENT to decides whether anything stood between the app and Mistral
			// (CUR-4577). A preview's Mistral lane may be the staging router, which forwards to La
			// Plateforme, so the backend alone reads the same either way.
			const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
			const stored = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
			const conv = (await stored.json()) as {
				json?: { messages?: Array<{ from: string; routerMetadata?: { lane?: string } }> };
			};
			const lane = (conv.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)
				?.routerMetadata?.lane;
			test.info().annotations.push({ type: 'lane', description: lane ?? '(not recorded)' });
			if (!laneVendor(lane)) {
				for (const row of [
					'inference-platform',
					'compute-router',
					'inference-engine',
					'sovereign-compute'
				]) {
					await expect(
						page.locator(`li[data-product-id="${row}"]`),
						`the ${row} row says Mistral ran the answer directly although it was sent to ${lane ?? 'an unrecorded lane'}`
					).not.toContainText('ran this answer directly');
				}
				return;
			}
			// The request went straight to La Plateforme, so the rows for what sits between the app and
			// Apertus are not marked as used.
			for (const row of [
				'inference-platform',
				'compute-router',
				'inference-engine',
				'api-management',
				'sovereign-compute'
			]) {
				await expect(
					page.locator(`li[data-product-id="${row}"]`),
					`the ${row} row lit on an answer that never passed through it`
				).not.toHaveAttribute('data-used', 'true');
			}
			// The skipped rows said "Working" under the finished answer, which reads as busy (CUR-2850).
			// Then "Not used", which read as a claim that nothing hosted the model at all (CUR-3966). Each
			// row the maker's own API stood in for now says so and names it.
			for (const row of [
				'inference-platform',
				'compute-router',
				'inference-engine',
				'sovereign-compute'
			]) {
				const skipped = page.locator(`li[data-product-id="${row}"]`);
				await expect(skipped, `the ${row} row does not say the answer skipped it`).toContainText(
					'Skipped for this answer'
				);
				await expect(
					skipped.locator('[data-layer-note]'),
					`the ${row} row does not name what ran the answer in its place`
				).toHaveText("Mistral AI's La Plateforme in France ran this answer directly.");
			}
		}
	);
});

// A visitor agent mode does not clear sees the Task helper row in X-ray's stack (CUR-2203). Its badge
// said "Not available to you", which reads as a locked door; it now says the part is not switched on.
test(
	'CUR-2203: X-ray tells a visitor without agent mode that the task helper is not switched on, in plain words',
	{ tag: ['@preview-only', '@F3'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'agent-mode': false });
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		await page.getByRole('button', { name: 'X-ray — see what happened behind the answer' }).click();

		const row = page.locator('[data-xray-panel] li[data-product-id="agent-service"]');
		await expect(
			row,
			'X-ray lists no task helper row for a visitor without agent mode'
		).toBeVisible({
			timeout: 15_000
		});
		await expect(row).toContainText('Not switched on for you');
		await expect(row, 'the row still reads as a locked door').not.toContainText(
			'Not available to you'
		);
	}
);

// A laptop on a projector is about 690px tall (CUR-3934). X-ray's tab bodies were a fixed 384px and the
// panel sits above the composer, so opening it there left no room for the answer it describes. The
// caret_cited_reply fault answers with no model call, so the answer's height is the same every run.
test.describe('x-ray on a short window', () => {
	test.use({ viewport: { width: 1280, height: 690 } });
	test(
		'CUR-3934: opening X-ray on a 690px-tall window leaves the answer it describes in view',
		{ tag: ['@preview-only', '@F3', '@CUR-3934'] },
		async ({ page }) => {
			test.setTimeout(120_000);
			const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcome, async () => {
				await welcome.getByRole('button', { name: /start chatting/i }).click();
			});
			await installFaultInjectionHeader(page, 'caret_cited_reply');
			await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(`What are the capitals of Japan and Australia? ${Date.now()}`);
			await composer.press('Enter');
			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(
				reply.getByRole('button', { name: 'Retry' }),
				'the turn never finished'
			).toBeVisible({
				timeout: 60_000
			});

			// A fixed reply's footer has no "How this answer was made"; the composer's X-ray chip opens the
			// panel on the latest answer either way.
			await page
				.getByRole('button', { name: 'X-ray — see what happened behind the answer' })
				.click({ timeout: 15_000 });
			const panel = page.locator('[data-xray-panel]');
			await expect(panel, 'X-ray did not open').toBeVisible({ timeout: 15_000 });
			await expect(page.getByRole('tab', { name: 'This answer' })).toBeVisible({ timeout: 15_000 });
			// The answer scroller clips what the panel squeezes out, so a third of the answer in the
			// viewport means it is still readable beside the panel, not a sliver above it.
			await expect(
				reply.locator('.prose'),
				'X-ray covers the answer it describes on a 690px window'
			).toBeInViewport({ ratio: 0.3, timeout: 5_000 });
		}
	);

	// On that window scrolling stopped at the answer's start, so its footer, the line X-ray is
	// opened to check, stayed under the panel's edge with only the answer's first line above it (CUR-3951). The
	// panel now gives back the height the footer is short of.
	test(
		'CUR-3951: X-ray opened from the composer chip on a 690px window keeps the whole answer and its footer above the panel',
		{ tag: ['@preview-only', '@F6', '@CUR-3951'] },
		async ({ page }) => {
			test.setTimeout(120_000);
			const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcome, async () => {
				await welcome.getByRole('button', { name: /start chatting/i }).click();
			});
			await installFaultInjectionHeader(page, 'caret_cited_reply');
			await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(`What are the capitals of Japan and Australia? ${Date.now()}`);
			await composer.press('Enter');
			const reply = page.locator('[data-message-role="assistant"]').last();
			const footer = reply.getByRole('button', { name: 'Retry' });
			await expect(footer, 'the turn never finished').toBeVisible({ timeout: 60_000 });

			await page
				.getByRole('button', { name: 'X-ray — see what happened behind the answer' })
				.click({ timeout: 15_000 });
			const panel = page.locator('[data-accessory-panel="xray"]');
			await expect(panel, 'X-ray did not open').toBeVisible({ timeout: 15_000 });
			// Polled, since the panel eases open. Both gaps are px: the answer's start below the thread's
			// top edge, and the footer's bottom above the panel's top edge.
			await expect
				.poll(
					async () => {
						const thread = await page.getByTestId('chat-scroll').boundingBox();
						const text = await reply.locator('.prose').boundingBox();
						const row = await footer.boundingBox();
						const top = await panel.boundingBox();
						if (!thread || !text || !row || !top) return null;
						return {
							start: Math.round(text.y - thread.y) >= 0,
							footer: Math.round(top.y - (row.y + row.height)) >= 0
						};
					},
					{
						message:
							"the open X-ray panel hides the answer's start or its footer on a 690px window, so the answer can't be read beside X-ray",
						timeout: 5_000
					}
				)
				.toEqual({ start: true, footer: true });
		}
	);
});
