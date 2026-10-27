// Who counts as a team account, and the staff tier that buys on every per-account usage limit (CUR-4620).
//
// A team account is a VERIFIED email on one of TEAM_DOMAINS. The PostHog release conditions that stage
// a flag to "team accounts only" match the same domains (docs/guides/feature-flags.md), and
// scripts/flag-matrix.mjs probes with this list, so the domains are written here once.
//
// Verified, because the address is the whole claim. Email-OTP proves it by delivery; Google, GitHub and
// Hugging Face say so in their own OAuth response, and Better Auth stores that as `emailVerified`,
// which auth.ts copies onto `locals.user` per request. An account whose address was never verified gets
// no tier, the same rule flagEmail.ts applies before an address reaches flag evaluation.
//
// The e2e suites' disposable `e2e-…@currentai.org` accounts are not team accounts: the scenario specs
// assert the visitor limits on them, and they share their own sandbox pool.
//
// Kept free of `$lib` imports so scripts/flag-matrix.mjs can import it under plain node.

/** The team's email domains. A flag condition for "team accounts" matches `@(<these>)$`. */
export const TEAM_DOMAINS = ["currentai.org", "publicai.co"] as const;

// The shape freshTestEmail() mints in e2e/scenarios/helpers/signIn.ts; no person holds one.
const TEST_ACCOUNT_EMAIL = /^e2e-[^@]+@(example\.org|currentai\.org)$/i;

/** True for an e2e suite's disposable test account. */
export function isTestAccountEmail(email: string | undefined): boolean {
	return !!email && TEST_ACCOUNT_EMAIL.test(email);
}

/**
 * The staff tier's numbers. High rather than unlimited, so a runaway loop on a team account still stops,
 * and every limit not listed here (per-minute rate, per-IP ceiling, per-task caps, live sandboxes, the
 * whole surface's daily ceilings) applies to the team exactly as to anyone.
 */
export const STAFF_TIER = {
	/** Agent tasks per 24 hours, 40x a visitor's 25. At about 30 s a task that is more than a
	 *  working day of back-to-back tasks, so in practice a team account is never stopped, yet a runaway loop
	 *  still ends. The chat surface's agent ceiling (AGENT_CALLER_DAILY_TASKS) is 10,000 so ten team
	 *  accounts at this cap still leave the day's room for visitors. */
	agentTasksPerDay: 1000,
	/** Stored conversations, 10x USAGE_LIMITS.conversations (100). A teammate who has tested for weeks
	 *  is past 100, and a full account refuses every new chat until some are deleted. */
	conversations: 1000,
} as const;

type MaybeUser = { email?: string; emailVerified?: boolean } | null | undefined;

/** True for a signed-in account whose verified address is on a team domain, and not an e2e test account. */
export function isTeamAccount(user: MaybeUser): boolean {
	if (!user || user.emailVerified !== true || !user.email) return false;
	const email = user.email.trim().toLowerCase();
	if (isTestAccountEmail(email)) return false;
	const at = email.lastIndexOf("@");
	if (at < 1) return false;
	const domain = email.slice(at + 1);
	return (TEAM_DOMAINS as readonly string[]).includes(domain);
}
