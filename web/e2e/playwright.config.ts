// The scenario suite that runs against a live deployed preview + a real Postgres
// database (.github/workflows/scenario-suite-check.yml). NOT vitest's `client` project — that's a
// browser sandbox with no real backend. `@playwright/test` is the test runner; `playwright` itself is
// the automation library web/scripts/fuzz/agent-loop.mjs drives directly via Stagehand.
//
// The preview it targets is Vercel's own per-PR deploy.
//
// No env-var validation at module scope: knip's Playwright plugin (and ci.yml's `check` job)
// both import this file directly to read `testDir`/`projects` without setting SCENARIO_BASE_URL,
// so a top-level throw here breaks `pnpm audit:knip`.
// The real "did you forget to set this" guard lives in ./scenarios/global-setup.ts, which
// Playwright only invokes when a test run starts, not when a config is merely loaded.
import { defineConfig, devices } from '@playwright/test';
import { entryPattern, readQuarantine } from './quarantine.mjs';
import { WITHDRAWN } from '../config/picker';

// The opt-in mobile viewport, declared here so `defineConfig` below can reference it —
// a `const` is in its temporal dead zone until this line runs, so the declaration has to precede
// the use rather than follow it.
//
// `Pixel 7` is chromium-based, so no second browser download, and carries `isMobile` and `hasTouch`.
// That last part is the whole point: A1's Known gaps records that the side rail loads collapsed, so
// "Log in" and "Signed in as {name}" are icon-only with their text reachable only through a hover
// title — and hover does not exist on touch (CUR-1466). Desktop cannot see that and never will.
//
// A- and F-journeys only. The persona specs (`@P\d+`) are deliberately excluded: each drives a live
// model, so a second viewport doubles their inference bill rather than their runtime, and nothing
// about a chaos-monkey run needs a phone to be worth reading.
// Every anonymous test's cookie-less first request is a legitimate trigger for
// auth.ts's mintOrAdoptAnonymousSession() coalescing (CUR-1240) — designed to fold one real
// browser's own parallel requests into one session, keyed on (IP, User-Agent) within a 2s
// window. Two DIFFERENT test files running concurrently on CI share one runner's egress IP
// and, absent this, Chromium's own identical default UA string — so at `workers: 2` (below)
// two unrelated tests' anonymous sessions coalesce into one almost every run, and each test's
// own full-object settings POST (settings.ts's setSettings/initValue/instantSet all send the
// client's complete local store, not a delta) then stomps the other's just-saved fields.
// Two raw curl POSTs sharing an IP+UA within the window reproduce it with no browser timing:
// application-settings.spec.ts's `raw`/`true` write was overwritten back to `smooth`/`false` by a
// second, unrelated write to the same coalesced session. `TEST_PARALLEL_INDEX` (set per worker
// PROCESS, before that process's own re-import of this config file — see workerProcessEntry.js)
// gives every worker slot a distinct value, so two tests that could genuinely run at the same
// instant always carry different UAs and can never coalesce with each other. Two tests queued
// sequentially on the SAME worker still share a UA, but that is the same-real-browser case
// this coalescing feature exists to handle, not a foreign test.
const workerUaSuffix = ` CUR1643Worker/${process.env.TEST_PARALLEL_INDEX ?? '0'}`;

// Record at the viewport's own size, never the 800x800 box `video: 'on'` fits a page into.
// At 800x450 the chat status line's small type lands near 7px and the journey critic misreads it
// (CUR-1956), while the trace holds the right text in the DOM. A single fixed size here would be
// wrong for one project or the other: 1280x720 squeezes the phone's 412x839 down to fit 720 high.
// Only a run that grades its recordings records them. journey-gallery.yml and
// persona-dogfood.yml set SCENARIO_VIDEO=1; every other run, the per-PR gate above all, records
// nothing, and helpers/recording.ts skips its camera holds to match.
const RECORD = process.env.SCENARIO_VIDEO === '1';
const recordAt = (device: (typeof devices)[string]) =>
	RECORD ? { mode: 'on' as const, size: device.viewport } : ('off' as const);

