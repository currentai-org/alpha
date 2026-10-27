// A bare `$effect.root(() => {...})` statement discards the dispose function it returns (CUR-1157). Svelte's own compiler marks that root
// EFFECT_PRESERVED specifically so it survives the enclosing component's own destroy cascade (see
// svelte.dev/docs/svelte/$effect#$effect.root: "a non-tracked scope that doesn't auto-cleanup") --
// the caller has to invoke the returned function itself (typically via onDestroy), or the effect,
// and whatever it owns (an SSE connection, an interval, an event listener), outlives the component.
//
// No existing rule catches this: no eslint-plugin-svelte rule references $effect.root or dispose,
// and ast-grep -- the obvious alternative -- cannot parse .svelte files at all (Svelte and Vue SFCs
// are outside its supported-language set, since neither is a single tree-sitter grammar). This
// rule reuses svelte-eslint-parser's delegation of a component's <script> block to the real
// TypeScript parser, so it needs no Svelte-specific AST awareness -- $effect.root(...) is ordinary
// JS/TS syntax (a MemberExpression call), just like any other function call.
//
// Deliberately narrow: only flags the call as a BARE ExpressionStatement (`$effect.root(...);`,
// nothing captured at all). A call that IS assigned to a variable but never used again
// (`const dispose = $effect.root(...)` with `dispose` never referenced) is already caught by
// `@typescript-eslint/no-unused-vars` (already `error` in this config) -- duplicating that check
// here would just be two rules reporting the same line.

/** @type {import('eslint').Rule.RuleModule} */
export const noDiscardedEffectRoot = {
	meta: {
		type: 'problem',
		docs: {
			description: 'disallow calling $effect.root(...) without capturing its dispose function'
		},
		schema: [],
		messages: {
			discarded:
				'$effect.root() returns a dispose function that must be captured and invoked (typically ' +
				'`const dispose = $effect.root(...)` then `onDestroy(dispose)`) -- this root is EFFECT_PRESERVED ' +
				'and will never tear down on its own (CUR-1157).'
		}
	},
	create(context) {
		return {
			ExpressionStatement(node) {
				const expr = node.expression;
				if (
					expr.type === 'CallExpression' &&
					expr.callee.type === 'MemberExpression' &&
					!expr.callee.computed &&
					expr.callee.object.type === 'Identifier' &&
					expr.callee.object.name === '$effect' &&
					expr.callee.property.type === 'Identifier' &&
					expr.callee.property.name === 'root'
				) {
					context.report({ node: expr, messageId: 'discarded' });
				}
			}
		};
	}
};
