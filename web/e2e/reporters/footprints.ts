// Which of our routes each scenario test reaches, recorded from its requests (SOL-245).
//
// PR runs pick tests through the `e2e-product` and `e2e-area` header tags, and 134 of 152 specs say
// `@chat`, so any chat-turn change selects nearly the whole suite. A footprint is the set of
// same-origin requests a test's pages made, as `METHOD /path` with ids folded to `:id`, which a later
// selector can intersect with a diff through each route's import closure.
//
// The `footprint` fixture in scenarios/helpers/test.ts records the requests and attaches them when
// E2E_FOOTPRINTS=1, which every scenario-suite-check run sets. This reporter unions every attempt's
// lines per test and writes e2e-footprints/footprints.json at shard end. That sits outside Playwright's
// outputDir (web/test-results by default), which every Playwright process empties as it starts, so a
// second process in the same job (the replay-miss rerun) would delete the first run's file before this
// reporter could add to it. It never fails a run, and nothing reads the file yet: selection is
// unchanged until the selector lands.
//
// Blind spots: requests a spec sends through Playwright's `request` fixture (APIRequestContext) are
// not page requests and are not seen. What a route reaches on the server is left to the closure
// script.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export const FOOTPRINTS_FILE = join(process.cwd(), 'e2e-footprints', 'footprints.json');
export const FOOTPRINT_ATTACHMENT = 'footprint';

const STATIC_FILE = /\.(?:js|mjs|css|map|woff2?|ttf|png|jpe?g|webp|avif|svg|ico|txt|webmanifest)$/;
const ID_SEGMENT =
	/^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/**
 * One request as a footprint line, or null when it says nothing about which of our routes ran: another
 * origin, a content-hashed or static file, or the same-origin PostHog proxy (`/rs/*`).
 */
export function footprintLine(method: string, url: string, origin: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.origin !== origin) return null;
	const path = parsed.pathname;
	if (path.startsWith('/_app/') || path.startsWith('/rs/') || STATIC_FILE.test(path)) return null;
	const folded = path
		.split('/')
		.map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
		.join('/');
	return `${method.toUpperCase()} ${folded}`;
}

// What a test's turns did, as `RAN …` lines beside its requests. scripts/lib/routeClosure.mjs
// cuts an optional subsystem's code out of a test's closure when its turns never ran it, and trusts
// that only when `RAN recorded` says every turn's stream was read.
export const RAN_RECORDED = 'RAN recorded';
export const RAN_WEB = 'RAN web';
const CONVERSATION_POST = /^\/chat\/conversation\/[^/]+\/?$/;
const URL_IN_TEXT = /https?:\/\/\S/;

/** The page calls this binding once per turn whose stream it read to the end (`turnWatcherScript`). */
export const TURN_BINDING = '__footprintTurn';

/** Whether a request is a posted turn, whose stream the page reports through `TURN_BINDING`. */
export function isTurnRequest(method: string, url: string, origin: string): boolean {
	try {
		const parsed = new URL(url);
		return method === 'POST' && parsed.origin === origin && CONVERSATION_POST.test(parsed.pathname);
	} catch {
		return false;
	}
}

/**
 * Whether one line of a conversation stream (one JSON update, padded with spaces) is a `webSearch` or
 * `searchAttempt` update. It runs inside the page too (`turnWatcherScript`), so it names nothing
 * outside itself.
 */
export function lineRanWeb(raw: string): boolean {
	const line = raw.trim();
	if (!line.startsWith('{')) return false;
	try {
		const type = (JSON.parse(line) as { type?: unknown }).type;
		return type === 'webSearch' || type === 'searchAttempt';
	} catch {
		// A line cut mid-JSON says nothing; the rest still count.
		return false;
	}
}

/**
 * The `RAN …` lines one turn earns. A turn fetched from the web when its stream carried a search
 * update, or when the posted message holds a link, which the route reads as a page.
 */
export function turnLines(searched: boolean, posted: string | null): string[] {
	return searched || (posted !== null && URL_IN_TEXT.test(posted)) ? [RAN_WEB] : [];
}

/**
 * An init script that wraps the page's `fetch`, reads a clone of each posted turn's stream as it
 * arrives, and calls `TURN_BINDING` with `{ searched }` once it ends. Reading it in the page keeps
 * the stream readable after the test reloads or navigates, which `response.text()` does not: Chromium
 * drops a response's body when its page moves on. A turn that is aborted or cut off reports nothing.
 */
