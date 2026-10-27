// `Boolean(detect(answer))` is true for every return value of `detect` -- every object is
// truthy, including `{fired: false}` (CUR-1617). `@typescript-eslint/no-unnecessary-
// condition` (wired up alongside this rule in eslint.quality.config.js) does not catch this shape: it
// only inspects syntactic boolean POSITION (`if (x)`, `x ? a : b`, `x && y`, `!x`), not a value passed
// as a function-call ARGUMENT -- `Boolean(x)`, `expect(x).toBeTruthy()`, `assert(x)` and
// `expect(x).toBeDefined()` are all call arguments, invisible to it. This rule covers exactly that gap,
// for the shapes CUR-1617 names.
//
// `isAlwaysObjectType` reimplements typescript-eslint's own always-truthy test, narrowed to "every
// union/intersection constituent is an object type" (TypeFlags.Object) rather than the fully general
// "possibly falsy" check `no-unnecessary-condition` uses internally -- that broader check lives in the
// eslint-plugin's own dist/util/truthinessUtils.js, which is not part of its published API surface (no
// stable subpath export) and isn't safe to deep-import. The object-only version is what CUR-1617 itself
// asks for ("objectExpr", "f returns an object") and is the actually non-obvious trap: an object is
// truthy no matter its shape, while a string/number/boolean literal being always-truthy already shows
// up in source and is partly caught by no-unnecessary-condition's syntactic checks.
//
// `any`/`unknown`/`never` are skipped throughout (can't prove anything about them, and no-unnecessary-
// condition does the same).

import { ESLintUtils } from '@typescript-eslint/utils';
import { isTypeAnyType, isTypeUnknownType } from '@typescript-eslint/type-utils';
import * as tsutils from 'ts-api-utils';
import ts from 'typescript';

const createRule = ESLintUtils.RuleCreator(
	() => 'https://typescript-eslint.io/developers/custom-rules'
);

/** @param {import('typescript').Type} type */
function isAlwaysObjectType(type) {
	const constituents = tsutils
		.unionConstituents(type)
		.flatMap((t) => tsutils.intersectionConstituents(t));
	if (constituents.length === 0) return false;
	return constituents.every(
		(t) =>
			!isTypeAnyType(t) &&
			!isTypeUnknownType(t) &&
			!tsutils.isTypeFlagSet(t, ts.TypeFlags.Never) &&
			tsutils.isTypeFlagSet(t, ts.TypeFlags.Object)
	);
}

/** @param {import('typescript').Type} type */
function isNeverUndefined(type) {
	const constituents = tsutils
		.unionConstituents(type)
		.flatMap((t) => tsutils.intersectionConstituents(t));
	if (constituents.length === 0) return false;
	return constituents.every(
		(t) =>
			!isTypeAnyType(t) &&
			!isTypeUnknownType(t) &&
			!tsutils.isTypeFlagSet(t, ts.TypeFlags.Undefined | ts.TypeFlags.Void)
	);
}

function isIdentifierNamed(node, name) {
	return node?.type === 'Identifier' && node.name === name;
}

// A subject whose non-optional type traces back to `x!` (either written inline, or on the
// initializer of the variable being read) earned that type from the author's own assertion, not
// from the value's real origin -- and a runtime toBeDefined() right after it is doing real work:
// it turns a silent `undefined` slipping past that `!` into a clear assertion failure instead of a
// confusing TypeError two lines later. Not the vacuous-by-construction shape this rule is for.
// Example: `body.split("\n").find(...)!`
// assigned to `row`, then `expect(row).toBeDefined()` -- exactly this idiom.
function isNonNullAssertionDerived(context, subject) {
	if (subject.type === 'TSNonNullExpression') return true;
	if (subject.type !== 'Identifier') return false;
	let scope = context.sourceCode.getScope(subject);
	while (scope) {
		const variable = scope.variables.find((v) => v.name === subject.name);
		if (variable) {
			const def = variable.defs[variable.defs.length - 1];
			return (
				def?.node?.type === 'VariableDeclarator' && def.node.init?.type === 'TSNonNullExpression'
			);
		}
		scope = scope.upper;
	}
	return false;
}

/** `assert(x)` or `assert.ok(x)` */
function isAssertCall(node) {
	if (node.callee.type === 'Identifier' && node.callee.name === 'assert') return true;
	return (
		node.callee.type === 'MemberExpression' &&
		!node.callee.computed &&
		isIdentifierNamed(node.callee.object, 'assert') &&
		isIdentifierNamed(node.callee.property, 'ok')
	);
}

export const noVacuousTruthinessAssertion = createRule({
	name: 'no-vacuous-truthiness-assertion',
	meta: {
		type: 'problem',
		docs: {
			description:
				'disallow a truthiness/definedness assertion whose subject can never be false or undefined'
		},
		schema: [],
		messages: {
			alwaysTruthyObject:
				'{{call}} can never be false: the argument is always an object type, and every object is ' +
				'truthy in JS. This assertion passes for every possible value, including one that failed ' +
				'(CUR-1617).',
			alwaysDefined:
				"expect(...).toBeDefined() can never fail: the expression's type never includes " +
				'undefined, so this is not testing anything (CUR-1617).'
		}
	},
	defaultOptions: [],
	create(context) {
		const services = ESLintUtils.getParserServices(context, true);
		if (!services.program) return {};
		const checker = services.program.getTypeChecker();

		/** @param {import('estree').Node} node */
		function typeOf(node) {
			const tsNode = services.esTreeNodeToTSNodeMap.get(node);
			return checker.getTypeAtLocation(tsNode);
		}

		return {
			// Boolean(x) / !!x
			'CallExpression[callee.name="Boolean"][arguments.length=1]'(node) {
				if (isAlwaysObjectType(typeOf(node.arguments[0]))) {
					context.report({ node, messageId: 'alwaysTruthyObject', data: { call: 'Boolean(...)' } });
				}
			},
			'UnaryExpression[operator="!"] > UnaryExpression[operator="!"]'(node) {
				if (isAlwaysObjectType(typeOf(node.argument))) {
					context.report({
						node: node.parent,
						messageId: 'alwaysTruthyObject',
						data: { call: '!!...' }
					});
				}
			},
			// expect(x).toBeTruthy() / expect(x).toBeDefined()
			'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(toBeTruthy|toBeDefined)$/][arguments.length=0]'(
				node
			) {
				const { callee } = node;
				if (
					callee.object.type !== 'CallExpression' ||
					!isIdentifierNamed(callee.object.callee, 'expect') ||
					callee.object.arguments.length !== 1
				) {
					return;
				}
				const subject = callee.object.arguments[0];
				const matcher = callee.property.name;
				if (matcher === 'toBeTruthy' && isAlwaysObjectType(typeOf(subject))) {
					context.report({
						node,
						messageId: 'alwaysTruthyObject',
						data: { call: 'expect(...).toBeTruthy()' }
					});
				} else if (
					matcher === 'toBeDefined' &&
					isNeverUndefined(typeOf(subject)) &&
					!isNonNullAssertionDerived(context, subject)
				) {
					context.report({ node, messageId: 'alwaysDefined' });
				}
			},
			// assert(x) / assert.ok(x)
			'CallExpression[arguments.length=1]'(node) {
				if (isAssertCall(node) && isAlwaysObjectType(typeOf(node.arguments[0]))) {
					context.report({
						node,
						messageId: 'alwaysTruthyObject',
						data: { call: node.callee.type === 'Identifier' ? 'assert(...)' : 'assert.ok(...)' }
					});
				}
			}
		};
	}
});
