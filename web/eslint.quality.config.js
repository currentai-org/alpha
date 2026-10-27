// Quality/correctness lint — mirrors the CodeQL "code quality" (Reliability +
// Maintainability) checks locally, so dead code, useless conditionals, and
// clobbered state are caught here instead of only on the Security tab.
//
// This is INTENTIONALLY separate from eslint.config.js: the main gate ignores the
// vendored chat-ui fork (src/lib/chat, src/routes/chat) because that subtree carries
// its own style history. But the fork is exactly where CodeQL found JS issues, so
// this config runs a *curated correctness ruleset* (no style rules) across the whole
// tree, including the fork. Run via `pnpm lint:quality`.
import path from 'node:path';
import globals from 'globals';
import ts from 'typescript-eslint';
import security from 'eslint-plugin-security';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import { noVacuousTruthinessAssertion } from './eslint-rules/no-vacuous-truthiness-assertion.js';
import { noChatPathLiteral } from './eslint-rules/no-chat-path-literal.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		// `.svelte.ts`/`.svelte.js` runes modules need the svelte parser (covered by the
		// main gate); everything else here is plain TS/JS.
		ignores: ['stub/**', 'drizzle/**', '.vercel/**', '.svelte-kit/**', '**/*.svelte.{ts,js}']
	},
	{
		// Scoped to .ts/.js. Svelte `<script>` blocks in NON-chat code already get these
		// correctness rules through the main gate (js.configs.recommended), and the chat
		// fork's .svelte files need the svelte parser to wire in — deferred; the high-value
		// findings (server/util/store correctness) all live in .ts, which is covered here.
		// `.mjs` is NOT optional here: scripts/ and evals/ are almost entirely .mjs, and without
		// it every file in them silently matches no config block and receives ZERO rules — the
		// lint runs, exits 0, and looks like coverage. After touching this, plant an
		// unused import in a scripts/*.mjs file and confirm the rule fires.
		files: ['**/*.{js,mjs,ts,mts,cts}'],
		// Register the TS and chat-paths plugins so inline `// eslint-disable @typescript-eslint/*`
		// and `chat-paths/*` directives in the source resolve (the rules stay off here — we only want
		// the correctness set below).
		plugins: {
			'@typescript-eslint': ts.plugin,
			security,
			'chat-paths': { rules: { 'no-chat-path-literal': noChatPathLiteral } }
		},
		languageOptions: {
			parser: ts.parser,
			globals: { ...globals.browser, ...globals.node }
		},
		linterOptions: { reportUnusedDisableDirectives: false },
		rules: {
			// no-undef is off: TypeScript already resolves globals, and the base rule
			// misfires on ambient/DOM types (the main config disables it for the same reason).
			'no-undef': 'off',

			// ── Reliability (CodeQL Error/Warning) ──────────────────────────────────
			'no-dupe-keys': 'error', // Overwritten property (duplicate object key)
			'no-dupe-else-if': 'error', // duplicated branch condition
			'no-unreachable': 'error', // Unreachable statement
			'no-constant-condition': ['error', { checkLoops: false }], // Useless conditional
			'no-constant-binary-expression': 'error', // e.g. `x ?? y` where x is never nullish
			'no-self-assign': 'error',
			'no-self-compare': 'error',
			'no-unsafe-negation': 'error',
			'no-empty': ['error', { allowEmptyCatch: false }], // Empty except (JS)

			// ── Maintainability (CodeQL Note) ───────────────────────────────────────
			// Warn, not error: the fork has a pre-existing backlog of these; surfacing
			// them without breaking CI. Ratchet to 'error' once the backlog is burned down.
			// NOTE: no-useless-assignment false-positives on the safe `let x = null; try { x = … }`
			// init-before-try idiom (correct defensive code) — keep it a warning for human triage.
			'no-useless-assignment': 'warn', // Useless assignment to local variable
			'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],

			// ── Security (eslint-plugin-security) — defence-in-depth over semgrep ────
			// Warnings: these overlap semgrep's JS rules (which came back clean) and the
			// high-noise detect-object-injection is off. This is the editor-time signal;
			// semgrep is the CI SAST gate.
			'security/detect-child-process': 'warn',
			'security/detect-non-literal-fs-filename': 'warn',
			'security/detect-non-literal-require': 'warn',
			'security/detect-eval-with-expression': 'warn',
			'security/detect-buffer-noassert': 'warn',
			'security/detect-pseudoRandomBytes': 'warn',
			'security/detect-new-buffer': 'warn',
			// Off — high-FP heuristics that drown the signal. Their real concern is
			// covered better elsewhere: ReDoS by semgrep's registry rules; property
			// access is pervasive-and-safe in this TS codebase.
			'security/detect-unsafe-regex': 'off', // safe-regex heuristic → 40 mostly-FP hits
			'security/detect-object-injection': 'off' // flags every obj[var] access
		}
	},
	{
		// CUR-1617: type-aware checks for the probe/metric surface — a separate block because
		// these need real type information (tsconfig.eslint-scripts.json), which the shared block
		// above doesn't have and shouldn't: building a full TS program is real cost, so the
		// type-aware rules cover probe and metric code only, not the whole tree linted above.
		// `no-vacuous-truthiness-assertion` (local, see the file for why it isn't just an option on
		// the stock rule) is meant to run repo-wide but only has type information here; elsewhere it
		// no-ops rather than throwing, per its own `services.program` guard. Extending it to
		// src/**'s spec files would reuse tsconfig.json's whole-app program, a materially bigger
		// type-aware-linting footprint.
		files: ['scripts/**/*.{js,mjs,ts}', 'evals/**/*.{js,mjs,ts}', 'config/**/*.{js,mjs,ts}'],
		plugins: {
			'@typescript-eslint': ts.plugin,
			local: { rules: { 'no-vacuous-truthiness-assertion': noVacuousTruthinessAssertion } }
		},
		languageOptions: {
			parser: ts.parser,
			parserOptions: { project: './tsconfig.eslint-scripts.json' },
			globals: { ...globals.node }
		},
		rules: {
			// Catches `if (x)`/`x ? a : b`/`x && y`/`!x` where x's type can never be false, such as
			// `Boolean(detect(answer))` in language-turn-probe.mjs (CUR-1617). Does NOT catch a value
			// passed as a function-call argument (Boolean(x), assert(x)); that gap is what
			// local/no-vacuous-truthiness-assertion below is for.
			//
			// `warn`, not `error`: across scripts/evals/config most hits are `?.`/`??` on an already-non-nullable
			// value, harmless redundancy; a minority are the alarming class (always-truthy/always-falsy/no-type-overlap). As errors
			// they would make every next probe/metric PR pay down that backlog to merge. Same call as
			// `svelte/no-add-event-listener` in eslint.config.js: ratchet to `error` once triaged.
			'@typescript-eslint/no-unnecessary-condition': 'warn',
			// `expr && expr` / `if (expr)` on a non-boolean type (a string, a number, an object)
			// must go through an explicit conversion (`!!expr`, `expr != null`, `expr.length > 0`)
			// instead of relying on JS's own coercion rules. Scoped here, not repo-wide: turning it
			// on tree-wide would be a much bigger, separate lint-policy decision (CUR-1617).
			//
			// `warn`, not `error`, for the same reason as above: hits are almost all
			// "any value in conditional" from untyped JSON/fetch-response handling throughout
			// scripts/. Real signal, not a thing to fix inline here.
			'@typescript-eslint/strict-boolean-expressions': 'warn',
			// `error`: no hits outside one excluded false positive (see the rule file's
			// isNonNullAssertionDerived comment), and it fires on all six named shapes. Nothing for a merge
			// to break.
			'local/no-vacuous-truthiness-assertion': 'error'
		}
	}
);
