import { describe, expect, it } from 'vitest';
import {
	Footprints,
	RAN_WEB,
	TURN_BINDING,
	footprintLine,
	isTurnRequest,
	lineRanWeb,
	turnLines,
	turnWatcherScript
} from '../reporters/footprints';

const ORIGIN = 'https://preview.example';

describe('footprints (SOL-245)', () => {
	it('folds ids to :id and drops the query, so every conversation reads as one route', () => {
		expect(
			footprintLine('post', `${ORIGIN}/chat/conversation/6ac45983846e0f13154081cc?x=1`, ORIGIN)
		).toBe('POST /chat/conversation/:id');
		expect(
			footprintLine(
				'GET',
				`${ORIGIN}/chat/api/files/0b8f3c2e-1d4a-4e5b-9c6d-7e8f9a0b1c2d/42`,
				ORIGIN
			)
		).toBe('GET /chat/api/files/:id/:id');
		expect(footprintLine('GET', `${ORIGIN}/chat/settings/data`, ORIGIN)).toBe(
			'GET /chat/settings/data'
		);
	});

	it('records nothing for another origin, a static or hashed file, or the PostHog proxy', () => {
		expect(footprintLine('GET', 'https://fonts.gstatic.com/x.woff2', ORIGIN)).toBeNull();
		expect(footprintLine('GET', `${ORIGIN}/_app/immutable/chunks/a1b2.js`, ORIGIN)).toBeNull();
		expect(footprintLine('GET', `${ORIGIN}/favicon.png`, ORIGIN)).toBeNull();
		expect(footprintLine('POST', `${ORIGIN}/rs/e/`, ORIGIN)).toBeNull();
		expect(footprintLine('GET', 'not a url', ORIGIN)).toBeNull();
	});

	it('unions a retried test into one entry, so a second attempt adds lines and never duplicates the test', () => {
		const f = new Footprints();
		f.add('e2e/scenarios/a.spec.ts', 'sends', ['GET /chat', 'POST /chat/conversation/:id']);
		f.add('e2e/scenarios/a.spec.ts', 'sends', ['GET /chat', 'GET /chat/api/models']);
		f.add('e2e/scenarios/b.spec.ts', 'opens', ['GET /']);
		expect(f.toJSON().tests).toEqual([
			{
				file: 'e2e/scenarios/a.spec.ts',
				title: 'sends',
				requests: ['GET /chat', 'GET /chat/api/models', 'POST /chat/conversation/:id']
			},
			{ file: 'e2e/scenarios/b.spec.ts', title: 'opens', requests: ['GET /'] }
		]);
	});

	it("keeps a shard's earlier file for the same commit when a rescue rerun writes again, and drops one from another commit", () => {
		const earlier = {
			sha: 'abc',
			tests: [{ file: 'e2e/scenarios/a.spec.ts', title: 'sends', requests: ['GET /chat'] }]
		};
		const rerun = new Footprints();
		rerun.add('e2e/scenarios/b.spec.ts', 'opens', ['GET /']);
		rerun.addPrevious(earlier, 'abc');
		expect(rerun.toJSON().tests.map((t) => t.title)).toEqual(['sends', 'opens']);

		const nextCommit = new Footprints();
		nextCommit.add('e2e/scenarios/b.spec.ts', 'opens', ['GET /']);
		nextCommit.addPrevious(earlier, 'def');
		expect(nextCommit.toJSON().tests.map((t) => t.title)).toEqual(['opens']);
	});
});

describe('turn recording (SOL-265)', () => {
	const pad = ' '.repeat(16);
	const stream = (...updates: object[]) =>
		updates.map((u) => JSON.stringify(u) + '\n' + pad).join('');

	it('a search-results or search-attempt update is a web fetch; any other update, or a cut line, is not', () => {
		expect(lineRanWeb(JSON.stringify({ type: 'webSearch', sources: [] }) + pad)).toBe(true);
		expect(lineRanWeb(JSON.stringify({ type: 'searchAttempt', failed: true }))).toBe(true);
		expect(lineRanWeb(JSON.stringify({ type: 'finalAnswer', text: 'hi' }))).toBe(false);
		expect(lineRanWeb('{"type":"webSea')).toBe(false);
		expect(lineRanWeb(pad)).toBe(false);
	});

	it('a posted message holding a link counts as a web fetch, since the route reads the page', () => {
		expect(turnLines(false, '{"inputs":"see https://example.org/a"}')).toEqual([RAN_WEB]);
		expect(turnLines(true, '{}')).toEqual([RAN_WEB]);
		expect(turnLines(false, '{"inputs":"hi"}')).toEqual([]);
		expect(turnLines(false, null)).toEqual([]);
	});

	it('only a POST to a conversation on our origin is a turn', () => {
		expect(isTurnRequest('POST', `${ORIGIN}/chat/conversation/abc`, ORIGIN)).toBe(true);
		expect(isTurnRequest('GET', `${ORIGIN}/chat/conversation/abc`, ORIGIN)).toBe(false);
		expect(isTurnRequest('POST', `${ORIGIN}/chat/conversation/abc/message/1`, ORIGIN)).toBe(false);
		expect(isTurnRequest('POST', 'https://other.example/chat/conversation/abc', ORIGIN)).toBe(
			false
		);
	});

	// The watcher runs in the page; here it runs against a stand-in window whose fetch streams a body in
	// chunks that split an update across reads, as a real turn's stream does.
	async function runWatcher(body: string, url: string, method = 'POST') {
		const reports: { searched: boolean }[] = [];
		const chunks = [body.slice(0, 7), body.slice(7, 30), body.slice(30)];
		const win: Record<string, unknown> = {
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
							controller.close();
						}
					})
				),
			[TURN_BINDING]: async (turn: { searched: boolean }) => {
				reports.push(turn);
			}
		};
		const g = globalThis as Record<string, unknown>;
		const saved = { window: g.window, location: g.location };
		g.window = win;
		g.location = new URL(`${ORIGIN}/chat`);
		try {
			new Function(turnWatcherScript())();
			const response = await (win.fetch as typeof fetch)(url, { method });
			expect(await response.text()).toBe(body);
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			g.window = saved.window;
			g.location = saved.location;
		}
		return reports;
	}

	it("the page reports a turn's search once its stream ends, and leaves the page's own read whole", async () => {
		const body = stream(
			{ type: 'status' },
			{ type: 'webSearch', sources: [] },
			{ type: 'finalAnswer' }
		);
		expect(await runWatcher(body, `${ORIGIN}/chat/conversation/abc`)).toEqual([{ searched: true }]);
	});

	it('the page reports a plain turn as unsearched, so selection may cut the search engines', async () => {
		const body = stream({ type: 'stream', token: 'hi' }, { type: 'finalAnswer', text: 'hi' });
		expect(await runWatcher(body, `${ORIGIN}/chat/conversation/abc`)).toEqual([
			{ searched: false }
		]);
	});

	it('the page reports nothing for a request that is not a posted turn', async () => {
		const body = stream({ type: 'webSearch' });
		expect(await runWatcher(body, `${ORIGIN}/chat/conversation/abc`, 'GET')).toEqual([]);
		expect(await runWatcher(body, 'https://other.example/chat/conversation/abc')).toEqual([]);
	});
});
