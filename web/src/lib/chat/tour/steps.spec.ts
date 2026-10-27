import { describe, expect, it } from 'vitest';
import { placeCard } from './steps';

// steps.ts's spacing, restated: 12px from the window's edges, 14px from the element.
const EDGE = 12;
const GAP = 14;

const viewport = { width: 1280, height: 900 };
const card = { width: 320, height: 200 };

describe('placeCard keeps the tour card next to its element and inside the window', () => {
	it('goes below an element near the top, centred on it', () => {
		const p = placeCard({ top: 10, left: 1100, width: 120, height: 30 }, card, viewport);
		expect(p.side).toBe('below');
		expect(p.top).toBe(10 + 30 + GAP);
		// Centring would push it off the right edge; it is clamped inside instead.
		expect(p.left).toBe(viewport.width - card.width - EDGE);
	});

	it('goes above an element near the bottom (the composer pills)', () => {
		const p = placeCard({ top: 820, left: 500, width: 90, height: 30 }, card, viewport);
		expect(p.side).toBe('above');
		expect(p.top).toBe(820 - GAP - card.height);
		expect(p.left).toBe(Math.round(500 + 45 - card.width / 2));
	});

	it('never starts left of the window edge on a phone', () => {
		const p = placeCard({ top: 400, left: 2, width: 40, height: 30 }, { width: 366, height: 180 }, { width: 390, height: 844 });
		expect(p.left).toBe(EDGE);
	});

	it('sits over the page against the bottom edge when neither side has room', () => {
		const p = placeCard({ top: 300, left: 100, width: 200, height: 300 }, { width: 320, height: 400 }, { width: 800, height: 700 });
		expect(p.side).toBe('over');
		expect(p.top).toBe(700 - 400 - EDGE);
	});
});
