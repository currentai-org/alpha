// Spec §5: every new icon comes from Remix Icon (`~icons/ri/*`), sharp-cornered variant. Other
// sets have different metrics, stroke weights and corner shapes.
import { docsUrl } from '../utils.js';

const OTHER =
	/^(~icons\/(?!ri\/)[\w-]+\/|@lucide\/svelte|lucide-svelte|@tabler\/icons|phosphor-svelte|@iconify\/svelte|svelte-heros)/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: { description: 'Require Remix Icon for icons', url: docsUrl('remix-icons-only') },
		messages: {
			other:
				'"{{source}}" is not Remix Icon. Use `~icons/ri/<name>-line` (or `-fill` for destructive / primary actions).'
		},
		schema: []
	},
	create(context) {
		return {
			ImportDeclaration(node) {
				if (OTHER.test(node.source.value))
					context.report({ node, messageId: 'other', data: { source: node.source.value } });
			}
		};
	}
};
