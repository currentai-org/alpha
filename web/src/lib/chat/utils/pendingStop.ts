/**
 * Stop pressed on the chat landing page before the new conversation's page has taken over (CUR-2971).
 *
 * The landing page sends a first message by creating a conversation and navigating to it; the
 * conversation page then sends the turn. A Stop in that window has no handler to reach, and the full
 * answer would arrive anyway. The landing page records the stop here against the conversation id, and the
 * conversation page stops the turn as soon as the server has received it, so the question is kept and
 * shows as stopped with Retry.
 */

const requested = new Set<string>();

/** Record a Stop for a conversation whose first turn has not started on its own page yet. */
function requestStopOnArrival(conversationId: string): void {
	requested.add(conversationId);
}

/** Whether a Stop was recorded for this conversation; consumes it so it applies to one turn only. */
export function takeStopOnArrival(conversationId: string): boolean {
	return requested.delete(conversationId);
}

/**
 * The landing side of the handoff, shared by both pages that start a chat (`ChatLanding.svelte` and
 * `routes/chat/models/[...model]`). Stop can be pressed before the new conversation's id is known, so
 * the press is held and recorded against the id once `arrived` names it.
 */
export function stopBeforeHandoff() {
	let stopRequested = false;
	let conversationId: string | undefined;
	return {
		/** A new send starts; a Stop from an earlier one no longer applies. */
		reset(): void {
			stopRequested = false;
			conversationId = undefined;
		},
		/** Stop pressed on the landing page. */
		stop(): void {
			stopRequested = true;
			if (conversationId) requestStopOnArrival(conversationId);
		},
		/** The conversation exists; a Stop pressed before now is recorded against it. */
		arrived(id: string): void {
			conversationId = id;
			if (stopRequested) requestStopOnArrival(id);
		},
	};
}
