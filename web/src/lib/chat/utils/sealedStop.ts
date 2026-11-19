// The browser's half of the stop clamp on a sealed answer (stage 4c).
//
// A stop that lands after the answer finished asks the server to cut the stored answer back to what was
// on screen. A sealed answer is stored without its text, so the server answers `{ sealedClamp }` and
// this tab opens the stored blob and posts its body once; the server checks it against the stored MAC,
// cuts it and seals it again. A tab that cannot open the chat (locked) sends nothing, and the answer
// stays whole: nothing is ever posted that the stored blob did not hold.

type OpenedEntry = { id: string; rev: number; body: Record<string, unknown>; salt?: string };

/** What became of a sealed stop clamp. */
export type SealedStopOutcome = "not_sealed" | "sent" | "locked" | "refused";

/**
 * Finish a stop whose first response asked for the stopped answer's opened body.
 *
 * @param first the stop request's response, read here only when it is JSON.
 * @param reopen opens the conversation as stored now and returns each sealed message's body
 *   (`reopenForTurn` in sealedHistory.ts).
 * @param post sends the stop request again with `opened`.
 */
export async function finishSealedStop(opts: {
	first: Response;
	stopPoint: { generationId: string; seenContentLength: number };
	reopen: () => Promise<{ history?: OpenedEntry[] }>;
	post: (body: unknown) => Promise<Response>;
}): Promise<SealedStopOutcome> {
	const { first, stopPoint, reopen, post } = opts;
	if (!first.headers.get("content-type")?.includes("application/json")) return "not_sealed";
	const answer = (await first.json().catch(() => null)) as {
		sealedClamp?: { messageId?: unknown; rev?: unknown };
	} | null;
	const ask = answer?.sealedClamp;
	if (!ask || typeof ask.messageId !== "string" || typeof ask.rev !== "number") return "not_sealed";
	const { history } = await reopen();
	const opened = history?.find((h) => h.id === ask.messageId && h.rev === ask.rev);
	if (!opened) return "locked";
	const res = await post({ ...stopPoint, opened });
	return res.ok ? "sent" : "refused";
}
