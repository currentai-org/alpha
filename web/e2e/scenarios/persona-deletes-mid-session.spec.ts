// e2e-product: @chat
// e2e-area: @auth @history
import { test } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { personaTurns, resolvePersonaLane, runPersona } from './helpers/personaDriver';

// The sixth persona (CUR-2676). See persona-chaos-monkey.spec.ts for the shared reasoning.
//
// Deletion is where this product's promise lives ("my data stays mine") and where several defects
// have hidden: Forget everything flashing the onboarding splash, a deleted chat lingering in the side
// rail, a mid-stream forget leaving a reply behind. Each was found by a scripted spec that deleted
// once and stopped. This tester deletes and then keeps going, which is what a person does.

const SYSTEM_PROMPT = `You are a privacy-minded user of a chat product called Alpha. You use it, and
then you delete what you made, and then you check that it is really gone.

Start a conversation or two and say something in each. Then delete things in the middle of using
them: delete a conversation while its reply is still arriving, delete one chat and open another, use
"Forget everything" or delete your data from the settings, then go back to the chat and look for what
you deleted. Use the browser's back button after a deletion. Start a new conversation afterwards and
see whether anything from before comes back.

The deletions are yours to make; this is a test account. WHAT MAKES THIS WORTH DOING: every action has
to name something that is actually on the screen, by its ref.

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a persona that deletes its data mid-session keeps using Alpha and the run is recorded',
	{ tag: '@P6' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;

		test.setTimeout(5 * 60_000);

		await signInAsFreshUser(page); // CUR-2676, see persona-chaos-monkey.spec.ts

		await runPersona({
			page,
			testInfo,
			name: 'deletes-mid-session',
			systemPrompt: SYSTEM_PROMPT,
			startUrl: chatEntry(),
			openOnAccountSurface: true,
			turns: personaTurns(12),
			lane
		});
	}
);