// scenarios/auth.setup.ts proves the deployment accepts a session minted by e2e/testAuth.ts
// before any spec that signs in through helpers/session.ts runs, so a wrong secret or cookie prefix
// fails once, at a step named for it. Every test project depends on it and none of them collects it.
//
// SCENARIO_SKIP_AUTH_SETUP drops it for a run whose specs sign nobody in. scenario-suite-live.yml sets
// it: no @live spec calls helpers/session.ts, and on production the step cannot pass at all, since it
// switches sign-in on through a flag override production does not honour.
const SKIP_AUTH_SETUP = !!process.env.SCENARIO_SKIP_AUTH_SETUP;
const AUTH_SETUP = { name: 'auth-setup', testMatch: /auth\.setup\.ts$/ };
const AFTER_AUTH_SETUP = {
	dependencies: SKIP_AUTH_SETUP ? [] : [AUTH_SETUP.name],
	testIgnore: /auth\.setup\.ts$/
};

const MOBILE_PROJECT = {
	name: 'mobile-chromium',
	...AFTER_AUTH_SETUP,
	use: {
		...devices['Pixel 7'],
		userAgent: devices['Pixel 7'].userAgent + workerUaSuffix,
		video: recordAt(devices['Pixel 7'])
	},
	grep: /@(?:A\d+|F\d+)\b/
};

// Desktop Firefox, opt-in through SCENARIO_FIREFOX so no existing run changes. Many visitors use
// Firefox, and every other project here is Chromium. It runs the two journeys a Firefox-
// only defect would hurt most, signing in and sending a message, rather than the whole suite: a full
// second pass would double the suite's runner minutes. scenario-suite-check.yml runs it on develop
// pushes as one warn-only matrix entry.
const FIREFOX_PROJECT = {
	name: 'firefox',
	...AFTER_AUTH_SETUP,
	testMatch: /(?:^|\/)(?:sign-in|chat-message-send)\.spec\.ts$/,
	use: {
		...devices['Desktop Firefox'],
		userAgent: devices['Desktop Firefox'].userAgent + workerUaSuffix,
		video: recordAt(devices['Desktop Firefox'])
	}
};

/** Tags left out of this run, as one `@(?:a|b)\b` pattern, or undefined when nothing is. */
const EXCLUDED_TAGS = [
	process.env.SCENARIO_THIRD_PARTY === '1' ? null : 'third-party',
	// @root specs drive a chat-surface deployment (APP_SURFACE=chat, chat at its host's root,
	// e.g. alpha-develop). Only a run against one sets SCENARIO_CHAT_SURFACE=1; every site-surface run
	// (PR previews, develop, www, the gallery) leaves them out.
	process.env.SCENARIO_CHAT_SURFACE === '1' ? null : 'root',
	process.env.SCENARIO_LOCAL_MOCK === '1' ? null : 'local-mock',
	// @linked-bucket links current-ai-official/e2e-linked with E2E_LINKED_BUCKET_TOKEN. The
	// scenario workflow sets SCENARIO_LINKED_BUCKET=1 when the preview secrets hold that token.
	process.env.SCENARIO_LINKED_BUCKET === '1' ? null : 'linked-bucket',
	// @output-screen specs drive the output screen (a fault that blocks, times out or cannot reach it),
	// or pass only because it did not withhold an answer. With OUTPUT_MODERATION off they fail, or pass
	// with nothing screened. The scenario workflows set SCENARIO_OUTPUT_SCREEN=1 when the preview
	// has OUTPUT_MODERATION on, so these run again when it does.
	process.env.SCENARIO_OUTPUT_SCREEN === '1' ? null : 'output-screen',
	// @apex-rp needs a build whose passkey RP ID matches the host under test. Develop's build sets it
	// to the apex, so a develop push run against the commit's *.vercel.app URL leaves it out; the
	// journey gallery's alias leg runs it there instead.
	process.env.SCENARIO_SKIP_APEX_RP === '1' ? 'apex-rp' : null,
	// @no-replay specs need a live model answer every run, so a PR's run leaves them out and
	// replays the rest; develop's push run runs them live (helpers/test.ts's modelReplay fixture).
	// Not `@live-…`: every www filter matches `@live` unanchored, so such a tag would join the www set (CUR-3852).
	process.env.SCENARIO_SKIP_LIVE_MODEL === '1' ? 'no-replay' : null,
	// @real-agent specs need agent-service itself, where every other spec gets the in-process
	// stand-in (helpers/test.ts's agentServiceFake), so a PR's run leaves them out the same way.
	process.env.SCENARIO_SKIP_LIVE_MODEL === '1' ? 'real-agent' : null,
	// A model on config/picker.ts's WITHDRAWN list is served nowhere, so a spec that pins it
	// (`@needs-apertus`) has nothing to talk to. Deleting the entry brings the model and its specs back.
	...WITHDRAWN.map((w) => w.specTag)
].filter((tag): tag is string => tag !== null);

