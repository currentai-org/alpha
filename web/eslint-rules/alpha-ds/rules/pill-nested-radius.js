// A button sitting inside a fully rounded (Radius 3, `rounded-pill`) container takes the pill's
// shape too. A default Button is Radius 1 (`rounded-sharp`), so its hover and press tile shows square
// corners against the pill's curve. A pill inside a pill is the only radius that follows it.
//
// Polices the design system's Button (fixed with `shape="pill"`) and native <button> / <a> carrying
// a smaller radius class. Other children (logos, badges, dots) keep their own shapes.
import { classTokens, docsUrl, isComponentImportedFromDs, parseClass } from '../utils.js';

const SMALLER_RADIUS = new Set(['rounded-sharp', 'rounded-field', 'rounded-card', 'rounded-popup']);

/** Unconditional utilities in an element's static class="…" literal(s). */
function staticUtilities(node) {
	const out = [];
	for (const attr of node.startTag.attributes) {
		if (attr.type !== 'SvelteAttribute' || attr.key?.name !== 'class') continue;
		for (const v of attr.value ?? []) {
			if (v.type !== 'SvelteLiteral') continue;
			for (const t of classTokens(v.value)) {
				const { variants, utility } = parseClass(t);
				if (!variants.length) out.push({ utility, node: v });
			}
		}
	}
	return out;
}

function attribute(node, name) {
	return node.startTag.attributes.find(
		(a) =>
			(a.type === 'SvelteAttribute' && a.key?.name === name) ||
			(a.type === 'SvelteShorthandAttribute' && a.key?.name === name)
	);
}

/** A spread (`{...props}`) may carry the shape, so the element is left to the runtime. */
const hasSpread = (node) =>
	node.startTag.attributes.some((a) => a.type === 'SvelteSpreadAttribute');

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'problem',
		fixable: 'code',
		docs: {
			description: 'Require buttons inside a pill to be pill-shaped',
			url: docsUrl('pill-nested-radius')
		},
		messages: {
			button:
				'<{{component}}> sits inside a rounded-pill container but is {{shape}}, so its hover tile shows square corners against the curve. Give it shape="pill".',
			native:
				'<{{tag}}> sits inside a rounded-pill container but has "{{value}}". Use rounded-pill so its corners follow the pill.'
		},
		schema: []
	},
	create(context) {
		/** Open elements, innermost last: whether each one is a pill. */
		const stack = [];
		const insidePill = () => stack.includes(true);
		return {
			SvelteElement(node) {
				const utilities = staticUtilities(node);
				if (insidePill()) check(node, utilities);
				stack.push(utilities.some((u) => u.utility === 'rounded-pill'));
			},
			'SvelteElement:exit'() {
				stack.pop();
			}
		};

		function check(node, utilities) {
			const name = context.sourceCode.getText(node.name);
			if (node.kind === 'component') {
				if (name !== 'Button' || !isComponentImportedFromDs(context, 'Button')) return;
				if (hasSpread(node)) return;
				const shape = attribute(node, 'shape');
				const literal =
					shape?.type === 'SvelteAttribute' &&
					shape.value?.length === 1 &&
					shape.value[0].type === 'SvelteLiteral'
						? shape.value[0].value
						: undefined;
				if (literal === 'pill' || (shape && literal === undefined)) return; // pill, or decided at runtime
				context.report({
					node: node.startTag,
					messageId: 'button',
					data: { component: name, shape: shape ? `shape="${literal}"` : 'Radius 1 by default' },
					fix: shape
						? (fixer) => fixer.replaceText(shape, 'shape="pill"')
						: (fixer) => fixer.insertTextAfter(node.name, ' shape="pill"')
				});
				return;
			}
			if (name !== 'button' && name !== 'a') return;
			for (const u of utilities) {
				if (SMALLER_RADIUS.has(u.utility))
					context.report({
						node: u.node,
						messageId: 'native',
						data: { tag: name, value: u.utility }
					});
			}
		}
	}
};
