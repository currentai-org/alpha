import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from './fuzzy.ts';

const languages = [
	{ label: 'Basque', keywords: ['euskara', 'eus'] },
	{ label: 'Catalan', keywords: ['català', 'cat'] },
	{ label: 'Chinese (Mandarin)', keywords: ['中文', 'cmn'] },
	{ label: 'Tagalog', keywords: ['tgl'] },
	{ label: 'Yoruba', keywords: ['yorùbá', 'yor'] }
];
const labels = (query: string) => fuzzyFilter(languages, query).map((l) => l.label);

describe('fuzzyFilter', () => {
	it('keeps every item in its original order for an empty query', () => {
		expect(labels('  ')).toEqual(languages.map((l) => l.label));
	});

	it('ranks a label that starts with the query above one that only has its letters in order', () => {
		expect(labels('ca')).toEqual(['Catalan', 'Chinese (Mandarin)']);
	});

	it('ranks a label that starts with the query above one that contains it', () => {
		expect(labels('ta')).toEqual(['Tagalog', 'Catalan']);
	});

	it('finds letters typed in order with some missing, and drops items that lack them', () => {
		expect(labels('ctln')).toEqual(['Catalan']);
	});

	it('ignores case and accents, and matches keywords such as an endonym or code', () => {
		expect(labels('CATALA')).toEqual(['Catalan']);
		expect(labels('euskara')).toEqual(['Basque']);
		expect(labels('yoruba')).toEqual(['Yoruba']);
		expect(labels('cmn')).toEqual(['Chinese (Mandarin)']);
	});

	it('matches the start of a later word in the label', () => {
		expect(labels('mand')).toEqual(['Chinese (Mandarin)']);
	});

	it('returns nothing when no item has the letters, rather than everything', () => {
		expect(labels('zzz')).toEqual([]);
	});
});
