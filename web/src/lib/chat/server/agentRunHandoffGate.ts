import { flagEnabledOr } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. Gates an agent run outliving the chat request that started it.
 *  @internal exported for the flag registry spec */
export const AGENT_RUN_HANDOFF_FLAG = "agent-run-handoff";

/**
 * Does an agent run outlive the chat request? On, the turn asks agent-service for its whole attempt
 * (AGENT_HANDOFF_WALL_CLOCK_SECS), hands the run to the page before the route's watchdog
 * (agentHandoffAt), and the page follows it to the end (AGENT_HANDOFF_RUN_CEILING_MS). Off is the
 * behaviour before it existed, exactly: a run is asked to stop at 150s and the turn ends at the 155s
 * watchdog. Sync, never throws, fallback OFF.
 *
 * Deployment-wide, and shipped to the browser in the layout data as `agentRunHandoffEnabled`, so the
 * server's handoff and the page's follow read one answer.
 */
export function agentRunHandoffEnabled(): boolean {
	return flagEnabledOr(AGENT_RUN_HANDOFF_FLAG, () => false);
}
