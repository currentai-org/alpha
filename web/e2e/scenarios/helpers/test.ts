// Every scenario spec imports `test` from here rather than from '@playwright/test', so two kinds of
// request a test never asserts on stop reaching the preview on every page load (CUR-2675).
//
// One
// scenario run sent ~37k requests, 21.2k of them `/_app/immutable/*` and 3.7k `/chat/api/warm`.
// Each test gets a fresh browser context, so its HTTP cache starts empty and every page load
// refetches the same ~15 content-hashed chunks; and every composer mount fires the warm ping.
//
// Content-hashed assets are fetched once per worker and served from memory after that. The bytes are
// the deployment's own, so a test sees exactly what a browser would. Playwright disables the HTTP
// cache in any context with a route (and helpers/signIn.ts already routes), so the other static
// files a page loads repeatedly are cached here too, keyed by full URL and kept for one worker.
//
// The composer's warm ping gets a 204 inside the page and never leaves it. A context.route stub let
// 27 of 100 pings through to the server; the ping is sent with
// `keepalive: true`, so it is answered by wrapping `fetch` in an init script instead. global-setup's real warm-up turn (helpers/warmup.ts) is what
// wakes the preview's model path; the browser ping only re-runs warmAll(), and no spec reads it.
import { test as base, type Page, type Route } from '@playwright/test';
import { mockAnswerShown, replayMissLine } from './replayMiss';
import {
	CHAT_MODELS_ANNOTATION,
	UPSTREAM_UNANSWERED_ANNOTATION,
	upstreamNoticeShown
} from './upstreamAdvisory';
import {
	FOOTPRINT_ATTACHMENT,
	RAN_RECORDED,
	RAN_WEB,
	TURN_BINDING,
	footprintLine,
	isTurnRequest,
	turnLines,
	turnWatcherScript
} from '../../reporters/footprints';
import { isCacheable } from './cacheable';
import { ASSET_CACHE_ANNOTATION } from '../../reporters/stepTimings';
import { startChattingPastWelcome } from './welcome';
import {
	LAYOUT_SHIFT_BINDING,
	LAYOUT_SHIFTS_ATTACHMENT,
	MAX_LAYOUT_SHIFTS,
	layoutShiftScript,
	type LayoutShift
} from './layoutShifts';

export * from '@playwright/test';

type Cached = { status: number; headers: Record<string, string>; body: Buffer };

/** One test's asset-cache traffic, read by reporters/stepTimings.ts as an annotation. */
type CacheTally = { hits: number; misses: { path: string; ms: number }[] };

async function serveFromCache(route: Route, cache: Map<string, Cached>, tally: CacheTally) {
	const request = route.request();
	if (request.method() !== 'GET') return route.fallback();
	const key = request.url();
	const hit = cache.get(key);
	if (hit) {
		tally.hits += 1;
		return route.fulfill(hit);
	}
	const started = Date.now();
	const response = await route.fetch();
	tally.misses.push({ path: new URL(key).pathname, ms: Date.now() - started });
	if (response.status() !== 200) return route.fulfill({ response });
	// A cookie set on one test's response must not be replayed into the next test's context.
	const { 'set-cookie': _dropped, ...headers } = response.headers();
	const entry: Cached = { status: 200, headers, body: await response.body() };
	cache.set(key, entry);
	return route.fulfill(entry);
}

export const test = base.extend<
	{
		cacheStaticAssets: boolean;
		previewTraffic: void;
		previewScreenStub: void;
		modelReplay: void;
		upstreamAdvisory: void;
		agentServiceFake: void;
		recordedViewport: void;
		firstNavigation: void;
		footprint: void;
		layoutShifts: void;
		welcome: 'seen' | 'show';
		welcomeHandled: void;
	},
	{ staticAssetCache: Map<string, Cached> }
