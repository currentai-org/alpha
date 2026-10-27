import { describe, expect, it } from 'vitest';
import {
	hasMarker,
	interpolate,
	mark,
	placeholders,
	segmentAt,
	segments,
	stripMarkers
} from './markers';

describe('copy edit markers', () => {
	it('round-trips a key index through an invisible tag, for small and large indexes', () => {
		for (const index of [0, 1, 3, 4, 17, 1117, 65_535]) {
			const tagged = mark(index, 'Save');
			expect(stripMarkers(tagged)).toBe('Save');
			expect(segments(tagged)).toEqual([
				expect.objectContaining({
					index,
					contentStart: tagged.indexOf('Save'),
					contentEnd: tagged.indexOf('Save') + 4
				})
			]);
		}
	});

	it('finds the innermost message at an offset when one is passed into another', () => {
		const inner = mark(7, 'Mozilla');
		const outer = mark(2, `Join the ${inner} community`);
		expect(segmentAt(outer, outer.indexOf('Join'))?.index).toBe(2);
		expect(segmentAt(outer, outer.indexOf('Mozilla') + 2)?.index).toBe(7);
		expect(segmentAt(outer, outer.indexOf('community'))?.index).toBe(2);
	});

	it('finds nothing in untagged text, and skips a tag cut off mid-way', () => {
		expect(hasMarker('Plain text')).toBe(false);
		expect(segments('Plain text')).toEqual([]);
		const cut = mark(5, 'Half').slice(0, -1);
		expect(segments(cut)).toEqual([]);
	});

	it('fills known placeholders and leaves unknown ones as written', () => {
		expect(interpolate('Signed in as {email}', { email: 'a@b.org' })).toBe('Signed in as a@b.org');
		expect(interpolate('{count} of {max}', { count: 3 })).toBe('3 of {max}');
		expect(placeholders('{b} and {a} and {b}')).toEqual(['a', 'b']);
	});
});
