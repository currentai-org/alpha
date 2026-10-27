import { describe, expect, it } from 'vitest';
import type { Message } from '$lib/chat/types/Message';
import {
	classifyRules,
	factCheckStep,
	formatDay,
	joinNames,
	ragSources,
	screenOrder,
	tidyExcerpt,
	webOrigins,
	webSources
} from './stepEvidence';

const msg = (over: Partial<Message> = {}): Message =>
	({ id: 'm1', from: 'assistant', content: 'An answer.', ...over }) as Message;

const web = (n: number, over: Record<string, unknown> = {}) => ({
	n,
	title: `Page ${n}`,
	url: `https://example.org/${n}`,
	snippet: `Passage  from\n page ${n}. `,
	engine: 'Wikipedia' as const,
	...over
});

describe('naming where a source came from', () => {
	it('joins names the way a person would say them', () => {
		expect(joinNames([])).toBe('');
		expect(joinNames(['A'])).toBe('A');
		expect(joinNames(['A', 'B'])).toBe('A and B');
		expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
	});

	it('names each search engine in plain words, and falls back for one that no longer exists', () => {
		expect(webOrigins(['Wikipedia', 'Firecrawl'])).toBe('Wikipedia and the open web');
		expect(webOrigins(['Marginalia'])).toBe('the open web');
	});
});

describe('the sources a web search read', () => {
	it('keeps the citation number, the link, the tidied passage and the day', () => {
		const [source] = webSources(
			msg({
				content: 'Paris [1].',
				webSearch: { query: 'q', asOf: '2026-09-29', sources: [web(1, { asOf: '2026-03-12' })] }
			})
		);
		expect(source).toMatchObject({
			n: 1,
			from: 'Wikipedia',
			excerpt: 'Passage from page 1.',
			date: '2026-03-12',
			cited: true
		});
	});

	it('marks a source cited only when the answer points at it', () => {
		const sources = webSources(
			msg({
				content: 'One [1]. Another [3].',
				webSearch: { query: 'q', asOf: '2026-09-29', sources: [web(1), web(2), web(3)] }
			})
		);
		// Cited pages come first, numbered as the answer shows them (CUR-3933).
		expect(sources.map((s) => [s.n, s.cited])).toEqual([
			[1, true],
			[2, true],
			[3, false]
		]);
	});

	it('calls no source "not cited" when the answer cites none', () => {
		const sources = webSources(
			msg({
				content: 'No numbers.',
				webSearch: { query: 'q', asOf: '2026-09-29', sources: [web(1)] }
			})
		);
		expect(sources[0].cited).toBeUndefined();
	});
});

describe('the passages a knowledge store returned', () => {
	const message = msg({
		content: 'Answer [2].',
		rag: {
			query: 'q',
			asOf: '2026-09-29',
			sources: [
				{ n: 1, title: 'Doc 1', snippet: 'a', engine: 'Potluck', sourceDate: '2026-01-05' },
				{ n: 2, title: 'Doc 2', snippet: 'b', engine: 'SyftHub', sourceName: 'owner/notes' }
			]
		}
	});

	it('names each store in plain words', () => {
		// The partner's passage is the one cited, so it is listed first (CUR-3933).
		const [partner, library] = ragSources(message);
		expect(library.from).toBe('AI Potluck’s knowledge library');
		expect(partner.from).toBe('A partner’s data source (owner/notes)');
	});

	it('can be limited to one store, keeping citation state from the whole answer', () => {
		expect(ragSources(message, 'SyftHub')[0].cited).toBe(true);
		expect(ragSources(message, 'Potluck')[0].cited).toBe(false);
	});
});

