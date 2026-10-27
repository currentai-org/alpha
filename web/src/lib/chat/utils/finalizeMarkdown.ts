import { Lexer, type Token, type Tokens } from "marked";

/*
 * Completion-time markdown normalization for FINISHED assistant messages.
 *
 * While a message streams, the renderer repairs incomplete markdown with
 * `remend` (see parseIncompleteMarkdown + the `streaming` branch of
 * processBlocks in ./marked.ts). That repair is deliberately skipped once the
 * message completes, because remend's streaming flash-guards would corrupt some
 * VALID completed markdown — most notably a trailing single-dash setext heading
 * (`text\n-`), which remend rewrites with a zero-width space. The side effect is
 * a visible "settle": when the model emits MALFORMED markdown, bold/list
 * formatting that showed while streaming reverts to a literal `**` / a run-on
 * paragraph the instant `loading` flips to false and the raw content is parsed.
 *
 * finalizeMarkdown runs on the completed content (the non-streaming branch) and
 * fixes only the two malformed-output shapes that cause that settle:
 *
 *   A. Run-on bold list — labeled items crammed onto one physical line. Detected
 *      as a malformed/crammed list (not prose) by either UNCLOSED bold labels
 *      (`1. **Alpha 2. **Beta …`) or a list item running its siblings on inside a
 *      real list (`2. **Economy**: … 3. Privacy … 4. **Environment**: …`). Split
 *      into real <li>s. See splitRunOnOrderedList for the exact disambiguation.
 *   B. Dangling bold — an opened `**` with no closing `**`. Closed per split
 *      item (each is self-contained) or once per whole paragraph unit (so a
 *      legitimate multi-line `**bold\nspan**` stays balanced and untouched).
 *
 * It also rewrites one valid shape the model never means: a setext `---` heading
 * whose text spans several lines, which is a block closed by a rule (a letter's
 * signature over its closing `---`, CUR-3662). See multiLineSetextAsRule.
 *
 * It is TOKEN-AWARE: it lexes with marked and only ever rewrites `paragraph` and
 * run-on `list` tokens, emitting every other container (tables, blockquotes,
 * code, headings, real multi-line lists, html) verbatim. Combined with the
 * guards below, that keeps it from turning valid markdown into a different
 * document — the failure mode of a naive raw-line regex pass.
 *
 * Safety guards:
 *   - A whole-message faithfulness check: finalizeMarkdown only runs when the
 *     block-token stream losslessly reconstructs the input. `Lexer.lex` hoists
 *     link/footnote reference definitions into `tokens.links` and normalizes
 *     CRLF, so any content where `token.raw` concatenation ≠ input is left
 *     entirely untouched (no dropped definitions, no CRLF rewrite).
 *   - Transform A splits only an unclosed-bold run or a bold list-continuation
 *     (see splitRunOnOrderedList). Prose that closes its bold ("See Section 1.
 *     **Introduction** and Section 2. **Methods**"), a first/only item with a
 *     sub-enumeration ("1. Sub-options: 2. a 3. b"), and bare number prose are all
 *     left untouched.
 *   - A unit whose line carries math (`$$`, `\[`, `\(`), an inline link/image, or
 *     a reference definition (`[id]:`) is not restructured (a run-on there is
 *     left whole rather than half-fixed). Run indentation is preserved so a
 *     nested list stays nested.
 *   - Bold counting is flanking-aware, so a literal `**` surrounded by spaces
 *     ("Type ** to start bold") or an operator `**` ("5**2") is not mistaken for
 *     an unclosed opener.
 *   - A unit containing inline code (`) is not bold-closed. Pre-existing list-item
 *     lines are never bold-closed, so a multi-line strong span inside a list item
 *     ("- **Important:\n  continues**") is preserved.
 *
 * For clean, well-formed content finalizeMarkdown is a byte-for-byte no-op.
 */

