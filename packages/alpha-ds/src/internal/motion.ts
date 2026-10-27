import { cubicOut } from 'svelte/easing';
import { slide } from 'svelte/transition';

/**
 * Motion for JS-driven transitions (Svelte's `transition:`), read from the same tokens CSS motion
 * uses. `prefers-reduced-motion` zeroes the duration tokens, so a transition built on these goes
 * quiet like the CSS ones do, with no reduced-motion branch of its own.
 */

const DURATIONS = {
	fast: '--ds-duration-fast',
	base: '--ds-duration-base',
	slow: '--ds-duration-slow'
} as const;

const EASES = { standard: '--ds-ease-standard', exit: '--ds-ease-exit' } as const;

/** A duration token in milliseconds, read where `node` sits. */
function durationToken(node: Element, size: keyof typeof DURATIONS): number {
	const ms = parseFloat(getComputedStyle(node).getPropertyValue(DURATIONS[size]));
	return Number.isFinite(ms) ? ms : 0;
}

/** The easing function for a CSS `cubic-bezier(x1, y1, x2, y2)` curve (x1 and x2 within 0–1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	const at = (p1: number, p2: number, s: number) =>
		3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3;
	return (t) => {
		if (t <= 0) return 0;
		if (t >= 1) return 1;
		// x rises with s, so bisect for the s whose x is t, then read y there.
		let lo = 0;
		let hi = 1;
		let s = t;
		for (let i = 0; i < 24; i++) {
			s = (lo + hi) / 2;
			const x = at(x1, x2, s);
			if (Math.abs(x - t) < 1e-6) break;
			if (x < t) lo = s;
			else hi = s;
		}
		return at(y1, y2, s);
	};
}

/** An easing token as a function, read where `node` sits. */
function easeToken(node: Element, name: keyof typeof EASES): (t: number) => number {
	const raw = getComputedStyle(node).getPropertyValue(EASES[name]);
	const points = /cubic-bezier\(([^)]+)\)/.exec(raw)?.[1].split(',').map(Number);
	return points?.length === 4 && points.every(Number.isFinite)
		? cubicBezier(points[0], points[1], points[2], points[3])
		: cubicOut;
}

/**
 * A `transition:` that eases height and opacity together on the standard curve, so whatever sits
 * below closes up or opens smoothly instead of jumping (a toast leaving its stack, a notice above
 * the composer). `duration` names a token: `base` by default; a composer panel swap uses `slow`.
 */
export function revealSlide(
	node: Element,
	{ duration = 'base' }: { duration?: keyof typeof DURATIONS } = {}
) {
	const grow = slide(node, {
		duration: durationToken(node, duration),
		easing: easeToken(node, 'standard')
	});
	return { ...grow, css: (t: number, u: number) => `${grow.css?.(t, u)}; opacity: ${t};` };
}
