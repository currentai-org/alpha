// Where a scenario test's time goes, measured per step rather than inferred.
//
// The list reporter prints one duration per test and nothing inside it. Chat turns are only about
// a quarter of test time, so the rest was invisible to every instrument the run had.
//
// This reporter adds every finished step's duration into a bucket named for what the step did, and
// prints the buckets largest first when the shard ends. Two partitions, so nothing is counted twice:
//
// - `top`: each test's top-level steps (Before Hooks, the body's own actions, After Hooks). Their sum
//   plus `untracked` is the test's duration, so `untracked` is time spent in spec code between steps.
// - `leaf`: steps with no children, which is where a wait actually happens (a navigation, a locator
//   wait, an expect poll, a fixture's setup or teardown). Steps that run concurrently under a
//   Promise.all are both counted, so a leaf total can exceed wall time; `top` never does.
//
// It never fails a run and writes nothing a later step reads.
//
// The buckets say what kind of wait costs most across a shard, not which test pays it. A test
// that runs SLOW_TEST_MS or longer also gets its own line: its slowest top-level steps and leaves by
// their full titles. And helpers/test.ts annotates each test with its static-asset cache traffic, so
// the shard end can say how much fetch time went to an asset another worker had already fetched,
// which is the most a cache shared between workers could save.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

export const STEP_TIMINGS_FILE = join(process.cwd(), 'test-results', 'step-timings.json');

export type Bucket = { key: string; n: number; ms: number; max: number };

/** The annotation helpers/test.ts adds to each test: `{hits, misses: [{path, ms}]}` as JSON. */
export const ASSET_CACHE_ANNOTATION = 'asset-cache';
export const SLOW_TEST_MS = 20_000;

export type SlowTest = {
	title: string;
	ms: number;
	top: { title: string; ms: number }[];
	leaves: { title: string; ms: number }[];
};

type Tally = { hits: number; misses: { path: string; ms: number }[] };

/** Every step with no children, depth first. */
function leavesOf(steps: TestStep[]): TestStep[] {
	return steps.flatMap((s) => (s.steps.length === 0 ? [s] : leavesOf(s.steps)));
}

const largest = (steps: Pick<TestStep, 'title' | 'duration'>[], n: number) =>
	[...steps]
		.sort((a, b) => b.duration - a.duration)
		.slice(0, n)
		.map((s) => ({ title: s.title.trim().slice(0, 90), ms: s.duration }));

/**
 * A step's bucket: its category and the verb of its title, with the specifics a title carries
 * (a selector, a quoted value, a URL's query) dropped so every instance of one kind of wait lands
 * together. A navigation keeps its path, since which page is slow is the useful fact.
 */
