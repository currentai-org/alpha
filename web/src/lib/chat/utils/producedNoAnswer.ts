// Did a FINISHED assistant turn leave the user with anything at all?
//
// Pure leaf so it can be unit-tested without rendering ChatMessage.svelte and its dependency tree —
// same posture as stripThink.ts. The component owns the `loading` / status / message.from gating and
// calls this only for the block content itself.
//
// THE FAILURE THIS GUARDS AGAINST (CUR-113): a thinking model opens `<think>`, reasons, never closes the
// tag and never writes an answer. The whole output is reasoning, so every visible block is empty and the
// turn would render as a finished message with a blank body: no error, no notice, nothing to retry.
//
// Deliberately CAUSE-AGNOSTIC: it asks whether anything renderable survived, not whether a think tag
// went unclosed. That covers an all-whitespace answer, a stream that died before its first visible
// token, and whatever the next model does that we have not seen. Reasoning is NOT an answer, which is
// why think blocks are not consulted — a turn that only thought produced nothing for the user.

/** The subset of ChatMessage's Block union this predicate needs. Structural on purpose: the component's
 *  own union carries render details (opIndex, closed) that have no bearing on "is there an answer". */
export type AnswerBlock = { type: "text"; content: string } | { type: string };

export function producedNoAnswer(blocks: AnswerBlock[], fileCount = 0): boolean {
	// A file IS a deliverable even with no prose around it (an image-only reply).
	if (fileCount > 0) return false;
	return !blocks.some(
		(b) =>
			// Whitespace is not an answer: a model that emitted "\n\n" left the user with a blank bubble.
			(b.type === "text" && typeof (b as { content?: string }).content === "string" &&
				(b as { content: string }).content.trim().length > 0) ||
			// An artifact is the answer when it is the whole answer — this is the case that makes gating
			// on contentWithoutThink wrong, since stripArtifacts would empty it.
			b.type === "artifact"
	);
}