// An ordered-list marker (`N.`/`N)`) followed by content (a non-space).
const ORDERED_MARKER = /(?:^|(?<=\s))(\d{1,3})[.)]\s+(?=\S)/g;
// A marker's content starting with a bold LABEL that carries a colon —
// `**Economy**:`, `**Climate Change:` (unclosed), `**Society & Culture**:`. This is
// the list-item shape the model emits ("**Label**: description"); prose that merely
// bolds a word after a number ("**Introduction** and", "**Alpha** for") has no
// colon and does not match, so it is not mistaken for a labeled list item.
const COLON_LABEL = /^\*\*[^*\n]*(?:\*\*)?:/;

/**
 * Flanking-aware scan for an unclosed `**`. Walks each `**` delimiter left to
 * right. A span opens only on a CLEAN opener — left-flanking (followed by a
 * non-space) and NOT also right-flanking (preceded by a space, start, or
 * punctuation) — so an intra-word or operator `**` like `5**2` (exponent) or
 * `un**even` is treated as literal, never as an unclosed opener. An open span
 * closes on any right-flanking `**` (preceded by a non-space). A `**` surrounded
 * by spaces ("Type ** to start") is neither and leaves no false "open".
 */
function hasDanglingBold(text: string): boolean {
	let open = false;
	const re = /\*\*/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const before = text[m.index - 1];
		const after = text[m.index + 2];
		const leftFlank = after !== undefined && !/\s/.test(after);
		const rightFlank = before !== undefined && !/\s/.test(before);
		if (open) {
			if (rightFlank) open = false;
		} else if (leftFlank && !rightFlank) {
			open = true;
		}
	}
	return open;
}

/** Append `**` to close a dangling bold in a self-contained segment. Segments
 *  containing inline code are left alone (a backtick would defeat the count). */
function closeBold(segment: string): string {
	if (segment.includes("`")) return segment;
	if (!hasDanglingBold(segment)) return segment;
	return segment.replace(/\s+$/, "") + "**";
}

type SplitLine = { prefix: string; items: string[]; listable: boolean };

/**
 * Detect a run-on ordered list on a single physical line and split it into a
 * prefix + one segment per item. Returns null when the line is not a run-on
 * list. The run is anchored at the first ordered marker on the line, uses
 * consecutive (+1) numbering, requires word content between markers (so
 * "figures 1. 2. and 3." — empty between 1 and 2 — is not a run), and must have at
 * least THREE items (a 2-item run is too easily one item + a numbered reference).
 *
 * It is split only when the run is unambiguously a malformed/crammed labeled list,
 * via ONE of two signals (a majority of items must qualify):
 *   (a) UNCLOSED bold labels — `1. **Climate: … 2. **Space: …` where the `**`
 *       never closes. Closed prose bold ("1. **Intro** and 2. **Body**") does not
 *       qualify, so a sentence that merely bolds words after numbers is left alone.
 *   (b) a LIST CONTINUATION — a run that starts at a number ≠ 1 inside a real list
 *       token (`isParagraph` false), e.g. item 2's text running its siblings on
 *       (`2. **Economy**: … 3. Privacy … 4. **Environment**: …`), whose items are
 *       STRICTLY mostly colon-labeled (`**Label**:`). Prose that references bold
 *       sections ("2. See Section 3. **Alpha** and 4. **Beta**") carries no colon
 *       labels, and a run starting at 1 (a first/only item, or prose) is too easily
 *       a sub-enumeration ("1. Sub-options: 2. a 3. b") — both are left to signal (a).
 *
 * `listable` reports whether splitting will actually parse as a list: a run
 * numbered from 1 can interrupt a paragraph, and a run at line start is already a
 * list context. A non-1 run after prose ("See 3. **Three 4. **Four") would only
 * become a <br> paragraph, so the caller declines to split it — but detection
 * still counts, so the caller leaves the whole unit untouched.
 */
