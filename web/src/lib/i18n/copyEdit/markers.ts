// Copy edit mode tags every rendered message with its key, so a click on the page can find which
// message a piece of text came from. The tag is invisible: a start character, the key's index in
// base 4 written with zero-width characters, a separator, the text, then an end character. Tags
// nest when a message is passed into another one as a parameter.

const START = '⁢';
const SEP = '⁣';
const END = '⁤';
const DIGITS = ['​', '‌', '‍', '⁠'];
const ALL = new Set([START, SEP, END, ...DIGITS]);

export function mark(index: number, text: string): string {
	let digits = '';
	let n = index;
	do {
		digits = DIGITS[n % 4] + digits;
		n = Math.floor(n / 4);
	} while (n > 0);
	return `${START}${digits}${SEP}${text}${END}`;
}

export function hasMarker(text: string): boolean {
	return text.includes(START);
}

/** The text with every tag character removed. */
export function stripMarkers(text: string): string {
	let out = '';
	for (const ch of text) if (!ALL.has(ch)) out += ch;
	return out;
}

export interface Segment {
	/** Key index, as passed to `mark`. */
	index: number;
	/** Offsets into the tagged string: the whole tag, and the text inside it. */
	start: number;
	end: number;
	contentStart: number;
	contentEnd: number;
	depth: number;
}

/** Every tagged message in `text`, outermost first. Unbalanced tags (a string cut mid-tag) are skipped. */
export function segments(text: string): Segment[] {
	const out: Segment[] = [];
	const stack: { index: number; start: number; contentStart: number }[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === START) {
			let j = i + 1;
			let index = 0;
			while (j < text.length && DIGITS.includes(text[j])) {
				index = index * 4 + DIGITS.indexOf(text[j]);
				j++;
			}
			if (text[j] !== SEP) continue;
			stack.push({ index, start: i, contentStart: j + 1 });
			i = j;
		} else if (ch === END && stack.length) {
			const open = stack.pop()!;
			out.push({ ...open, end: i + 1, contentEnd: i, depth: stack.length });
		}
	}
	return out.sort((a, b) => a.start - b.start || a.depth - b.depth);
}

/** The innermost tagged message whose text contains `offset`. */
export function segmentAt(text: string, offset: number): Segment | undefined {
	let best: Segment | undefined;
	for (const s of segments(text)) {
		if (offset >= s.contentStart && offset <= s.contentEnd && (!best || s.depth > best.depth))
			best = s;
	}
	return best;
}

/** The `{name}` placeholders a message template uses, sorted. */
export function placeholders(template: string): string[] {
	return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((x) => x[1]))].sort();
}

/** A template with its `{name}` placeholders filled from `inputs`; unknown ones stay as written. */
export function interpolate(template: string, inputs: unknown): string {
	const values = (inputs ?? {}) as Record<string, unknown>;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
	);
}
