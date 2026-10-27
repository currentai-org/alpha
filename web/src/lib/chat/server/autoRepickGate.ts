import { flagEnabledOr } from "$lib/chat/server/flags";
import { autoRepickGiveUpMsFor } from "$lib/chat/server/harnessProfiles";

/** PostHog flag key. Owner: chat. Gates Auto picking again within a turn its pick did not answer. */
export const AUTO_REPICK_FLAG = "auto-repick";

/**
 * How long an Auto-chosen model may go without a first chunk before the turn ends on the silent-model
 * error and the browser asks Auto again (CUR-4384). A model whose own give-up is sooner keeps it, and a
 * model measured slower to its first token has a longer row in harnessProfiles.ts (CUR-4539).
 */
const AUTO_REPICK_GIVE_UP_MS = 20_000;

/** How long Auto waits for `modelId` before asking again: its measured row, else the 20s default (CUR-4539). */
export function autoRepickGiveUpFor(modelId: string | undefined): number {
	return autoRepickGiveUpMsFor(modelId) ?? AUTO_REPICK_GIVE_UP_MS;
}

/**
 * Is Auto's in-turn re-pick on for this deployment? Sync, never throws. Off is today's behaviour: an
 * Auto turn whose model is busy or silent ends on that model's error, and Auto routes around it only on
 * the next send. Fallback OFF, so a change to which model answers cannot switch itself on.
 *
 * Deployment-wide like `auto-routing`, and shipped to the browser in the layout data as
 * `autoRepickEnabled`, so the server's sooner give-up and the browser's re-pick read one answer.
 */
export function autoRepickEnabled(): boolean {
	return flagEnabledOr(AUTO_REPICK_FLAG, () => false);
}
