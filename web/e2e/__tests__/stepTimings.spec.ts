import { describe, expect, it } from 'vitest';
import type { TestStep } from '@playwright/test/reporter';
import { ASSET_CACHE_ANNOTATION, StepTimings, stepKey } from '../reporters/stepTimings';

type Fake = { category: string; title: string; duration: number; steps?: Fake[] };
const step = (s: Fake): TestStep =>
	({ ...s, steps: (s.steps ?? []).map(step) }) as unknown as TestStep;

describe('stepTimings (SOL-98)', () => {
	it('puts every instance of one kind of wait in one bucket, keeping a navigation path', () => {
		expect(
			stepKey({ category: 'pw:api', title: "Click getByRole('button', { name: 'Send' })" })
		).toBe('pw:api: Click');
		expect(stepKey({ category: 'expect', title: 'Expect "toBeVisible"' })).toBe('expect: Expect');
		expect(
			stepKey({
				category: 'pw:api',
				title: 'Navigate to "/chat/conversation/6ac45983846e0f13154081cc?x=1"'
			})
		).toBe('pw:api: Navigate to /chat/conversation/:id');
	});

	it('sums top-level steps plus untracked spec time to exactly the test duration, and counts each leaf once', () => {
		const t = new StepTimings();
		t.addResult({
			duration: 10_000,
			steps: [
				step({
					category: 'hook',
					title: 'Before Hooks',
					duration: 2_000,
					steps: [{ category: 'fixture', title: 'Fixture "page"', duration: 1_800 }]
				}),
				step({ category: 'pw:api', title: 'Navigate to "/chat"', duration: 3_000 }),
				step({
					category: 'hook',
					title: 'After Hooks',
					duration: 4_000,
					steps: [{ category: 'fixture', title: 'Fixture "context"', duration: 3_900 }]
				})
			]
		});
		const top = [...t.top.values()];
		expect(top.reduce((s, b) => s + b.ms, 0)).toBe(10_000);
		expect(t.top.get('untracked: spec code between steps')?.ms).toBe(1_000);
		expect(t.leaf.get('fixture: Fixture "context"')?.ms).toBe(3_900);
		expect(t.leaf.get('fixture: Fixture "page"')?.ms).toBe(1_800);
		expect(t.leaf.has('hook: Before Hooks')).toBe(false);
		expect(t.table('top', 1)).toMatch(/After Hooks/);
	});

	it('breaks down only tests of 20 s or more, naming their largest steps by full title', () => {
		const t = new StepTimings();
		t.addResult({ duration: 5_000, steps: [] }, 'fast.spec.ts:1 quick');
		t.addResult(
			{
				duration: 30_000,
				steps: [
					step({ category: 'pw:api', title: 'Navigate to "/chat"', duration: 4_000 }),
					step({
						category: 'test.step',
						title: 'sign in',
						duration: 20_000,
						steps: [{ category: 'expect', title: 'Expect "toBeVisible"', duration: 18_000 }]
					})
				]
			},
			'slow.spec.ts:9 slow one'
		);
		expect(t.slow).toHaveLength(1);
		expect(t.slow[0].top[0]).toEqual({ title: 'sign in', ms: 20_000 });
		expect(t.slow[0].leaves[0]).toEqual({ title: 'Expect "toBeVisible"', ms: 18_000 });
		expect(t.slowTable()).toMatch(/30\.0s {2}slow\.spec\.ts:9 slow one\n.*top .*sign in/);
	});

	it('counts an asset miss as refetched only when a different worker already fetched that path', () => {
		const t = new StepTimings();
		const tally = (misses: { path: string; ms: number }[], hits = 0) => [
			{ type: ASSET_CACHE_ANNOTATION, description: JSON.stringify({ hits, misses }) }
		];
		const a = { path: '/_app/immutable/a.js', ms: 300 };
		const b = { path: '/_app/immutable/b.js', ms: 200 };
		t.addResult({ duration: 1, steps: [], workerIndex: 0, annotations: tally([a, b], 4) });
		t.addResult({ duration: 1, steps: [], workerIndex: 1, annotations: tally([a], 2) });
		expect(t.assetSummary()).toEqual({
			hits: 6,
			misses: 3,
			missMs: 800,
			uniquePaths: 2,
			redundant: 1,
			redundantMs: 300
		});
	});
});
