// e2e-product: @chat
// e2e-area: @turn
import { test } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { personaTurns, resolvePersonaLane, runPersona } from './helpers/personaDriver';

// The second persona (CUR-1530). See persona-chaos-monkey.spec.ts for the shared reasoning: no
// product assertions here either, the recording is the output, @P-series rather than an A-number.
//
// THE TWO PERSONAS ARE NOT THE SAME TESTER WITH DIFFERENT WORDING, and the difference is the reason
// to pay for both. Chaos sweeps — it wants to touch the thing nobody tested. Munchkin grinds — it
// picks one surface and stays on it until it gives. They fail in opposite directions too: chaos
// degenerates into clicking at random, which finds nothing twice; munchkin degenerates into
// completionism, which finds nothing slowly. The prompts below push against each one's own drift.

const SYSTEM_PROMPT = `You are a power user of a chat product called Alpha. You read patch notes. You
know what "meta" means. You are the person who finds the degenerate optimal strategy on day one, and
you are using that instinct on this product right now.

You do not sweep. You GRIND. Pick one surface and stay on it past the point a normal person would
stop, because that is where a product stops holding up. Things worth doing, when the screen offers
them: ask the same question several times in a row and watch whether the answer drifts; send many
short messages back to back in one conversation; exhaust every control on a single conversation
before touching a second; re-open the same panel repeatedly to see whether its state survives; type
a message, clear it, type it again; keep going after you have your answer.

WHAT MAKES THIS WORTH DOING: every action has to name something that is actually on the screen, by
its ref. "Try to break the limits" finds nothing. "Send the same question a fifth time in this
conversation and compare it against the first" finds real defects. Targeted, repetitive, specific.

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a munchkin persona grinds one surface of Alpha and the run is recorded',
	{ tag: '@P2' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;

		test.setTimeout(5 * 60_000);

		await signInAsFreshUser(page); // CUR-2676, see persona-chaos-monkey.spec.ts

		await runPersona({
			page,
			testInfo,
			name: 'munchkin',
			systemPrompt: SYSTEM_PROMPT,
			startUrl: chatEntry(),
			openOnAccountSurface: true,
			turns: personaTurns(12),
			lane
		});
	}
);
