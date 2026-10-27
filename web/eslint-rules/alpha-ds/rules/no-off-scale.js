// Tailwind's default font sizes, radii and shadows are a different scale from Alpha's. The spec
// has six sizes (text-micro…text-display), three radii (rounded-sharp/field/pill) and one shadow.
import { classTokens, classVisitor, docsUrl, parseClass } from '../utils.js';

const TEXT = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/;
const ROUNDED = /^rounded(-[trblse]{1,2})?(-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/;
const SHADOW = /^shadow(-(2xs|xs|sm|md|lg|xl|2xl))?$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow Tailwind default type sizes, radii and shadows',
			url: docsUrl('no-off-scale')
		},
		messages: {
			text: '"{{value}}" is off the type scale. Use text-micro | text-small | text-body | text-subhead | text-heading | text-display, or a type-* role.',
			rounded:
				'"{{value}}" is off the radius scale. Use rounded-sharp (default), rounded-field (composer, prompt examples) or rounded-pill (in-chat CTAs).',
			shadow:
				'"{{value}}" — the system is flat. Use shadow-popover for floating layers or shadow-window for the outer app frame.'
		},
		schema: []
	},
	create(context) {
		return classVisitor(context, (text, node) => {
			for (const t of classTokens(text)) {
				const { utility } = parseClass(t);
				if (TEXT.test(utility)) context.report({ node, messageId: 'text', data: { value: t } });
				else if (ROUNDED.test(utility))
					context.report({ node, messageId: 'rounded', data: { value: t } });
				else if (SHADOW.test(utility))
					context.report({ node, messageId: 'shadow', data: { value: t } });
			}
		});
	}
};
