import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import { noDiscardedEffectRoot } from './eslint-rules/no-discarded-effect-root.js';
import { noChatPathLiteral } from './eslint-rules/no-chat-path-literal.js';
import alphaDs, {
	internal as alphaDsInternal,
	strict as alphaDsStrict
} from './eslint-rules/alpha-ds/index.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

/**
 * Code built on the Alpha design system — every design lint rule is an error here. When a legacy
 * chat surface is migrated onto the system, add it to this list (and `pnpm lint:design --update`
 * drops it from the ratchet baseline).
 */
export const DESIGN_SYSTEM_STRICT = [
	// The system's own examples and catalog, as packages/alpha-ds/eslint.config.js sees them (CUR-4479).
	'src/**/examples/**/*.svelte',
	'src/catalog/**/*.{ts,svelte}',
	'src/routes/designsystem/**/*.{ts,svelte}',
	// Chat surfaces migrated onto the system (Claude Desktop shell).
	'src/lib/chat/components/ChatShell.svelte',
	'src/lib/chat/components/ChatAppLayout.svelte',
	'src/lib/chat/components/NavMenu.svelte',
	'src/lib/chat/components/NavConversationItem.svelte',
	'src/lib/chat/components/Modal.svelte',
	'src/lib/chat/components/Portal.svelte',
	'src/lib/chat/components/Switch.svelte',
	'src/lib/chat/components/DeleteAllConversationsModal.svelte',
	'src/lib/chat/components/chat/ChatIntroduction.svelte',
	'src/lib/chat/components/AccountMenu.svelte',
	'src/lib/chat/components/ChatSearchDialog.svelte',
	'src/lib/chat/components/ReportProblemDialog.svelte',
	'src/lib/chat/components/provenance/*.svelte',
	'src/lib/chat/components/stack/XRayPanel.svelte',
	'src/lib/chat/components/stack/AnswerReceipt.svelte',
	'src/routes/chat/settings/+layout.svelte',
	'src/routes/chat/settings/(nav)/appearance/+page.svelte',
	'src/routes/chat/settings/(nav)/data/+page.svelte',
	'src/routes/chat/settings/(nav)/personalization/+page.svelte',
	'src/routes/chat/settings/(nav)/+page.svelte',
	'src/lib/chat/components/SessionFootprint.svelte',
	'src/lib/chat/components/ScrollToBottomBtn.svelte',
	'src/lib/chat/components/WelcomeModal.svelte',
	'src/lib/chat/components/ChatBackdrop.svelte',
	'src/lib/chat/components/chat/GuestRetentionNotice.svelte',
	'src/lib/chat/components/ChatSearchDialog.svelte',
	'src/lib/chat/components/stack/StackXRayLayerCard.svelte',
	'src/lib/chat/components/stack/XRayComposerPanel.svelte'
];

/** The design system's own sources, where recipes may use arbitrary values and inline geometry.
 *  Package-relative: packages/alpha-ds/eslint.config.js lints them with this config (CUR-4479). */
