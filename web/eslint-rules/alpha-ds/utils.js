// Shared helpers for the Alpha design-system lint rules. Plain JS (ESM) so eslint.config.js can
// load the plugin without a build step. Works on .svelte (svelte-eslint-parser) and .ts/.js files.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every `--ds-*` token the system defines, plus the Tailwind colour utility names. */
export const manifest = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL('../../../packages/alpha-ds/src/tokens/generated/manifest.json', import.meta.url)
		),
		'utf8'
	)
);
/**
 * Custom properties the utilities define rather than the token build: lengths they register with
 * `@property` (`--ds-fade-start`) and knobs they read with a fallback (`var(--ds-scroll-fade, 32px)`).
 * A component that drives a utility sets these, so they are as real as a token.
 */
const utilitiesCss = readFileSync(
	fileURLToPath(new URL('../../../packages/alpha-ds/src/tokens/utilities.css', import.meta.url)),
	'utf8'
);
const UTILITY_PROPERTIES = [
	...utilitiesCss.matchAll(/@property\s+(--ds-[\w-]+)|var\(\s*(--ds-[\w-]+)\s*,/g)
].map((m) => m[1] ?? m[2]);
export const TOKENS = new Set([...manifest.tokens, ...UTILITY_PROPERTIES]);

const CLASS_CALLEES = new Set(['cn', 'clsx', 'cx', 'tv', 'twMerge', 'twJoin', 'cva']);

/**
 * Split a class token into its variants and its utility. Colons inside [] or () don't split
 * (`[&_svg]:size-4`, `data-[state=open]:x`, `bg-(--x)`).
 */
export function parseClass(token) {
	let depth = 0;
	let last = -1;
	for (let i = 0; i < token.length; i++) {
		const ch = token[i];
		if (ch === '[' || ch === '(') depth++;
		else if (ch === ']' || ch === ')') depth--;
		else if (ch === ':' && depth === 0) last = i;
	}
	const variants = last >= 0 ? token.slice(0, last).split(':') : [];
	let utility = last >= 0 ? token.slice(last + 1) : token;
	utility = utility.replace(/^!|!$/g, '').replace(/^-/, '');
	const slash = utility.lastIndexOf('/');
	const base =
		slash > 0 && !utility.includes('[') && !utility.includes('(')
			? utility.slice(0, slash)
			: utility;
	return { variants, utility: base, raw: token };
}

export const classTokens = (text) => text.split(/\s+/).filter(Boolean);

function isClassAttribute(node) {
	return node?.type === 'SvelteAttribute' && node.key?.name === 'class';
}

/** Is this string node a list of classes (class attr, cn()/tv() arg, *Class variable)? */
export function isClassContext(node) {
	let n = node.parent;
	while (n) {
		if (isClassAttribute(n)) return true;
		if (n.type === 'SvelteDirective' && n.kind === 'Class') return false;
		if (n.type === 'CallExpression') {
			const callee = n.callee.type === 'Identifier' ? n.callee.name : n.callee.property?.name;
			if (callee && (CLASS_CALLEES.has(callee) || /Recipe$/.test(callee))) return true;
		}
		if (
			n.type === 'VariableDeclarator' &&
			n.id.type === 'Identifier' &&
			/class(es|Name)?$/i.test(n.id.name)
		)
			return true;
		if (n.type === 'Property' && n.key && /^(class|className)$/.test(n.key.name ?? n.key.value))
			return true;
		if (n.type === 'SvelteStartTag' || n.type === 'Program' || n.type === 'FunctionDeclaration')
			return false;
		n = n.parent;
	}
	return false;
}

/**
 * Visit every class string in a file: `cb(text, node)`. Covers class="…" literals, and string
 * literals / template quasis inside class contexts.
 */
export function classVisitor(context, cb) {
	const onString = (node, text) => {
		if (typeof text === 'string' && isClassContext(node)) cb(text, node);
	};
	return {
		SvelteLiteral(node) {
			if (isClassAttribute(node.parent)) cb(node.value, node);
		},
		Literal(node) {
			onString(node, node.value);
		},
		TemplateElement(node) {
			onString(node, node.value.cooked ?? node.value.raw);
		}
	};
}

/** Visit style text: <style> blocks, style="" attributes, style: directives. `cb(text, node)`. */
export function styleVisitor(context, cb) {
	const source = context.sourceCode;
	return {
		SvelteStyleElement(node) {
			cb(source.getText(node), node);
		},
		SvelteAttribute(node) {
			if (node.key?.name === 'style') cb(source.getText(node), node);
		},
		SvelteStyleDirective(node) {
			cb(source.getText(node), node);
		}
	};
}

export const TAILWIND_PALETTE =
	'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
export const COLOR_PREFIX =
	'bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow|inset-shadow';

export function isComponentImportedFromDs(context, rootName) {
	const program = context.sourceCode.ast;
	for (const stmt of walkImports(program)) {
		if (!/(^@aipotluck\/alpha-ds$|alpha-ds(\/index(\.ts)?)?$)/.test(stmt.source.value)) continue;
		if (stmt.specifiers.some((s) => s.local.name === rootName)) return true;
	}
	return false;
}

function* walkImports(program) {
	for (const node of program.body) {
		if (node.type === 'ImportDeclaration') yield node;
		if (node.type === 'SvelteScriptElement') {
			for (const inner of node.body ?? []) if (inner.type === 'ImportDeclaration') yield inner;
		}
	}
}

export const docsUrl = (rule) => `https://www.aipotluck.org/designsystem/linting#${rule}`;
