// When a refused request can try again, in the words an allowance message uses: "in 7 minutes" under
// an hour, "in about 3 hours" above. Shared by the agent-task allowance (db/agentTaskAllowance.ts) and
// the sandbox usage tiers (mcp/sandboxAllowance.ts), so both say it the same way.

/** "in 7 minutes" under an hour, "in about 3 hours" above. */
export function retryAfterWords(secs: number): string {
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	return secs < 3600
		? `in ${plural(Math.max(1, Math.ceil(secs / 60)), "minute")}`
		: `in about ${plural(Math.ceil(secs / 3600), "hour")}`;
}
