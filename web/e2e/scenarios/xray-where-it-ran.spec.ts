// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { backendDisplay, backendHost } from '../../src/lib/chat/servingProvenance';
import {
	backendOrg,
	catalogByGatewayId,
	MODEL_HOSTS,
	orgs,
	type Org
} from '../../src/lib/chat/routing/catalog';
import { installFaultInjectionHeader } from './helpers/faultInjection';

// Asked who runs it, the model cannot say: on a gateway lane the backend is picked after the
// prompt is written. The turn's routing record can, and X-ray's receipt shows it under "Where it ran".
// It used to be a "Routing record for this answer" line appended to the answer text; it now
// lives in X-ray, so the answer itself must carry no such line.
//
// The contract is that X-ray and the badge agree: each test reads the badge's compute from the page,
// opens X-ray on the same answer, and checks that "Where it ran" names the same host and country.
// Both must also be the host the turn's own routing record names: the stored message's
// `routerMetadata.backend`, never a configured one.

const APERTUS = 'swiss-ai/apertus-v1.5-70b';
const LARGE_4 = LARGE4_MODEL;
const QUESTION = 'Which model are you, and who runs it?';
const OLD_LEAD = 'Routing record for this answer';

type Stored = { id: string; content: string; routerMetadata?: { backend?: string } };

