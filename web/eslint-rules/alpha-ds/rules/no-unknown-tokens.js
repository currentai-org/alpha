// A typo'd or invented token (`var(--ds-bg-4)`, `--ds-text-5`) resolves to nothing and fails
// silently. Every `--ds-*` reference must exist in the generated manifest.
import { docsUrl, styleVisitor, TOKENS } from '../utils.js';

const REF = /--ds-[a-z0-9_-]*[a-z0-9]/g;

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow references to --ds-* tokens that do not exist',
			url: docsUrl('no-unknown-tokens')
		},
		messages: {
			unknown:
				'"{{value}}" is not a design token. Check tokens/generated/manifest.json (or /designsystem/colors).'
		},
		schema: []
	},
	create(context) {
		const check = (text, node) => {
			for (const m of text.matchAll(REF)) {
				// Declarations of new local custom properties inside components are allowed (`--ds-grid-min:`).
				const after = text.slice(m.index + m[0].length).trimStart();
				if (after.startsWith(':') || after.startsWith('={')) continue;
				if (!TOKENS.has(m[0]))
					context.report({ node, messageId: 'unknown', data: { value: m[0] } });
			}
		};
		return {
			...styleVisitor(context, check),
			SvelteLiteral: (node) => node.parent?.key?.name !== 'style' && check(node.value, node),
			Literal: (node) => typeof node.value === 'string' && check(node.value, node),
			TemplateElement: (node) => check(node.value.raw, node)
		};
	}
};
