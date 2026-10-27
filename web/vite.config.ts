import { readFileSync, promises } from 'node:fs';
import { dirname, resolve as resolvePath, sep } from 'node:path';
import type { Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideOptions } from './paraglide.config.js';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { config } from 'dotenv';

config({ path: './.env.local', quiet: true });

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Canonical site origin, baked in at build for absolute URLs (e.g. og:image) on
// prerendered pages. Vercel sets VERCEL_PROJECT_PRODUCTION_URL on every deploy.
const siteOrigin = process.env.VERCEL_PROJECT_PRODUCTION_URL
	? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
	: '';

// CUR-4448: which app this build serves (src/lib/surface.ts). Deployment identity like INSTANCE, read
// at build time so the server and client bundles agree on `base` and `reroute`. Unset is `site`; an
// unknown value fails the build rather than guessing which app to ship.
const appSurface = (() => {
	const raw = process.env.APP_SURFACE?.trim() ?? '';
	if (raw === '' || raw === 'site') return 'site';
	if (raw === 'chat') return 'chat';
	throw new Error(
		`APP_SURFACE="${raw}" is neither "site" nor "chat"; refusing to guess which app to build`
	);
})();

// Specs that need a live DB + auth context — excluded from hermetic CI unless TEST_LIVE=true.
const NON_HERMETIC_SERVER_SPECS = [
	'src/routes/chat/login/callback/updateUser.spec.ts',
	'src/lib/chat/server/api/__tests__/conversations-id.spec.ts',
	'src/lib/chat/server/api/__tests__/user.spec.ts'
];

// Postgres-backed specs that share one database and use table-wide cleanup.
// These stay serial (one worker); everything else can run file-parallel.
const STATEFUL_SERVER_SPECS = [
	'src/lib/chat/server/api/__tests__/conversations.spec.ts',
	'src/lib/chat/server/api/__tests__/conversations-message.spec.ts',
	'src/lib/chat/server/api/__tests__/misc.spec.ts',
	'src/lib/chat/server/db/__tests__/cleanup.spec.ts',
	// CUR-4116: the owner-key lock, against real Postgres advisory locks.
	'src/lib/chat/server/db/__tests__/advisoryLock.spec.ts',
	'src/lib/chat/server/db/__tests__/deleteConversations.spec.ts',
	'src/lib/chat/server/db/__tests__/wipeUserData.spec.ts',
	'src/lib/chat/server/db/__tests__/nullByteSanitize.spec.ts',
	'src/lib/chat/server/db/__tests__/concurrentWrites.spec.ts',
	'src/lib/chat/server/db/__tests__/eventWindow.spec.ts',
	'src/lib/chat/server/db/__tests__/searchConversations.spec.ts',
	// CUR-4576: past-chat search never reads another account's chats, against the real schema.
	'src/lib/chat/server/db/__tests__/pastChats.spec.ts',
	'src/lib/chat/server/db/__tests__/ownReports.spec.ts',
	'src/lib/chat/server/db/__tests__/guardDailyCounts.spec.ts',
	'src/lib/chat/server/db/__tests__/localInferencePairings.spec.ts',
	'src/lib/chat/server/db/__tests__/uploadChunks.spec.ts',
	// CUR-4312: sync tokens, push idempotency and tombstones, against real Postgres.
	'src/lib/chat/server/sync/__tests__/sync.spec.ts',
	'src/lib/chat/server/endpoints/openai/replayStore.spec.ts',
	'src/lib/chat/server/betterAuth.accountMerge.spec.ts',
	'src/lib/chat/server/betterAuth.selfInvite.spec.ts',
	'src/lib/chat/server/__tests__/generations.spec.ts',
	// CUR-4629: a probe or turn marks a model down and Auto routes around it, against real alert_state.
	'src/lib/chat/server/__tests__/autoSkipsDownModel.spec.ts',
	'src/lib/chat/server/__tests__/conversation-stop-generating.spec.ts',
	'src/lib/chat/server/__tests__/workspaceUsage.spec.ts',
	'src/lib/chat/server/__tests__/accountUsage.spec.ts',
	'src/lib/chat/server/__tests__/currentWorkspace.spec.ts',
	'src/lib/chat/server/rag/__tests__/adminStoreScope.spec.ts',
	'src/lib/chat/server/__tests__/resumeWorkspace.spec.ts',
	'src/lib/chat/server/layoutData.spec.ts',
	'src/lib/chat/server/localModels.spec.ts',
	'src/lib/chat/server/humanEval/humanEval.flow.spec.ts',
	'src/lib/chat/server/api/__tests__/localInferenceEndpoints.spec.ts',
	'src/lib/chat/server/api/__tests__/localInferencePairingLink.spec.ts',
	'src/lib/chat/server/api/__tests__/cleanupRoute.spec.ts',
	'src/routes/chat/conversation/[id]/report/report.spec.ts',
	'src/routes/chat/conversation/[id]/server.turn.spec.ts',
	'src/routes/chat/api/v2/export/export.spec.ts',
	'src/lib/chat/server/mcp/elicitation.spec.ts',
	'src/lib/chat/utils/tree/treeHelpers.spec.ts',
	'src/lib/chat/utils/tree/addChildren.spec.ts',
	'src/lib/chat/utils/tree/addSibling.spec.ts',
	'src/lib/chat/utils/tree/buildSubtree.spec.ts',
	'src/lib/chat/utils/tree/convertLegacyConversation.spec.ts',
	// Outside src/ on purpose: it spawns the standalone DB verifier SCRIPTS (verify:cleanup,
	// verify:drizzle-slice, db:verify) as processes and asserts they exit 0. Those run in CI's
	// stateful job but belong to no other vitest project, so without this entry a green `pnpm test`
	// would say nothing about them.
	// Listed here rather than matched by a glob because `server-fast`'s include is `src/**`, so a
	// scripts/ path cannot be double-collected by the parallel project.
	'scripts/__tests__/verifiers.spec.ts',
	'scripts/__tests__/dbMigrateParity.spec.ts',
	// CUR-2529: runs the e2e cleanup against real tables.
	'scripts/__tests__/cleanupE2eArtifacts.spec.ts',
	// Included in the stateful project only when TEST_LIVE=true (see include below).
	...NON_HERMETIC_SERVER_SPECS
];

