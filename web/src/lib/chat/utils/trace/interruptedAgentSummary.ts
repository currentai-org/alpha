// emitInterruptedFinalAnswer (conversation/[id]/+server.ts) builds finalAnswer from the raw
// streamed message.content, which is empty whenever a stall lands mid tool-use — the model's own answer
// text never started. agentConfirmations is the one durable per-call record that survives that stall
// under ACP_PERMISSION_POLICY=confirm (CUR-218): each entry's `title` is agent-service's own redacted
// description of the call (never raw tool input/output — see MessageAgentConfirmUpdate), and `decision`
// records whether it actually ran before the turn was cut. Turning the allowed entries into a sentence is
// the honest "here's what finished" text the user would otherwise never see (say 3 of 4 files written
// and finalAnswer left "", CUR-1091).
//
// Confirm-gated calls only — a turn with no open confirmations (ACP_PERMISSION_POLICY=allow, or a stall
// before the first confirm resolved) has no persisted per-call record to summarize (MessageAgentStepUpdate
// is animation-only, never persisted) and this returns undefined rather than claim nothing happened.
export function summarizeInterruptedAgentWork(
	confirmations: { title: string; decision?: "allow" | "deny" | "canceled" }[] | undefined
): string | undefined {
	const completed = (confirmations ?? [])
		.filter((c) => c.decision === "allow")
		.map((c) => c.title)
		.filter(Boolean);
	if (completed.length === 0) return undefined;
	// Quoted as labels, not woven into a clause: `title` is agent-service's own confirm-prompt copy
	// ("Approve edit: a.py") — an ask, grammatically, not a completed-action sentence. A clause like
	// "Completed first: Approve edit: a.py" (CUR-1091) reads as a backwards to-do list. Quoting sidesteps title's tense entirely instead of assuming a shape
	// (e.g. an "Approve " prefix) that's agent-service's to change, not this file's to parse.
	const quoted = completed.map((title) => `"${title}"`).join(", ");
	return `Interrupted before finishing. Steps confirmed before the stall: ${quoted}.`;
}
