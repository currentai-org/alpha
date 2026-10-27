// `bg-${tone}-500` and class="text-{size}" build class names at runtime. Tailwind's scanner can't
// see them (so the CSS never ships) and no lint rule can check them. Write each class out in full
// and choose between them (`tone === 'accent' ? 'bg-accent-1' : 'bg-surface-2'`, or a tv() variant).
import { docsUrl, isClassContext } from '../utils.js';

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Require class names to be statically analysable',
			url: docsUrl('require-static-classes')
		},
		messages: {
			dynamic:
				'Class name built by interpolation ("{{value}}"). Write whole class names and choose between them.'
		},
		schema: []
	},
	create(context) {
		return {
			TemplateLiteral(node) {
				if (!node.expressions.length || !isClassContext(node)) return;
				node.quasis.forEach((q, i) => {
					const raw = q.value.raw;
					const before = i < node.quasis.length - 1 && /[\w-]$/.test(raw);
					const after = i > 0 && /^[\w-]/.test(raw);
					if (before || after)
						context.report({ node, messageId: 'dynamic', data: { value: raw.trim() || '…' } });
				});
			},
			SvelteAttribute(node) {
				if (node.key?.name !== 'class' || !node.value || node.value.length < 2) return;
				node.value.forEach((v, i) => {
					if (v.type !== 'SvelteLiteral') return;
					const prevIsTag = node.value[i - 1]?.type === 'SvelteMustacheTag';
					const nextIsTag = node.value[i + 1]?.type === 'SvelteMustacheTag';
					if ((nextIsTag && /[\w-]$/.test(v.value)) || (prevIsTag && /^[\w-]/.test(v.value))) {
						context.report({ node: v, messageId: 'dynamic', data: { value: v.value.trim() } });
					}
				});
			}
		};
	}
};