>({
	// Playwright reads a fixture's dependencies from its destructured first argument, so one with none
	// must still destructure an empty object.
	// eslint-disable-next-line no-empty-pattern
	staticAssetCache: [async ({}, use) => use(new Map()), { scope: 'worker' }],

	// A spec that throttles the network (CDP Network.emulateNetworkConditions) sets this false with
	// test.use: a route-fulfilled response skips the throttle, so the slow-connection specs measured a
	// fast one (site-header-first-paint 9.7s -> 2.2s in CI). With it off, no route is registered and
	// the context keeps Chromium's own HTTP cache and network path.
	cacheStaticAssets: [true, { option: true }],

	// Every page a test opens presses past the first-run welcome whenever it shows, so a change
	// to the welcome reds only the specs about it. Those set `test.use({ welcome: 'show' })` and handle
	// it themselves. Nothing is saved up front: marking it seen through a guest session before the test
	// signs in carries that sparse guest settings row into the new account, which changed what 59
	// unrelated tests saw.
	welcome: ['seen', { option: true }],

	welcomeHandled: [
		async ({ context, welcome }, use) => {
			if (welcome === 'seen') {
				const handle = (page: Page) => {
					const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
					// A page that closes before the registration lands rejects it; there is nothing left to welcome.
					page.addLocatorHandler(dialog, () => startChattingPastWelcome(dialog)).catch(() => {});
				};
				context.pages().forEach(handle);
				context.on('page', handle);
			}
			await use();
		},
		{ auto: true }
	],

	previewTraffic: [
		async ({ context, baseURL, staticAssetCache, cacheStaticAssets }, use, testInfo) => {
			const origin = baseURL ? new URL(baseURL).origin : null;
			const sameOrigin = (url: URL) => origin !== null && url.origin === origin;
			const tally: CacheTally = { hits: 0, misses: [] };

			if (cacheStaticAssets) {
				await context.route(
					(url) => sameOrigin(url) && isCacheable(url),
					async (route: Route) => {
						try {
							await serveFromCache(route, staticAssetCache, tally);
						} catch (error) {
							// A page can still be loading an asset when its test ends and the context closes.
							// That request has nobody left to answer. And a spec that unroutes its own page
							// (forget-in-two-tabs.spec.ts) makes Playwright continue every request that page's
							// handler held, assets included, so this fulfil finds it already answered from the
							// network. Anything else is a real failure.
							if (!/disposed|closed|Test ended|already handled/i.test(String(error))) throw error;
						}
					}
				);
			}

			await context.addInitScript(() => {
				const realFetch = window.fetch.bind(window);
				window.fetch = (input, init) => {
					const url = new URL(input instanceof Request ? input.url : String(input), location.href);
					if (
						url.origin === location.origin &&
						url.pathname.endsWith('/api/warm') &&
						!url.searchParams.has('target')
					) {
						return Promise.resolve(new Response(null, { status: 204 }));
					}
					return realFetch(input, init);
				};
			});

			await use();
			if (cacheStaticAssets)
				testInfo.annotations.push({
					type: ASSET_CACHE_ANNOTATION,
					description: JSON.stringify(tally)
				});
		},
		{ auto: true }
	],

	// On a PR preview, each chat send asks for the server's stub screen, which allows
	// everything after a fixed pause, so the suite stops queueing the one Shieldstral GPU production
	// screens through (previewScreenStub.ts). A test tagged `@real-screen` reads a verdict, a decline or
	// an everyday question that must not be declined, and keeps the real screen. The headers go on in
	// the page's own fetch, ahead of any page.route, so a spec's fault header is added beside them
	// rather than in place of them. Without the token (production) or in the gallery
	// (SCENARIO_NO_CANNED_REPLIES) nothing is sent, so the real screen runs there and its verdict replays
	// (SOL-258); the shared development site ignores a plain `stub` either way; a development build at its own
	// deployment URL honours it (SOL-198). A test tagged `@stub-screen` films nothing and reads
	// no verdict, so it asks for the stub even in the gallery, with `stub-tagged`, the one value
	// the shared development site honours.
	previewScreenStub: [
		async ({ context }, use, testInfo) => {
			const token = process.env.E2E_FAULT_INJECT_TOKEN;
			const tagged = testInfo.tags.includes('@stub-screen');
			const stub =
				Boolean(token) &&
				(process.env.SCENARIO_NO_CANNED_REPLIES !== '1' || tagged) &&
				!testInfo.tags.includes('@real-screen');
			if (stub) {
				await context.addInitScript(
					([token, asked]: [string, string]) => {
						const realFetch = window.fetch.bind(window);
						window.fetch = (input, init) => {
							const request = input instanceof Request ? input : null;
							const url = new URL(request ? request.url : String(input), location.href);
							const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
							if (
								url.origin !== location.origin ||
								method !== 'POST' ||
								!/\/conversation\/[a-f0-9]+$/.test(url.pathname)
							)
								return realFetch(input, init);
							const headers = new Headers(init?.headers ?? request?.headers);
							headers.set('x-e2e-fault-inject-token', token);
							headers.set('x-e2e-screen', asked);
							return realFetch(input, { ...init, headers });
						};
					},
					[token!, tagged ? 'stub-tagged' : 'stub'] as [string, string]
				);
			}
			testInfo.annotations.push({ type: 'screen', description: stub ? 'stub' : 'real' });
			await use();
		},
		{ auto: true }
	],

	// Every model call a chat send makes is answered from a recording when one matches, and
	// recorded when none does, so a second run of the same head buys no model calls. Recordings are
	// keyed on the whole request body, so a change to our prompt, history or harness misses and goes
	// live; replay hides only upstream drift on identical input. A test tagged `@no-replay` needs that
	// drift and goes live; `@no-replay` runs on develop push and nightly, never in the gallery's grade (SOL-287). A miss is
	// answered with a mock (MOCK_ANSWER in modelReplay.ts) and calls no model, on every attempt, so an
	// upstream outage cannot redden a run; a spec that reads the answer's content needs a recording, made by
	// a run with E2E_REPLAY_MODE=record (the `scenarios:record` PR label). E2E_REPLAY_MODE=none
	// fails any miss, which proves a run made zero live calls. The header goes on beside a spec's own
	// fault header, so replay and a named fault apply to the same send. In a record run a retry sends
	// `all`: it calls the live model and records over the answer, so one bad draw recorded on the first
	// attempt does not fail every retry and later run on the branch (SOL-166). `mock` and `none` stay as
	// they are on a retry. `record-misses` (the journey gallery, SOL-287) records a miss on every
	// attempt and never re-asks a recorded turn, so a retry there cannot go live and meet an outage. It
	// sends `nearest`, which also reads the base branch's recording of the same conversation when only the
	// graded build's own persona prompt differs, so a turn goes live only when nobody has recorded it.
	modelReplay: [
		async ({ context }, use, testInfo) => {
			const token = process.env.E2E_FAULT_INJECT_TOKEN;
			const mode =
				process.env.E2E_REPLAY_MODE === 'none'
					? 'none'
					: process.env.E2E_REPLAY_MODE === 'record-misses'
						? 'nearest'
						: process.env.E2E_REPLAY_MODE !== 'record'
							? 'mock'
							: testInfo.retry > 0
								? 'all'
								: 'new_episodes';
			const replay =
				Boolean(token) &&
				process.env.E2E_REPLAY_MODE !== 'off' &&
				!testInfo.tags.includes('@no-replay');
			// The guard's verdicts replay too. A `@real-screen` spec exists to read the live screen,
			// so on a run that may call live models (develop push, nightly, promotion) it asks for the live
			// guard, which refreshes a stored verdict off-peak every few days and replays it otherwise
			// (SOL-267, `guardRefreshDue`); a PR run replays what it said most recently.
			const guardLive =
				testInfo.tags.includes('@real-screen') &&
				process.env.SCENARIO_SKIP_LIVE_MODEL !== '1' &&
				mode !== 'none';
			if (replay) {
				await context.addInitScript(
					([token, mode, guardLive]: [string, string, boolean]) => {
						const realFetch = window.fetch.bind(window);
						window.fetch = (input, init) => {
							const request = input instanceof Request ? input : null;
							const url = new URL(request ? request.url : String(input), location.href);
							const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
							// Auto's draft read goes to Clef through the same store.
							if (
								url.origin !== location.origin ||
								method !== 'POST' ||
								!/\/conversation\/[a-f0-9]+$|\/chat\/api\/routing\/classify$/.test(url.pathname)
							)
								return realFetch(input, init);
							const headers = new Headers(init?.headers ?? request?.headers);
							headers.set('x-e2e-fault-inject-token', token);
							headers.set('x-e2e-replay', mode);
							if (guardLive) headers.set('x-e2e-guard', 'live');
							return realFetch(input, { ...init, headers });
						};
					},
					[token!, mode, guardLive] as [string, string, boolean]
				);
			}
			testInfo.annotations.push({ type: 'model-replay', description: replay ? mode : 'live' });
			await use();
			// A failed attempt whose page shows a mock answer most likely failed because no
			// recording matched (a prompt edit changes every key), not because the PR broke the test.
			// helpers/replayMiss.ts says how the line reaches the verdict.
			if (
				replay &&
				mode === 'mock' &&
				testInfo.status !== testInfo.expectedStatus &&
				(await mockAnswerShown(context.pages()))
			) {
				testInfo.annotations.push({
					type: 'replay-miss',
					description: 'a mock answer is on the page'
				});
				console.log(replayMissLine(testInfo));
			}
		},
		{ auto: true }
	],

	// Which models this test started chats on, and, after a failed attempt, whether the page
	// shows our own timed-out notice. quarantineOutcomes.ts reads both to mark a failure advisory
	// (helpers/upstreamAdvisory.ts). createConversation.ts sends the model on every new chat, the default
	// included, so a test that chats on the default records it and blocks.
	upstreamAdvisory: [
		async ({ context }, use, testInfo) => {
			const models = new Set<string>();
			const onRequest = (req: import('@playwright/test').Request) => {
				if (req.method() !== 'POST' || !/\/chat\/conversation$/.test(new URL(req.url()).pathname))
					return;
				try {
					const model = (req.postDataJSON() as { model?: unknown } | null)?.model;
					if (typeof model === 'string' && model) models.add(model);
				} catch {
					// A body that is not JSON names no model.
				}
			};
			context.on('request', onRequest);
			await use();
			context.off('request', onRequest);
			if (models.size > 0)
				testInfo.annotations.push({
					type: CHAT_MODELS_ANNOTATION,
					description: [...models].join(',')
				});
			if (
				testInfo.status !== testInfo.expectedStatus &&
				(await upstreamNoticeShown(context.pages()))
			)
				testInfo.annotations.push({
					type: UPSTREAM_UNANSWERED_ANNOTATION,
					description: 'the timed-out notice is on the page'
				});
		},
		{ auto: true }
	],

	// Every agent turn a chat send starts goes to the deployment's in-process stand-in for
	// agent-service (fakeAgentService.ts), so the suite stops queueing on the one shared agent machine
	// every shard and preview shares, which runs four tasks at a time. The stand-in paces a run past the
	// 20s turn deadline, ends with the prompt's `receipt <nonce>` line and writes the file a prompt asks
	// for. A test tagged `@real-agent` needs a real agent's answer and sends no header; a PR's run leaves
	// those out and a develop push run keeps them (playwright.config.ts). The gallery (SOL-287) uses the
	// stand-in too; twelve gallery browsers on a four-slot machine graded its capacity, not our code.
	agentServiceFake: [
		async ({ context }, use, testInfo) => {
			const token = process.env.E2E_FAULT_INJECT_TOKEN;
			const fake = Boolean(token) && !testInfo.tags.includes('@real-agent');
			// A tag `@agent-knob:<knob>` asks the stand-in for one of its FAKE_AGENT_KNOBS, e.g. a 429.
			const knobs = testInfo.tags
				.filter((t) => t.startsWith('@agent-knob:'))
				.map((t) => t.slice('@agent-knob:'.length));
			const agentHeader = ['fake', ...knobs].join(';');
			if (fake) {
				await context.addInitScript(
					({ token, agentHeader }: { token: string; agentHeader: string }) => {
						const realFetch = window.fetch.bind(window);
						window.fetch = (input, init) => {
							const request = input instanceof Request ? input : null;
							const url = new URL(request ? request.url : String(input), location.href);
							const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
							if (
								url.origin !== location.origin ||
								method !== 'POST' ||
								!/\/conversation\/[a-f0-9]+$/.test(url.pathname)
							)
								return realFetch(input, init);
							const headers = new Headers(init?.headers ?? request?.headers);
							headers.set('x-e2e-fault-inject-token', token);
							headers.set('x-e2e-agent', agentHeader);
							return realFetch(input, { ...init, headers });
						};
					},
					{ token: token!, agentHeader }
				);
			}
			testInfo.annotations.push({ type: 'agent-service', description: fake ? 'fake' : 'live' });
			await use();
		},
		{ auto: true }
	],

	// The recorder is sized once per worker from the device, so a test that narrows the window
	// with test.use({ viewport }) is drawn into the top-left of a larger frame and the rest is padded
	// grey. The graders read that band as a broken screen. The reporter copies this annotation into the
	// recording's meta.json, and critique-journey.mjs crops each frame to it.
	recordedViewport: [
		async ({ viewport }, use, testInfo) => {
			if (viewport)
				testInfo.annotations.push({
					type: 'viewport',
					description: `${viewport.width}x${viewport.height}`
				});
			await use();
		},
		{ auto: true }
	],

	// The recording starts when the test's first page exists, and a test that signs accounts in
	// or calls an API before its first `goto` films that setup as a blank tab, which the gallery filed as
	// the product's first screen taking 4 s. This stamps when that page first asks for a document, and the
	// reporter turns it into `navigatedAtMs` so the opening blank is counted from there.
	firstNavigation: [
		async ({ context }, use, testInfo) => {
			let stamped = false;
			const watch = (page: Page) =>
				page.on('request', (request) => {
					if (stamped || !request.isNavigationRequest() || request.frame() !== page.mainFrame())
						return;
					stamped = true;
					testInfo.annotations.push({ type: 'first-navigation', description: String(Date.now()) });
				});
			const [existing] = context.pages();
			if (existing) watch(existing);
			else context.once('page', watch);
			await use();
		},
		{ auto: true }
	],

	// With E2E_FOOTPRINTS=1 (scenario-suite-check.yml sets it), every same-origin request this
	// test's pages make is kept as a `METHOD /path` line and attached, and reporters/footprints.ts writes
	// them per test to e2e-footprints/footprints.json. Selection does not read it yet.
	footprint: [
		async ({ context, baseURL }, use, testInfo) => {
			const origin = process.env.E2E_FOOTPRINTS === '1' && baseURL ? new URL(baseURL).origin : null;
			const lines = new Set<string>();
			// The page reads each posted turn's stream itself and reports what it ran through
			// TURN_BINDING. A turn with no report (still running at teardown, aborted, a closed page)
			// leaves `RAN recorded` off, and selection then keeps this test's whole closure.
			let posted = 0;
			const reports: boolean[] = [];
			if (origin) {
				context.on('request', (request) => {
					const line = footprintLine(request.method(), request.url(), origin);
					if (line) lines.add(line);
					if (!isTurnRequest(request.method(), request.url(), origin)) return;
					posted += 1;
					for (const ran of turnLines(false, request.postData())) lines.add(ran);
				});
				await context.exposeBinding(TURN_BINDING, (_source, turn: { searched?: unknown }) => {
					reports.push(turn?.searched === true);
				});
				await context.addInitScript({ content: turnWatcherScript() });
			}
			await use();
			if (origin) {
				const deadline = Date.now() + 5_000;
				while (reports.length < posted && Date.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 100));
				if (reports.length >= posted) lines.add(RAN_RECORDED);
				if (reports.some(Boolean)) lines.add(RAN_WEB);
				await testInfo.attach(FOOTPRINT_ATTACHMENT, {
					body: [...lines].join('\n'),
					contentType: 'text/plain'
				});
			}
		},
		{ auto: true }
	],

	// Every layout shift a page reports, for the journey reporter to place in the video.
	// Capture-only: nothing here fails a test.
	layoutShifts: [
		async ({ context }, use, testInfo) => {
			const shifts: LayoutShift[] = [];
			await context.exposeBinding(LAYOUT_SHIFT_BINDING, (_source, shift: LayoutShift) => {
				if (shifts.length < MAX_LAYOUT_SHIFTS) shifts.push(shift);
			});
			await context.addInitScript({ content: layoutShiftScript() });
			await use();
			if (shifts.length > 0)
				await testInfo.attach(LAYOUT_SHIFTS_ATTACHMENT, {
					body: JSON.stringify(shifts),
					contentType: 'application/json'
				});
		},
		{ auto: true }
	]
});
