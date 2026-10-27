import { describe, expect, it } from 'vitest';
import { processBlocksSync, processTokensSync } from './marked';
import { citationOrder } from './trace/citedIndices';
import {
	collapseCitations,
	collapseMarkerRun,
	collapseSources,
	renumberCited
} from './collapseSources';

// The shape from the #1495 preview: three chunks of one product, then its organization.
const openGuardrails = [
	{ title: 'OpenGuardrails', link: '/product/openguardrails' },
	{ title: 'OpenGuardrails', link: '/product/openguardrails' },
	{ title: 'OpenGuardrails', link: '/org/openguardrails' },
	{ title: 'OpenGuardrails', link: '/product/openguardrails' }
];

describe('collapseSources (CUR-888)', () => {
	it('lists a page once however many of its chunks were sources', () => {
		const { entries, display } = collapseSources(openGuardrails);
		expect(entries.map((e) => e.link)).toEqual(['/product/openguardrails', '/org/openguardrails']);
		expect(display).toEqual([1, 1, 2, 1]);
	});

	it('numbers the entries 1..k with no gap, even when the duplicate sits between two distinct pages', () => {
		const { display } = collapseSources([
			{ link: '/a' },
			{ link: '/a' },
			{ link: '/b' },
			{ link: '/c' }
		]);
		expect([...new Set(display)]).toEqual([1, 2, 3]);
	});

	it('never merges two sources without a link, even with the same title', () => {
		const { entries } = collapseSources<{ title: string; link?: string }>([
			{ title: 'Policy' },
			{ title: 'Policy' }
		]);
		expect(entries).toHaveLength(2);
	});

	it('is the identity when no two sources share a link', () => {
		const { display } = collapseSources([{ link: '/a' }, { link: '/b' }, {}]);
		expect(display).toEqual([1, 2, 3]);
	});
});

describe('collapseMarkerRun (CUR-888)', () => {
	const { display } = collapseSources(openGuardrails);

	it('writes [1][2] over two pieces of one page as [1], never [1][1]', () => {
		expect(collapseMarkerRun([1, 2], display)).toEqual([1]);
	});

	it("sends a marker for a later duplicate to its page's entry number", () => {
		expect(collapseMarkerRun([4], display)).toEqual([1]);
		expect(collapseMarkerRun([3], display)).toEqual([2]);
	});

	it('keeps distinct pages in the order the answer cited them', () => {
		expect(collapseMarkerRun([3, 1, 2], display)).toEqual([2, 1]);
	});

	it('drops a marker no source has, as the renderer already did', () => {
		expect(collapseMarkerRun([0, 9], display)).toEqual([]);
	});
});

describe('collapseCitations (CUR-888)', () => {
	// RAG numbered first, the web continuing after it, as the server assigns them.
	const message = {
		rag: {
			sources: [
				{ n: 1, url: '/product/openguardrails', title: 'OpenGuardrails' },
				{ n: 2, url: '/product/openguardrails', title: 'OpenGuardrails' },
				{ n: 3, url: '/org/openguardrails', title: 'OpenGuardrails' }
			]
		},
		webSearch: { sources: [{ n: 4, url: 'https://example.org/a', title: 'A' }] }
	};

	it('drops the duplicate and closes the gap across both strips', () => {
		const shown = collapseCitations(message);
		expect(shown.rag?.sources.map((s) => [s.n, s.url])).toEqual([
			[1, '/product/openguardrails'],
			[2, '/org/openguardrails']
		]);
		expect(shown.webSearch?.sources.map((s) => s.n)).toEqual([3]);
	});

	it('marks a source cited through its duplicate as cited on the entry the strip shows', () => {
		expect([...renumberCited(new Set([2, 4]), message)]).toEqual([1, 3]);
	});

	it('returns the message itself when no url repeats', () => {
		const plain = {
			rag: {
				sources: [
					{ n: 1, url: '/a' },
					{ n: 2, url: '/b' }
				]
			}
		};
		expect(collapseCitations(plain)).toBe(plain);
	});
});

