// `style="color: …"` and `style:color={…}` bypass tokens and the lint rules above. Setting a CSS
// custom property is allowed (`style:--progress={pct}`) — that is how runtime values feed tokens.
import { docsUrl } from '../utils.js';

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow inline styles other than custom-property assignments',
			url: docsUrl('no-inline-styles')
		},
		messages: {
			attribute:
				'Inline style attribute. Use token utilities; for a runtime value, set a custom property (style:--name={value}).',
			directive:
				'`style:{{name}}` sets a property directly. Use a utility, or set a custom property (style:--name) that a utility reads.'
		},
		schema: []
	},
	create(context) {
		return {
			SvelteAttribute(node) {
				if (node.key?.name !== 'style' || node.parent?.parent?.kind === 'component') return;
				const text = context.sourceCode.getText(node);
				const onlyCustom = /^style="(\s*--[\w-]+\s*:[^;]+;?)+\s*"$/.test(text);
				if (!onlyCustom) context.report({ node, messageId: 'attribute' });
			},
			SvelteStyleDirective(node) {
				const name = node.key?.name?.name ?? node.key?.name;
				if (typeof name === 'string' && !name.startsWith('--'))
					context.report({ node, messageId: 'directive', data: { name } });
			}
		};
	}
};