describe('showing a passage and a day', () => {
	it('collapses whitespace, and returns nothing for whitespace only', () => {
		expect(tidyExcerpt('  A  b\n\nc ')).toBe('A b c');
		expect(tidyExcerpt(' \n ')).toBeUndefined();
	});

	it('gives the day in the reader’s time zone, not the UTC day', () => {
		const instant = '2026-03-12T23:30:00Z';
		expect(formatDay(instant, { timeZone: 'UTC', locale: 'en-GB' })).toBe('12 Mar 2026');
		expect(formatDay(instant, { timeZone: 'Asia/Tokyo', locale: 'en-GB' })).toBe('13 Mar 2026');
	});

	// A source's publication day, stored as YYYY-MM-DD, reads as that day west of UTC too. (CUR-4171)
	it('gives a bare calendar day as that day in every time zone', () => {
		expect(formatDay('2026-10-18', { timeZone: 'America/Los_Angeles', locale: 'en-GB' })).toBe('18 Oct 2026');
		expect(formatDay('2026-10-18', { timeZone: 'Pacific/Auckland', locale: 'en-GB' })).toBe('18 Oct 2026');
	});
});

describe('the named safety rules for a turn whose screen ran', () => {
	const rules = [
		{ label: 'Hate', kind: 'content' as const },
		{ label: 'Self-harm', kind: 'content' as const }
	];

	it('marks every rule clear when nothing fired', () => {
		expect(classifyRules(rules, {}).map((r) => r.state)).toEqual(['clear', 'clear']);
	});

	it('marks the fired rule triggered and the rest not checked, never clear', () => {
		expect(
			classifyRules(rules, { triggeredLabel: 'Self-harm', blocked: true }).map((r) => r.state)
		).toEqual(['not-checked', 'triggered']);
	});

	it('marks a distress rule that answered under the card triggered, never clear, and the rest clear (CUR-3915)', () => {
		expect(classifyRules(rules, { triggeredLabel: 'Self-harm' }).map((r) => r.state)).toEqual([
			'clear',
			'triggered'
		]);
	});

	it('marks every rule not checked when an unnamed rule blocked the turn', () => {
		expect(classifyRules(rules, { blocked: true }).map((r) => r.state)).toEqual([
			'not-checked',
			'not-checked'
		]);
	});
});

describe('when the input safety screen ran relative to the model', () => {
	it('says the screen came first when nothing overlapped', () => {
		expect(screenOrder(undefined)).toBe('first');
		expect(screenOrder({ speculativeEvents: 0 })).toBe('first');
	});

	it('says the model started alongside when events were held, and whether they were discarded', () => {
		expect(screenOrder({ speculativeEvents: 4 })).toBe('alongside');
		expect(screenOrder({ speculativeEvents: 4, speculativeDiscarded: true })).toBe(
			'alongside-discarded'
		);
	});
});

describe('a page retrieved as several passages (CUR-888)', () => {
	it('is one entry, numbered without gaps, and the answer’s marker for any passage marks it cited', () => {
		const product = (n: number) => ({
			n,
			title: 'OpenGuardrails',
			url: '/product/openguardrails',
			snippet: `part ${n}`,
			engine: 'Potluck' as const
		});
		const sources = ragSources(
			msg({
				content: 'It screens prompts [2].',
				rag: {
					query: 'q',
					asOf: '2026-09-29',
					sources: [
						product(1),
						product(2),
						{ n: 3, title: 'Other', url: '/product/other', snippet: 'x', engine: 'Potluck' }
					]
				}
			})
		);
		expect(sources.map((s) => [s.n, s.url, s.cited])).toEqual([
			[1, '/product/openguardrails', true],
			[2, '/product/other', false]
		]);
	});
});

describe('factCheckStep (CUR-2927)', () => {
	it('says how many claims a revised answer lost when the stamp carries the count', () => {
		expect(factCheckStep({ outcome: 'revised', removed: 1 }).what).toBe('Removed 1 claim no source supports.');
		expect(factCheckStep({ outcome: 'revised', removed: 3 }).what).toBe('Removed 3 claims no source supports.');
	});

	it('names no number for an answer stamped before the count existed', () => {
		expect(factCheckStep({ outcome: 'revised' }).what).toBe('Removed claims no source supports.');
	});

	it('says a check that never finished left the answer as written, never that it passed', () => {
		for (const outcome of ['truncated', 'too-many', 'detect-failed', 'revise-failed'] as const) {
			expect(factCheckStep({ outcome })).toEqual({
				what: 'The fact check couldn’t finish, so the answer is shown as written.',
				tone: 'note'
			});
		}
	});
});