describe('inline citation markers over collapsed sources (CUR-888)', () => {
	// Through the real renderer, so the rewrite is checked where the reader sees it.
	const render = (md: string, sources: { title: string; link: string }[]) => {
		const text = processTokensSync(md, sources).find((t) => t.type === 'text');
		return text && 'html' in text && typeof text.html === 'string' ? text.html : '';
	};
	const sources = [
		{ title: 'OpenGuardrails', link: '/product/openguardrails' },
		{ title: 'OpenGuardrails', link: '/product/openguardrails' },
		{ title: 'OpenGuardrails', link: '/org/openguardrails' }
	];
	const markers = (html: string) => [...html.matchAll(/>\[(\d+)\]<\/a>/g)].map((m) => Number(m[1]));

	it('renders [1][2] over two chunks of one product as a single [1], never [1][1]', () => {
		const html = render('It publishes a detection model [1][2].', sources);
		expect(markers(html)).toEqual([1]);
		expect(html).not.toMatch(/\[1\]<\/a>[^[]*\[1\]/);
	});

	it('numbers the organization [2], the entry the strip shows, not its source number 3', () => {
		const html = render('It maintains a specification [3].', sources);
		expect(markers(html)).toEqual([2]);
		expect(html).toContain('href="/org/openguardrails"');
	});
});

describe('cited pages are numbered first (CUR-3933)', () => {
	// Seven pages read, the answer cited the third and fourth.
	const seven = Array.from({ length: 7 }, (_, i) => ({
		title: `Page ${i + 1}`,
		link: `/p${i + 1}`
	}));
	const render = (md: string, sources: { title: string; link: string; citedRank?: number }[]) => {
		const text = processTokensSync(md, sources).find((t) => t.type === 'text');
		return text && 'html' in text && typeof text.html === 'string' ? text.html : '';
	};

	it('numbers the cited sources 1..m in the order the answer first cites them, the rest after', () => {
		const { entries, display } = collapseSources(seven, [4, 3]);
		expect(entries.map((e) => e.link)).toEqual(['/p4', '/p3', '/p1', '/p2', '/p5', '/p6', '/p7']);
		expect(display).toEqual([3, 4, 2, 1, 5, 6, 7]);
	});

	it('renders an answer citing sources 3 and 4 as [1][2], linked to those same pages', () => {
		const ranked = seven.map((s, i) => ({
			...s,
			citedRank: i === 2 ? 0 : i === 3 ? 1 : undefined
		}));
		const html = render('The rates held [3][4].', ranked);
		expect(
			[...html.matchAll(/href="([^"]+)"[^>]*>\[(\d+)\]<\/a>/g)].map((m) => [m[2], m[1]])
		).toEqual([
			['1', '/p3'],
			['2', '/p4']
		]);
	});

	it('lists the cited pages as 1 and 2 in X-ray, matching the answer, with the uncited pages after', () => {
		const message = {
			content: 'The rates held [3][4].',
			webSearch: { sources: seven.map((s, i) => ({ n: i + 1, url: s.link })) }
		};
		const shown = collapseCitations(message).webSearch!.sources;
		expect(shown.slice(0, 2)).toEqual([
			{ n: 1, url: '/p3' },
			{ n: 2, url: '/p4' }
		]);
		expect(shown.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect([...renumberCited(new Set([3, 4]), message)]).toEqual([1, 2]);
	});

	it('numbers every source inside a range, not only its ends, so "[3]-5" shows as [1][2][3]', () => {
		const md = 'Rates held [3]-5.';
		const rank = new Map(citationOrder(md).map((n, i) => [n, i]));
		const ranked = seven.map((s, i) => ({ ...s, citedRank: rank.get(i + 1) }));
		expect(
			[...render(md, ranked).matchAll(/href="([^"]+)"[^>]*>\[(\d+)\]<\/a>/g)].map((m) => [
				m[2],
				m[1]
			])
		).toEqual([
			['1', '/p3'],
			['2', '/p4'],
			['3', '/p5']
		]);
	});

	it('renders the same block with the numbers of the message it belongs to, not a cached earlier one', () => {
		const md = 'The rates held [3][4].';
		const first = seven.map((s, i) => ({ ...s, citedRank: i === 2 ? 0 : i === 3 ? 1 : undefined }));
		const second = seven.map((s, i) => ({
			...s,
			citedRank: i === 3 ? 0 : i === 2 ? 1 : undefined
		}));
		const numbers = (sources: typeof first) =>
			processBlocksSync(md, sources)
				.flatMap((b) => b.tokens)
				.flatMap((t) => ('html' in t && typeof t.html === 'string' ? [t.html] : []))
				.flatMap((html) => [...html.matchAll(/>\[(\d+)\]<\/a>/g)].map((m) => m[1]));
		expect(numbers(first)).toEqual(['1', '2']);
		expect(numbers(second)).toEqual(['2', '1']);
	});

	it("keeps retrieval order when the sources sit after a visitor's own pasted [1]..[k]", () => {
		const message = {
			content: 'As your source says [1], and the web agrees [4] and [3].',
			webSearch: { sources: [3, 4].map((n) => ({ n, url: `/p${n}` })) }
		};
		expect(collapseCitations(message).webSearch!.sources).toEqual([
			{ n: 1, url: '/p3' },
			{ n: 2, url: '/p4' }
		]);
	});
});

describe('citationOrder reads every shape the renderer links (CUR-3933)', () => {
	it('orders caret, group, range and bold-wrapped citations by first appearance', () => {
		expect(citationOrder('Tokyo^3,2^. More [^4^] and [1]-5.')).toEqual([3, 2, 4, 1, 5]);
		expect(citationOrder('Both [2, 3]. Again **[3][2]**.')).toEqual([2, 3]);
		expect(citationOrder('Held steady [3]-5.')).toEqual([3, 4, 5]);
		expect(citationOrder('Held steady^3-5^.')).toEqual([3, 4, 5]);
	});

	it('ignores a marker inside code or a link', () => {
		expect(citationOrder('`[9]` and [link](https://x.test/[8]) then [2]')).toEqual([2]);
	});

	it('numbers a caret-only answer from [1] when it cites the second and third pages', () => {
		const sources = ['Sydney', 'Tokyo', 'Canberra'].map((t) => ({ title: t, link: `/${t}` }));
		const md = 'Tokyo^2,3^. Canberra [^3^].';
		const rank = new Map(citationOrder(md).map((n, i) => [n, i]));
		const ranked = sources.map((s, i) => ({ ...s, citedRank: rank.get(i + 1) }));
		const tokens = processTokensSync(md, ranked);
		const html = tokens
			.map((t) => ('html' in t && typeof t.html === 'string' ? t.html : ''))
			.join('');
		const links = [...html.matchAll(/href="([^"]+)"[^>]*>\[(\d+)\]/g)].map((m) => [m[2], m[1]]);
		expect(links[0]).toEqual(['1', '/Tokyo']);
		expect(links).toContainEqual(['2', '/Canberra']);
		expect(links.some(([, href]) => href === '/Sydney')).toBe(false);
	});
});
