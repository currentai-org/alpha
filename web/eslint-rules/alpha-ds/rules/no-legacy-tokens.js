// The pre-design-system vocabulary: --ap-* variables, the site palette (--paper, --salmon,
// --dark-blue…), shadcn's semantic utilities, and `dark:` variants (mode is automatic now —
// every token is light-dark()). Each keeps working through tokens/legacy-bridge.css; this rule
// is what drains that file.
import { classTokens, classVisitor, docsUrl, parseClass, styleVisitor } from '../utils.js';

const SITE =
	'paper|dark-blue|salmon|coral|light-grey|medium-grey|highlight-grey|light-blue|dark-grey|muted-red|bright-red|pink|grid-line';
const LEGACY_VAR = new RegExp(`var\\(--(ap-[a-z0-9-]+|${SITE})\\)`);
const LEGACY_UTILITY = new RegExp(
	`^(bg|text|border(-[xytrblse])?|ring|fill|stroke|from|via|to|divide|outline|decoration)-((${SITE})|sidebar(-[a-z-]+)?|(background|foreground|primary|secondary|tertiary|muted|accent|destructive|card|popover|input|ring)(-foreground)?)$`
);
const LEGACY_FONT = /^font-(jakarta|noto-serif)$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow legacy (pre-design-system) tokens and dark: variants',
			url: docsUrl('no-legacy-tokens')
		},
		messages: {
			variable:
				'"{{value}}" is a legacy variable. Use the matching --ds-* token (see tokens/legacy-bridge.css for the mapping).',
			utility:
				'"{{value}}" is a legacy utility. Use a design-system token utility (bg-surface-*, text-fg-*, border-line-*…).',
			dark: '"{{value}}" — `dark:` is unnecessary: every token is light-dark() and follows the mode automatically.',
			font: '"{{value}}" — use font-sans / font-mono / font-serif or a type-* role.'
		},
		schema: []
	},
	create(context) {
		const report = (node, messageId, value) => context.report({ node, messageId, data: { value } });
		const classes = classVisitor(context, (text, node) => {
			for (const t of classTokens(text)) {
				const { variants, utility } = parseClass(t);
				if (variants.includes('dark')) report(node, 'dark', t);
				else if (LEGACY_UTILITY.test(utility)) report(node, 'utility', t);
				else if (LEGACY_FONT.test(utility)) report(node, 'font', t);
				const v = utility.match(LEGACY_VAR);
				if (v) report(node, 'variable', v[0]);
			}
		});
		const styles = styleVisitor(context, (text, node) => {
			const v = text.match(LEGACY_VAR);
			if (v) report(node, 'variable', v[0]);
		});
		return {
			...classes,
			...styles,
			Literal(node) {
				classes.Literal(node);
				if (typeof node.value === 'string' && !node.parent?.type?.startsWith('Svelte')) {
					const v = node.value.match(LEGACY_VAR);
					if (v && !classesHandles(node)) report(node, 'variable', v[0]);
				}
			}
		};
	}
};

// Class-context literals are already checked by the class visitor.
function classesHandles(node) {
	let n = node.parent;
	while (n) {
		if (n.type === 'CallExpression') return true;
		n = n.parent;
	}
	return false;
}
