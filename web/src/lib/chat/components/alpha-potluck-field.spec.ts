import { describe, expect, it } from 'vitest';
import { heapHeights, pickHeapSite, wave } from './alpha-potluck-field';

/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
	let s = seed;
	return () => {
		s = (s * 16807) % 2147483647;
		return (s - 1) / 2147483646;
	};
}

describe('heapHeights', () => {
	it('builds a hill: every column at least one piece, none above the peak, tallest in the middle', () => {
		for (let seed = 1; seed < 40; seed++) {
			const heights = heapHeights(5, 4, seeded(seed));
			expect(heights).toHaveLength(5);
			for (const h of heights) expect(h).toBeGreaterThanOrEqual(1);
			for (const h of heights) expect(h).toBeLessThanOrEqual(4);
			expect(heights[2]).toBeGreaterThanOrEqual(Math.max(heights[0], heights[4]));
		}
	});
});

describe('pickHeapSite', () => {
	const width = 1200;
	const height = 800;
	const size = { w: 100, h: 80 };
	const greeting = { left: 300, top: 260, right: 900, bottom: 560 };

	it('never places a heap over the excluded greeting', () => {
		for (let seed = 1; seed < 200; seed++) {
			const site = pickHeapSite({
				width,
				height,
				size,
				blocked: [greeting],
				t: seed * 997,
				rand: seeded(seed)
			});
			if (!site) continue;
			const clear =
				site.left + size.w <= greeting.left ||
				site.left >= greeting.right ||
				site.top + size.h <= greeting.top ||
				site.top >= greeting.bottom;
			expect(clear).toBe(true);
		}
	});

	it('keeps heaps inside the visible part of the radial mask, out of the faded corners', () => {
		for (let seed = 1; seed < 200; seed++) {
			const site = pickHeapSite({ width, height, size, blocked: [], t: 0, rand: seeded(seed) });
			if (!site) continue;
			const cx = site.left + size.w / 2;
			const cy = site.top + size.h / 2;
			expect(Math.hypot((cx - 600) / 900, (cy - 360) / 560)).toBeLessThanOrEqual(0.62);
		}
	});

	it('returns null (no heap) when everything is blocked, rather than overlapping', () => {
		const everything = { left: 0, top: 0, right: width, bottom: height };
		expect(
			pickHeapSite({ width, height, size, blocked: [everything], t: 0, rand: seeded(3) })
		).toBeNull();
	});

	it('prefers the brightest point of the drift among the candidates', () => {
		const t = 12_000;
		const site = pickHeapSite({ width, height, size, blocked: [], t, rand: seeded(7), tries: 200 });
		expect(site).not.toBeNull();
		const score = wave(site!.left + size.w / 2, site!.top + size.h / 2, t);
		// A random point in the field averages ~0.5; the pick should sit near a crest.
		expect(score).toBeGreaterThan(0.75);
	});
});