// e2e/quarantine.json lists flaky scenarios that stop blocking merges while their owner
// ticket is open. Only a run that sets SCENARIO_QUARANTINE=1 leaves them out, and only
// scenario-suite-check.yml sets it, on pull_request runs. Every other run, that workflow's develop
// push above all, still runs them, so a quarantined spec keeps reporting (CUR-4151).
const QUARANTINED =
	process.env.SCENARIO_QUARANTINE === '1' ? readQuarantine().map(entryPattern) : [];
const GREP_INVERT = [
	...(EXCLUDED_TAGS.length ? [new RegExp(`@(?:${EXCLUDED_TAGS.join('|')})\\b`)] : []),
	...QUARANTINED
];

export default defineConfig({
	testDir: './scenarios',
	globalSetup: './scenarios/global-setup.ts',
	// A file's tests may run on different workers, and so on different CI shards, which is
	// what lets scripts/shard-plan.mjs pack tests rather than whole files. A file whose tests share
	// state opts out with test.describe.configure({ mode: 'default' }) (social-sign-in.spec.ts) or
	// 'serial', and the planner keeps that file whole.
	fullyParallel: true,
	// @third-party scenarios call a service we don't run (the TTS Space), so they stay out of
	// every gating run and the gallery, and run only where SCENARIO_THIRD_PARTY=1 asks for them
	// (scenario-suite-live.yml's develop leg).
	//
	// @local-mock scenarios sign in through the mock identity provider, which runs only inside
	// the test run on localhost (sign-in-local.yml sets SCENARIO_LOCAL_MOCK=1), never on a deployment.
	grepInvert: GREP_INVERT.length ? GREP_INVERT : undefined,
	// Raised from 1 once the suite's own OTP send/verify calls stopped sleeping ahead of Better Auth's
	// per-IP cap, which is what `workers: 1` was protecting against (CUR-1553).
	//
	// Raising `workers` does not put two attempts of the same test in flight at once: retries of one
	// test are sequential by construction, attempt 0 finishing before attempt 1 starts on a different
	// worker. journeyArtifacts.ts's protection against collisions is `recordingSlug` keying each
	// recording by test title + project (CUR-1550), which two different tests running concurrently
	// can never share.
	//
	// Timed against the live preview at workers 1, 2 and 4: 1 and 2 passed the suite (2 about twice as
	// fast), 4 failed, including a real backend 500 under load. The preview tier has a concurrency
	// ceiling well below what a bigger CI box could drive, and 4 crossed it; 2 is the highest value it
	// holds up under.
	workers: 2,
	retries: process.env.CI ? 1 : 0,
	// 90s. chat-message-send's worst case is a 30s poll for an actionable composer, then up to 30s
	// for the conversation URL, then 10s for the message bubble: 70s of legitimate waiting that 60s
	// could cut off mid-flight and report as a failure. Raising a ceiling is a widening, not a
	// narrowing: a test that was going to pass still passes, and a stuck one costs 30s more before it
	// says so.
	timeout: 90_000,
	// './reporters/journeyArtifacts.ts' re-homes each @A1/@F2/...-tagged test's video to a
	// journey-keyed path so a critique pass can find "the current recording for A1" without guessing
	// at a path built from the spec filename and the test's title string.
	// './reporters/flakyTests.ts' surfaces a test that failed then passed on the retry
	// `retries` grants above. None of the other three reporters say anything about it — `github`
	// annotates only real failures and `list` prints a tick — so before this the run was green and
	// the retry was invisible. It runs in both modes deliberately: a local `retries: 0` run can
	// never produce a flaky outcome, so the reporter is inert there rather than wrong, and keeping
	// one reporter list means CI is not the only place the wiring is ever exercised.
	// './reporters/taggedOutcomes.ts' is the one place that records every journey-tagged
	// test's final outcome, including a SKIPPED one — the case none of the other three reporters (nor
	// journeyArtifacts.ts's own meta.json, which needs a video attachment that a skip never produces)
	// can see. journey-gallery.yml's commit check reads its output; kept in both modes for the same
	// wiring-exercise reason as flakyTests.ts above.
	// './reporters/quarantineOutcomes.ts' records which failures e2e/quarantine.json covers,
	// so journey-gallery.yml's fail step can pass a run whose only failures are quarantined.
	// './reporters/redactTraceSecrets.ts' replaces the secret header values in each trace.zip
	// as its test ends, since a trace records route-added headers and the traces are uploaded.
	// './reporters/stepTimings.ts' prints, at shard end, where test time went by kind of step.
	// './reporters/footprints.ts' writes each test's recorded requests when E2E_FOOTPRINTS=1.
	reporter: process.env.CI
		? [
				['github'],
				['list'],
				['./reporters/journeyArtifacts.ts'],
				['./reporters/flakyTests.ts'],
				['./reporters/taggedOutcomes.ts'],
				['./reporters/quarantineOutcomes.ts'],
				['./reporters/redactTraceSecrets.ts'],
				['./reporters/stepTimings.ts'],
				['./reporters/footprints.ts']
			]
		: [
				['list'],
				['./reporters/journeyArtifacts.ts'],
				['./reporters/flakyTests.ts'],
				['./reporters/taggedOutcomes.ts'],
				['./reporters/quarantineOutcomes.ts'],
				['./reporters/redactTraceSecrets.ts'],
				['./reporters/stepTimings.ts'],
				['./reporters/footprints.ts']
			],
	use: {
		baseURL: process.env.SCENARIO_BASE_URL,
		// The bypass header is injected by helpers/signIn.ts via page.route(), scoped to exactly the two
		// auth paths otpSendCapCarveOut reads it on. A global extraHTTPHeaders would send it on every
		// request, and a custom header on a cross-origin request forces a CORS preflight that
		// fonts.gstatic.com refuses, logging a console error on every font fetch.
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		// On only where a grader reads it (RECORD, above). It is not a debugging artifact: a failure
		// already keeps its trace, which holds every frame's DOM. A passing graded run is the
		// recording design and the journey critic read, so it is kept whether the suite passed or not.
		//
		// What it does NOT prove: the video walks the path the SPEC walks. A thin scenario records a
		// convincing thirty seconds of nothing. Write the scenario from the ticket's own "what people
		// should see" if the recording is meant to stand as evidence the feature exists.
		// Left at the default frame size deliberately: a scenario weighs ~300 KB either way (302 KB at
		// 1280x720, 301 KB at 800x450). VP8 on a mostly-static page is bitrate-bound by motion, not by
		// resolution, so shrinking the frame buys nothing and only makes the recording harder to read. The
		// lever that does work is retention and upload scope, both set in scenario-suite-check.yml.
		//
		// The 800x450 above is what `video: 'on'` (no `size:`) scales a recording down to, never a real
		// viewport option: this file sets no `viewport`, so Playwright's own default, 1280x720, is the real
		// one, and 'on' fits that into an 800x800 box (1280x720 * 0.625 = 800x450). Reproduce a recording's
		// problem at 1280x720, not at the literal 800x450. Each project below overrides this to record at
		// its own viewport's size.
		video: RECORD ? 'on' : 'off'
	},
	// A second entry here is safe because the recording path carries the project
	// (`<test-slug>--<project>`), so entries do not collide on a directory named from the test title
	// alone. `workers` is global in Playwright, not per project, so the two project runs of a test are
	// serial, not concurrent; without the project in the path the second would silently overwrite the
	// first.
	//
	// Mobile is OFF by default and opts in through `JOURNEY_MOBILE_VIEWPORT`: desktop A1–A4 and A8 do
	// not all grade clean yet, and a second viewport doubles both the unread verdicts and the grading
	// cost. The gallery states the narrowing in its configuration line, because a page that cannot tell
	// "mobile is off" from "mobile ran and recorded nothing" would hide it. That notice disappears by
	// itself when the default flips.
	projects: [
		...(SKIP_AUTH_SETUP ? [] : [AUTH_SETUP]),
		{
			name: 'chromium',
			...AFTER_AUTH_SETUP,
			use: {
				...devices['Desktop Chrome'],
				userAgent: devices['Desktop Chrome'].userAgent + workerUaSuffix,
				video: recordAt(devices['Desktop Chrome'])
			}
		},
		...(process.env.JOURNEY_MOBILE_VIEWPORT ? [MOBILE_PROJECT] : []),
		...(process.env.SCENARIO_FIREFOX === '1' ? [FIREFOX_PROJECT] : [])
	]
});
