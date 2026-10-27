// Content that jumps under a visitor's eye, measured by the browser's Layout Instability API
// rather than judged from sampled frames. helpers/test.ts subscribes every page, journeyArtifacts.ts
// writes the shifts into meta.json, and critique-journey.mjs copies them into its --json. They never
// reach a grader prompt or the ticket filer.

/** The page calls this binding once per shift. */
export const LAYOUT_SHIFT_BINDING = '__e2eLayoutShift';

/** The test attaches its shifts under this name; journeyArtifacts.ts reads the same literal. */
export const LAYOUT_SHIFTS_ATTACHMENT = 'layout-shifts';

/** Most shifts kept per test. A page that keeps jumping is the finding by then. */
export const MAX_LAYOUT_SHIFTS = 200;

/** One shift as the page reports it: `at` is epoch ms, so the reporter can place it in the video. */
export type LayoutShift = {
	at: number;
	value: number;
	path: string;
	sources: { node: string | null; from: number[] | null; to: number[] | null }[];
};

/** The init script each page runs. Chromium alone reports `layout-shift`; elsewhere it does nothing.
 *  A shift within 500 ms of a click or key press is the page answering the person and is dropped,
 *  as Cumulative Layout Shift drops it. Below 0.001 a shift is sub-pixel settling nobody sees. */
export function layoutShiftScript(): string {
	return `(() => {
	if (typeof PerformanceObserver === 'undefined') return;
	if (!(PerformanceObserver.supportedEntryTypes || []).includes('layout-shift')) return;
	// Tag, id and test id only. Text and labels would copy what the page showed (test emails, codes,
	// chat content) into CI artifacts.
	const describe = (n) => {
		if (!n) return null;
		if (n.nodeType !== 1) return n.nodeName;
		let s = n.tagName.toLowerCase();
		if (n.id) s += '#' + n.id.slice(0, 40);
		const testId = n.getAttribute('data-testid');
		return testId ? s + '[' + testId.slice(0, 40) + ']' : s;
	};
	const rect = (r) => (r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null);
	new PerformanceObserver((list) => {
		const send = window[${JSON.stringify(LAYOUT_SHIFT_BINDING)}];
		if (typeof send !== 'function') return;
		for (const e of list.getEntries()) {
			if (e.hadRecentInput || e.value < 0.001) continue;
			const shift = {
				at: performance.timeOrigin + e.startTime,
				value: e.value,
				path: location.pathname,
				sources: (e.sources || []).slice(0, 3).map((s) => ({ node: describe(s.node), from: rect(s.previousRect), to: rect(s.currentRect) }))
			};
			Promise.resolve(send(shift)).catch(() => {});
		}
	}).observe({ type: 'layout-shift', buffered: true });
})();`;
}
