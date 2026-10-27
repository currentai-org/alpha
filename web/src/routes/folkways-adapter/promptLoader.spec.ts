import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the DB collection so getTuning() (via tuning.ts) hits an in-memory stub, same pattern as
// $lib/chat/server/tuning.spec.ts. bustTuningCache() between tests forces a fresh read past
// tuning.ts's own ~20s in-process TTL cache.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findOneMock = vi.fn(async (_filter: unknown): Promise<any> => null);
vi.mock('$lib/chat/server/database', () => ({
	collections: {
		config: {
			findOne: (filter: unknown) => findOneMock(filter)
		}
	}
}));

// Mock the model registry rather than boot it — models.ts pulls in the full live-catalog
// machinery (agent routing, endpoint failover, remote snapshot fetch...), none of which this
// loader needs. It only reads `defaultModel.id` / `.name` / `.preprompt` and `models[].id`.
vi.mock('$lib/chat/server/models', () => ({
	defaultModel: {
		id: 'swiss-ai/apertus-v1.5-70b',
		name: 'Apertus',
		preprompt: 'You may use tools when helpful.'
	},
	models: [{ id: 'swiss-ai/apertus-v1.5-70b' }, { id: 'swiss-ai/apertus-v1.5-8b' }]
}));

import { bustTuningCache } from '$lib/chat/server/tuning';
import { models } from '$lib/chat/server/models';
import {
	loadStablePromptSegments,
	stablePromptHash,
	resolveModelAllowlist,
	resolveModelParameters,
	PROMPT_SEGMENT_IDS,
	type PromptReportSegment
} from './promptLoader';

function byId(segments: PromptReportSegment[], id: string) {
	const s = segments.find((seg) => seg.id === id);
	if (!s) throw new Error(`no segment ${id}`);
	return s;
}

describe('folkways-adapter promptLoader (tuning row empty -> code defaults)', () => {
	beforeEach(() => {
		findOneMock.mockReset();
		findOneMock.mockResolvedValue(null);
		bustTuningCache();
	});

	it('returns exactly the seven segments, in the contract order, all sourced from code', async () => {
		const segments = await loadStablePromptSegments();
		expect(segments.map((s) => s.id)).toEqual([...PROMPT_SEGMENT_IDS]);
		for (const s of segments) {
			expect(s.active_source).toBe('code');
			expect(s.override).toBeNull();
			expect(s.override_editor).toBeUndefined();
			expect(s.override_edited_at).toBeUndefined();
			expect(typeof s.code_default).toBe('string');
			expect(s.code_default.length).toBeGreaterThan(0);
		}
	});

	it('persona code default names the served default model', async () => {
		const segments = await loadStablePromptSegments();
		expect(byId(segments, 'persona').code_default).toContain('Apertus');
	});

	it('grounding code default is the raw template, {asOf}/{evidence} left unfilled', async () => {
		const segments = await loadStablePromptSegments();
		const grounding = byId(segments, 'grounding').code_default;
		expect(grounding).toContain('{asOf}');
		expect(grounding).toContain('{evidence}');
	});

	it('model-preprompt reads defaultModel.preprompt and never carries a tuning override', async () => {
		const segments = await loadStablePromptSegments();
		const seg = byId(segments, 'model-preprompt');
		expect(seg.code_default).toBe('You may use tools when helpful.');
		expect(seg.override).toBeNull();
		expect(seg.active_source).toBe('code');
	});

	it('decoding code default is the JSON of GROUNDED_DECODING', async () => {
		const segments = await loadStablePromptSegments();
		const decoding = JSON.parse(byId(segments, 'decoding').code_default);
		expect(decoding).toMatchObject({ temperature: 0.1, max_tokens: 1024 });
	});
});

