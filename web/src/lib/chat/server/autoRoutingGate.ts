import { flagEnabledOr } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. Gates "Auto" model routing for new chats. */
export const AUTO_ROUTING_FLAG = "auto-routing";

/**
 * Is Auto model routing on for this deployment? Sync, never throws.
 *
 * Off is today's behaviour: the composer's model menu has no Auto row and never classifies the draft,
 * and a new chat starts on the model chosen in settings (or the first model). Fallback OFF, so a
 * routing feature that overrides that choice cannot switch itself on if PostHog is unreachable.
 *
 * Deployment-wide, not per-user. It is shipped to the client in the layout data as
 * `autoRoutingEnabled`, so the composer's menu and the landing page's model choice read one answer.
 */
export function autoRoutingEnabled(): boolean {
	return flagEnabledOr(AUTO_ROUTING_FLAG, () => false);
}