const liveSpecs = 'src/**/*.live.spec.ts';
const svelteSpecs = 'src/**/*.svelte.{test,spec}.{js,ts}';
// CUR-4479: the design system's specs run here, with the app's $app and ~icons, since the package
// has no SvelteKit of its own.
const alphaDsSpecs = '../packages/alpha-ds/src/**/*.{test,spec}.{js,ts}';
const alphaDsSvelteSpecs = '../packages/alpha-ds/src/**/*.svelte.{test,spec}.{js,ts}';

// Load fonts server-side for thumbnail (satori) generation.
function loadTTFAsArrayBuffer() {
	return {
		name: 'load-ttf-as-array-buffer',
		async transform(_src: string, id: string) {
			if (id.endsWith('.ttf')) {
				return `export default new Uint8Array([
												${new Uint8Array(await promises.readFile(id))}
										]).buffer`;
			}
		}
	};
}

// Copy edit mode (src/lib/i18n/copyEdit): on every build except Vercel production, imports of
// `$lib/paraglide/messages.js` get messagesProxy.ts, the same `m` routed through the editor. Production
// keeps Paraglide's module, so none of the mode's code ships there.
const copyEditEnabled = process.env.VERCEL_ENV !== 'production';

function copyEditMessages(): Plugin {
	const proxy = resolvePath('src/lib/i18n/copyEdit/messagesProxy.ts');
	const target = `${sep}src${sep}lib${sep}paraglide${sep}messages.js`;
	return {
		name: 'copy-edit-messages',
		enforce: 'pre',
		async resolveId(source, importer, options) {
			if (!source.includes('paraglide/messages') || importer?.startsWith(dirname(proxy)))
				return null;
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			return resolved && resolved.id.split('?')[0].endsWith(target) ? proxy : null;
		}
	};
}

