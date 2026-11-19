// How much an agent turn does without asking. The Allow/Deny card itself needs no gate of
// its own: the `agent-confirm-ui` flag that once gated it was retired once it was on everywhere, and
// agent-mode / agent-mode-access already decide who reaches an agent turn at all.

import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key for agent auto mode. A kill switch: 0% puts everyone in ask mode. */
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
