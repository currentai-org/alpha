import type { SpeakMode } from "$lib/chat/stores/speakMode";

/**
 * Resolve the effective per-turn speak preference from the request fields.
 *
 * `speakMode` (the tri-state the client now sends) is AUTHORITATIVE when present: a client that says
 * "off" must win even over a contradictory legacy `speakAll: true` (deploy-skew, a stale client bug, or
 * a crafted payload) — otherwise "off" wouldn't be honored. The legacy boolean is consulted ONLY when
 * `speakMode` is absent (an old client that predates this field):
 *   - speakAll: true  → "always" (preserve the old client's speak-every-answer behavior);
 *   - otherwise       → "auto"   (D3 default — old clients collapsed off and auto into speakAll:false,
 *                                  so we can't distinguish them; "auto" preserves their intent-driven
 *                                  read-aloud, and an un-upgraded "off" client self-heals on reload).
 *
 * Pure + dependency-free so the precedence (the load-bearing "off beats speakAll") is unit-testable
 * without standing up the generation pipeline. Consumed by textGeneration.
 */
export function resolveSpeakMode(
	speakMode: SpeakMode | undefined,
	speakAll: boolean | undefined
): SpeakMode {
	return speakMode ?? (speakAll ? "always" : "auto");
}
