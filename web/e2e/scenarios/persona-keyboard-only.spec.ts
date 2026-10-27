// e2e-product: @chat
// e2e-area: @turn
import { test } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import {
	KEYBOARD_ONLY_ACTIONS,
	personaTurns,
	resolvePersonaLane,
	runPersona
} from './helpers/personaDriver';

// The fifth persona (CUR-2676). See persona-chaos-monkey.spec.ts for the shared reasoning.
//
// THE DRIVER, NOT THE PROMPT, KEEPS THIS ONE OFF THE MOUSE. `actions` leaves out click, so a model
// that reaches for a click is refused and asked again; a prompt alone would drift back to clicking
// within a few turns and the run would stop being a keyboard test without saying so. Typing is
// `fill`: `press` takes one key name, and a keyboard user types (CUR-2916).

const SYSTEM_PROMPT = `You use a chat product called Alpha without a mouse or a touchscreen. You
navigate only with the keyboard: Tab and Shift+Tab to move between controls, Enter and Space to
activate them, Escape to close things, arrow keys inside menus and lists.

You can only press keys on an element from the list, or type text into one; you cannot click. Use that to do what a person
on a keyboard actually does: get to the message box and send a question, open a menu and choose
something in it, open a dialog and close it again, reach the settings. When focus seems to disappear
or a control cannot be reached, keep trying the way a real keyboard user would before moving on.

WHAT MAKES THIS WORTH DOING: every action has to name something that is actually on the screen, by
its ref, and has to be a key a keyboard user would press there.

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a keyboard-only persona drives Alpha without clicking and the run is recorded',
	{ tag: '@P5' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;

		test.setTimeout(5 * 60_000);

		await signInAsFreshUser(page); // CUR-2676, see persona-chaos-monkey.spec.ts

		await runPersona({
			page,
			testInfo,
			name: 'keyboard-only',
			systemPrompt: SYSTEM_PROMPT,
			startUrl: chatEntry(),
			openOnAccountSurface: true,
			turns: personaTurns(12),
			lane,
			actions: KEYBOARD_ONLY_ACTIONS
		});
	}
);
