// A design-system component's look belongs to its recipe. Consumers may place it (margin,
// width, flex/grid placement, position) but not re-skin it — colours, type, radius, borders and
// shadows passed through `class` fork the design one call site at a time. Change the recipe or
// add a variant instead. (shadcn/lint's `no-restyle`.)
//
// Layout primitives are exempt: Stack, Inline, Grid, Center, Surface, Frame and friends exist to
// group other elements and are expected to take composition classes (padding, text tier for their
// contents). The rule polices components and patterns — things with a skin.
import { classTokens, docsUrl, isComponentImportedFromDs, parseClass } from '../utils.js';

const LAYOUT = new RegExp(
	'^(' +
		[
			'-?m[trblxyse]?-.+',
			'p[trblxyse]?-.+',
			'(min-|max-)?(w|h|size)-.+',
			'(flex|grow|shrink|basis|order|self|justify-self|place-self|col|row)(-.+)?',
			'(absolute|relative|fixed|sticky|static)',
			'-?(inset|top|right|bottom|left|start|end)(-.+)?',
			'z-.+',
			'(block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|contents|sr-only|not-sr-only)',
			'(overflow|overscroll)(-.+)?',
			'(truncate|isolate)',
			'(translate|-translate)(-.+)?',
			'(visible|invisible|collapse)',
			'(pointer-events)-.+',
			'(aspect)-.+',
			'(group|peer)(\\/.+)?',
			'(items|justify|content|place-items|place-content|gap)(-.+)?',
			'(grid-cols|grid-rows|auto-cols|auto-rows|col-span|row-span|col-start|col-end|row-start|row-end)(-.+)?'
		].join('|') +
		')$'
);

const PRIMITIVES = new Set([
	'Stack',
	'Inline',
	'Grid',
	'Center',
	'Surface',
	'Frame',
	'VisuallyHidden',
	'ThemeProvider'
]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow restyling design-system components through class',
			url: docsUrl('no-restyle')
		},
		messages: {
			restyle:
				'<{{component}}> is restyled with "{{value}}". Pass layout classes only; change its recipe or add a variant for visual changes.'
		},
		schema: []
	},
	create(context) {
		return {
			SvelteElement(node) {
				if (node.kind !== 'component') return;
				const name = context.sourceCode.getText(node.name);
				const root = name.split('.')[0];
				if (PRIMITIVES.has(root) || !isComponentImportedFromDs(context, root)) return;
				for (const attr of node.startTag.attributes) {
					if (attr.type !== 'SvelteAttribute' || attr.key?.name !== 'class') continue;
					for (const v of attr.value ?? []) {
						if (v.type !== 'SvelteLiteral') continue;
						for (const t of classTokens(v.value)) {
							const { utility } = parseClass(t);
							if (!LAYOUT.test(utility))
								context.report({
									node: v,
									messageId: 'restyle',
									data: { component: name, value: t }
								});
						}
					}
				}
			}
		};
	}
};