// SvelteKit options (adapter, compilerOptions, preprocess, prerender) live in svelte.config.js.
export default defineConfig({
	plugins: [
		paraglideVitePlugin(paraglideOptions),
		...(copyEditEnabled ? [copyEditMessages()] : []),
		tailwindcss(),
		sveltekit(),
		Icons({ compiler: 'svelte' }),
		loadTTFAsArrayBuffer()
	],
	// Inlined at build time as the single source of truth for the package version + origin.
	define: {
		__APP_VERSION__: JSON.stringify(version),
		__SITE_ORIGIN__: JSON.stringify(siteOrigin),
		__APP_SURFACE__: JSON.stringify(appSurface),
		__COPY_EDIT__: JSON.stringify(copyEditEnabled)
	},
	build: {
		// CUR-1510: 'hidden' emits .map files without a `//# sourceMappingURL` comment in the shipped
		// chunk, so a browser never fetches them and they're never publicly reachable even if the
		// upload/delete step below fails. scripts/upload-posthog-sourcemaps.mjs takes it from there:
		// tag each chunk with an id, send the maps to PostHog so captured exceptions get readable
		// stacks, then remove the .map files from the Vercel output directory before it's served.
		sourcemap: 'hidden'
	},
	server: {
		port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
		allowedHosts: ['huggingface.ngrok.io'],
		// Copy edit mode reads the message catalogs as written (src/lib/i18n/copyEdit/catalogs.ts).
		fs: { allow: ['messages'] }
	},
	optimizeDeps: {
		include: ['uuid', 'sharp', 'clsx']
	},
	// ES-module workers: chat's markdown worker dynamic-imports KaTeX/highlight.js on demand,
	// which requires the "es" worker format (the default "iife" can't code-split).
	worker: {
		format: 'es'
	},
	test: {
		coverage: {
			provider: 'v8',
			include: ['src/lib/chat/server/**'],
			// `json` writes coverage-final.json, which scripts/patch-coverage.mjs reads (SOL-107).
			reporter: ['text-summary', 'json-summary', 'json'],
			// Baselined for vitest 4, which uses AST-based remapping instead of v8-to-istanbul and removed
			// coverage.ignoreEmptyLines, so lines without runtime code do not pad the denominator. The older
			// method credited branches it could not actually map, so `branches` is the number that sits
			// lowest under the accurate instrument.
			//
			// On 202 files / 2378 tests: statements 68.91%, lines 69.16%, functions 70.66%, branches 61.14%.
			// The chat/** slice below, which is the genuinely well-tested area, measures 97.91 / 93.50 /
			// 96.67.
			//
			// The `branches` floor of 60 sits just under the measured 61.14% rather than at a number chosen
			// to make the gate pass. `functions` has a 4.7-point margin (70.66% against 66), so the next
			// real drop there trips it, which is the point of leaving it where it is.
			//
			// A PR's unit job runs only the specs its diff reaches (UNIT_SELECTED, SOL-261), which
			// measures a slice of the codebase, so it skips the floors and is judged on patch coverage.
			// Develop pushes run every spec and enforce them.
			thresholds:
				process.env.UNIT_SELECTED === 'true'
					? undefined
					: {
							statements: 35,
							branches: 60,
							functions: 66,
							lines: 35,
							'src/lib/chat/server/chat/**': {
								statements: 90,
								branches: 80,
								functions: 90,
								lines: 90
							}
						}
		},
		projects: [
			...(process.env.VITEST_BROWSER === 'true'
				? [
						{
							// Client-side tests (Svelte components), opt-in due to flaky browser harness.
							extends: true as const,
							// esbuild pre-bundling has no .svelte loader, so dep-scanning component
							// imports (@lucide/svelte, vaul-svelte re-export .svelte files) hard-fails
							// the whole project before any test runs. Vite's own transform pipeline
							// (svelte plugin) serves these fine — turn discovery off for tests.
							optimizeDeps: {
								noDiscovery: true,
								include: []
							},
							test: {
								name: 'client',
								// Its own group, so it never has to agree with another project's maxWorkers.
								// vitest 4 throws — before a single test runs — when two projects share a
								// groupOrder and declare different maxWorkers, and every `test:*` script here
								// passes `--project=<one>`, so no CI job can reach the two-project case. The one
								// caller that does is Stryker's dry run (mutation-nightly.yml, which runs the
								// whole workspace with VITEST_BROWSER=true); it fails on exactly this when server-fast
								// sets maxWorkers (CUR-1347), reporting zero mutants rather
								// than a config error (CUR-1336). Reproduce with two specs and no --project:
								//   VITEST_BROWSER=true npx vitest run <a .svelte.test.ts> <a server spec>
								// Browser instances are far heavier than a node worker, so sharing a worker
								// budget with server-fast was never what we wanted either.
								sequence: { groupOrder: 1 },
								// One spec file at a time, because each concurrent file costs its own browser
								// context. Uncapped the suite peaked at 4077 MB (2183 MB of it headless Chrome)
								// in 44.9s; at one worker, 3048 MB (Chrome 1034 MB) in 37.0s, same 105 tests
								// (CUR-2249). VITEST_CLIENT_MAX_WORKERS overrides it for a roomier machine.
								maxWorkers: Number(process.env.VITEST_CLIENT_MAX_WORKERS) || 1,
								// No `environment: 'browser'` — vitest 4 rejects it outright ("To enable Browser
								// Mode, use test.browser.enabled instead"). It was always redundant with the
								// browser.enabled below; v4 just stopped tolerating both.
								browser: {
									enabled: true,
									// vitest 4 takes a provider OBJECT, not the string 'playwright' — the providers
									// moved out of @vitest/browser (now removed from our deps) into their own
									// packages. The runtime `page`/`utils` imports moved to `vitest/browser` too.
									provider: playwright(),
									instances: [{ browser: 'chromium', headless: true }],
									// Motion specs check both sides of `prefers-reduced-motion`, which only the
									// Playwright page can emulate. Typed in src/vitest-browser.d.ts.
									commands: {
										setReducedMotion: ({ page }, reduce: boolean) =>
											page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' })
									}
								},
								include: [svelteSpecs, alphaDsSvelteSpecs],
								exclude: ['src/lib/chat/server/**'],
								setupFiles: ['./scripts/setups/vitest-setup-client.ts'],
								// Browser mode defaults to 15s (vitest resolves `testTimeout ??= browser.enabled ?
								// 15e3 : 5e3`), so the 30s here is explicit and matches ci-local.sh (CUR-2204).
								// local-inference-tab's fully mocked tests pass 11/11 alone and time out
								// at 15s inside a loaded pre-push. 30s matches server-fast; ci-local.sh's pressure
								// retry is what handles a freeze longer than that.
								testTimeout: 30000,
								hookTimeout: 30000
							}
						}
					]
				: []),
			{
				// Fast hermetic unit tests — no shared Postgres state.
				extends: true as const,
				test: {
					name: 'server-fast',
					environment: 'node',
					fileParallelism: true,
					// Capped in every environment, not only CI. Each worker is a full Node heap, so the
					// binding constraint on worker count is available memory rather than core count, and
					// developer machines are the ones without headroom: `ci:local` also runs a build this
					// repo caps at 4GB. On an 8-core host an unbounded pool takes free memory down to a few
					// hundred MiB and can OOM-kill a pre-push run, where 2 workers hold flat near 2.2Gi.
					// 4 is the number CI runs safely (CUR-1347).
					//
					// Env-overridable so a session on a loaded box can trade wall-clock for headroom;
					// CI's coverage step sets it to 2. Never name it VITEST_MAX_WORKERS: vitest applies
					// that variable to every project's resolved config, which lifts server-stateful off
					// its maxWorkers of 1 and runs its files side by side, each wiping the users the
					// other is using.
					maxWorkers: Number(process.env.UNIT_FAST_MAX_WORKERS) || 4,
					// evals/** is here for evals/imports.spec.ts, which checks that the harnesses can be
					// LOADED (an unresolvable relative import otherwise ships unnoticed). It never runs them —
					// see that file. Without this the spec would match no project and run nowhere, the
					// failure called out at the liveSpecs comment below.
					// scripts/** is here so dev-tooling logic can be tested at all. It is safe against
					// double-collection: the one scripts/ spec that needs Postgres
					// (scripts/__tests__/verifiers.spec.ts) is in STATEFUL_SERVER_SPECS, which the
					// exclude below already spreads — so widening the include cannot pull it in.
					// e2e/__tests__ holds the hermetic half of Playwright helper logic (CUR-1530's
					// persona action validator). It is deliberately OUTSIDE e2e/scenarios, which is
					// playwright.config.ts's `testDir` and matches every *.spec.ts under it — a vitest
					// spec placed in there would be collected by Playwright too, fail on a missing
					// `page` fixture, and read as a broken scenario rather than as a misfiled test.
					include: [
						'src/**/*.{test,spec}.{js,ts}',
						'evals/**/*.{test,spec}.{js,ts}',
						'scripts/**/*.{test,spec}.{js,ts}',
						'e2e/__tests__/**/*.{test,spec}.{js,ts}',
						alphaDsSpecs
					],
					exclude: [svelteSpecs, alphaDsSvelteSpecs, liveSpecs, ...STATEFUL_SERVER_SPECS],
					setupFiles: ['./scripts/setups/vitest-setup-server.ts'],
					testTimeout: 30000,
					hookTimeout: 30000
				}
			},
			// Live specs — hit REAL external vendors. Excluded from `server-fast` above and given their
			// own project below, because a file that belongs to no project is not a test, however green
			// the suite looks (as `scripts/__tests__/verifiers.spec.ts` documents above). `pnpm test:live`
			// sets TEST_LIVE, which only widens the stateful project, an unrelated axis.
			//
			// OPT-IN, and that is load-bearing. Defining this project unconditionally puts the live specs
			// into plain `vitest` — i.e. `pnpm test`, the documented local command — and
			// classify.live.spec.ts has NO env gate of its own, so every dev running the normal suite
			// would silently call the real embeddings endpoint. Registering the project is the same
			// decision as running it. Set by `pnpm test:live`; nothing else turns it on.
			//
			// Serial and single-worker on purpose: these call rate-limited vendor APIs, and parallel files
			// would race the same quota. Long timeout because a cold serving lane is normal here and a
			// timeout would misreport as a vendor failure.
			//
			// Each spec keeps its OWN gate (AGENT_LIVE / URL_GUARD_LIVE / JUDGE_LIVE) so a subset can be
			// run by hand — which means this project can legitimately run zero tests, and why the nightly
			// workflow asserts PER FILE that each enabled spec passed something rather than trusting an
			// exit code.
			...(process.env.VITEST_LIVE === '1'
				? [
						{
							extends: true as const,
							test: {
								name: 'server-live',
								environment: 'node',
								fileParallelism: false,
								maxWorkers: 1,
								minWorkers: 1,
								include: [liveSpecs],
								setupFiles: ['./scripts/setups/vitest-setup-server.ts'],
								testTimeout: 120000,
								hookTimeout: 120000
							}
						}
					]
				: []),
			{
				// Postgres-backed specs — serial, one worker. Shared table-wide cleanup
				// is unsafe across files. bail in CI so a broken pool cannot amplify into
				// dozens of 30s timeouts.
				//
				// On vitest 4, project-level fileParallelism/maxWorkers are honored under `extends`, so the
				// settings below win over the CLI: forcing `--file-parallelism --maxWorkers=4` on this
				// project leaves it neither faster nor broken (83.75s without, 77.42s with). The same two
				// flags do change server-fast, so the flags themselves work.
				//
				// `test:ci:stateful` still passes `--no-file-parallelism --maxWorkers=1`, on purpose.
				// It is free, and it insures a guarantee whose failure mode is a red that teaches
				// people to discount red. Delete it only after re-measuring on the current vitest.
				extends: true as const,
				test: {
					name: 'server-stateful',
					environment: 'node',
					// The throwaway local container's URL (`docker start aipotluck-dev-pg`), the same value
					// ci.yml's unit job sets. It is not a secret, so a fresh worktree needs no .env for it.
					// A real DATABASE_URL from the shell or Doppler still wins (SOL-236).
					env: {
						DATABASE_URL:
							process.env.DATABASE_URL ||
							process.env.POSTGRES_URL ||
							'postgres://postgres:postgres@localhost:5432/aipotluck_test'
					},
					fileParallelism: false,
					maxWorkers: 1,
					minWorkers: 1,
					pool: 'forks',
					bail: process.env.CI || process.env.CI_HERMETIC === 'true' ? 1 : 0,
					include:
						process.env.TEST_LIVE === 'true'
							? STATEFUL_SERVER_SPECS
							: STATEFUL_SERVER_SPECS.filter((p) => !NON_HERMETIC_SERVER_SPECS.includes(p)),
					setupFiles: ['./scripts/setups/vitest-setup-server.ts'],
					testTimeout: 30000,
					hookTimeout: 30000
				}
			}
		]
	}
});
