// Usage tiers for run-code in chat (CUR-4578). Every account can run code from its first message; what
// grows with use is how much. An account starts on the first tier and moves up as its runs pile up over
// days, the way API tiers work at Anthropic or Mistral. A safety decline on the account holds it on the
// first tier for `declineHoldDays`. The tiers are read in `server/mcp/sandboxAllowance.ts`; change the
// numbers here, and the unit spec beside that file checks the table still parses.
//
// The numbers, and where each comes from:
// - `liveIdleMinutes` 2: E2B pauses a conversation's run-code sandbox after 120 s without a call
//   (`E2B_RUN_CODE_IDLE_SECS`, agent-service/api/app.py; agent-service's /healthz reports it as
//   `sandbox_run_code_idle_s`), so a conversation with a call in the last 2 minutes is one holding a live
//   sandbox. Change both together. A paused sandbox resumes on the next call with its files and memory, so
//   the short window costs a resume, and it is what lets one 56-slot host serve a room: a 10-minute window
//   would hold 56 people per ten minutes and refuse a new account a second conversation for ten.
// - `maxLive` never above 2: agent-service refuses a third live sandbox for any account
//   (`E2B_ACCOUNT_MAX_LIVE`, CUR-4553). Raising a tier past it needs that raised first.
// - `runsPerDay` 40 on the first tier: one sandbox turn may make 16 calls (`SANDBOX_MAX_CALLS`) and the
//   agent eval's multi-step tasks took about 12, so 40 is three heavy turns or ten light ones a day.
// - `testAccountsMaxLive` 2: e2e suites sign in as disposable `e2e-…` accounts, and every one of
//   them together may hold 2 live sandboxes. Develop's host fits 4, so a burst of CI runs leaves the
//   other 2 for staff. A run on the in-process `sandbox_stub` touches no host and is not counted.
// - The capacity math behind these for the 56-sandbox production host is on CUR-4578.

import { z } from "zod";

/** agent-service's per-account ceiling on live run-code sandboxes (`E2B_ACCOUNT_MAX_LIVE`). */
const SERVICE_MAX_LIVE = 2;

const tierSchema = z.object({
	name: z.string().min(1),
	/** Conversations that may hold a live sandbox at once. */
	maxLive: z.number().int().min(1).max(SERVICE_MAX_LIVE),
	/** Sandbox calls (run_code, run_command, write_file) in any 24 hours. */
	runsPerDay: z.number().int().positive(),
	/** Runs the account needs inside the history window to reach this tier. */
	runsToReach: z.number().int().min(0),
	/** Days since the account's first run inside the history window, to reach this tier. */
	daysToReach: z.number().int().min(0),
});

const configSchema = z
	.object({
		liveIdleMinutes: z.number().int().positive(),
		/** How far back runs count toward a tier. A run older than this no longer counts. */
		historyDays: z.number().int().positive(),
		/** A safety decline on the account this recent holds it on the first tier. */
		declineHoldDays: z.number().int().min(0),
		/** Live sandboxes all e2e test accounts may hold at once, together. */
		testAccountsMaxLive: z.number().int().min(1),
		tiers: z.array(tierSchema).min(1),
	})
	.superRefine((cfg, ctx) => {
		const [first, ...rest] = cfg.tiers;
		if (first.runsToReach !== 0 || first.daysToReach !== 0) {
			ctx.addIssue({ code: "custom", message: "the first tier is where every account starts: it needs 0 runs and 0 days" });
		}
		let prev = first;
		for (const t of rest) {
			const grows = t.runsToReach > prev.runsToReach && t.daysToReach >= prev.daysToReach;
			const gives = t.maxLive >= prev.maxLive && t.runsPerDay > prev.runsPerDay;
			if (!grows || !gives) {
				ctx.addIssue({ code: "custom", message: `tier ${t.name} must need more than ${prev.name} and give more` });
			}
			if (t.daysToReach > cfg.historyDays) {
				ctx.addIssue({ code: "custom", message: `tier ${t.name} needs more days than the history window keeps` });
			}
			prev = t;
		}
	});

export type SandboxTier = z.infer<typeof tierSchema>;
export type SandboxTierConfig = z.infer<typeof configSchema>;

/** Parses at module load, so a bad edit fails the unit spec and the build, not a turn.
 *  @internal exported for sandboxAllowance.spec */
export function parseSandboxTiers(raw: unknown): SandboxTierConfig {
	return configSchema.parse(raw);
}

export const SANDBOX_TIERS: SandboxTierConfig = parseSandboxTiers({
	liveIdleMinutes: 2,
	historyDays: 30,
	declineHoldDays: 30,
	testAccountsMaxLive: 2,
	tiers: [
		{ name: "new", maxLive: 1, runsPerDay: 40, runsToReach: 0, daysToReach: 0 },
		{ name: "regular", maxLive: 2, runsPerDay: 150, runsToReach: 30, daysToReach: 2 },
		{ name: "established", maxLive: 2, runsPerDay: 400, runsToReach: 150, daysToReach: 7 },
	],
});
