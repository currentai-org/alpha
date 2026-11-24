// MODEL_ALLOWLIST is read in one module, config/picker.ts (modelAllowlist, servedModels, defaultModel).
// On Vercel the committed picker decides what www and alpha serve, and the variable is only an
// off-Vercel override. A harness or live spec that reads it directly grades whatever an environment
// value says, which can differ from what visitors are served.
//
// The rule fails MODEL_ALLOWLIST taken off `process.env` by a dot, a string index or a destructure, read
// or written. It leaves `config.MODEL_ALLOWLIST`
// alone: that is the app's validated env object, which the resolver's callers in src/ already go
// through. A spec that needs the override sets it with `vi.stubEnv("MODEL_ALLOWLIST", …)`.
//
// A custom rule rather than `no-restricted-syntax` entries: the lint configs already give
// `no-restricted-syntax` to the same files for the host-env rule, and a second block would replace
// that array instead of adding to it.
//
// Used by eslint.config.js (src/ and e2e/, specs included) and eslint.scripts.config.js (scripts/,
// config/ and evals/).

/** The one file allowed to read MODEL_ALLOWLIST, relative to web/. */
export const MODEL_ALLOWLIST_MODULE = 'config/picker.ts';

const NAME = 'MODEL_ALLOWLIST';

/** Is `node` the expression `process.env`? */
function isProcessEnv(node) {
	return (
		node?.type === 'MemberExpression' &&
		node.object.type === 'Identifier' &&
		node.object.name === 'process' &&
		!node.computed &&
		node.property.type === 'Identifier' &&
		node.property.name === 'env'
	);
}

/** The property name a member expression or destructured key names, if it is a static one. */
function staticName(key, computed) {
	if (!computed && key.type === 'Identifier') return key.name;
	if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
	return undefined;
}

export const noModelAllowlistRead = {
	meta: {
		type: 'problem',
		docs: { description: 'Read MODEL_ALLOWLIST only through config/picker.ts' },
		schema: [],
		messages: {
			read: 'Read the served models through config/picker.ts (defaultModel, servedModels, modelAllowlist), never MODEL_ALLOWLIST off process.env: off Vercel it is an override, on Vercel the picker decides. A spec sets it with vi.stubEnv.'
		}
	},
	create(context) {
		return {
			MemberExpression(node) {
				if (isProcessEnv(node.object) && staticName(node.property, node.computed) === NAME) {
					context.report({ node, messageId: 'read' });
				}
			},
			VariableDeclarator(node) {
				if (node.id.type !== 'ObjectPattern' || !isProcessEnv(node.init)) return;
				for (const prop of node.id.properties) {
					if (prop.type === 'Property' && staticName(prop.key, prop.computed) === NAME) {
						context.report({ node: prop, messageId: 'read' });
					}
				}
			}
		};
	}
};
