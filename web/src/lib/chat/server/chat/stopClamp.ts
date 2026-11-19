// The stop clamp on a finished answer, for sealed and plaintext messages alike.
//
// The clamp cuts a stored answer back to what was on screen at Stop (stopTruncation.ts). A sealed
// answer stores `content: ""`, so the server has no text to cut. The browser that pressed Stop opens
// the stored blob and posts its body; the server checks it against the stored revision and MAC, as a
// turn's history is checked, cuts it, and seals the cut answer at the next revision. Nothing here
// writes a sealed answer back in plaintext: a sealed answer with no sealer fails the request.

import { clampFinishedMessage } from "$lib/chat/server/stopTruncation";
import { hydrateSealedMessage, type ConversationSealer, type TurnHistoryEntry } from "$lib/chat/server/chat/sealedTurn";
import type { Message } from "$lib/chat/types/Message";

/** What the stop route does with a finished answer. */
export type StopClampPlan =
	/** Nothing past the stop point, or nothing to cut. */
	| { kind: "none" }
	/** A sealed answer runs past the stop point and no opened body was posted: the browser opens the
	 *  stored blob at `rev` and posts it. */
	| { kind: "needs_body"; messageId: string; rev: number }
	/** The answer as it is stored after the clamp. */
	| { kind: "write"; message: Message };

/**
 * The stored form of a finished answer after Stop, or what the browser must send first.
 *
 * `sealerFor` is asked only when there is something to write. A plaintext answer is sealed when it
 * returns a sealer (sealing is on and the owner has a key) and written as before when it returns null.
 *
 * @throws SealedHistoryError when the posted body does not match the stored answer.
 * @throws Error when a sealed answer would be written and there is no sealer: never written in plaintext.
 */
export async function planStopClamp(opts: {
	message: Message;
	conversationId: string;
	seenContentLength: number;
	opened?: TurnHistoryEntry;
	sealerFor: () => Promise<ConversationSealer | null>;
}): Promise<StopClampPlan> {
	const { message, conversationId, seenContentLength, opened, sealerFor } = opts;
	if (!message.sealed) {
		const clamped = clampFinishedMessage(message, seenContentLength);
		if (!clamped) return { kind: "none" };
		const next = { ...message, ...clamped };
		const sealer = await sealerFor();
		return { kind: "write", message: sealer ? await sealer.message(next) : next };
	}
	// `chars` is the sealed content's length, so an answer the stop point already covers needs no body.
	if ((message.chars ?? 0) <= seenContentLength) return { kind: "none" };
	if (!opened) return { kind: "needs_body", messageId: message.id, rev: message.sealedRev ?? 0 };
	const plain = hydrateSealedMessage(message, conversationId, opened);
	const clamped = clampFinishedMessage(plain, seenContentLength);
	if (!clamped) return { kind: "none" };
	const sealer = await sealerFor();
	if (!sealer) {
		throw new Error("a sealed answer cannot be clamped here: this deployment cannot seal it again");
	}
	return { kind: "write", message: await sealer.message({ ...plain, ...clamped }) };
}
