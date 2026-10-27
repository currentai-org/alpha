// Runs once, only when Playwright actually starts a test run — unlike a module-scope throw in
// playwright.config.ts or a spec file, which also fires when a static tool (knip's Playwright
// plugin) merely imports the file to read its shape. Both required env vars are
// read here so config loading and spec collection stay side-effect-free.
function requireEnv(name: string, why: string): void {
	if (!process.env[name]) {
		throw new Error(`${name} is not set — ${why}`);
	}
}

import { checkChatEntry, CHAT_ENTRY } from './helpers/chatEntry';
import { warmUpChatPath, recordWarmup } from './helpers/warmup';

export default async function globalSetup(): Promise<void> {
	requireEnv(
		'SCENARIO_BASE_URL',
		'this suite runs against a real deployed preview, never a default localhost. Set it to a real Vercel preview URL (see scenario-suite-check.yml, CUR-1150) — e.g. `gh api repos/<owner>/<repo>/deployments?sha=<sha>` for a PR, or https://develop.aipotluck.org directly.'
	);
	requireEnv(
		'SCENARIO_DATABASE_URL',
		"the sign-in helper reads the real OTP from this database's verification table — the shared `preview` Doppler config's DATABASE_URL (CUR-1150), not a per-PR branch."
	);

	// One request, before any spec: a chat entry that doesn't answer 200 would otherwise surface as
	// the same failure repeated in every spec that opens chat.
	const base = process.env.SCENARIO_BASE_URL as string;
	await checkChatEntry(base);
	console.log(`scenario suite: chat entry on ${base} answers 200 at ${CHAT_ENTRY}`);

	// A real throwaway turn, paid for here rather than by whichever spec's own 45s-ceiling
	// assertion happens to run first against a cold PR preview. See helpers/warmup.ts for why this has
	// to be a real turn and not a cheap route ping (CUR-1803).
	const warmup = await warmUpChatPath(process.env.SCENARIO_BASE_URL as string);
	recordWarmup(warmup);
	console.log(
		warmup.ok
			? `scenario suite: warm-up turn finished in ${warmup.ms}ms`
			: `scenario suite: warm-up turn failed after ${warmup.ms}ms — ${warmup.error}`
	);
}
