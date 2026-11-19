// What this tab has opened of sealed conversations, kept for the next turn (stage 4 of
//). No dependency on age, so the conversation page can build a turn's post without loading the
// cipher; sealedHistory.ts fills it as it opens blobs.
//
// The server cannot open what it sealed, so a turn posts back each sealed message's body and the
// sealed preprompt, and the server checks each against the MAC it stored with it. That is why the exact
// body the blob held is kept here, never the view built from it. A later open of the same message
// replaces its entry, so a reload after a reseal posts the new revision. Each entry keeps its envelope's
// MAC salt too, which the server's MAC covers and only the blob holds.
//
// `forgetOpened` empties all of it, and the keyring calls it whenever it lets go of an identity (sign-out,
// account switch), so nothing opened under one account outlives it in the tab.

type OpenedBody = { rev: number; body: Record<string, unknown>; salt?: string };
type OpenedText = { rev: number; text: string; salt?: string };

const opened = new Map<string, Map<string, OpenedBody>>();
const openedPreprompts = new Map<string, OpenedText>();

/** Keep one opened message body at the revision it opened at, with its envelope's salt. */
export function rememberBody(
	conversationId: string,
	messageId: string,
	rev: number,
	body: Record<string, unknown>,
	salt?: string
): void {
	let bodies = opened.get(conversationId);
	if (!bodies) opened.set(conversationId, (bodies = new Map()));
	bodies.set(messageId, salt === undefined ? { rev, body } : { rev, body, salt });
}

/** Keep an opened preprompt at its revision, with its envelope's salt. */
export function rememberPreprompt(conversationId: string, rev: number, text: string, salt?: string): void {
	openedPreprompts.set(conversationId, salt === undefined ? { rev, text } : { rev, text, salt });
}

/** Slots this tab wrote itself and the server sealed: `conversationId|messageId|rev`, with
 *  the preprompt's message id empty. Only these show without a key; a body opened with a key does not
 *  outlive the key that opened it. */
const sentHere = new Set<string>();
const slotKey = (conversationId: string, messageId: string, rev: number) => `${conversationId}|${messageId}|${rev}`;

/** Keep what this tab sent and the create route sealed, so its first turn posts it back without a key. */
export function rememberSent(
	conversationId: string,
	preprompt: OpenedText,
	history: ({ id: string } & OpenedBody)[]
): void {
	rememberPreprompt(conversationId, preprompt.rev, preprompt.text, preprompt.salt);
	sentHere.add(slotKey(conversationId, '', preprompt.rev));
	for (const h of history) {
		rememberBody(conversationId, h.id, h.rev, h.body, h.salt);
		sentHere.add(slotKey(conversationId, h.id, h.rev));
	}
}

/** Drop every opened body, preprompt and sent slot this tab holds. */
export function forgetOpened(): void {
	opened.clear();
	openedPreprompts.clear();
	sentHere.clear();
}

/** The body this tab sent itself for a message at `rev`, if it did. */
export function sentBody(conversationId: string, messageId: string, rev: number | undefined): Record<string, unknown> | undefined {
	if (rev === undefined || !sentHere.has(slotKey(conversationId, messageId, rev))) return undefined;
	const b = opened.get(conversationId)?.get(messageId);
	return b && b.rev === rev ? b.body : undefined;
}

/** The preprompt this tab sent itself at `rev`, with its salt, if it did. */
export function sentPreprompt(conversationId: string, rev: number | undefined): OpenedText | undefined {
	if (rev === undefined || !sentHere.has(slotKey(conversationId, '', rev))) return undefined;
	const p = openedPreprompts.get(conversationId);
	return p && p.rev === rev ? p : undefined;
}

/**
 * What a turn in this conversation posts so the server can read its sealed parts: the opened body of
 * each message in `messageIds` this tab has opened, and the opened preprompt. Empty for a conversation
 * this tab has opened nothing of, which is every conversation with nothing sealed.
 */
export function sealedHistoryForTurn(
	conversationId: string,
	messageIds: Iterable<string>
): { history?: ({ id: string } & OpenedBody)[]; sealedPreprompt?: OpenedText } {
	const bodies = opened.get(conversationId);
	const history: ({ id: string } & OpenedBody)[] = [];
	if (bodies) {
		for (const id of messageIds) {
			const b = bodies.get(id);
			if (b) history.push({ id, ...b });
		}
	}
	const preprompt = openedPreprompts.get(conversationId);
	return { ...(history.length ? { history } : {}), ...(preprompt ? { sealedPreprompt: preprompt } : {}) };
}
