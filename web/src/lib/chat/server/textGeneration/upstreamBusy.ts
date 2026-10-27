// A model API answering 429 gets its own copy instead of the SDK's text, "429 Rate limit
// exceeded", rendered verbatim in the failed turn's bubble. Mistral's key for develop and every
// preview is capped at 30 requests a minute, so two visitors at once reach it. The status alone is
// the signal: our own per-session limiter refuses before the stream opens (chat/rateLimit.ts), so a
// 429 that reaches the generation catch always came from the model's host.
//
// The copy names the model and what to do, and deliberately avoids the phrases isRateLimitMessage
// (stores/errors.ts) keys on, because that one means "you sent too many messages", which is not what
// happened here. (CUR-2307)

import { isRateLimited } from "../endpoints/retryPolicy";

/** The visitor-facing message for a generation error, or null when the error is not a model host
 *  refusing on rate. */
export function upstreamBusyMessage(err: unknown, modelName: string): string | null {
	if (!isRateLimited(err)) return null;
	return `${modelName} is busy right now, so this reply didn't get through. Wait a minute, then press Retry.`;
}
