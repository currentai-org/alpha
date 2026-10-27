// Correctness lint for `scripts/` (CUR-2235). The main gate (eslint.config.js) ignores the
// directory and `lint:quality` only warns, so before this nothing failed on an undefined name or a
// dead import in the ops tooling that deploys, gates and probes the app. Run via `pnpm lint:scripts`.
//
// Correctness only, no style: formatting is prettier's job (scripts/.prettierrc.json), enforced on
// the files a commit or PR touches rather than by reformatting the whole directory at once.
import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

const unusedVars = [
	'error',
	{
		argsIgnorePattern: '^_',
		varsIgnorePattern: '^_',
		caughtErrors: 'none',
		// `const { omitted, ...rest } = obj` is how these scripts drop a key.
		ignoreRestSiblings: true
	}
];

export default defineConfig(
	{
		files: ['scripts/**/*.{js,mjs,cjs,ts,mts}'],
		extends: [js.configs.recommended],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			'no-unused-vars': unusedVars,
			// Style, not defects: a defaulted `let` that every branch reassigns, and the narrow
			// no-break spaces the number parsers match on purpose.
			'no-useless-assignment': 'off',
			'no-irregular-whitespace': ['error', { skipRegExps: true, skipTemplates: true }]
		}
	},
	{
		files: ['scripts/**/*.{ts,mts}'],
		extends: [ts.configs.recommended],
		rules: {
			// tsc owns undefined names in TypeScript, and the base rule misreads type-only names.
			'no-undef': 'off',
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': unusedVars
		}
	},
	{
		// These run callbacks inside the page through Playwright's `page.evaluate`, where the
		// browser globals are the real ones.
		files: ['scripts/alpha-ds-probe.mjs', 'scripts/mobile-audit.mjs'],
		languageOptions: { globals: { ...globals.browser } }
	}
);