async function askWhoRunsIt(
	page: Page,
	modelId: string
): Promise<{ content: string; compute: string; recorded?: string; org?: Org }> {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(pinnedChatEntry(modelId), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(QUESTION);
	await composer.press('Enter');

	const message = page.locator('[data-message-role="assistant"]').first();
	await expect(turnDone(message), `"${QUESTION}" on ${modelId} never finished`).toBeVisible({
		timeout: 90_000
	});
	await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await message.getAttribute('data-message-id');
	const stored = body.json?.messages?.find((m) => m.id === id);
	expect(stored, `message ${id} is not in the stored conversation`).toBeTruthy();

	// The badge's full wording lives in its title: "… · served via X · compute: Host (Country)", or
	// "… · host not recorded" when the turn reported neither.
	const badge = message.locator('[data-provenance="line"]').first();
	await expect(badge, 'no provenance badge on the answer').toBeAttached({ timeout: 15_000 });
	const title = (await badge.getAttribute('title')) ?? '';
	const compute =
		title
			.split(' · ')
			.find((s) => s.startsWith('compute:'))
			?.slice('compute:'.length)
			.trim() ?? '';
	return {
		content: stored!.content,
		compute,
		recorded: backendDisplay(stored!.routerMetadata?.backend),
		// The recorded host's catalog org (BACKEND_HOSTS), which X-ray credits with its mention.
		org: backendOrg(backendHost(stored!.routerMetadata?.backend))?.org
	};
}

/**
 * The host-and-country check every "where it ran" test shares: the badge's compute is the host the
 * turn's routing record names, and X-ray's "Where it ran" names that host, its country when one is on
 * record, and the host's org mention. Returns the "Where it ran" locator.
 */
async function expectXrayNamesRecordedHost(
	page: Page,
	{ compute, recorded, org }: { compute: string; recorded?: string; org?: Org }
) {
	// "Infomaniak (Switzerland)" → host "Infomaniak", country "Switzerland". A host whose country is on
	// no record we hold ("NextBit") is named alone, so the country is optional.
	const [, host, country] = compute.match(/^(\S+)(?:.*\((.+)\))?$/) ?? [];
	expect(host, `the badge names no measured compute: "${compute}"`).toBeTruthy();
	expect(
		compute,
		`the badge's compute is not the host this turn's routing record names (${recorded ?? 'none recorded'})`
	).toBe(recorded);

	await page
		.locator('[data-message-role="assistant"]')
		.first()
		.getByRole('button', { name: /How this answer was made/ })
		.click();
	await page.getByRole('tab', { name: 'This answer' }).click();
	const ranOn = page.locator('[data-answer-receipt] [data-ran-on]');
	await expect(ranOn, 'X-ray does not say where this answer ran').toContainText(host, {
		timeout: 15_000
	});
	if (country) {
		await expect(ranOn, `X-ray names ${host} but not its country, ${country}`).toContainText(
			country
		);
	}
	if (org) {
		// Every host in the catalog's table is an org, so X-ray credits it with its mention: logo,
		// then the name linking to the org's site (Phoeniqs on an Apertus turn).
		const mention = ranOn.locator(`[data-org-mention="${org.id}"]`);
		await expect(mention, `X-ray names ${host} without ${org.name}'s org mention`).toBeVisible();
		if (org.url) {
			await expect(mention.getByRole('link', { name: org.name })).toHaveAttribute('href', org.url);
		}
	}
	return ranOn;
}

for (const { modelId, name, needs } of [
	{ modelId: APERTUS, name: 'Apertus', needs: ['@needs-apertus'] },
	{ modelId: LARGE_4, name: 'Mistral Large 4', needs: [] }
]) {
	test(
		`asked who runs it on ${name}, the answer carries no routing line and X-ray names where it ran, as the badge does`,
		{ tag: ['@preview-only', ...needs] },
		async ({ page }) => {
			// One real turn, waited on for up to 90s, after up to 60s of setup (the budget check).
			test.setTimeout(180_000);
			const { content, compute, recorded, org } = await askWhoRunsIt(page, modelId);
			expect(content, 'the stored answer still carries the appended routing record').not.toContain(
				OLD_LEAD
			);
			const ranOn = await expectXrayNamesRecordedHost(page, { compute, recorded, org });
			await expect(ranOn).toContainText('routing record');
		}
	);
}

// ALIA's turns record their host, but X-ray had no name for it and said "Not recorded". The
// recorded host must be ALIA's own (`MODEL_HOSTS`), and then the same host-and-country check as the tests
// above applies: the badge's compute is that host, and X-ray names it and, when one is on record, its
// country.
const ALIA = 'BSC-LT/ALIA-40b-instruct';

test(
	'an ALIA answer names the host its routing record holds, never "not recorded"',
	{ tag: ['@preview-only', '@needs-alia'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const { compute, recorded, org } = await askWhoRunsIt(page, ALIA);
		expect(
			recorded,
			'the ALIA turn recorded a backend X-ray has no name for, so it reads "not recorded"'
		).toBeTruthy();
		// The host must be one that serves ALIA. Host and country alone pass a turn some other model
		// answered: a Mistral Medium answer under the ALIA link reads "Mistral … (France)" on the badge and
		// in X-ray alike.
		const aliaHost = MODEL_HOSTS[catalogByGatewayId(ALIA)!.id];
		expect(
			org?.id,
			`the ALIA turn's routing record names ${recorded}, not ALIA's host (${orgs[aliaHost].name})`
		).toBe(aliaHost);
		const ranOn = await expectXrayNamesRecordedHost(page, { compute, recorded, org });
		await expect(
			ranOn,
			'X-ray says where the ALIA answer ran was not recorded'
		).not.toHaveAttribute('data-ran-on', 'not-recorded', { timeout: 15_000 });
	}
);

// An answer whose routing record names its model but no host. Every surface used to fall back
// to a configured host (`MODEL_HOSTS`, the catalogue's plan) and state it as where the answer ran. The
// `provenance_host_stripped` fault keeps the served model in the turn's record and drops the provider and
// backend, the way a lane that sends no host header leaves it.
test(
	'an answer whose routing record names no host says "not recorded" in its footer and X-ray, and names no configured host',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await installFaultInjectionHeader(page, 'provenance_host_stripped');
		const { compute, recorded } = await askWhoRunsIt(page, LARGE_4);
		expect(
			recorded,
			'the fault did not reach the server: the stored turn still records a backend'
		).toBe(undefined);
		expect(compute, 'the footer names a compute host for a turn that recorded none').toBe('');

		const message = page.locator('[data-message-role="assistant"]').first();
		const title =
			(await message.locator('[data-provenance="line"]').first().getAttribute('title')) ?? '';
		expect(title, 'the footer title does not say the host was not recorded').toContain(
			'host not recorded'
		);
		expect(title, 'the footer title names a provider the turn never reported').not.toContain(
			'served via'
		);

		await message.getByRole('button', { name: /How this answer was made/ }).click();
		await page.getByRole('tab', { name: 'This answer' }).click();
		const ranOn = page.locator('[data-answer-receipt] [data-ran-on]');
		await expect(
			ranOn,
			'X-ray "Where it ran" names a host the turn never recorded'
		).toHaveAttribute('data-ran-on', 'not-recorded', { timeout: 15_000 });
		await expect(ranOn).toContainText('Where it ran');
		await expect(ranOn).toContainText('Not recorded');
		const configured = [...new Set(Object.values(MODEL_HOSTS))].map((id) => orgs[id].name);
		const ranOnText = (await ranOn.textContent()) ?? '';
		for (const host of configured) {
			expect(ranOnText, `X-ray "Where it ran" names ${host}, a configured host`).not.toContain(
				host
			);
			expect(title, `the footer title names ${host} as compute`).not.toContain(`compute: ${host}`);
		}
	}
);
