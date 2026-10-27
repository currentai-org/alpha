// CUR-4448: chat is served under `/chat` on the site surface and at the root on the chat surface
// (APP_SURFACE=chat, src/lib/surface.ts), so a link, fetch or redirect that types `/chat/...` by hand
// works on one surface and takes a 308 detour (or, for a POST, the wrong route) on the other. Build it
// from `base` or `chatHome` in $lib/chat/paths, or name the reserved path that stays `/chat/...` on
// both surfaces (AUTH_BASE_PATH, CHAT_API_PATH, CIMD_PATH, ...).
//
// Flags a string literal, the first chunk of a template literal, and a Svelte attribute value that
// begins with `/chat` followed by the end, `/`, `?` or `#` (so `/chatui/...` static assets pass).
// Comparisons against a SvelteKit route id (`page.route.id?.startsWith('/chat')`) are legitimately
// literal, since route ids keep `/chat` on both surfaces: say so with an eslint-disable comment.

const CHAT_PATH = /^\/chat(?:$|[/?#])/;

/** @type {import('eslint').Rule.RuleModule} */
export const noChatPathLiteral = {
	meta: {
		type: 'problem',
		docs: {
			description: 'disallow a hand-typed `/chat` path in chat code; build it from $lib/chat/paths'
		},
		schema: [],
		messages: {
			literal:
				'A literal `/chat` path breaks on the chat surface, where chat is at the root (CUR-4448). ' +
				'Use `${base}`/`chatHome` from $lib/chat/paths, or a reserved-path constant there; a ' +
				'route-id comparison may disable this rule with a reason.'
		}
	},
	create(context) {
		const check = (node, value) => {
			if (typeof value === 'string' && CHAT_PATH.test(value)) {
				context.report({ node, messageId: 'literal' });
			}
		};
		return {
			Literal(node) {
				check(node, node.value);
			},
			TemplateLiteral(node) {
				check(node, node.quasis[0]?.value.cooked);
			},
			SvelteLiteral(node) {
				check(node, node.value);
			}
		};
	}
};
