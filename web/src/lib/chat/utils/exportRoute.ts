// Which way an account-page download goes. A sealed chat's words open only in the browser,
// and only the export summary says whether the account has any, so no click may take the plain link
// until the summary has said none: a plain-link file would hold sealed chats with their text missing.

/** Where the summary request stands, and what it counted once it answered. */
export type ExportSummaryState =
	| { status: "loading" }
	| { status: "failed" }
	| { status: "loaded"; sealed: number };

/**
 * - `plain`: nothing is sealed, so the link downloads the server's file as it always has.
 * - `browser`: something is sealed, so the browser builds the file (sealedExport.ts).
 * - `wait`: the summary has not answered; hold the click until it does, then ask again.
 * - `refuse`: the summary failed, so whether anything is sealed is unknown; say so, download nothing.
 */
export function exportRoute(state: ExportSummaryState): "plain" | "browser" | "wait" | "refuse" {
	if (state.status === "loading") return "wait";
	if (state.status === "failed") return "refuse";
	return state.sealed > 0 ? "browser" : "plain";
}

/** Read the summary's answer: anything but a whole, non-negative `sealed` count is a failure. */
export function summaryState(body: unknown): ExportSummaryState {
	const sealed = (body as { sealed?: unknown } | null)?.sealed;
	return typeof sealed === "number" && Number.isSafeInteger(sealed) && sealed >= 0
		? { status: "loaded", sealed }
		: { status: "failed" };
}