function splitRunOnOrderedList(line: string, isParagraph: boolean): SplitLine | null {
	const markers: { start: number; contentStart: number; num: number }[] = [];
	let m: RegExpExecArray | null;
	ORDERED_MARKER.lastIndex = 0;
	while ((m = ORDERED_MARKER.exec(line)) !== null) {
		markers.push({ start: m.index, contentStart: m.index + m[0].length, num: Number(m[1]) });
	}
	if (markers.length < 2) return null;

	let j = 0;
	while (
		j + 1 < markers.length &&
		markers[j + 1].num === markers[j].num + 1 &&
		/\w/.test(line.slice(markers[j].contentStart, markers[j + 1].start))
	)
		j++;
	// Need a run of ≥3 items. A 2-marker run ("N. X N+1. Y") is too easily a single
	// list item that references the next number rather than a crammed list; both
	// reported failures crammed 3+ items, so this is the safe floor.
	if (j < 2) return null;

	const run = markers.slice(0, j + 1);
	const prefix = line.slice(0, run[0].start);
	const anchoredAtStart = prefix.trim() === "";
	const items: string[] = [];
	for (let i = 0; i < run.length; i++) {
		const end = i + 1 < run.length ? run[i + 1].start : line.length;
		items.push(line.slice(run[i].start, end));
	}

	const unclosedBold = items.filter((it) => hasDanglingBold(it)).length;
	const colonLabels = run.filter((mk) => COLON_LABEL.test(line.slice(mk.contentStart))).length;
	// (a) A majority of items have UNCLOSED bold — a strong "malformed output" signal.
	const majorityUnclosed = unclosedBold * 2 >= run.length;
	// (b) A list continuation (num≠1, real list) whose items are STRICTLY mostly
	// colon-labeled. Closed bold is weaker evidence than unclosed, so it needs a
	// strict majority of `**Label**:` items — prose like "2. See Section 3. **Alpha**
	// and 4. **Beta**" has zero colon labels and is left alone.
	const isListContinuation = !isParagraph && run[0].num !== 1;
	const colonMajority = colonLabels * 2 > run.length;
	if (!(majorityUnclosed || (isListContinuation && colonMajority))) return null;

	const listable = run[0].num === 1 || anchoredAtStart;
	return { prefix, items, listable };
}

/**
 * Normalize one paragraph/list token's raw text. `isParagraph` gates the
 * whole-unit bold close: a paragraph is a single logical unit (safe to close a
 * dangling bold across its soft breaks), but a list token's lines are
 * independent items and must not be closed as one unit — only run-on items
 * produced by the split are self-contained enough to close.
 */
function finalizeUnit(raw: string, isParagraph: boolean): string {
	const trail = raw.match(/\n*$/)?.[0] ?? "";
	const body = raw.slice(0, raw.length - trail.length);

	const lines = body.split("\n");
	const splits = lines.map((line) => splitRunOnOrderedList(line, isParagraph));
	const hasRunOn = splits.some(Boolean);

	// A run-on can only be safely restructured when it isn't entangled with other
	// syntax on the line: math ($$/\[/\(), inline links/images (a `N. **` could
	// fall inside a `[label]`), a link/footnote reference definition (`[id]:`), or
	// inline raw HTML (whose text content is literal and must not be rewritten);
	// and every detected run must be listable (see splitRunOnBoldLine).
	const hasMath = /\$\$|\\\[|\\\(/.test(body);
	const hasLinkOrImage = /!?\]\(/.test(body);
	const hasDefinition = /^\s*\[[^\]\n]+\]:/m.test(body);
	// Any raw-markup start — a tag (`<a`, `</a`), an HTML comment / declaration /
	// CDATA (`<!`), or a processing instruction (`<?`) — whose contents are literal
	// and must not be rewritten. `< ` / `<3` (prose comparators) are not matched.
	const hasInlineHtml = /<[a-zA-Z/!?]/.test(body);
	const allListable = splits.every((s) => !s || s.listable);
	const canSplit = !hasMath && !hasLinkOrImage && !hasDefinition && !hasInlineHtml && allListable;

	if (hasRunOn) {
		// Present but unsafe to restructure → leave the whole unit untouched rather
		// than half-fix it (splitting some markers, closing one stray bold).
		if (!canSplit) return raw;
		const outLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const split = splits[i];
			if (!split) {
				outLines.push(lines[i]);
				continue;
			}
			// A whitespace-only prefix is the run's indentation (keep it on every
			// item, so a nested list stays nested); a textual prefix becomes its own
			// preceding line and the items sit at that line's indentation level.
			const indent = split.prefix.trim() === "" ? split.prefix : "";
			if (split.prefix.trim() !== "") outLines.push(split.prefix.replace(/[ \t]+$/, ""));
			for (const item of split.items) {
				outLines.push(indent + closeBold(item.replace(/[ \t]+$/, "")));
			}
		}
		return outLines.join("\n") + trail;
	}

	// No run-on: close a dangling bold across the whole paragraph unit. Skipped for
	// list tokens (would orphan a multi-line span's closer), math, definitions, and
	// inline raw HTML (a literal ** inside <span>…</span> must not be closed).
	if (isParagraph && !hasMath && !hasDefinition && !hasInlineHtml) return closeBold(body) + trail;
	return raw;
}

