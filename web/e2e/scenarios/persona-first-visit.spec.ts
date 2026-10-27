// e2e-product: @chat
// e2e-area: @turn
import { test } from './helpers/test';
import { personaTurns, resolvePersonaLane, runPersona } from './helpers/personaDriver';

// The third persona (CUR-2676). See persona-chaos-monkey.spec.ts for the shared reasoning.
//
// SIGNED OUT, unlike the other five, because a first visit is signed out. Every other persona starts
// from a fresh account; this one is the only check that the front door still makes sense to someone
// who has never been told what Alpha is, which is the visitor a conference link brings.

const SYSTEM_PROMPT = `You have just arrived at a chat product called Alpha from a link someone shared.
You have never heard of it. You do not know what it is for, who runs it, or whether it is free. You
are not technical.

Behave like that person. Read what is on the screen before acting. Try to work out what Alpha is and
whether you can trust it, then try to get one ordinary thing done: a question you would really ask, a
short piece of writing you would really want. When something is unclear, click the thing that looks
like it would explain it. Give up on a path the way a real newcomer would, and try another.

WHAT MAKES THIS WORTH DOING: every action has to name something that is actually on the screen, by
its ref. Act on what the screen says, not on what you already know about chat products.

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a first-time visitor persona finds its way into Alpha and the run is recorded',
	{ tag: '@P3' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;

		test.setTimeout(5 * 60_000);

		await runPersona({
			page,
			testInfo,
			name: 'first-visit',
			systemPrompt: SYSTEM_PROMPT,
			startUrl: '/',
			turns: personaTurns(12),
			lane
		});
	}
);
