// A model host's connection closing partway through an answer ended the turn with undici's
// own text, "terminated", in the failed turn's bubble. The generation catch passes any error's message
// through when nothing maps it (CUR-2307 mapped the 429 case the same way), and this is the shape a
// dropped stream has: a TypeError "terminated" whose cause is the socket error. The raw text stays in
// the log. (CUR-2628)

const DROPPED_SOCKET_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]);

/** True when the error is a model host's stream closing before the answer finished. */
function isUpstreamDropped(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	if (err instanceof TypeError && err.message === "terminated") return true;
	const { code, cause } = err as { code?: unknown; cause?: { code?: unknown } | null };
	return DROPPED_SOCKET_CODES.has(String(code)) || DROPPED_SOCKET_CODES.has(String(cause?.code));
}

/** The visitor-facing message for a generation error, or null when the error is not a dropped stream. */
export function upstreamDroppedMessage(err: unknown, modelName: string): string | null {
	if (!isUpstreamDropped(err)) return null;
	return `The connection to ${modelName} dropped before this answer finished. Press Retry to ask again.`;
}
