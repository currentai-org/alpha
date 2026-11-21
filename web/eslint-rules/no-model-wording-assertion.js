// An e2e spec that reads an assistant message's text is grading the model's wording, which varies
// between runs, so the spec passes or fails by chance and a red suite stops meaning our code changed.
// This refuses reading the text of a locator built from `[data-message-role="assistant"]` (directly,
// or through a variable that holds one) outside a test or describe tagged `@live-model`. A locator
// that names a test id after the assistant message is ours (a notice or chip inside the message) and
// is allowed; a test id before it only scopes the search, so the read is still the model's wording.
//
// A custom rule rather than a no-restricted-syntax selector: the specs name the message once
// (`const answer = page.locator(...)`) and read it later through that variable, which a selector,
// matching one node at a time, cannot follow.

const ASSISTANT = /data-message-role=["']?assistant/;
const OURS = /data-testid/;
const TEXT_READS = new Set([
	'innerText',
	'textContent',
	'allInnerTexts',
	'allTextContents',
	'innerHTML'
]);
const TEXT_MATCHERS = new Set(['toHaveText', 'toContainText']);
const LIVE_MODEL = '@live-model';

/** @param {any} node @returns {string | null} */
function stringOf(node) {
	if (!node) return null;
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.raw).join('');
	return null;
}

/** Whether a call's title or details object carries the @live-model tag. @param {any} call */
function tagsLiveModel(call) {
	const [title, details] = call.arguments;
	if (stringOf(title)?.includes(LIVE_MODEL)) return true;
	if (details?.type !== 'ObjectExpression') return false;
	const tag = details.properties.find((p) => p.type === 'Property' && p.key?.name === 'tag');
	if (!tag) return false;
	const values = tag.value.type === 'ArrayExpression' ? tag.value.elements : [tag.value];
	return values.some((v) => stringOf(v)?.includes(LIVE_MODEL));
}

/** `test(...)`, `test.describe(...)`, `test.describe.serial(...)`, `test.only(...)` and so on. */
function isTestCall(node) {
	if (node.type !== 'CallExpression') return false;
	let callee = node.callee;
	while (callee.type === 'MemberExpression') callee = callee.object;
	return callee.type === 'Identifier' && (callee.name === 'test' || callee.name === 'describe');
}

/** @type {import('eslint').Rule.RuleModule} */
export const noModelWordingAssertion = {
	meta: {
		type: 'problem',
		docs: {
			description: "Refuse asserting on an assistant message's text outside a @live-model test"
		},
		schema: [],
		messages: {
			wording:
				"This reads the assistant message's text, so the spec grades the model's wording, which changes between runs. Assert on something our code emits instead: a notice, chip or trace line by its test id (answer.getByTestId(...)), a data attribute, or a network event. A check that genuinely needs the wording goes in a test or describe tagged '@live-model'."
		}
	},
	create(context) {
		/** Variable names that hold an assistant-message locator. */
		const assistantVars = new Set();
		/** Variable names that hold a locator inside the message that we own (it names a test id). */
		const oursVars = new Set();

		/**
		 * Walk a locator chain from its root outwards and report what it names. A test id counts as ours
		 * only once the chain has already reached the assistant message, so it narrows to our element
		 * inside the message rather than scoping the search from outside it. @param {any} node
		 */
		function chain(node, found = { assistant: false, ours: false }) {
			if (!node) return found;
			const s = stringOf(node);
			if (s !== null) {
				const a = s.search(ASSISTANT);
				if (a >= 0) found.assistant = true;
				const o = s.search(OURS);
				if (o >= 0 && found.assistant && (a < 0 || o > a)) found.ours = true;
				return found;
			}
			switch (node.type) {
				case 'Identifier':
					if (assistantVars.has(node.name)) found.assistant = true;
					if (oursVars.has(node.name)) found.ours = true;
					break;
				case 'AwaitExpression':
				case 'ChainExpression':
					chain(node.argument ?? node.expression, found);
					break;
				case 'MemberExpression':
					chain(node.object, found);
					break;
				case 'CallExpression':
					// The callee is the earlier part of the chain, so it is walked before this call's own
					// selector or test id.
					chain(node.callee, found);
					if (
						node.callee.type === 'MemberExpression' &&
						node.callee.property.name === 'getByTestId' &&
						found.assistant
					)
						found.ours = true;
					for (const arg of node.arguments) chain(arg, found);
					break;
			}
			return found;
		}

		function remember(name, init) {
			const found = chain(init);
			if (found.assistant) assistantVars.add(name);
			if (found.ours) oursVars.add(name);
		}

		function insideLiveModel(node) {
			return context.sourceCode.getAncestors(node).some((a) => isTestCall(a) && tagsLiveModel(a));
		}

		function check(node, target) {
			const found = chain(target);
			if (found.assistant && !found.ours && !insideLiveModel(node))
				context.report({ node, messageId: 'wording' });
		}

		return {
			VariableDeclarator(node) {
				if (node.id.type === 'Identifier' && node.init) remember(node.id.name, node.init);
			},
			AssignmentExpression(node) {
				if (node.left.type === 'Identifier') remember(node.left.name, node.right);
			},
			CallExpression(node) {
				if (node.callee.type !== 'MemberExpression') return;
				const name = node.callee.property.name;
				// answer.innerText(), answer.locator('.prose').textContent() ...
				if (TEXT_READS.has(name)) check(node, node.callee.object);
				// expect(answer).toContainText(...), expect(answer).not.toHaveText(...)
				if (TEXT_MATCHERS.has(name)) {
					let subject = node.callee.object;
					while (subject.type === 'MemberExpression') subject = subject.object;
					if (subject.type === 'CallExpression' && subject.arguments[0])
						check(node, subject.arguments[0]);
				}
			}
		};
	}
};
