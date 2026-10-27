// Any model error the busy or dropped-stream copy doesn't map would otherwise reach the visitor as the
// SDK's own text: "500 Internal Server Error", a 401, a context-length 400. None of those names a cause
// the visitor can act on, so the turn says the model couldn't answer and the raw text stays in the log
// (CUR-2829).

/** The visitor-facing message for a generation error no named copy covers. */
export function upstreamFailedMessage(modelName: string): string {
	return `${modelName} couldn't answer this time. Press Retry to ask again.`;
}
