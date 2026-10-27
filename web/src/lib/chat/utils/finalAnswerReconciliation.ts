export type FinalAnswerReconciliation =
	| { type: "noop" }
	| { type: "append"; text: string }
	| { type: "replace"; text: string };

/**
 * Decide how the live-rendered streamed text should reconcile with the authoritative FinalAnswer.
 * A suffix match is NOT enough to keep the current text: honesty guards can remove a bad prefix
 * sentence, leaving finalText as a suffix of the already-rendered text.
 */
export function reconcileFinalAnswerText(
	currentText: string,
	finalText: string
): FinalAnswerReconciliation {
	if (finalText === currentText) return { type: "noop" };
	if (finalText.startsWith(currentText)) {
		return { type: "append", text: finalText.slice(currentText.length) };
	}
	return { type: "replace", text: finalText };
}