export function turnWatcherScript(): string {
	function watch(binding: string, pathSource: string, ranWeb: (line: string) => boolean) {
		const path = new RegExp(pathSource);
		const original = window.fetch;
		async function read(response: Response) {
			const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
			let rest = '';
			let searched = false;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (searched) continue;
					const lines = (rest + value).split('\n');
					rest = lines.pop() ?? '';
					searched = lines.some(ranWeb);
				}
				await (window as unknown as Record<string, (turn: { searched: boolean }) => Promise<void>>)[
					binding
				]({ searched: searched || ranWeb(rest) });
			} catch {
				// An aborted turn reports nothing, so the test keeps its whole closure.
			}
		}
		window.fetch = async function (...args: Parameters<typeof fetch>) {
			const response = await original.apply(window, args);
			try {
				const [input, init] = args;
				const request = input instanceof Request ? input : null;
				const url = new URL(request ? request.url : String(input), location.href);
				const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
				if (
					method === 'POST' &&
					url.origin === location.origin &&
					path.test(url.pathname) &&
					response.body
				)
					void read(response.clone());
			} catch {
				// Watching must never break the page's own fetch.
			}
			return response;
		};
	}
	return `(${watch.toString()})(${JSON.stringify(TURN_BINDING)}, ${JSON.stringify(CONVERSATION_POST.source)}, ${lineRanWeb.toString()});`;
}

export type TestFootprint = { file: string; title: string; requests: string[] };

/** Footprints keyed by `file > title path`, each the union of its attempts' lines, sorted. */
export class Footprints {
	private readonly byTest = new Map<string, { file: string; title: string; lines: Set<string> }>();

	add(file: string, title: string, lines: Iterable<string>): void {
		const key = `${file} > ${title}`;
		const entry = this.byTest.get(key) ?? { file, title, lines: new Set<string>() };
		for (const line of lines) entry.lines.add(line);
		this.byTest.set(key, entry);
	}

	get size(): number {
		return this.byTest.size;
	}

	/**
	 * Fold in the tests of a file written earlier in this job for the same commit. A shard's in-job rescue
	 * rerun is a second Playwright process, and without this its handful of tests replaced the whole
	 * shard's file. A file from another commit is left out.
	 */
	addPrevious(previous: unknown, sha: string | null): void {
		const prev = previous as { sha?: unknown; tests?: TestFootprint[] } | null;
		if (!prev || prev.sha !== sha || !Array.isArray(prev.tests)) return;
		for (const t of prev.tests) this.add(t.file, t.title, t.requests);
	}

	toJSON(): { tests: TestFootprint[] } {
		const tests = [...this.byTest.values()]
			.map(({ file, title, lines }) => ({ file, title, requests: [...lines].sort() }))
			.sort((a, b) => `${a.file} > ${a.title}`.localeCompare(`${b.file} > ${b.title}`));
		return { tests };
	}
}

export default class FootprintsReporter implements Reporter {
	private footprints = new Footprints();

	onTestEnd(test: TestCase, result: TestResult): void {
		const attachment = result.attachments.find((a) => a.name === FOOTPRINT_ATTACHMENT);
		if (!attachment?.body) return;
		const lines = attachment.body.toString('utf8').split('\n').filter(Boolean);
		const file = relative(process.cwd(), test.location.file);
		this.footprints.add(file, test.titlePath().slice(3).join(' > '), lines);
	}

	onEnd(): void {
		if (this.footprints.size === 0) return;
		const sha = process.env.HEAD_SHA ?? null;
		if (existsSync(FOOTPRINTS_FILE)) {
			try {
				this.footprints.addPrevious(JSON.parse(readFileSync(FOOTPRINTS_FILE, 'utf8')), sha);
			} catch {
				// An unreadable earlier file is replaced, as before this merge existed.
			}
		}
		mkdirSync(dirname(FOOTPRINTS_FILE), { recursive: true });
		writeFileSync(
			FOOTPRINTS_FILE,
			JSON.stringify({ sha, ...this.footprints.toJSON() }, null, 2) + '\n'
		);
		console.log(
			`footprints (SOL-245): ${this.footprints.size} tests written to ${FOOTPRINTS_FILE}`
		);
	}
}
