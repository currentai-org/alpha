import { describe, expect, it } from 'vitest';
import { gradedShelf, offersShelf, shelf } from './starterShelf';
import recordJson from './starterRecord.json';
import { suggestions } from './suggestions';
import { STARTER_COUNT } from '$lib/chat/server/chatShellData';

type StarterRecord = Parameters<typeof gradedShelf>[1];
const starterRecord: StarterRecord = recordJson;

const record = (prompts: StarterRecord['prompts']): StarterRecord => ({
	graded_on: '2026-09-29',
	base: 'develop.aipotluck.org',
	model: 'test-model',
	runs: 5,
	pass_at: 4,
	log: 'test.eval',
	prompts
});

describe('gradedShelf (CUR-1003)', () => {
	it('drops a candidate the record never graded, so an added prompt stays off the shelf until it is graded', () => {
		expect(gradedShelf(['graded', 'new'], record({ graded: { correct: 5, runs: 5 } }))).toEqual(['graded']);
	});

	it('drops a candidate graded below the pass bar, so re-grading a failing prompt removes it with no code change', () => {
		const rec = record({ a: { correct: 4, runs: 5 }, b: { correct: 3, runs: 5 } });
		expect(gradedShelf(['a', 'b'], rec)).toEqual(['a']);
	});

	it('returns an empty shelf when the record matches nothing, rather than falling back to the candidates', () => {
		expect(gradedShelf(['a', 'b'], record({}))).toEqual([]);
	});
});

describe('the committed shelf', () => {
	it('offers only prompts the committed record graded at or above its pass bar', () => {
		for (const p of shelf) {
			expect(starterRecord.prompts[p]?.correct ?? -1, p).toBeGreaterThanOrEqual(starterRecord.pass_at);
		}
	});

	it('has enough graded prompts for the empty state to rotate', () => {
		expect(shelf.length).toBeGreaterThan(STARTER_COUNT);
	});

	it('was graded against every current candidate, so a stale record cannot silently shrink the shelf', () => {
		const ungraded = suggestions.filter((p) => !(p in starterRecord.prompts));
		expect(ungraded, 'run `pnpm probe:starters --write-record` to grade these').toEqual([]);
	});
});

describe('offersShelf (CUR-2323)', () => {
	it('offers nothing when the browser ranks another language first, even with English as a fallback', () => {
		expect(offersShelf('fr-FR,fr;q=0.9,en;q=0.8')).toBe(false);
		expect(offersShelf('es-MX')).toBe(false);
	});

	it('offers the shelf when English ranks first, by order or by q-value', () => {
		expect(offersShelf('en-GB,en;q=0.9')).toBe(true);
		expect(offersShelf('fr;q=0.5, en-US;q=0.9')).toBe(true);
	});

	it('offers the shelf when there is no usable header, since the page itself is English', () => {
		expect(offersShelf(null)).toBe(true);
		expect(offersShelf('')).toBe(true);
		expect(offersShelf('*')).toBe(true);
	});
});
