// e2e-product: @chat
// e2e-area: @history @settings
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { captionForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// A3's delete step, walked at the moment it actually breaks: mid-answer.
//
// `data-portability.spec.ts` already walks "Forget everything" on a settled conversation and that is
// the right default case. This file exists because the wipe has a second caller the settled walk
// structurally cannot reach — someone who decides to leave while Alpha is still typing. "Forget
// everything" lives in Settings → Data & privacy, one tap from the chat's Private pill, so the person
// goes there while the turn is still in flight.
//
// WHAT THIS PINS DOWN, AND WHY IT COULD NOT BE A UNIT TEST. The wipe deletes the conversation being
// viewed, so the streaming turn's own post-turn resync 404s, and `conversation/[id]/+page.ts` turns
// a 404 into a redirect to the chat entry. That redirect crosses route trees, so it is a document
// load: it destroys the confirmation panel — the honest list of what was cleared — and the modal
// comes back armed at "Forget everything?" as though the delete never ran (CUR-1642). Nothing in
// that chain is visible from inside a component test; it needs a real stream, a real delete, and a
// real router.
//
// The assertion is deliberately about what STAYS on screen. Ten seconds separated the successful
// wipe from the 404 in the trace that found this, so a check that reads the panel once and moves on
// passes against the broken build.
const PROMPT = 'A3 mid-stream wipe: write me a few sentences about open source';

test(
	'a visitor who forgets everything mid-answer still gets to read what was cleared',
	{ tag: '@A3' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(PROMPT);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		const conversationUrl = page.url();

		// The generating state, asserted rather than slept for. "Stop generating" is rendered only
		// while a turn is streaming (StopGeneratingBtn.svelte), so its presence is the precondition
		// this whole test rests on: wiping a settled conversation cannot reproduce the defect.
		await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
			timeout: 30_000
		});

		// Leave for Data & privacy while the answer is still streaming.
		await journeyStep(page, 'A3', 3, async () => {
			await page.getByRole('button', { name: 'Where your message goes' }).click();
			await page.getByRole('link', { name: 'Data & privacy' }).click();
			await page.waitForURL(/\/settings\/data/, { timeout: 30_000 });
		});
		await journeyStep(page, 'A3', 4, async () => {
			await page.getByRole('button', { name: /^Forget everything/ }).click();
			await expect(page.getByRole('heading', { name: 'Forget everything?' })).toBeVisible({
				timeout: 10_000
			});
		});

		const clearedHeading = page.getByRole('heading', { name: 'Your data has been cleared' });
		// The disclosure itself, not the counts in it. What each bucket should say is
		// data-portability.spec.ts's question and CUR-1638's; this test is only about whether the
		// visitor gets to read the list at all, so it must not go red over an argument about numbers.
		const clearedList = page.getByText('We deleted and removed from our servers:');
		await journeyStep(page, 'A3', 5, async () => {
			await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
			await expect(clearedHeading).toBeVisible({ timeout: 15_000 });
			await expect(clearedList).toBeVisible({ timeout: 15_000 });
		});

		// CUR-1619/CUR-1620/CUR-1773: the wipe used to leave the in-flight generation running against
		// the conversation it had just deleted, so it ran to its own watchdog and surfaced as an error
		// once the receipt was already up. A single status:error update drives the error line in the
		// message bubble (CUR-1748) and disables the composer with a pointer to that line's Retry
		// (CUR-1921, which also retired the toast and the composer's own error copy for this case). deleteConversationsCascade now aborts the generation before the delete runs,
		// so none of that should ever fire. Checked here, while the receipt is still the only thing on
		// screen, and not just after the 25s wait below — the failure mode was a race, and the earliest
		// possible check is the one most likely to catch it if the fix regresses.
		const errorToast = page.getByTestId('chat-error-toast');
		await expect(errorToast).toHaveCount(0);

		// The part that goes red on the defect. The resync that tears the panel down arrives after the
		// turn ends, which is why the panel looks fine at first and is gone by the time anybody has
		// read it. 25s covers a preview turn (7-12s observed) plus the resync behind it with room to
		// spare, and every assertion below is about the panel STILL being there.
		//
		// The toast clears itself after 5s, so a check at each end of the window misses one raised in
		// the middle, which is where the graded recordings caught it (CUR-1773). Watch for it the whole
		// time instead.
		const toastRaised = await errorToast.waitFor({ state: 'visible', timeout: 25_000 }).then(
			() => true,
			() => false
		);
		expect(
			toastRaised,
			'an error toast appeared beside the "data cleared" receipt while the wiped turn wound down'
		).toBe(false);

		await expect(clearedHeading).toBeVisible();
		await expect(clearedList).toBeVisible();
		await expect(errorToast).toHaveCount(0);
		// The re-armed prompt is the visitor-facing half: a second "Forget everything" invites a second wipe
		// of data that is already gone, and it is the same element the confirm phase renders.
		await expect(page.getByRole('button', { name: 'Forget everything', exact: true })).toHaveCount(
			0
		);
		// And nothing navigated away underneath it: a redirect is what destroys the panel, so the URL is
		// the direct reading of the mechanism rather than of its symptom.
		await expect(page).toHaveURL(/\/settings\/data/);

		await page.getByRole('button', { name: 'Done' }).click();
		await expect(clearedHeading).toBeHidden();
		// Dismissing the receipt must not surface the killed turn as an error after the fact, nor re-arm
		// the wipe for data that is already gone.
		await expect(errorToast).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Forget everything?' })).toHaveCount(0);

		// And the thing the receipt just promised actually happened (CUR-1672): the conversation the turn
		// was streaming into is gone, not waiting to be reopened.
		await captionForRecording(page, "reopening the deleted chat's old link on purpose");
		await page.goto(conversationUrl, { waitUntil: 'commit' });
		await expect(
			page.getByText(PROMPT),
			'the receipt said this conversation was deleted and it can still be opened'
		).toHaveCount(0, { timeout: 10_000 });
		await expect(page, 'the deleted conversation still has a page').not.toHaveURL(conversationUrl, {
			timeout: 10_000
		});
		// And the chat still works after the wipe: the visitor lands somewhere they can start again.
		await expect(
			page.getByLabel('Message AI Potluck'),
			'after the wipe there is no composer to start a new conversation from'
		).toBeVisible({ timeout: 30_000 });
	}
);
