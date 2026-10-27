// Tailwind palette colours (bg-gray-500, text-white), arbitrary colours (bg-[#f88376]) and colour
// literals (#hex, rgb(), hsl(), numeric oklch()) bypass the theme: they don't follow light/dark,
// don't follow a theme swap, and can't be contrast-checked. Use a semantic token utility.
import {
	classTokens,
	classVisitor,
	COLOR_PREFIX,
	docsUrl,
	parseClass,
	styleVisitor,
	TAILWIND_PALETTE
} from '../utils.js';

const PALETTE = new RegExp(`^(${COLOR_PREFIX})-((${TAILWIND_PALETTE})-\\d{2,3}|white|black)$`);
const ARBITRARY_COLOR = new RegExp(
	`^(${COLOR_PREFIX})-\\[(#|rgb|hsl|oklch|oklab|lab|lch|color-mix|color\\()`
);
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(\s*\d|\boklch\(\s*[\d.]/;
const WHOLE_STRING_COLOR = /^(#[0-9a-fA-F]{3,8}|(rgba?|hsla?|oklch|oklab)\(\s*[\d.].*\))$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow colours that bypass design tokens',
			url: docsUrl('no-raw-colors')
		},
		messages: {
			palette:
				'"{{value}}" is a raw Tailwind colour. Use a token utility (bg-surface-2, text-fg-2, border-line-2, text-accent-1-text…).',
			literal:
				'Raw colour "{{value}}". Use a design token (var(--ds-…)) so it follows theme and mode.'
		},
		schema: []
	},
	create(context) {
		const report = (node, messageId, value) => context.report({ node, messageId, data: { value } });
		const classes = classVisitor(context, (text, node) => {
			for (const t of classTokens(text)) {
				const { utility } = parseClass(t);
				if (PALETTE.test(utility) || ARBITRARY_COLOR.test(utility)) report(node, 'palette', t);
			}
		});
		const styles = styleVisitor(context, (text, node) => {
			const m = text.match(LITERAL);
			if (m) report(node, 'literal', m[0]);
		});
		return {
			...classes,
			...styles,
			Literal(node) {
				classes.Literal(node);
				if (typeof node.value === 'string' && WHOLE_STRING_COLOR.test(node.value.trim()))
					report(node, 'literal', node.value);
			}
		};
	}
};
