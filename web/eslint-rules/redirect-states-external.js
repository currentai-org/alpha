// SvelteKit 3 throws `redirect_external_not_allowed` on a redirect() to another origin unless the call
// passes `{ external: true }`, and the throw is a 500 the person sees. Nothing type-checks the
// location, so a computed one (a URL another module built, a helper's return) slips through review and
// fails only when a real visitor reaches it.
//
// Flags a redirect() imported from @sveltejs/kit that passes no options argument, unless its location
// is a same-site path this file shows (isSameSitePath). Any other location states what it is:
// `{ external: true }` when it can leave the site, `{ external: false }` when it is a same-site path
// built elsewhere. `false` is SvelteKit's default, so it changes nothing but what the line says.

/**
 * Whether `node` is a same-site path we can see in this file: a string or template literal starting
 * with `/`; a template starting with SvelteKit's `base`; a conditional whose branches both are; or a
 * local `const` initialised to one of those. Anything else (an import, a call, a variable) is unknown.
 * @param {any} node an ESTree expression
 * @param {import('eslint').Scope.Scope} scope
 * @param {number} depth
 */
function isSameSitePath(node, scope, depth = 0) {
	if (!node || depth > 4) return false;
	if (node.type === 'Literal') return typeof node.value === 'string' && node.value.startsWith('/');
	if (node.type === 'TemplateLiteral') {
		const head = node.quasis[0]?.value.cooked ?? '';
		if (head.startsWith('/')) return true;
		const first = node.expressions[0];
		if (head !== '' || !first) return false;
		if (first.type === 'Identifier' && first.name === 'base') return true;
		return isSameSitePath(first, scope, depth + 1);
	}
	if (node.type === 'ConditionalExpression') {
		return (
			isSameSitePath(node.consequent, scope, depth + 1) &&
			isSameSitePath(node.alternate, scope, depth + 1)
		);
	}
	if (node.type === 'Identifier') {
		for (let s = scope; s; s = s.upper) {
			const v = s.set.get(node.name);
			if (!v) continue;
			const def = v.defs[0];
			if (def?.type !== 'Variable' || def.parent?.kind !== 'const') return false;
			return isSameSitePath(def.node.init, s, depth + 1);
		}
	}
	return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const redirectStatesExternal = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'require a redirect() to a computed location to say whether it leaves the site ({ external })'
		},
		schema: [],
		messages: {
			unstated:
				'This redirect() goes to a computed location with no options. SvelteKit 3 answers an ' +
				'off-origin redirect without `{ external: true }` with a 500; pass `{ external: true }` if ' +
				'it can leave the site, or `{ external: false }` if it is a same-site path.'
		}
	},
	create(context) {
		/** Local names `redirect` is imported as from @sveltejs/kit. */
		const names = new Set();
		return {
			ImportDeclaration(node) {
				if (node.source.value !== '@sveltejs/kit') return;
				for (const spec of node.specifiers) {
					if (
						spec.type === 'ImportSpecifier' &&
						spec.imported.type === 'Identifier' &&
						spec.imported.name === 'redirect'
					) {
						names.add(spec.local.name);
					}
				}
			},
			CallExpression(node) {
				if (node.callee.type !== 'Identifier' || !names.has(node.callee.name)) return;
				if (node.arguments.length >= 3) return;
				const where = node.arguments[1];
				if (isSameSitePath(where, context.sourceCode.getScope(node))) return;
				context.report({ node, messageId: 'unstated' });
			}
		};
	}
};
