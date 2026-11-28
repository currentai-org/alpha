import { describe, expect, it } from 'vitest';
import { locationTabNames, type LocationSummary } from './locationTypes';

const hf = (id: string, label: string, repo: string): LocationSummary => ({
	id,
	kind: 'hf-bucket',
	label,
	detail: `huggingface.co/${repo}`,
	status: 'ok',
	lastError: null,
	grant: 'oauth'
});
const names = (locs: LocationSummary[]) => [...locationTabNames(locs).values()].map((n) => n.name);

describe('locationTabNames (CUR-4441)', () => {
	it('names each bucket by its own name when every bucket is the same account, dropping the shared prefix', () => {
		expect(
			names([
				hf('a', 'me on Hugging Face', 'buckets/me/alpha-files'),
				hf('b', 'me/notes on Hugging Face', 'buckets/me/notes'),
				hf('c', 'me/Notes', 'buckets/me/Notes')
			])
		).toEqual(['alpha-files', 'notes', 'Notes']);
	});

	it('keeps the account when linked buckets span more than one, since then it is what tells them apart', () => {
		expect(
			names([hf('a', 'me/data on Hugging Face', 'buckets/me/data'), hf('b', 'team/data', 'buckets/team/data')])
		).toEqual(['me/data', 'team/data']);
	});

	it('shows a linked folder after its bucket', () => {
		expect(names([hf('a', 'me/data', 'buckets/me/data/2026/raw')])).toEqual(['data/2026/raw']);
	});

	it('leaves a label the person typed as they typed it, and falls back to full labels when two still read the same', () => {
		expect(names([hf('a', 'Thesis drafts', 'buckets/me/x'), hf('b', 'me/x on Hugging Face', 'buckets/me/x/y')])).toEqual([
			'Thesis drafts',
			'x/y'
		]);
		expect(names([hf('a', 'Same', 'buckets/me/x'), hf('b', 'Same', 'buckets/me/y')])).toEqual(['Same', 'Same']);
	});

	it('puts the full label and the huggingface.co path in the tooltip', () => {
		const [n] = locationTabNames([hf('a', 'me/notes on Hugging Face', 'buckets/me/notes')]).values();
		expect(n.full).toEqual(['me/notes on Hugging Face', 'huggingface.co/buckets/me/notes']);
		expect(n.provider).toBe('huggingface');
	});
});
