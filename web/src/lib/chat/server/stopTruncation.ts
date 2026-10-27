import type { AbortedGeneration } from "$lib/chat/types/AbortedGeneration";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";

/**
 * Content to persist for a user-stopped generation.
 *
 * The stopping client freezes its UI the moment Stop is clicked and reports
 * the stop point (generation id + rendered character count) on the abort
 * marker. Tokens keep arriving server-side until the marker is observed — or
 * much longer when the stop request itself is delayed or retried — so without
 * this clamp the interrupted message "grows back" past what the user saw on
 * the next sync.
 *
 * The clamp is bounded below by the pre-generation prefix (continue flows
 * append to existing content) and above by what was actually generated.
 * Markers for another generation, legacy stop requests without a stop point,
 * and non-finite lengths leave the content unchanged.
 */
export function clampStoppedContent(opts: {
	content: string;
	initialLength: number;
	generationId: string | undefined;
	marker: Pick<AbortedGeneration, "generationId" | "seenContentLength"> | null;
}): string {
	const { content, initialLength, generationId, marker } = opts;
	const seen = marker?.seenContentLength;
	if (
		generationId === undefined ||
		marker?.generationId !== generationId ||
		typeof seen !== "number" ||
		!Number.isFinite(seen)
	) {
		return content;
	}
	const keepUpTo = Math.max(initialLength, Math.min(content.length, Math.floor(seen)));
	return content.slice(0, keepUpTo);
}

/**
 * The stopped version of a message whose generation had already finished on the server, or null
 * when there is nothing to clamp.
 *
 * Smooth mode paces received text onto the page, so Stop can still be on screen after the server
 * has stored the whole answer (CUR-2306). No abort path runs for a generation that already
 * completed, so the clamp above never applies and the reload brings back text the user never saw.
 * This applies the same stop point after the fact: content and the stored FinalAnswer text both,
 * since the page renders a finished message from the latter (CUR-2300), and marks it interrupted.
 *
 * The prefix a continue flow appended to is recovered from the FinalAnswer: content ends with that
 * answer's text, so everything before it predates the generation.
 */
export function clampFinishedMessage(
	message: Pick<Message, "content" | "updates" | "interrupted">,
	seenContentLength: number
): Pick<Message, "content" | "updates" | "interrupted"> | null {
	const final = message.updates?.findLast((u) => u.type === MessageUpdateType.FinalAnswer);
	const finalText = final && "text" in final ? final.text : undefined;
	const initialLength =
		finalText !== undefined && message.content.endsWith(finalText)
			? message.content.length - finalText.length
			: 0;
	const content = clampStoppedContent({
		content: message.content,
		initialLength,
		generationId: "stop",
		marker: { generationId: "stop", seenContentLength },
	});
	if (content === message.content) return null;
	const text = content.slice(initialLength);
	return {
		content,
		updates: message.updates?.map((u) =>
			u.type === MessageUpdateType.FinalAnswer ? { ...u, text, interrupted: true } : u
		),
		interrupted: true,
	};
}
