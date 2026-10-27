// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { startChattingPastWelcome } from './helpers/welcome';

// With zentropi-african-routing on, a turn whose typed text is Amharic, Yoruba, Hausa or
// Kiswahili is screened by Zentropi's CoPE-B (zentropi-ai/cope-b-a4b on our own Hugging Face endpoint)
// instead of Shieldstral (CUR-4340). The observable is the model the
// screen's own first answering call recorded, stored on the answer as the `safety-screen` helper in
// routerMetadata.assistedBy (CUR-3563). The messages are safe, so the spec never sends harmful text to a
// shared endpoint and never depends on a decline.
//
// A declined turn stores no safety-screen helper, so the Kiswahili message must be one both judges
// allow on every rule. The messages must be safe
// in both judges' reading; this ginger-tea request passes both.
//
// Tagged @real-screen: the preview stub screens with no model, so it stores no safety-screen helper.
// s1-safety-judge is forced off in every test: with it on, S1 replaces the CoPE lane (CUR-4527).
const KISWAHILI = 'Naomba unipe mapishi rahisi ya chai ya tangawizi kwa watu wanne.';
const ENGLISH = 'Please explain in two sentences why the sky is blue.';
// Hausa that the detector ranks first by only 0.21 (under its 0.5 margin), so the turn keeps
// Shieldstral and gets CoPE as a second opinion (CUR-4423); the stored helper names CoPE when CoPE answered. Before
// CUR-4423 this turn was Shieldstral's alone. Both judges answer no to every rule, and
// languageFallback.spec.ts pins the read as a near-miss. This shows the route, not that both judges ran:
// the unit tests in guardGate.spec.ts cover the merge.
const HAUSA_NEAR_MISS = 'Menene sunan agogo da Turanci?';
const FLAG = 'zentropi-african-routing';

type Assist = { role: string; model: string; backend?: string };
type Stored = { id: string; routerMetadata?: { assistedBy?: Assist[] } };

/** Sends `text` in a new chat and returns the stored safety-screen helper on its answer. */
async function screenedBy(page: Page, text: string): Promise<Assist | undefined> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').fill(text);
	await sendOpensConversation(page);
	const answer = page.locator('[data-message-role="assistant"]').last();
	await expect(turnDone(answer), `"${text}" never finished within 90s`).toBeVisible({
		timeout: 90_000
	});
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await answer.getAttribute('data-message-id');
	const helpers = body.json?.messages?.find((m) => m.id === id)?.routerMetadata?.assistedBy ?? [];
	test.info().annotations.push({ type: 'assistedBy', description: JSON.stringify(helpers) });
	return helpers.find((h) => h.role === 'safety-screen');
}

test(
	'a Kiswahili turn is screened by Zentropi CoPE-B on our endpoint when zentropi-african-routing is on (CUR-4340)',
	{ tag: ['@A5', '@CUR-4340', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, {
			'zentropi-african-routing': true,
			's1-safety-judge': false
		});
		const screen = await screenedBy(page, KISWAHILI);
		expect(
			screen?.model,
			`the Kiswahili turn was not screened by Zentropi; its safety-screen helper was ${JSON.stringify(screen)}. Shieldstral here means ${FLAG} did not route, HF_TOKEN is unset on this deployment, or the first calls fell back (the CoPE endpoint down, cold or over 5 s); undefined means the turn was declined`
		).toBe('zentropi-ai/cope-b-a4b');
		expect(screen?.backend).toBe('6ad97f72eefe43aa1376fbea.endpoints.huggingface.cloud');
	}
);

test(
	'a Hausa turn the detector is not sure of gets CoPE-B as a second opinion when zentropi-african-routing is on (CUR-4423)',
	{ tag: ['@A5', '@CUR-4423', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, {
			'zentropi-african-routing': true,
			's1-safety-judge': false
		});
		const screen = await screenedBy(page, HAUSA_NEAR_MISS);
		expect(
			screen?.model,
			`the near-miss Hausa turn's safety-screen helper was ${JSON.stringify(screen)}. Shieldstral here means the near-miss turn got no second opinion (inputJudgeFor did not return alsoJudge), or every CoPE call failed; undefined means the turn was declined`
		).toBe('zentropi-ai/cope-b-a4b');
		expect(screen?.backend).toBe('6ad97f72eefe43aa1376fbea.endpoints.huggingface.cloud');
	}
);

test(
	'an English turn is still screened by Shieldstral with zentropi-african-routing on (CUR-4340)',
	{ tag: ['@A5', '@CUR-4340', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, {
			'zentropi-african-routing': true,
			's1-safety-judge': false
		});
		const screen = await screenedBy(page, ENGLISH);
		expect(
			screen?.model,
			`the English turn's safety-screen helper was ${JSON.stringify(screen)}`
		).toMatch(/Shieldstral/i);
	}
);

test(
	'with zentropi-african-routing off, the same Kiswahili turn is screened by Shieldstral (CUR-4340)',
	{ tag: ['@A5', '@CUR-4340', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		// Forced false, not left unset: the flag is on for preview, so no cookie would still route.
		await setFlagOverrides(context, baseURL!, {
			'zentropi-african-routing': false,
			's1-safety-judge': false
		});
		const screen = await screenedBy(page, KISWAHILI);
		expect(
			screen?.model,
			`the Kiswahili turn's safety-screen helper was ${JSON.stringify(screen)}`
		).toMatch(/Shieldstral/i);
	}
);
