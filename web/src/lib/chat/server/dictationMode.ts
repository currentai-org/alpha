// Is dictation (mic → transcription → composer text) on? (CUR-198)
//
// Split out from multimodalMode.ts on purpose: dictation only ever produces TEXT — the
// transcribed string lands in the same composer field typed text does, and goes through the
// same moderation the rest of chat already runs. It carries none of the "does the model actually
// understand this input" or "does anything screen it" questions the image/audio-in-general
// multimodal flag exists for (CUR-160), so it doesn't need to wait on those to ship.
//
// ── The FLAG is the gate; TRANSCRIPTION_MODEL is config ──────────────────────────────────────────
// The PostHog `dictation` flag decides on/off. TRANSCRIPTION_MODEL is the Whisper-style model
// address the transcribe call hits, NOT a switch — the anti-pattern this repo keeps removing
// (agentMode.ts for AGENT_SERVICE_URL, multimodalMode.ts for MULTIMODAL_ENABLED). Env-var presence
// alone must not double as "voice is on" here too: it would light the client's transcriptionEnabled
// flag while the mic button had no way to appear and the API gate read a different signal.
//
// A missing TRANSCRIPTION_MODEL while the flag is ON is therefore a MISCONFIGURATION, not a silent
// "off": the flag opened a feature with nowhere to send audio. Say so LOUDLY and withhold, same
// shape as every other gate in this file.
//
// Fallback is OFF: when PostHog has never been polled (cold start, unreachable at boot, no key)
// dictation stays off until the flag explicitly opens it. A gated feature defaults closed.

import { config } from "$lib/chat/server/config";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key. Owner: chat. Expected to be removed once dictation is either permanently on
 *  or permanently gone — a flag nobody removes is worse than no flag. */
export const DICTATION_FLAG = "dictation";

/**
 * Has the deployment configured a transcription model? A statement of readiness, NOT the gate.
 * Read via Reflect.get because the key isn't in the committed .env (same pattern as
 * MULTIMODAL_ENABLED / AGENT_SERVICE_URL).
 */
export function transcriptionModelConfigured(): boolean {
	return !!String(Reflect.get(config, "TRANSCRIPTION_MODEL") ?? "").trim();
}

/** Should dictation be exposed? Sync, never throws. The single gate — see the header. The FLAG
 *  decides on/off (default OFF); the flag ON with TRANSCRIPTION_MODEL unset is a loud config
 *  error, not a silent toggle. */
export function dictationEnabled(): boolean {
	if (!flagEnabledOr(DICTATION_FLAG, () => false)) return false;
	if (!transcriptionModelConfigured()) {
		logger.warn(
			"[dictation] dictation flag is ON but TRANSCRIPTION_MODEL is unset — dictation withheld (config error, not a feature toggle)"
		);
		return false;
	}
	return true;
}
