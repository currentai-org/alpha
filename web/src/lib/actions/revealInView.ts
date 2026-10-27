const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * Sets `data-revealed` on `node` once it is `share` in view, then stops watching; CSS keys its
 * reveal animation off that attribute. "In view" is `share` of the node, or `share` of the
 * viewport's height when the node is taller than the viewport can show at that share (a long
 * mobile list would otherwise never qualify).
 */
export function revealInView(node: HTMLElement, share = 0.5) {
	const reveal = () => node.setAttribute('data-revealed', '');

	if (typeof IntersectionObserver === 'undefined') {
		reveal();
		return;
	}

	const observer = new IntersectionObserver(
		(entries) => {
			const visible = entries.some(
				(entry) =>
					entry.isIntersecting &&
					(entry.intersectionRatio >= share ||
						entry.intersectionRect.height >= window.innerHeight * share)
			);
			if (visible) {
				reveal();
				observer.disconnect();
			}
		},
		{ threshold: STEPS }
	);
	observer.observe(node);

	return {
		destroy() {
			observer.disconnect();
		}
	};
}
