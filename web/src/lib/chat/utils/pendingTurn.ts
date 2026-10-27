/**
 * A turn this tab has sent but the server may not have saved yet (CUR-1893).
 *
 * The server writes the question only once its pre-stream chain has run, which takes seconds on a
 * cold instance. A reload in that gap loads a snapshot with no trace of the turn, so the page needs
 * a record to know to wait for the answer the server goes on to save. The page
 * records the id it minted for the turn's new message (the server adopts it, CUR-2098) before the
 * POST, and a load that finds the record but not the message waits for it.
 *
 * Kept in sessionStorage, so it belongs to this tab and survives the reload that matters. Every
 * access is guarded: storage can throw in a private window or with site data blocked, and then the
 * page simply behaves as if no record existed.
 */

/** How long a recorded turn is worth waiting for. A turn the server never saved by then is lost. */
export const PENDING_TURN_MAX_MS = 120_000;

const key = (conversationId: string) => `pendingTurn:${conversationId}`;

interface PendingTurn {
	messageId: string;
	at: number;
}

export function recordPendingTurn(conversationId: string, messageId: string, now = Date.now()) {
	try {
		sessionStorage.setItem(key(conversationId), JSON.stringify({ messageId, at: now }));
	} catch {
		/* storage unavailable: the reload case goes unhandled, as before */
	}
}

export function clearPendingTurn(conversationId: string) {
	try {
		sessionStorage.removeItem(key(conversationId));
	} catch {
		/* nothing to clear */
	}
}

/**
 * The message id to wait for on load: recorded by this tab, recent enough to still arrive, and not
 * already in the snapshot. Anything else clears the record and returns undefined.
 */
export function pendingTurnToAwait(
	conversationId: string,
	snapshotIds: readonly string[],
	now = Date.now()
): string | undefined {
	let turn: PendingTurn | undefined;
	try {
		const raw = sessionStorage.getItem(key(conversationId));
		turn = raw ? (JSON.parse(raw) as PendingTurn) : undefined;
	} catch {
		turn = undefined;
	}
	if (
		!turn?.messageId ||
		now - turn.at > PENDING_TURN_MAX_MS ||
		snapshotIds.includes(turn.messageId)
	) {
		clearPendingTurn(conversationId);
		return undefined;
	}
	return turn.messageId;
}
