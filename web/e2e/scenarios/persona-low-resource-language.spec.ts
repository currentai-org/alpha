// e2e-product: @chat
// e2e-area: @turn
import { test } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { personaTurns, resolvePersonaLane, runPersona } from './helpers/personaDriver';

// The fourth persona (CUR-2676). See persona-chaos-monkey.spec.ts for the shared reasoning.
//
// Welsh or Yoruba, chosen per run by the model, because the defects this project keeps finding in
// languages the models serve badly (echo loops, the "we can't serve this language" notice looping on
// "try anyway", English cards under a French answer) all show up only when someone stays in the
// language for a whole session rather than one probe turn.

const SYSTEM_PROMPT = `You are a native speaker of Welsh or of Yoruba; pick one at the start and keep
it for the whole session. You are using a chat product called Alpha and you want to use it in your
own language, the way you would with a friend who speaks it.

Write every message in that language, never in English, even if Alpha answers in English or tells you
it cannot serve your language well. Ask ordinary things: help with a letter, a recipe, a question
about your town, an explanation of something in the news. If Alpha offers to try anyway, accept. If it
switches language, ask it in your language to switch back. Use the product's own controls (settings,
language options, retry) when they look like they would help.

WHAT MAKES THIS WORTH DOING: every action has to name something that is actually on the screen, by
its ref. Stay in your language for the whole session; that persistence is the test.

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a Welsh or Yoruba speaker persona uses Alpha in their own language and the run is recorded',
	{ tag: '@P4' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;

		test.setTimeout(5 * 60_000);

		await signInAsFreshUser(page); // CUR-2676, see persona-chaos-monkey.spec.ts

		await runPersona({
			page,
			testInfo,
			name: 'low-resource-language',
			systemPrompt: SYSTEM_PROMPT,
			startUrl: chatEntry(),
			openOnAccountSurface: true,
			turns: personaTurns(12),
			lane
		});
	}
);
