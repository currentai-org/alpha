// Minimal, hand-written types for the Lexical JSON shapes actually rendered by this walker —
// deliberately NOT importing from `@payloadcms/richtext-lexical` (its conversion exports carry
// peer deps on `payload`/React/`@faceless-ui`, the wrong fit for a Svelte app).

// A single loose shape covering every node kind this walker dispatches on, rather than a
// discriminated union — the walker narrows by `node.type` at each `{#if}` branch anyway, and a
// shared shape means no per-branch casting in the `.svelte` dispatcher.
export type LexicalNode = {
	type: string;
	version: number;
	children?: LexicalNode[];
	text?: string;
	format?: number;
	tag?: string;
	listType?: 'bullet' | 'number' | 'check';
	headerState?: number;
	colSpan?: number;
	rowSpan?: number;
	fields?: {
		blockType?: string;
		url?: string | null;
		newTab?: boolean | null;
		[key: string]: unknown;
	} | null;
	[key: string]: unknown;
};

export type LexicalRoot = {
	root: {
		children: LexicalNode[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

const TEXT_FORMAT_BITS = {
	bold: 1,
	italic: 2,
	strikethrough: 4,
	underline: 8,
	code: 16
} as const;

export function textFormatFlags(format: number) {
	return {
		bold: (format & TEXT_FORMAT_BITS.bold) !== 0,
		italic: (format & TEXT_FORMAT_BITS.italic) !== 0,
		strikethrough: (format & TEXT_FORMAT_BITS.strikethrough) !== 0,
		underline: (format & TEXT_FORMAT_BITS.underline) !== 0,
		code: (format & TEXT_FORMAT_BITS.code) !== 0
	};
}
