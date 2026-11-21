import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

/**
 * Continue: an answer the turn's time limit cut off is kept, and Continue asks the model to
 * finish it. The page and the server both start the continued answer from the same text, so both read it here.
 */

/** The answer text a reader saw: reasoning blocks left out, an unclosed one with everything after it.
 *  Leading space is dropped and trailing space kept, since a cut can fall between two words. */
export function visibleAnswerText(content: string): string {
	return content
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<think>[\s\S]*$/i, "")
		.trimStart();
}

/** Whether an answer has visible text to continue from. */
export function hasAnswerToContinue(content: string): boolean {
	return visibleAnswerText(content).trim().length > 0;
}

/** What a continued answer starts as. A message renders from its updates, so the cut text is its first
 *  stream entry as well as its content; the FinalAnswer then carries the whole answer (streamUpdate.ts). */
export function continuedAnswerStart(cutText: string): { content: string; updates: MessageUpdate[] } {
	return { content: cutText, updates: [{ type: MessageUpdateType.Stream, token: cutText }] };
}
