/** Top and bottom edges, in the same coordinates (viewport pixels from getBoundingClientRect). */
export interface Edges {
	top: number;
	bottom: number;
}

/** Rounding room: a start this far above the thread's top still counts as in view. */
const START_SLACK_PX = 1;

/**
 * How far the thread scrolls so an answer's footer stays readable above the X-ray panel as it opens
 * (CUR-3951). The panel takes height from the thread, which would slide the footer, the line X-ray is
 * there to be checked against, under the panel's top edge. `clearance` keeps the footer out of the
 * thread's bottom fade. Never scrolls up: an answer already above that line stays where it is. Never
 * scrolls an answer's start out of view either, when it is in view: on a short window the answer's text
 * outranks its footer (CUR-3934).
 */
export function answerFooterDelta(view: Edges, answer: Edges, clearance: number): number {
	const toFooter = answer.bottom - (view.bottom - clearance);
	const toStart = answer.top - view.top;
	// An answer that fits above the line shows whole: the chat's own scrolling can leave its start just
	// above the thread's top as the thread shrinks, so it scrolls back up to it.
	if (answer.bottom - answer.top <= view.bottom - clearance - view.top)
		return toStart < 0 ? toStart : Math.max(0, toFooter);
	// The cap only guards a start that is still in view: a long answer read from its end has none to keep.
	// A start scrolled exactly to the thread's top is still in view, within a pixel of rounding.
	if (toStart < -START_SLACK_PX) return Math.max(0, toFooter);
	return Math.max(0, Math.min(toFooter, Math.max(0, toStart)));
}

/**
 * How many pixels the panel's body gives back so an answer's start and its footer both fit above the
 * panel (CUR-3951). `answerFooterDelta` stops at the answer's start on a short window, which would
 * leave the footer under the panel's edge with only the answer's first line above it. Shrinking the
 * body by the shortfall hands that height back to the thread. Never below `minBody`, so the panel stays
 * usable, and nothing when the answer's start has already scrolled away (a long answer read from its
 * end only needs its footer).
 */
export function panelBodyShrink(
	view: Edges,
	answer: Edges,
	clearance: number,
	body: number,
	minBody: number
): number {
	const toFooter = answer.bottom - (view.bottom - clearance);
	const toStart = answer.top - view.top;
	// A start scrolled above the thread comes back once the answer fits (answerFooterDelta), so the body
	// gives back what the whole answer is short of, unless it can't give enough for it to fit at all.
	if (toStart < -START_SLACK_PX) {
		const need = answer.bottom - answer.top - (view.bottom - clearance - view.top);
		return need > 0 && need <= body - minBody ? need : 0;
	}
	const short = toFooter - Math.max(0, toStart);
	if (short <= 0) return 0;
	return Math.max(0, Math.min(short, body - minBody));
}
