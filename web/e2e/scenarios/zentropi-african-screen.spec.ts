// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { startChattingPastWelcome } from './helpers/welcome';

// Zentropi S1 (zentropi-ai/cope-b-s1, flag s1-safety-judge) is the chat turn's input screen on preview
// and production. The CoPE-B lane (zentropi-ai/cope-b-a4b) that once judged Amharic, Yoruba,
// Hausa and Kiswahili turns is deleted. No flag is forced here: each turn runs on the
// deployment's own flags, so the spec checks the guard real visitors get. The S1-off path is covered by
// s1-safety-judge.spec.ts.
//
// The observable is the model the screen's own first answering call recorded, stored on the answer as
// the `safety-screen` helper in routerMetadata.assistedBy. The messages are safe, so the spec
// never sends harmful text to a shared endpoint and never depends on a decline.
//
// Tagged @real-screen: the preview stub screens with no model, so it stores no safety-screen helper.
const KISWAHILI = 'Naomba unipe mapishi rahisi ya chai ya tangawizi kwa watu wanne.';
const ENGLISH = 'Please explain in two sentences why the sky is blue.';
// Hausa that the language detector ranked first by only 0.21, under its 0.5 margin: the CoPE-B lane gave
// it a second opinion.
const HAUSA_NEAR_MISS = 'Menene sunan agogo da Turanci?';
const S1_MODEL = 'zentropi-ai/cope-b-s1';
const S1_BACKEND = '6ada5fa5a0e732657786181a.endpoints.huggingface.cloud';
const COPE_B_MODEL = 'zentropi-ai/cope-b-a4b';

type Assist = { role: string; model: string; backend?: string };
type Stored = { id: string; routerMetadata?: { assistedBy?: Assist[] } };

/** Sends `text` in a new chat and returns every stored helper on its answer plus the safety-screen one. */
async function screenedBy(
	page: Page,
	text: string
): Promise<{ helpers: Assist[]; screen: Assist | undefined }> {
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
	return { helpers, screen: helpers.find((h) => h.role === 'safety-screen') };
}

for (const [label, text, tags] of [
	['a Kiswahili turn', KISWAHILI, ['@CUR-4340']],
	['a Hausa turn the language detector is not sure of', HAUSA_NEAR_MISS, ['@CUR-4423']],
	['an English turn', ENGLISH, ['@CUR-4340']]
] as const) {
	test(
		`${label} is screened by S1, the live guard, and never by CoPE-B (CUR-4527)`,
		{ tag: ['@A5', '@CUR-4527', ...tags, '@real-screen'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			const { helpers, screen } = await screenedBy(page, text);
			expect(
				screen?.model,
				`${label}'s safety-screen helper was ${JSON.stringify(screen)}. ${COPE_B_MODEL} means the CoPE lane ran; Shieldstral means s1-safety-judge is off on this deployment; undefined means the turn was declined`
			).toBe(S1_MODEL);
			expect(screen?.backend).toBe(S1_BACKEND);
			expect(
				helpers.filter((h) => h.model === COPE_B_MODEL),
				'a CoPE-B helper was stored on the answer'
			).toEqual([]);
		}
	);
}