describe('folkways-adapter promptLoader (tuning row set -> database overrides)', () => {
	const row = {
		persona: 'You are {model}, a custom persona.',
		grounding: 'Custom grounding template with {evidence} and {asOf}.',
		panelistPrompt: 'Custom panelist instructions.',
		aggregatorPrompt: 'Custom aggregator instructions.',
		searchClassifierPrompt: 'Custom classifier instructions.',
		decoding: { temperature: 0.5 },
		editedBy: 'editor',
		editedAt: '2026-09-10T00:00:00.000Z'
	};

	beforeEach(() => {
		findOneMock.mockReset();
		findOneMock.mockResolvedValue(row);
		bustTuningCache();
	});

	it('every overridable segment reports active_source database, the editor, and the time', async () => {
		const segments = await loadStablePromptSegments();
		for (const id of [
			'persona',
			'grounding',
			'panelist',
			'aggregator',
			'search-classifier',
			'decoding'
		]) {
			const s = byId(segments, id);
			expect(s.active_source).toBe('database');
			expect(s.override).not.toBeNull();
			expect(s.override_editor).toBe('editor');
			expect(s.override_edited_at).toBe('2026-09-10T00:00:00.000Z');
			// The code default is still reported alongside the override.
			expect(s.code_default.length).toBeGreaterThan(0);
		}
	});

	it('model-preprompt has no tuning key, so it stays code-sourced even with a tuning row set', async () => {
		const segments = await loadStablePromptSegments();
		const seg = byId(segments, 'model-preprompt');
		expect(seg.active_source).toBe('code');
		expect(seg.override).toBeNull();
	});

	it('persona override is rendered through buildPersonaPrompt, not the raw tuning text', async () => {
		const segments = await loadStablePromptSegments();
		const persona = byId(segments, 'persona');
		// The raw override contains the {model} token; the rendered override must not (it's filled).
		expect(persona.override).not.toContain('{model}');
		expect(persona.override).toContain('Apertus');
	});

	it('decoding override is the MERGED result (override keys win, code defaults fill the rest)', async () => {
		const segments = await loadStablePromptSegments();
		const decoding = JSON.parse(byId(segments, 'decoding').override as string);
		expect(decoding.temperature).toBe(0.5); // overridden
		expect(decoding.max_tokens).toBe(1024); // code default, not overridden
	});
});

describe('folkways-adapter stablePromptHash', () => {
	beforeEach(() => {
		findOneMock.mockReset();
		bustTuningCache();
	});

	it('is deterministic: the same segments hash the same way every time', async () => {
		findOneMock.mockResolvedValue(null);
		const segments = await loadStablePromptSegments();
		expect(stablePromptHash(segments)).toBe(stablePromptHash(segments));
		expect(stablePromptHash([...segments])).toBe(stablePromptHash(segments));
	});

	it('changes when a tuning override changes the active text', async () => {
		findOneMock.mockResolvedValue(null);
		const before = stablePromptHash(await loadStablePromptSegments());

		bustTuningCache();
		findOneMock.mockResolvedValue({
			persona: 'A totally different persona.',
			editedBy: 'editor',
			editedAt: '2026-09-10T00:00:00.000Z'
		});
		const after = stablePromptHash(await loadStablePromptSegments());

		expect(after).not.toBe(before);
	});

	it('is independent of segment array order (fixed PROMPT_SEGMENT_IDS ordering)', async () => {
		findOneMock.mockResolvedValue(null);
		const segments = await loadStablePromptSegments();
		const reversed = [...segments].reverse();
		expect(stablePromptHash(reversed)).toBe(stablePromptHash(segments));
	});

	it('is a 64-char hex sha256 digest', async () => {
		findOneMock.mockResolvedValue(null);
		const hash = stablePromptHash(await loadStablePromptSegments());
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('folkways-adapter resolveModelAllowlist', () => {
	// models.ts's own `models` export is a live-mutated array (publishRegistry uses splice, not
	// reassignment, so importers holding the array object see updates) — the mock above mirrors
	// that shape, so these tests mutate it the same way rather than re-mocking the module.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const asModel = (id: string): any => ({ id });
	const originalIds = [...models.map((m) => m.id)];

	afterEach(() => {
		models.splice(0, models.length, ...originalIds.map((id) => asModel(id)));
	});

	it('returns the ids of the registered models[] list', () => {
		expect(resolveModelAllowlist('fallback-id')).toEqual([
			'swiss-ai/apertus-v1.5-70b',
			'swiss-ai/apertus-v1.5-8b'
		]);
	});

	it('is never empty: falls back to [hostModelId] when the registry has no ids', () => {
		models.splice(0, models.length);
		expect(resolveModelAllowlist('swiss-ai/apertus-v1.5-70b')).toEqual([
			'swiss-ai/apertus-v1.5-70b'
		]);
	});

	it('de-duplicates repeated ids', () => {
		models.splice(0, models.length, asModel('a'), asModel('a'), asModel('b'));
		expect(resolveModelAllowlist('fallback-id')).toEqual(['a', 'b']);
	});
});

describe('folkways-adapter resolveModelParameters', () => {
	beforeEach(() => {
		findOneMock.mockReset();
		bustTuningCache();
	});

	it('is GROUNDED_DECODING when there is no tuning override', async () => {
		findOneMock.mockResolvedValue(null);
		const params = await resolveModelParameters();
		expect(params).toMatchObject({ temperature: 0.1, max_tokens: 1024 });
	});

	it('merges a tuning override over the code defaults, same as the decoding segment', async () => {
		findOneMock.mockResolvedValue({ decoding: { temperature: 0.5 } });
		const params = await resolveModelParameters();
		expect(params.temperature).toBe(0.5); // overridden
		expect(params.max_tokens).toBe(1024); // code default, not overridden
	});
});