// A setext heading's raw: its text lines, then a dash underline, then any trailing newlines. Only
// three or more dashes stand alone as a rule; a shorter underline would become a list marker or text.
const SETEXT_DASH_HEADING = /^([\s\S]*\n)([ ]{0,3}-{3,}[ \t]*)(\n*)$/;

/**
 * A setext `---` heading whose text spans several lines, rewritten as that paragraph and a rule.
 *
 * @remarks
 * A heading is one line in practice, so several lines over a `---` are a block the model closed with
 * a rule: a model may bracket a drafted letter in `---` and put the closing one straight under
 * the signature (CUR-3662). A one-line setext heading (`Title\n---`) is left as it is, and so is an
 * `===` underline, which is no rule.
 */
function multiLineSetextAsRule(token: Token): string | null {
	if (token.type !== "heading" || (token as Tokens.Heading).depth !== 2) return null;
	const match = SETEXT_DASH_HEADING.exec(token.raw);
	if (!match) return null;
	const [, text, underline, trail] = match;
	if (!text.trimEnd().includes("\n")) return null;
	return `${text}\n${underline}${trail}`;
}

function isNumberReadAsEmptyList(token: Token): boolean {
	return (
		token.type === "list" &&
		(token as Tokens.List).ordered &&
		(token as Tokens.List).items.every((item) => item.text.trim() === "")
	);
}

/**
 * Normalize completed assistant markdown. See the file header for the full
 * contract. Only `paragraph` and `list` block tokens, and a multi-line setext
 * heading, are rewritten; everything else is emitted verbatim. A lexer failure degrades to the original content.
 */
export function finalizeMarkdown(content: string): string {
	let tokens;
	try {
		tokens = Lexer.lex(content, { gfm: true });
	} catch {
		return content;
	}
	// Faithfulness guard: only proceed when the block-token stream losslessly
	// reconstructs the input, since concatenating `token.raw` can otherwise drop
	// or alter content. When the partition isn't exact, leave the message alone.
	//
	// Verified on marked 18 (markedCorpus.spec.ts asserts this holds for
	// the whole corpus): the only cause that trips it is CRLF — the lexer normalizes
	// \r\n and a lone \r to \n, so the rebuilt string differs by those bytes. Link and
	// footnote reference definitions do not trip it: `[ref]: url`, a bare ref-def, and
	// `[^1]: note` all reconstruct exactly.
	//
	// The failure is silent by construction — returning `content` means every repair
	// below simply doesn't happen, with no error and no log line. That is why the
	// spec asserts the guard rather than only the repairs.
	let rebuilt = "";
	for (const token of tokens) rebuilt += token.raw;
	if (rebuilt !== content) return content;

	let out = "";
	for (const token of tokens) {
		const asRule = multiLineSetextAsRule(token);
		if (isNumberReadAsEmptyList(token)) {
			// A reply that is only `4417.` lexes as `<ol start="4417"><li></li></ol>`: a blank bubble.
			// An ordered list whose every item is empty is a number the model wrote, never a list it
			// meant, so the delimiter is escaped and the number shows as text (CUR-2283).
			out += token.raw.replace(/^(\s*\d{1,9})([.)])/gm, "$1\\$2");
		} else if (token.type === "paragraph" || token.type === "list") {
			out += finalizeUnit(token.raw, token.type === "paragraph");
		} else if (asRule !== null) {
			out += asRule;
		} else {
			out += token.raw;
		}
	}
	return out;
}
