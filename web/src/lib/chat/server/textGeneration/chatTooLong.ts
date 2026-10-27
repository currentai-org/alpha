// The newest message alone was over the model's context, so the turn was refused before any call
// (CUR-2893, endpoints/openai/fitHistory.ts). Retry would resend the same message and fail the same
// way, so the generic "press Retry" sentence would mislead; this says what works.

import { MessageTooLongError } from "../endpoints/openai/fitHistory";

/** The visitor-facing message for a refused over-long message, or null for any other error. */
export function messageTooLongMessage(err: unknown, modelName: string): string | null {
	if (!(err instanceof MessageTooLongError)) return null;
	return `This message is too long for ${modelName} to read. Shorten it, or attach less, and send it again.`;
}
