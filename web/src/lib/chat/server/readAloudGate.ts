import { READ_ALOUD_ENABLED } from "$lib/chat/readAloud";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { speechConfigured } from "$lib/chat/server/mcp/readAloudSpeech";

// Read-aloud (TTS), moved off the hardcoded const so it can be turned on without a deploy.
//
// ── Why the const stays where it is ─────────────────────────────────────────────────────────────
// `$lib/chat/readAloud` is imported by BOTH the server generation path and two client components, so
// it cannot import `flags.ts` — that is server-only. The const therefore survives as this flag's
// FALLBACK rather than being replaced: a deployment that never reaches PostHog behaves exactly as it
// does today, which is off. This module is the server-side half; the client half arrives through
// `getLayoutFeatureFlags`, the same seam `agentEnabled` already uses.
//
// ── ONE gate ────────────────────────────────────────────────────────────────────────────────────
// Two independent switches must not both gate the feature. The const forces the effective speak mode
// to "off" server-side (textGeneration/index.ts), and SEPARATELY the composer toggle in
// ChatInput.svelte could carry a literal `hidden` class. Flipping the flag alone would re-enable
// synthesis while leaving no way to reach it: the rollout would read as successful and every user
// would see nothing. So the `hidden` class is driven by this same value. If a third switch ever
// appears, it belongs here too — there is one answer to "is read-aloud on".
//
// ── What turning it on actually restores ────────────────────────────────────────────────────────
// The const's own comment records why it is off, and the reasons are about behaviour rather than
// about the code being unfinished: the server's absent-speakMode fallback resolves to "auto", and any
// browser that set auto/always before the toggle was hidden still sends that preference. Both are
// neutralised by producing no clip. Turning this flag on re-arms both paths at once — so roll it out
// on a release condition rather than flipping it to 100%, and expect stale client preferences to start
// autoplaying for the users who set them.

/** PostHog flag key. Owner: chat. */
export const READ_ALOUD_FLAG = "read-aloud";

/**
 * Is read-aloud on for this deployment? Sync, never throws.
 *
 * Deployment-wide rather than per-user: the surfaces it gates are a server synthesis decision and two
 * rendered controls, and a per-user split would let one of those disagree with the others.
 */
export function readAloudEnabled(): boolean {
	if (!flagEnabledOr(READ_ALOUD_FLAG, () => READ_ALOUD_ENABLED)) return false;
	// The flag is the only switch; read-aloud does not depend on any other address being set.
	// A flag that is on with no router credential is a misconfiguration: say so and withhold. (CUR-3151)
	if (speechConfigured()) return true;
	if (!warnedUnconfigured) {
		warnedUnconfigured = true;
		logger.error(
			{ flag: READ_ALOUD_FLAG },
			"[read-aloud] flag is on but HF_TOKEN is unset, so read aloud is withheld"
		);
	}
	return false;
}

let warnedUnconfigured = false;
