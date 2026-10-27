// Is the agent confirmation UI (CUR-218) on? A tool call paused under ACP_PERMISSION_POLICY=confirm
// needs a human answer within agent-service's own timeout (fails CLOSED to deny on its own — nothing
// here has to enforce that), and this flag gates whether the chat side renders a real Allow/Deny
// affordance for it and accepts a click.
//
// A NEW flag, not a reuse of `agent-mode` — same reasoning as `agent-artifact-download`: a bug in this
// path shouldn't force disabling agent mode entirely to contain it. It also composes with a SEPARATE,
// agent-service-owned switch this repo doesn't control: ACP_PERMISSION_POLICY stays off "confirm" until
// agent-service turns it on, so today the `awaiting_confirmation` event this flag gates can't fire in
// prod regardless of this flag's value. That is a real, independent gate, not a reason to skip this
// one: this flag guards a genuinely new interactive surface (an in-chat Allow/Deny control, not just a
// rendering choice) on top of agent-service's own gate.
//
// Fallback is OFF: when PostHog has never been polled, the confirm UI stays off until the flag
// explicitly opens it. A gated feature defaults closed.

import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key. Owner: chat. */
export const AGENT_CONFIRM_UI_FLAG = "agent-confirm-ui";

/** Should the chat surface render/accept the agent confirmation Allow/Deny UI? Sync, never throws. */
export function agentConfirmUiEnabled(): boolean {
	return flagEnabledOr(AGENT_CONFIRM_UI_FLAG, () => false);
}

/** PostHog flag key for agent auto mode (CUR-3142). A kill switch: 0% puts everyone in ask mode. */
export const AGENT_AUTO_MODE_FLAG = "agent-auto-mode";

/**
 * Does this person's agent turn run in auto mode? agent-service then runs what its reviewer clears
 * and opens a card only before a delete. Auto is the default for everyone: the sandbox has no network
 * and nothing in it outlives the task, so asking about each edit or command only tires people out. A
 * person who wants a card for every step turns on "Ask before every step" in Settings →
 * Personalization. No settings row (a guest who never saved one, or a failed read) means auto.
 * `agent-auto-mode` at 0% overrides all of that and asks everyone, for when the reviewer misbehaves.
 */
export async function agentAutoApproveFor(locals: App.Locals | undefined): Promise<boolean> {
	if (!flagEnabledOr(AGENT_AUTO_MODE_FLAG, () => true)) return false;
	if (!locals) return true;
	try {
		// Loaded here, not at the top: this module sits under the agent endpoint and the confirm route, and a
		// top-level database import drags the model registry into every spec that imports either.
		const [{ collections }, { authCondition }] = await Promise.all([
			import("$lib/chat/server/database"),
			import("$lib/chat/server/auth"),
		]);
		const settings = await collections.settings.findOne(authCondition(locals));
		return settings?.agentAskEveryStep !== true;
	} catch (err) {
		// Auto on a failed read: the default, in a sandbox, beats failing the turn. Said, not silent.
		logger.warn({ err: String(err) }, "[agent] settings read failed; running auto mode");
		return true;
	}
}
