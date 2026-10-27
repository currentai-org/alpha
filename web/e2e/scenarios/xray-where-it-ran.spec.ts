// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { backendDisplay, backendHost } from '../../src/lib/chat/servingProvenance';
import { backendOrg, type Org } from '../../src/lib/chat/routing/catalog';

// Asked who runs it, the model cannot say (CUR-2921): on a gateway lane the backend is picked after the
// prompt is written. The turn's routing record can, and X-ray's receipt shows it under "Where it ran".
// It used to be a "Routing record for this answer" line appended to the answer text (CUR-2135); it now
// lives in X-ray, so the answer itself must carry no such line.
//
// The contract is that X-ray and the badge agree: each test reads the badge's compute from the page,
// opens X-ray on the same answer, and checks that "Where it ran" names the same host and country.
// Both must also be the host the turn's own routing record names: the stored message's
// `routerMetadata.backend`, never a configured one (CUR-3562).

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
	// "… · host not recorded" when the turn reported neither (CUR-3562).
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
		// The recorded host's catalog org (BACKEND_HOSTS, CUR-4587), which X-ray credits with its mention.
		org: backendOrg(backendHost(stored!.routerMetadata?.backend))?.org
	};
}

for (const { modelId, name, needs } of [
	{ modelId: APERTUS, name: 'Apertus', needs: ['@needs-apertus'] },
	{ modelId: LARGE_4, name: 'Mistral Large 4', needs: [] }
]) {
	test(
		`asked who runs it on ${name}, the answer carries no routing line and X-ray names where it ran, as the badge does`,
		{ tag: ['@preview-only', '@CUR-2921', ...needs] },
		async ({ page }) => {
			// One real turn, waited on for up to 90s, after up to 60s of setup (CUR-1633's budget check).
			test.setTimeout(180_000);
			const { content, compute, recorded, org } = await askWhoRunsIt(page, modelId);
			expect(content, 'the stored answer still carries the appended routing record').not.toContain(
				OLD_LEAD
			);
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
				// then the name linking to the org's site (Phoeniqs on an Apertus turn, CUR-4587).
				const mention = ranOn.locator(`[data-org-mention="${org.id}"]`);
				await expect(
					mention,
					`X-ray names ${host} without ${org.name}'s org mention`
				).toBeVisible();
				if (org.url) {
					await expect(mention.getByRole('link', { name: org.name })).toHaveAttribute(
						'href',
						org.url
					);
				}
			}
			await expect(ranOn).toContainText('routing record');
		}
	);
}

// ALIA's turns record their host, but X-ray had no name for it and
// said "Not recorded" (CUR-3941). The host's country is on no record we hold, so this checks the name X-ray gives
// against the stored backend's own display name rather than the host-and-country shape above.
const ALIA = 'BSC-LT/ALIA-40b-instruct';

test(
	'an ALIA answer names the host its routing record holds, never "not recorded"',
	{ tag: ['@preview-only', '@CUR-3941'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const { recorded } = await askWhoRunsIt(page, ALIA);
		expect(
			recorded,
			'the ALIA turn recorded a backend X-ray has no name for, so it reads "not recorded"'
		).toBeTruthy();

		await page
			.locator('[data-message-role="assistant"]')
			.first()
			.getByRole('button', { name: /How this answer was made/ })
			.click();
		await page.getByRole('tab', { name: 'This answer' }).click();
		const ranOn = page.locator('[data-answer-receipt] [data-ran-on]');
		await expect(
			ranOn,
			'X-ray says where the ALIA answer ran was not recorded'
		).not.toHaveAttribute('data-ran-on', 'not-recorded', { timeout: 15_000 });
		await expect(ranOn, `X-ray does not name ${recorded}`).toContainText(
			recorded!.replace(/ \(.*\)$/, '')
		);
	}
);
