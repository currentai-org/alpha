// eslint-plugin-alpha-ds — the Alpha design-system linter (shadcn/lint parity + Alpha rules).
// Loaded directly by web/eslint.config.js. Rule docs: /designsystem/linting.

import noRawColors from './rules/no-raw-colors.js';
import noArbitraryValues from './rules/no-arbitrary-values.js';
import noOffScale from './rules/no-off-scale.js';
import noLegacyTokens from './rules/no-legacy-tokens.js';
import noUnknownTokens from './rules/no-unknown-tokens.js';
import noInlineStyles from './rules/no-inline-styles.js';
import noRestyle from './rules/no-restyle.js';
import requireStaticClasses from './rules/require-static-classes.js';
import remixIconsOnly from './rules/remix-icons-only.js';
import pillNestedRadius from './rules/pill-nested-radius.js';

export const rules = {
	'no-raw-colors': noRawColors,
	'no-arbitrary-values': noArbitraryValues,
	'no-off-scale': noOffScale,
	'no-legacy-tokens': noLegacyTokens,
	'no-unknown-tokens': noUnknownTokens,
	'no-inline-styles': noInlineStyles,
	'no-restyle': noRestyle,
	'require-static-classes': requireStaticClasses,
	'remix-icons-only': remixIconsOnly,
	'pill-nested-radius': pillNestedRadius
};

// The design system's version (derived from packages/alpha-ds/src/changelog). ESLint keys its cache on
// plugin meta, so a recorded rule change invalidates `--cache` results linted under the old rule.
// Guarded: an editor's bundled Node without TypeScript stripping still gets working rules.
let version = '0.0.0-unknown';
try {
	version = (await import('../../scripts/lib/dsLedger.mjs')).loadLedger().version;
} catch {
	// Keep the placeholder; `pnpm lint:design` reports a broken ledger on its own.
}

const plugin = { meta: { name: 'eslint-plugin-alpha-ds', version }, rules };

/** Every rule as an error — for product code built on the design system. */
export const strict = Object.fromEntries(Object.keys(rules).map((r) => [`alpha-ds/${r}`, 'error']));

/**
 * Inside the design system's own component/primitive/pattern sources: recipes legitimately use
 * arbitrary values, inline geometry and their own classes on sibling parts.
 */
export const internal = {
	...strict,
	'alpha-ds/no-arbitrary-values': 'off',
	'alpha-ds/no-inline-styles': 'off',
	'alpha-ds/no-restyle': 'off'
};

export default plugin;