export function stepKey(step: Pick<TestStep, 'category' | 'title'>): string {
	const title = step.title.trim();
	// A fixture's or hook's name is the specific fact (the context teardown that saves the video).
	if (step.category === 'fixture' || step.category === 'hook')
		return `${step.category}: ${title.slice(0, 48)}`;
	const nav = /^(Navigate to|Wait for (?:navigation|URL)) "?([^"?#\s]*)/.exec(title);
	if (nav) {
		const path = nav[2].replace(/[0-9a-f]{24}|[0-9a-f-]{36}/g, ':id');
		return `${step.category}: ${nav[1]} ${path}`.trim();
	}
	const verb = title
		.split(/\s*["'`(]|\s+(?:getBy|locator)/)[0]
		.trim()
		.slice(0, 48);
	return `${step.category}: ${verb || title.slice(0, 48)}`;
}

function add(into: Map<string, Bucket>, key: string, ms: number): void {
	const b = into.get(key) ?? { key, n: 0, ms: 0, max: 0 };
	b.n += 1;
	b.ms += ms;
	b.max = Math.max(b.max, ms);
	into.set(key, b);
}

export class StepTimings {
	readonly top = new Map<string, Bucket>();
	readonly leaf = new Map<string, Bucket>();
	readonly slow: SlowTest[] = [];
	/** Asset fetches per worker: which paths it missed, and how long each fetch took. */
	readonly assetMisses = new Map<number, { path: string; ms: number }[]>();
	assetHits = 0;
	testMs = 0;
	tests = 0;

	/** Adds one finished attempt: its top-level steps, its leaves, and the gap between steps. */
	addResult(
		result: Pick<TestResult, 'duration' | 'steps'> &
			Partial<Pick<TestResult, 'annotations' | 'workerIndex'>>,
		title = ''
	): void {
		this.tests += 1;
		if (result.duration >= SLOW_TEST_MS)
			this.slow.push({
				title,
				ms: result.duration,
				top: largest(result.steps, 3),
				leaves: largest(leavesOf(result.steps), 5)
			});
		for (const a of result.annotations ?? []) {
			if (a.type !== ASSET_CACHE_ANNOTATION || !a.description) continue;
			const tally = JSON.parse(a.description) as Tally;
			this.assetHits += tally.hits;
			const worker = result.workerIndex ?? 0;
			this.assetMisses.set(worker, [...(this.assetMisses.get(worker) ?? []), ...tally.misses]);
		}
		this.testMs += result.duration;
		let tracked = 0;
		for (const step of result.steps) {
			add(this.top, stepKey(step), step.duration);
			tracked += step.duration;
		}
		add(this.top, 'untracked: spec code between steps', Math.max(0, result.duration - tracked));
		const walk = (steps: TestStep[]): void => {
			for (const s of steps) {
				if (s.steps.length === 0) add(this.leaf, stepKey(s), s.duration);
				else walk(s.steps);
			}
		};
		walk(result.steps);
	}

	/**
	 * Asset cache totals. A miss is `redundant` when another worker fetched the same path first in
	 * worker order, so `redundantMs` is the fetch time a cache shared across workers would remove.
	 */
	assetSummary(): {
		hits: number;
		misses: number;
		missMs: number;
		uniquePaths: number;
		redundant: number;
		redundantMs: number;
	} {
		const seen = new Set<string>();
		let misses = 0;
		let missMs = 0;
		let redundant = 0;
		let redundantMs = 0;
		for (const worker of [...this.assetMisses.keys()].sort((a, b) => a - b)) {
			const mine = new Set<string>();
			for (const m of this.assetMisses.get(worker) ?? []) {
				misses += 1;
				missMs += m.ms;
				if (seen.has(m.path)) {
					redundant += 1;
					redundantMs += m.ms;
				}
				mine.add(m.path);
			}
			mine.forEach((p) => seen.add(p));
		}
		return { hits: this.assetHits, misses, missMs, uniquePaths: seen.size, redundant, redundantMs };
	}

	/** One block per slow test, slowest first: its largest top-level steps, then its largest leaves. */
	slowTable(): string {
		const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
		return [...this.slow]
			.sort((a, b) => b.ms - a.ms)
			.map(
				(t) =>
					`${s(t.ms).padStart(7)}  ${t.title}\n` +
					t.top.map((x) => `           top  ${s(x.ms).padStart(6)}  ${x.title}`).join('\n') +
					'\n' +
					t.leaves.map((x) => `           leaf ${s(x.ms).padStart(6)}  ${x.title}`).join('\n')
			)
			.join('\n');
	}

	/** The buckets largest first, each with its share of all test time. */
	table(which: 'top' | 'leaf', limit: number): string {
		const rows = [...this[which].values()].sort((a, b) => b.ms - a.ms).slice(0, limit);
		const pct = (ms: number) => (this.testMs ? ((100 * ms) / this.testMs).toFixed(1) : '0.0');
		return rows
			.map(
				(b) =>
					`${(b.ms / 1000).toFixed(0).padStart(6)}s ${pct(b.ms).padStart(5)}%  n=${String(b.n).padEnd(5)} ` +
					`avg=${(b.ms / b.n / 1000).toFixed(2)}s max=${(b.max / 1000).toFixed(1)}s  ${b.key}`
			)
			.join('\n');
	}
}

export default class StepTimingsReporter implements Reporter {
	private timings = new StepTimings();

	onTestEnd(test: TestCase, result: TestResult): void {
		if (result.status !== 'skipped')
			this.timings.addResult(
				result,
				`${test.location.file.split('/').pop()}:${test.location.line} ${test.title}`
			);
	}

	onEnd(): void {
		const t = this.timings;
		if (t.tests === 0) return;
		console.log(
			`\nstep timings (SOL-98): ${t.tests} attempts, ${(t.testMs / 1000).toFixed(0)}s of test time\n` +
				`-- top-level steps (sums to test time) --\n${t.table('top', 25)}\n` +
				`-- leaf steps (where the waiting happens; concurrent steps both count) --\n${t.table('leaf', 40)}\n`
		);
		const a = t.assetSummary();
		console.log(
			`-- static asset cache (SOL-354) --\n` +
				`hits=${a.hits} misses=${a.misses} fetch=${(a.missMs / 1000).toFixed(0)}s unique=${a.uniquePaths} ` +
				`refetched-by-another-worker=${a.redundant} (${(a.redundantMs / 1000).toFixed(0)}s)\n` +
				`-- tests over ${SLOW_TEST_MS / 1000}s (SOL-354): ${t.slow.length} --\n${t.slowTable()}\n`
		);
		mkdirSync(dirname(STEP_TIMINGS_FILE), { recursive: true });
		writeFileSync(
			STEP_TIMINGS_FILE,
			JSON.stringify(
				{
					tests: t.tests,
					testMs: t.testMs,
					top: [...t.top.values()],
					leaf: [...t.leaf.values()],
					assetCache: t.assetSummary(),
					slow: t.slow
				},
				null,
				2
			) + '\n'
		);
	}
}
