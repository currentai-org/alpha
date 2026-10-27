// `p-[13px]`, `text-[length:var(--x)]`, `h-(--x)`: arbitrary values step off the scale. Use a
// scale step, a token utility, or add a token. Arbitrary VARIANTS (`[&_svg]:size-4`) are fine.
import { classTokens, classVisitor, docsUrl, parseClass } from '../utils.js';

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow arbitrary Tailwind values',
			url: docsUrl('no-arbitrary-values')
		},
		messages: {
			arbitrary:
				'"{{value}}" uses an arbitrary value. Use the spacing/type scale or a token utility; add a token if none fits.'
		},
		schema: []
	},
	create(context) {
		return classVisitor(context, (text, node) => {
			for (const t of classTokens(text)) {
				const { utility } = parseClass(t);
				if (/\[.*\]|\(--/.test(utility))
					context.report({ node, messageId: 'arbitrary', data: { value: t } });
			}
		});
	}
};
