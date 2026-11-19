// The cause a thrown generation error records for the turn's failureLayer
// ($lib/chat/utils/failureLayer). It reads the error with the same predicates the generation catch
// already uses to pick the visitor's sentence (upstreamSilent, upstreamBusy, upstreamDropped,
// chatTooLong), so the alert and the visitor are told the same thing about the same error.

import type { FailureCause } from "$lib/chat/utils/failureLayer";
import { NoFirstChunkError } from "../endpoints/failover";
import { MessageTooLongError } from "../endpoints/openai/fitHistory";
import { isRateLimited, statusOf } from "../endpoints/retryPolicy";
import { isUpstreamDropped } from "./upstreamDropped";

/** Connection failures before any response: the OpenAI SDK's connection errors and undici/Node codes. */
const CONNECT_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);
const CONNECT_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

function isUnreachable(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const { name, code, cause } = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } | null };
	const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
	if (CONNECT_ERROR_NAMES.has(String(name)) || CONNECT_ERROR_NAMES.has(String(ctor))) return true;
	return CONNECT_ERROR_CODES.has(String(code)) || CONNECT_ERROR_CODES.has(String(cause?.code));
}

/** The failure cause for an error thrown out of generation that was not an abort. */
export function failureCauseOfError(err: unknown): FailureCause {
	if (err instanceof MessageTooLongError) return "message-too-long";
	if (err instanceof NoFirstChunkError) return "upstream-no-first-chunk";
	if (isRateLimited(err)) return "upstream-rate-limited";
	if (isUpstreamDropped(err)) return "upstream-dropped";
	if (isUnreachable(err)) return "upstream-unreachable";
	const status = statusOf(err);
	if (status !== undefined && status >= 500) return "upstream-http-5xx";
	// A 4xx other than 429 is a request we built or a key we hold; no status at all is a throw of ours.
	return "exception";
}
