// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { startChattingPastWelcome } from './helpers/welcome';
import { warmupContext } from './helpers/warmup';

// Apertus answers Hausa in English under the generic "reply in the user's language" rule.
// With `low-resource-per-model` on, Clef reads the message, offered
// Hausa, and the turn names Hausa to the model; the turn records it and XRAY's Step by step says so.
// The question is the ticket's own probe, word for word: the Clef read for it is a bundled recording
// (endpoints/openai/cassettes/c996441a…json), so a PR run replays Clef's real answer rather than
// missing. Change the question and the recording no longer matches; the read then fails, is logged
// as an error, and the flag-on test goes red here rather than passing on a fallback.
//
// What this does not show: that Apertus then writes Hausa. PR runs answer from recordings or a mock,
// so the answer's language is measured by the live A/B on the ticket.
const APERTUS = 'swiss-ai/apertus-v1.5-70b';
const QUESTION = 'Menene babban birnin Japan?';
const STEP = 'Asked for an answer in Hausa';

type Persisted = {
	json?: { messages?: Array<{ from: string; routerMetadata?: { answerLanguage?: string } }> };
};

for (const on of [true, false]) {
	test(
		on
			? 'with low-resource-per-model on, a Hausa question to Apertus is asked for in Hausa, and XRAY says so'
			: 'with low-resource-per-model off, a Hausa question to Apertus names no language',
		{ tag: ['@A2', '@preview-only', '@CUR-2237', '@needs-apertus'] },
		async ({ page, context, baseURL }) => {
			test.setTimeout(120_000);
			if (on) await setFlagOverrides(context, baseURL!, { 'low-resource-per-model': true });
			else await setFlagOverrides(context, baseURL!, { 'low-resource-per-model': false });
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await page.goto(pinnedChatEntry(APERTUS), { waitUntil: 'commit' });

			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(QUESTION);
			await composer.press('Enter');
			await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
			if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(
				reply.getByRole('button', { name: 'Retry' }),
				'the turn never finished' + warmupContext()
			).toBeVisible({ timeout: 90_000 });

			const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
			const body = (await res.json()) as Persisted;
			const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
			expect(
				answer?.routerMetadata?.answerLanguage,
				on
					? 'the turn did not record Hausa as the language asked for: Clef was not asked, missed its recording, or read something else (search the run logs for "[clef] language read failed")'
					: 'the flag is off and the turn still named a language'
			).toBe(on ? 'hau' : undefined);

			// Through the composer's X-ray pill, which opens on the latest answer. A PR run answers with
			// the replay harness's mock, which reports no served model, so the answer's own "How this
			// answer was made" link (AnswerFooter, shown only when a model is named) is not there.
			const pill = page.getByRole('button', { name: /^X-ray — see what happened/ });
			if ((await pill.getAttribute('aria-expanded', { timeout: 15_000 })) !== 'true') {
				await pill.click({ timeout: 15_000 });
			}
			await page.getByRole('tab', { name: 'Step by step' }).click({ timeout: 10_000 });
			const step = page.getByText(STEP);
			if (on)
				await expect(
					step,
					'XRAY lists no step saying the answer was asked for in Hausa'
				).toBeVisible({ timeout: 10_000 });
			else await expect(step).toHaveCount(0);
		}
	);
}
