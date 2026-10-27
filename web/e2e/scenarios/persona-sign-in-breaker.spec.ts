// e2e-product: @chat
// e2e-area: @auth
import { test } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { readSignInOtp } from './helpers/otp';
import { freshTestEmail, installOtpBypassHeader } from './helpers/signIn';
import {
	DEFAULT_ACTIONS,
	personaTurns,
	resolvePersonaLane,
	runPersona,
	signInInboxNote
} from './helpers/personaDriver';

// The seventh persona, aimed at A1 (CUR-2676). See persona-chaos-monkey.spec.ts for the shared
// reasoning: no product assertions, the recording is the output, the PM critic judges it.
//
// SIGNED OUT AT THE START, because the anonymous-to-signed-in carry-over is half of what it tests.
// It gets an inbox: `check_inbox` reads the latest code sent to its own address out of the
// `verification` table (helpers/otp.ts), the same read every sign-in spec makes. The address is an
// e2e-<uuid>@example.org one, so no email is sent (betterAuth.ts suppresses the domain), the send cap
// is carved out by the bypass header, and cleanup-e2e-artifacts.mjs removes the account afterwards.
// The driver refuses to type any address outside example.org.

const EMAIL = freshTestEmail();

const SYSTEM_PROMPT = `You are testing the sign-in of a chat product called Alpha, and you are trying
to make it go wrong. Your email address is ${EMAIL}. Use only that address.

You start signed out. Ask Alpha one short question first, so there is a conversation to carry over,
then sign in with your email and the code it sends you. You read codes with check_inbox; it shows
the latest code sent to your address. Then make sign-in awkward the way real people do:
- type a wrong code first, then the right one
- ask for a second code, then type the FIRST one
- press the sign-in or verify button twice quickly
- press the browser's back button in the middle of signing in, and after signing in
- reload on the code screen
- sign out, then sign back in, and check whether your earlier conversation is still yours

WHAT MAKES THIS WORTH DOING: every action has to name something that is actually on the screen, by
its ref. After each step look at what the screen says: is it clear whether you are signed in, and
is your conversation still there?

Do not narrate. Do not explain your strategy. Choose one action.`;

test(
	'a sign-in breaker persona signs in, out and back again the awkward way and the run is recorded',
	{ tag: '@P7' },
	async ({ page }, testInfo) => {
		const lane = resolvePersonaLane();
		test.skip('error' in lane, 'error' in lane ? lane.error : '');
		if ('error' in lane) return;
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		test.skip(!databaseUrl, 'SCENARIO_DATABASE_URL is unset, so the persona has no inbox to read');
		if (!databaseUrl) return;

		test.setTimeout(6 * 60_000);

		await installOtpBypassHeader(page);

		await runPersona({
			page,
			testInfo,
			name: 'sign-in-breaker',
			systemPrompt: SYSTEM_PROMPT,
			// The pinned model's page, so the guest session defaults to it before any sign-in.
			startUrl: chatEntry(),
			turns: personaTurns(12),
			lane,
			actions: [...DEFAULT_ACTIONS, 'check_inbox'],
			inbox: () => signInInboxNote(EMAIL, () => readSignInOtp(databaseUrl, EMAIL))
		});
	}
);
