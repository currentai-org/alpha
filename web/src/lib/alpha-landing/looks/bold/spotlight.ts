import { on } from 'svelte/events';

/**
 * Moves a `.pat-field`'s bright spot (`--mx` / `--my`) toward the pointer while it is over the
 * element, and lets it drift back to its resting place when the pointer leaves.
 */
export function spotlight(node: HTMLElement) {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	let frame = 0;

	const offMove = on(node, 'pointermove', (event: PointerEvent) => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			const rect = node.getBoundingClientRect();
			node.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
			node.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
		});
	});
	const offLeave = on(node, 'pointerleave', () => {
		cancelAnimationFrame(frame);
		node.style.removeProperty('--mx');
		node.style.removeProperty('--my');
	});

	return {
		destroy() {
			cancelAnimationFrame(frame);
			offMove();
			offLeave();
		}
	};
}
