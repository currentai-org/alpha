// The deadlines an ordinary (not agent, not local) turn runs under, shared by the conversation route's
// generation watchdog and the warm cron's model probe (modelProbe.ts, CUR-4042), so a probe gives a model
// exactly as long to send its first chunk as a visitor's turn does.

import { config } from "$lib/chat/server/config";
import { generationTimeoutMsFor } from "$lib/chat/server/harnessProfiles";
import {
	DEFAULT_GENERATION_TIMEOUT_MS,
	DEFAULT_SILENCE_TIMEOUT_MS,
	resolveGenerationTimeoutMs,
	withModelFloor,
	type ResolvedGenerationTimeout,
} from "$lib/chat/utils/deadlineLadder";

/** An ordinary turn's total generation timeout: GENERATION_TIMEOUT_MS, raised to the model's own floor
 *  (harnessProfiles.ts `generationTimeoutMs`, CUR-4403). */
export function ordinaryTurnTimeout(modelId: string | undefined): ResolvedGenerationTimeout {
	return withModelFloor(
		resolveGenerationTimeoutMs(Reflect.get(config, "GENERATION_TIMEOUT_MS"), DEFAULT_GENERATION_TIMEOUT_MS),
		generationTimeoutMsFor(modelId)
	);
}

/** How long an ordinary turn waits for the model's first token before the watchdog ends it: the silence
 *  window with the model's floor, never past the total timeout. The route computes the same pair. */
export function firstTokenDeadlineMs(modelId: string | undefined): number {
	const silence = withModelFloor(
		resolveGenerationTimeoutMs(Reflect.get(config, "SILENCE_TIMEOUT_MS"), DEFAULT_SILENCE_TIMEOUT_MS),
		generationTimeoutMsFor(modelId)
	);
	return Math.min(silence.effectiveMs, ordinaryTurnTimeout(modelId).effectiveMs);
}
