// e2e-product: @chat
// e2e-area: @turn
import { test } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { personaTurns, resolvePersonaLane, runPersona } from './helpers/personaDriver';

// The adversarial half of the journey suite (CUR-1530). Read helpers/personaDriver.ts first — it
// carries why this exists and why the `ref` validator is the part everything else rests on.
//
// TAGGED @P1 RATHER THAN BORROWING AN A-NUMBER. The A-series is the product roadmap — "A2. Alpha speaks
// my language" is a commitment it tracks — and a QA persona is not a milestone. Putting one in that
// list would make the gallery's A1-A4 column answer a question nobody asked it.
//
// THIS SPEC ASSERTS NOTHING ABOUT THE PRODUCT, deliberately, and that is the opposite of how the
// other scenario specs work. Its output is a recording. What counts as a defect in that recording is
// the PM critic's call against the same frames every other journey is judged on; a persona that also
// graded itself would be a second rubric, and two rubrics disagreeing about the same video is worse
// than one rubric with a known ceiling. The only thing that fails here is the driver itself.

const SYSTEM_PROMPT = `You are a QA tester trying to BREAK a chat product called Alpha. You are not
trying to use it well. You are trying to find crashes, stuck states, controls that do nothing, and
screens that contradict themselves.

Pick the most degenerate plausible action every turn. Things worth doing, when the screen offers
them: stop a reply while it is still streaming and immediately send another; send the same message
several turns in a row; click a control twice in quick succession; submit an empty composer; reload
in the middle of a response; go back after a reply has landed; toggle a setting mid-turn; type
something enormous.

WHAT MAKES THIS WORTH DOING, and the thing that separates a useful run from a boring one: every
action has to name something that is actually on the screen, by its ref. "Break everything" finds
nothing. "Click the Stop button on turn 4 while the reply is still coming in, then immediately press
Enter in the composer" finds real defects. Be specific and be targeted.

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a chaos-monkey persona drives Alpha and the run is recorded',
	{ tag: '@P1' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		// A missing model lane is skipped with the reason stated, never failed and never quietly
		// passed. Where the environment carries no ANTHROPIC_API_KEY (CUR-1528), this
		// skips — and a skip is exactly the signal that should reach the
		// gallery, where it renders as a coverage gap rather than as a clean journey.
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;

		// Generous: twelve model round-trips plus twelve real interactions against a preview measured
		// ~2.5x slower than production. The budget is not the thing under test.
		test.setTimeout(5 * 60_000);

		// Signed in, as a fresh test account, because signed out every per-account surface
		// (My files, workspaces, export, saved settings) is out of reach and that is where a real
		// person's session goes wrong. cleanup-e2e-artifacts.mjs removes the account afterwards.
		await signInAsFreshUser(page);

		await runPersona({
			page,
			testInfo,
			name: 'chaos-monkey',
			systemPrompt: SYSTEM_PROMPT,
			startUrl: chatEntry(),
			openOnAccountSurface: true,
			turns: personaTurns(12),
			lane
		});
	}
);
