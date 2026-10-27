import { describe, expect, it } from 'vitest';
import { mergeRouterMetadata, servingRecorded } from './routerMetadata';

const MISTRAL = 'https://api.mistral.ai/v1';

describe('mergeRouterMetadata', () => {
	// The live page must keep backend when merging, so the badge shows "compute:".
	it('keeps the backend a frame carries, which is what the badge names as compute', () => {
		const merged = mergeRouterMetadata(undefined, {
			route: '',
			model: 'mistral-large-2512',
			backend: MISTRAL
		});
		expect(merged.backend).toBe(MISTRAL);
	});

	it('a later frame without a backend does not erase the one an earlier frame set', () => {
		const first = mergeRouterMetadata(undefined, { route: '', model: 'm', backend: MISTRAL });
		const later = mergeRouterMetadata(first, { route: '', model: '', provider: 'mistral' as never });
		expect(later).toMatchObject({ model: 'm', backend: MISTRAL, provider: 'mistral' });
	});

	// The staging router and La Plateforme both report api.mistral.ai; the lane is what differs. (CUR-3193)
	it('keeps the lane a frame carries, and a later frame without one does not erase it', () => {
		const first = mergeRouterMetadata(undefined, {
			route: '',
			model: 'm',
			backend: MISTRAL,
			lane: 'router.example.test'
		});
		const later = mergeRouterMetadata(first, { route: '', model: '', provider: 'mistral' as never });
		expect(later).toMatchObject({ backend: MISTRAL, lane: 'router.example.test' });
	});

	it('adds no lane key when no frame carried one, so older records read the same', () => {
		expect(mergeRouterMetadata(undefined, { route: '', model: 'm' })).not.toHaveProperty('lane');
	});

	it('keeps an empty verifyMethod, a real "checked, unverified" signal, rather than dropping it', () => {
		const merged = mergeRouterMetadata(
			{ route: '', model: 'm', verifyMethod: 'judge' },
			{ route: '', model: '', verifyMethod: '' }
		);
		expect(merged.verifyMethod).toBe('');
	});

	it('leaves verifyMethod alone when the frame says nothing about it', () => {
		const merged = mergeRouterMetadata(
			{ route: '', model: 'm', verifyMethod: 'judge' },
			{ route: '', model: '' }
		);
		expect(merged.verifyMethod).toBe('judge');
	});

	// Helper models arrive in their own frame, with no model of their own. (CUR-984)
	it('keeps the helper models a frame carries, and a later model frame does not erase them', () => {
		const helper = { role: 'math-route' as const, model: 'mistral-small-2603', backend: 'api.mistral.ai' };
		const first = mergeRouterMetadata(undefined, { route: '', model: '', assistedBy: [helper] });
		const later = mergeRouterMetadata(first, { route: '', model: 'mistral-large-2512' });
		expect(later).toMatchObject({ model: 'mistral-large-2512', assistedBy: [helper] });
	});

	it('a second entry for the same role replaces the first rather than listing the role twice', () => {
		const a = { role: 'search-decision' as const, model: 'a' };
		const b = { role: 'search-decision' as const, model: 'b' };
		const merged = mergeRouterMetadata(
			mergeRouterMetadata(undefined, { route: '', model: 'm', assistedBy: [a] }),
			{ route: '', model: '', assistedBy: [b] }
		);
		expect(merged.assistedBy).toEqual([b]);
	});

	it('adds no assistedBy key at all when no helper ran', () => {
		expect(mergeRouterMetadata(undefined, { route: '', model: 'm' })).not.toHaveProperty('assistedBy');
	});
});

describe('servingRecorded', () => {
	// The helper frame lands before any answer. On a turn that then produced nothing, its
	// record alone would put a footer and a Copy button under the error.
	it('is false for a record holding only the helpers that ran, so an errored turn gets no footer', () => {
		const rm = mergeRouterMetadata(undefined, {
			route: '',
			model: '',
			assistedBy: [{ role: 'search-decision', model: 'e' }]
		});
		expect(servingRecorded(rm)).toBe(false);
	});

	it('is true once any serving field is set', () => {
		expect(servingRecorded({ route: '', model: 'm' })).toBe(true);
		expect(servingRecorded({ route: '', model: '', backend: 'https://api.mistral.ai/v1' })).toBe(true);
		expect(servingRecorded({ route: '', model: '', verifyMethod: '' })).toBe(true);
	});

	it('is false with no record at all', () => {
		expect(servingRecorded(undefined)).toBe(false);
	});
});
