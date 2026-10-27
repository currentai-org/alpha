const VISIBLE_THRESHOLD = 0.4;
const DURATION_MS = 1200;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts every `.count-up` figure inside `node` from 0 to its `--count-to`, once 40% of `node` is
 * in view: 1.2s, ease-out cubic, as in the roadmap HTML demo. Each frame sets `--count` inline,
 * which the figure prints with a CSS counter (`.count-up` in app.css); the last frame leaves the
 * final value set. The frames are driven from here rather than by a CSS animation of `--count`,
 * because Safari doesn't repaint a counter from an animated custom property and jumps from 0 to
 * the final value.
 */
export function countUp(node: HTMLElement) {
	let frame = 0;

	const start = () => {
		// Reduced motion: app.css already shows the final value, so there is nothing to run.
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const figures = [...node.querySelectorAll<HTMLElement>('.count-up')];
		const targets = figures.map((figure) =>
			Number(getComputedStyle(figure).getPropertyValue('--count-to'))
		);
		// Timed from the first frame's own timestamp. A frame's `now` is when that frame began, which can
		// precede a performance.now() read in the observer callback, and a negative progress eases to a
		// negative count: the figure printed -1 before counting up.
		let startedAt: number | undefined;
		const tick = (now: number) => {
			startedAt ??= now;
			const progress = Math.min((now - startedAt) / DURATION_MS, 1);
			const eased = easeOutCubic(progress);
			figures.forEach((figure, i) => {
				figure.style.setProperty('--count', String(Math.round(targets[i] * eased)));
			});
			if (progress < 1) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
	};

	if (typeof IntersectionObserver === 'undefined') {
		start();
		return { destroy: () => cancelAnimationFrame(frame) };
	}

	const observer = new IntersectionObserver(
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				start();
				observer.disconnect();
			}
		},
		{ threshold: VISIBLE_THRESHOLD }
	);
	observer.observe(node);

	return {
		destroy() {
			observer.disconnect();
			cancelAnimationFrame(frame);
		}
	};
}