const ALPHA_DS_INTERNAL = ['src/{components,primitives,patterns,internal,theme}/**/*.{ts,svelte}'];

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		ignores: [
			'config/**',
			'coop/**',
			'scripts/**',
			'evals/**',
			'models/**',
			'drizzle/**',
			'stub/**'
		]
	},
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',

			// DO NOT give prefer-const an options object here. Passing options resets the rule's other
			// defaults — including `destructuring`, which the inherited config sets to "all" — and with
			// that reset every Svelte 5 `let { a, b } = $props()` gets reported member by member (adding
			// `ignoreReadBeforeAssign` alone does this). The two sites that need
			// that exemption carry an inline disable instead (second-opinion/+server.ts).

			// A leading underscore already means "deliberately unused" in this repo — 31 files use it,
			// on mock signatures that must keep their arity, on positional params before the one that
			// matters, and on caught errors that are genuinely being swallowed. The rule was reporting
			// all of them, which is the rule failing to read a convention rather than reporting defects (CUR-219).
			// Encoded here instead of deleting
			// bindings that callers depend on.
			//
			// This does NOT weaken the check: an unused variable with no underscore is still an error,
			// so opting out stays a deliberate, visible act at the site.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
					destructuredArrayIgnorePattern: '^_'
				}
			],

			// Discarding the dispose function `$effect.root(() => {...})` returns leaks the root: Svelte
			// marks it EFFECT_PRESERVED specifically so it outlives the component, so nothing tears it
			// down unless the caller invokes that function (BackgroundGenerationPoller.svelte's
			// onDestroy(disposeRoot), CUR-1157). No eslint-plugin-svelte rule catches THAT shape (none
			// references $effect.root or dispose), but the identical footgun for a store's own
			// unsubscribe function has one, off by default. Its legitimate hits are a module-level store
			// synced to localStorage for the whole session (agentMode.ts/speakMode.ts/webSearchMode.ts),
			// and each carries an inline disable explaining why.
			'svelte/no-ignored-unsubscribe': 'error',

			// `require-atomic-updates` (core ESLint, off by default) is not enabled. It targets the same
			// shape of bug as CUR-1157 -- state mutated by something the code didn't wait for -- but
			// produces many hits here, and the ones checked (writeMessage's `finally` cleanup,
			// +server.ts's `turnStopped = true`, messageUpdates.ts's `priorRetriableStatus`) is a plain
			// unconditional write after an unrelated earlier `await`, not a stale read-then-write. The
			// rule can't distinguish "safe cleanup" from "real race", and this codebase's style (long
			// async functions, state reset in a trailing finally) is its blind spot. That much noise as
			// `error` trains people to blanket-disable it.

			// Many hits (ChatMessage.svelte, MobileNav.svelte, PinchZoomImage.svelte, StackXRay.svelte,
			// conversation/[id]/+page.svelte itself, and more) -- raw addEventListener with no enforced
			// matching removeEventListener, the DOM-listener sibling of the effect/store leaks above.
			// `warn`, not `error`: these need triaging file by file (some are low-risk, e.g. a listener on a throwaway Audio object),
			// not a blanket fail. Ratchet to `error` once the backlog is cleared.
			'svelte/no-add-event-listener': 'warn'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		},
		// CUR-1157: $effect.root(...) is ordinary JS/TS syntax (a MemberExpression call), so this
		// rule needs no Svelte-template awareness -- it just needs the <script> block's AST, which
		// svelte-eslint-parser already delegates to ts.parser above for every file this block covers.
		// Local, inline plugin (no separate package) -- see eslint-rules/no-discarded-effect-root.js.
		plugins: { local: { rules: { 'no-discarded-effect-root': noDiscardedEffectRoot } } },
		rules: {
			'local/no-discarded-effect-root': 'error'
		}
	},
	{
		// CUR-4448: chat code builds its own paths from $lib/chat/paths, because `/chat` is the root on
		// the chat surface. Set to error (CUR-4463).
		files: ['src/lib/chat/**/*.{ts,js,svelte}', 'src/routes/chat/**/*.{ts,js,svelte}'],
		ignores: ['src/lib/chat/paths.ts', '**/*.spec.ts', '**/*.test.ts', '**/*.svelte.test.ts'],
		plugins: { 'chat-paths': { rules: { 'no-chat-path-literal': noChatPathLiteral } } },
		rules: {
			'chat-paths/no-chat-path-literal': 'error'
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	},
	{
		// Alpha design-system linter (eslint-rules/alpha-ds, docs at /designsystem/linting).
		// Inside the system's own component/primitive/pattern sources, recipes may use arbitrary
		// values and inline geometry; everywhere built ON the system gets every rule as an error.
		// Legacy chat code is not listed here — `pnpm lint:design` ratchets it (scripts/ds-lint-ratchet.mjs)
		// and a migrated file joins DESIGN_SYSTEM_STRICT below.
		files: ALPHA_DS_INTERNAL,
		ignores: ['**/*.spec.ts', '**/examples/**'],
		plugins: { 'alpha-ds': alphaDs },
		rules: alphaDsInternal
	},
	{
		files: DESIGN_SYSTEM_STRICT,
		ignores: ['**/*.spec.ts'],
		plugins: { 'alpha-ds': alphaDs },
		rules: alphaDsStrict
	},
	{
		// The chat subtree began as a fork of HuggingFace chat-ui, but most of its files are now our own
		// work, so it is linted like the rest of the repo (CUR-219). Only the rules below are changed,
		// and one rule is genuinely inapplicable and stays off. Scoped by path rather than by wholesale
		// ignore so that a new fork-specific exception has to be named and justified in this block.
		files: ['src/lib/chat/**', 'src/routes/chat/**'],
		rules: {
			// The fork navigates with `${base}/…` throughout, which is chat-ui's own convention. This
			// rule wants SvelteKit's resolve(), so it is off here.
			'svelte/no-navigation-without-resolve': 'off',

			// Off because it cannot go green here. It reads a Svelte 5 bindable prop default —
			// `focused = $bindable(false)` inside `$props()` — as a dead assignment, and there is no
			// other way to spell that prop. The rest of what it reports is `let x: T | null = null`
			// followed by assignment on every path, plus deliberate test sentinels (`let outcome = "did
			// not settle"`, so a hung promise reads as that instead of undefined). ESLint classes this
			// rule as a suggestion, not a possible-problem. Genuinely dead writes go unreported in this
			// subtree.
			'no-useless-assignment': 'off',

			// ON here specifically, because this is the one subtree prettier does not format.
			// `.prettierignore` skips `src/lib/chat/` and `src/routes/chat/` so the fork keeps its
			// double-quote style, which also means nothing tidies up after `eslint --fix`. When --fix
			// deletes an `eslint-disable` comment it removes the text and leaves the indentation, so a
			// line that was `\t// eslint-disable-next-line foo` becomes `\t`, and no other gate sees it.
			//
			// Everywhere else in the repo prettier owns this and the rule would be redundant — that is
			// why it is scoped to this block rather than set globally.
			'no-trailing-spaces': 'error'
		}
	},
	{
		// CUR-1003: suggestions.ts holds candidate starters, graded or not. The shelf a visitor sees is
		// starterShelf.ts, which drops any candidate without a passing live grade, so reading the
		// candidates anywhere else puts an ungraded prompt back in front of visitors.
		files: ['src/**/*.ts', 'src/**/*.svelte'],
		ignores: [
			'src/lib/chat/constants/starterShelf.ts',
			'src/lib/chat/constants/starterShelf.spec.ts'
		],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					// The date-fns barrel costs ~4 s to load, which every spec that touches auth would pay (CUR-2446). Kept in this block because a second no-restricted-imports block for
					// the same files would replace this one in flat config rather than merge with it.
					paths: [
						{
							name: 'date-fns',
							message:
								'Import each function from its subpath (date-fns/addWeeks): the barrel loads the whole library, ~4 s per test file (CUR-2446).'
						},
						{
							name: 'better-auth/plugins',
							message:
								'Import each plugin from its subpath (better-auth/plugins/generic-oauth): the barrel loads every plugin, ~2.6 s per auth test file (CUR-2446).'
						},
						{
							name: '@sveltejs/kit',
							importNames: ['json'],
							message:
								'Import json from $lib/chat/server/api/utils/json, which refuses a payload whose type carries a secret-named field such as apiKey (CUR-2643).'
						}
					],
					patterns: [
						{
							group: [
								'$lib/chat/constants/suggestions',
								'**/constants/suggestions',
								'./suggestions'
							],
							message:
								'Offer starters from $lib/chat/constants/starterShelf (shelf), which keeps only prompts with a passing grade in starterRecord.json (CUR-1003).'
						}
					]
				}
			]
		}
	},
	{
		// A recorded journey must not resize its own viewport mid-test (CUR-1764).
		//
		// Playwright fixes a video's frame size when the context is created. `page.setViewportSize()`
		// afterwards resizes the PAGE and leaves the FRAME alone, so every subsequent frame is the page
		// scaled down inside the old frame with flat mid-grey, `rgb(128, 128, 128)`, filling the rest:
		// resizing a 1280x720 context to 390x844 leaves a full-bleed panel occupying 204 of an 800-wide
		// frame's columns, and the other 596 are recorder padding.
		//
		// Nothing about the test goes red when that happens — the DOM assertions still pass on the real
		// viewport. What breaks is the artifact, and the two critics that read it, which grade the
		// padding as a product layout defect.
		//
		// The fix each time is the same, so the message names it: set the viewport where the context is
		// built (`test.use({ viewport })`, or a `projects` entry in e2e/playwright.config.ts) and the
		// recording matches the page.
		files: ['e2e/**/*.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: "CallExpression > MemberExpression[property.name='setViewportSize']",
					message:
						'setViewportSize resizes the page but not the video frame, so the rest of the recording is the page scaled into grey padding and both critics grade the padding. Set the viewport at context creation instead: test.use({ viewport: { width, height } }), or a projects entry in e2e/playwright.config.ts (CUR-1764).'
				},
				{
					// The details object (second argument of test() and test.x()) takes tag, annotation and
					// lock. Playwright drops a `timeout:` there without a word, so the test keeps the config's
					// budget while its author believes it has more (CUR-2433).
					selector:
						"CallExpression:matches([callee.name='test'], [callee.object.name='test']) > ObjectExpression:nth-child(2) > Property[key.name='timeout']",
					message:
						"Playwright ignores `timeout` in a test's details object, so this test still runs on the config's budget. Put `test.setTimeout(N)` as the first line of the test body instead (CUR-2433)."
				},
				{
					// What a spec types into the page is filmed, and the reels are shown to people, so a
					// ticket id there reads as test scaffolding on screen (CUR-2961). Keep the id in the
					// test's title or tag. Text joined with `+` is caught too; a label passed through a
					// helper first is not.
					selector:
						'CallExpression[callee.property.name=/^(fill|pressSequentially|type)$/] > Literal[value=/CUR-[0-9]+/]',
					message:
						'This text is typed on camera and the recording is shown to people. Type what a visitor would, and keep the ticket id in the test title or tag (CUR-2961).'
				},
				{
					selector:
						'CallExpression[callee.property.name=/^(fill|pressSequentially|type)$/] > TemplateLiteral > TemplateElement[value.raw=/CUR-[0-9]+/]',
					message:
						'This text is typed on camera and the recording is shown to people. Type what a visitor would, and keep the ticket id in the test title or tag (CUR-2961).'
				},
				{
					selector:
						'CallExpression[callee.property.name=/^(fill|pressSequentially|type)$/] > BinaryExpression Literal[value=/CUR-[0-9]+/]',
					message:
						'This text is typed on camera and the recording is shown to people. Type what a visitor would, and keep the ticket id in the test title or tag (CUR-2961).'
				},
				{
					selector:
						'CallExpression[callee.property.name=/^(fill|pressSequentially|type)$/] > BinaryExpression TemplateElement[value.raw=/CUR-[0-9]+/]',
					message:
						'This text is typed on camera and the recording is shown to people. Type what a visitor would, and keep the ticket id in the test title or tag (CUR-2961).'
				}
			]
		}
	},
	{
		// CUR-2675: a spec that takes `test` from '@playwright/test' skips helpers/test.ts's asset cache
		// and warm-ping stub, and refetches every content-hashed chunk on every page load of the preview.
		files: ['e2e/scenarios/*.spec.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: '@playwright/test',
							importNames: ['test'],
							message:
								"Import test from './helpers/test', which serves content-hashed assets from a per-worker cache and stubs the composer's warm ping (CUR-2675)."
						}
					]
				}
			]
		}
	}
);
