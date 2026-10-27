// Trim an answer that ends in a run of closing brackets nothing opened (CUR-2882).
//
// The failure: a model answers a question about an attached PDF correctly, then echoes the
// `</document>` tag prepareTurnMedia.ts wraps a document in, and ran on into
//
//   _/document_.]() }}}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}]}…
//
// for hundreds of characters. The answer above it was right; the tail made it read as broken.
// Neither existing probe sees it: degeneration.ts counts `{}` groups with nothing inside and this
// tail has no `{` at all, and repetitionGuard.ts counts words.
//
// The signal is mechanism, the same way degeneration.ts's is: a closing bracket with no opener
// anywhere before it closes nothing. Legitimate text balances, including JSON or code left outside a
// fence, so its closers are all matched. Only the TAIL is touched, meaning the stretch after the last
// letter or digit, so a "1) 2) 3)" list or a ":)" mid-answer is never in reach, and a single
// unmatched closer at the end (a smiley, a stray paren) is left alone. Fenced and inline code is
// excised before counting, as degeneration.ts does, so a code block ending in `}}}` is never read.
//
// The echoed wrapper tag is our own framing. Stripping it from the end of an answer matches a shape
// we generate ourselves.

import { FENCE_RE, INLINE_CODE_RE } from "./degeneration";

/** Unmatched closers the tail must hold before it counts. One or two is a smiley or a typo. */
const MIN_UNMATCHED_CLOSERS = 4;

const OPENER_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** What the tail may hold: brackets, whitespace, and the punctuation and emphasis marks seen around them. */
const TAIL_CHAR_RE = /[()[\]{}\s.,;:*_]/;
/**
 * prepareTurnMedia.ts's `<document …>` wrapper echoed at the end: `<document …>`, `</document>`, or
 * `/document` with its angle brackets lost, as in the failure above. A slash or `<` is required, so a
 * sentence that simply ends on the word "document" keeps it.
 */
const ECHOED_WRAPPER_RE = /\s*[*_]*(?:<\/?document(?![a-z])[^>\n]*>?|\/document(?![a-z]))[*_]*\.?\s*$/i;

/**
 * A run of markup after the answer's last sentence stop or closing `**`, on the same line, with no tag in it:
 * `notes?] }]```}```]```…`, `events?```]````, `19:40.">.">.">…`. It
 * must hold a backtick, `]`, `}` or `>`, so a closing quote or paren after a stop (`"why?").`) stays,
 * and it cannot cross a line, so a fence closed on its own line stays. A bare `>` right after the stop,
 * with or without a quote before it, is cut at any length: `…about the library?">`.
 */
const RUNAWAY_AFTER_STOP_RE = /(?<=[.!?*_])(?:(?=[^\n]*[`\]}>])[ \t\]})`"'>.]{3,}|["']?>)$/;
/** Zero-width spaces and joiners at the very end: invisible, but they ride along on a copy. */
const TRAILING_ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]+$/;

interface CloserRunVerdict {
	cleaned: string;
	flagged: boolean;
	/** unmatched closers found in the tail; 0 when nothing was trimmed */
	unmatched: number;
}

/** Blank out fenced and inline code so its brackets are not counted, keeping every offset in place. */
function maskCode(text: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return text.replace(FENCE_RE, blank).replace(INLINE_CODE_RE, blank);
}

/** An inline code span holding nothing but bare tags and punctuation: `` `</document>` ``, `` `</div>` ``. */
const MARKUP_ONLY_SPAN_RE = /^`[\s\p{P}\p{S}]*(?:<\/?[a-z]+(?:_[0-9a-f]+)?>[\s\p{P}\p{S}]*)+`$/u;

/**
 * maskCode for the echo trims, except that a code span holding only bare tags keeps its tags. A model
 * can wrap the echoed closer in backticks (`` .```</document>```.```</div>``` ``,
 * CUR-3218), and masking it as code hid the echo. Only a span inside a longer run of backticks is
 * read this way: `` `</document>` `` written once, to explain the tag, stays code, and so does any
 * tag with attributes.
 */
function maskCodeKeepingBareTags(text: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return text
		.replace(FENCE_RE, blank)
		.replace(INLINE_CODE_RE, (m, at: number) =>
			MARKUP_ONLY_SPAN_RE.test(m) && (text[at - 1] === "`" || text[at + m.length] === "`")
				? ` ${m.slice(1, -1)} `
				: blank(m)
		);
}

export function stripTrailingCloserRun(text: string): CloserRunVerdict {
	if (!text) return { cleaned: text, flagged: false, unmatched: 0 };
	const visible = text.replace(TRAILING_ZERO_WIDTH_RE, "");
	const verdict = stripCloserRun(visible);
	if (verdict.flagged) return verdict;
	const cut = runawayStart(visible);
	if (cut >= 0) return { cleaned: visible.slice(0, cut), flagged: true, unmatched: 0 };
	return visible === text ? verdict : { cleaned: visible.trimEnd(), flagged: true, unmatched: 0 };
}

/**
 * Where a runaway starts, or -1. A stop inside a code span does not count, so `cd ..`. keeps its
 * span; the run itself is read unmasked, because a runaway of backticks pairs up into fake spans.
 */
function runawayStart(text: string): number {
	const masked = maskCode(text);
	for (let from = 0; from < text.length; ) {
		const m = text.slice(from).match(RUNAWAY_AFTER_STOP_RE);
		if (!m || m.index === undefined) return -1;
		const start = from + m.index;
		if (masked[start - 1] === text[start - 1]) return start;
		from = start + 1;
	}
	return -1;
}

function stripCloserRun(text: string): CloserRunVerdict {
	const unchanged = { cleaned: text, flagged: false, unmatched: 0 };
	const masked = maskCode(text);

	let start = masked.length;
	while (start > 0 && TAIL_CHAR_RE.test(masked[start - 1])) start--;
	if (start === masked.length) return unchanged;

	const open: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
	for (let i = 0; i < start; i++) {
		const ch = masked[i];
		if (ch in open) open[ch]++;
		else if (ch in OPENER_OF && open[OPENER_OF[ch]] > 0) open[OPENER_OF[ch]]--;
	}
	let unmatched = 0;
	let cut = -1;
	for (let i = start; i < masked.length; i++) {
		const ch = masked[i];
		if (ch in open) open[ch]++;
		else if (ch in OPENER_OF) {
			if (open[OPENER_OF[ch]] > 0) open[OPENER_OF[ch]]--;
			else if (unmatched++ === 0) cut = i;
		}
	}
	if (unmatched < MIN_UNMATCHED_CLOSERS) return unchanged;

	// Cut at the first closer nothing opened. What comes before it in the tail is the answer's own
	// ending, a full stop, a closing `**` or a `)` that closed a real opener, and stays.
	const cleaned = text.slice(0, cut).replace(ECHOED_WRAPPER_RE, "").trimEnd();
	return { cleaned, flagged: true, unmatched };
}

/**
 * Our opener's two attributes with the tag word itself lost: `** name="expenses-policy.pdf"
 * type="application/pdf">`, or only `="expenses-policy.pdf" type="application/pdf"` (seen on
 * every PDF turn asked to cite its sources, CUR-3212). The value must be a file name
 * with an extension and the type a MIME type, and a bare `=` must not follow a letter, so HTML in an
 * answer (`src="a.js" type="text/javascript"`) is not read as it.
 */
const ATTRIBUTES_ONLY_OPENER_SRC = String.raw`(?:\bname=|(?<![\w-])=)"[^"\n]*\.[a-z0-9]{2,5}"\s+type="[a-z]+\/[\w.+-]+"\s*\/?>?`;
/**
 * The opening tag of prepareTurnMedia.ts's wrapper, as the model echoes it. With both of our
 * attributes, `<document name="…" type="…">`, the angle brackets may be lost. With fewer (models
 * also write `<document>` and `<document name="…">`), both brackets are required, so prose that
 * mentions a document is never read as the tag.
 */
const ECHOED_OPENER_SRC = String.raw`<document(?:_[0-9a-f]+)?(?:\s+[a-z]+="[^"\n]*")*\s*>|<?document\s+name="[^"\n]*"\s+type="[^"\n]*"\s*>?|${ATTRIBUTES_ONLY_OPENER_SRC}`;
const ECHOED_OPENER_RE = new RegExp(ECHOED_OPENER_SRC, "gi");
/** An opener carrying our `type` attribute: the start of a whole wrapper echoed back, body included. */
const TYPED_OPENER_RE = /type="[a-z]+\/[\w.+-]+"\s*>/i;
/** A finished sentence: a stop, or the `**`, `)` or `]` a bold item or a citation ends on. */
const SENTENCE_END_RE = /[.!?*)\]]$/;
/** Our closer at the very end of the answer, with only punctuation after it. */
const CLOSER_AT_END_RE = /<?\/document(?:_[0-9a-f]+)?>?[^\p{L}\p{N}]*$/iu;
/**
 * A run of echoed tags left inside or after the answer: it starts at one of our tags, takes in any
 * further tags and quoted file-name lists (`["notes.txt"]`) with only punctuation between them, and
 * the punctuation after. A quoted list with no tag before it is the answer's own text.
 */
const ECHO_TAG_SRC = String.raw`(?:${ECHOED_OPENER_SRC}|<\/document(?:_[0-9a-f]+)?>)`;
/** Inside a run of our tags, a bare HTML tag the model ran on into (`</div>`) is part of the run. */
const RUN_TAG_SRC = String.raw`(?:${ECHO_TAG_SRC}|<\/?(?:div|span|p)>)`;
const ECHO_RUN_RE = new RegExp(
	String.raw`\s*${ECHO_TAG_SRC}(?:[^\p{L}\p{N}]*?(?:${RUN_TAG_SRC}|\[\s*"[\w.-]+\.[a-z0-9]{2,5}"\s*\]))*[^\p{L}\p{N}]*`,
	"giu"
);
const ECHOED_CLOSER_RE = /<?\/document(?:_[0-9a-f]+)?>?/gi;
/** Distinct words a remainder may hold and still be markup: `./cite]` ten times over is one. */
const MAX_REMAINDER_WORDS = 2;

/**
 * The tail of our opener's `name="…"` echoed after the last sentence, with no tag around it
 * (`…boiler servicing. lakeside-library-hours.txt"].`, PR #2561 preview, CUR-3203). It must look
 * like the attribute: a file name with an extension, our closing quote, then `]` or `>`, after a sentence
 * stop or a closing `**`, `_` or `)` (an answer ending on a bold list item).
 */
const ECHOED_NAME_TAIL_RE = /(?<=[.!?*_)])\s+[\w.-]+\.[a-z0-9]{2,5}"\s*[\]>][^\p{L}\p{N}]*$/iu;

/**
 * Trim our `<document>` wrapper echoed after an answer, and the markup the model ran on into after it
 * (CUR-2882's second shape). A correct PDF answer can end on
 * `22:00document name="expenses-policy.pdf" type="application/pdf">./cite[1]/./cite]./cite]…`.
 * The run interleaves letters, so stripTrailingCloserRun's tail holds one closer and never fires.
 *
 * The cut is at the first echoed opener after some answer text, and only when what follows it holds no
 * prose: at most two distinct words once further echoed tags are removed. An opener followed by a real
 * sentence is left alone, and so is one at the very start, where cutting would leave nothing.
 */
export function stripEchoedWrapperTail(answer: string): { cleaned: string; flagged: boolean } {
	const nameTail = answer.match(ECHOED_NAME_TAIL_RE);
	const text = nameTail ? answer.slice(0, nameTail.index).trimEnd() : answer;
	const unchanged = { cleaned: text, flagged: Boolean(nameTail) };
	if (!text) return unchanged;
	const masked = maskCodeKeepingBareTags(text);
	for (const m of masked.matchAll(ECHOED_OPENER_RE)) {
		const at = m.index ?? 0;
		if (!/[\p{L}\p{N}]/u.test(masked.slice(0, at))) continue;
		const rest = masked
			.slice(at + m[0].length)
			.replace(ECHOED_OPENER_RE, " ")
			.replace(ECHOED_CLOSER_RE, " ");
		const words = new Set((rest.match(/\p{L}+/gu) ?? []).map((w) => w.toLowerCase()));
		// The whole wrapper echoed back, `name="…" type="…">`, the document's text and our closer, ends
		// the answer: everything from the opener on is the attachment (CUR-3212). Only after
		// a finished sentence, so a lead-in ("Here is a summary:") that puts the model's own answer
		// inside the wrapper keeps it, through the tag-only trim below.
		const after = masked.slice(at + m[0].length);
		const kept = text.slice(0, at).trimEnd();
		const wholeWrapper =
			SENTENCE_END_RE.test(kept) &&
			TYPED_OPENER_RE.test(m[0]) &&
			CLOSER_AT_END_RE.test(after) &&
			!new RegExp(ECHOED_OPENER_SRC, "i").test(after);
		// The model's own stop can come after our closer (`…22:00**` then `</document.`); keep it,
		// unless the kept answer already ends on one.
		if (wholeWrapper) {
			const tail = after.match(CLOSER_AT_END_RE)?.[0].replace(ECHOED_CLOSER_RE, "") ?? "";
			const stop = /[.!?]$/.test(kept) ? "" : (tail.match(/[.!?]/)?.[0] ?? "");
			return { cleaned: kept + stop, flagged: true };
		}
		if (words.size > MAX_REMAINDER_WORDS) continue;
		// `after 22:00 [1]<document>.` keeps its full stop: with no words after the tag, the stop is the
		// sentence's own (CUR-3212).
		const stop = words.size === 0 && !/[.!?]$/.test(kept) ? (rest.match(/[.!?]/)?.[0] ?? "") : "";
		return { cleaned: kept + stop, flagged: true };
	}
	// Any echoed tags still there, with prose on both sides of them: drop the tags and keep the prose
	// (`servicing<document name="a.txt">. </document>. Is there anything else…`, or the model starting
	// the answer over after an opener and ending `<document …>.</document>**.**["a.txt"].</document>`).
	let cleaned = "";
	let last = 0;
	for (const m of masked.matchAll(ECHO_RUN_RE)) {
		const at = m.index ?? 0;
		if (!/[\p{L}\p{N}]/u.test(masked.slice(0, at))) continue;
		const before = text.slice(last, at);
		const more = at + m[0].length < text.length;
		const stop = /[.!?]$/.test((cleaned + before).trimEnd()) ? "" : ".";
		cleaned += before + stop + (more ? " " : "");
		last = at + m[0].length;
	}
	if (last === 0) return unchanged;
	return { cleaned: (cleaned + text.slice(last)).trimEnd(), flagged: true };
}

/**
 * A tool call written into the answer as Hermes-format text, `<function=calculate>\n</function>`,
 * with the `------` rules a model can draw around it (CUR-3302). Nothing on this
 * path parses the format, so it reached the reader verbatim. Our own prose never writes the tag.
 */
const HERMES_CALL_RE = /\s*-*[ \t]*<function=[\w.-]+>[^<]{0,2000}<\/function>[ \t]*-*\s*/g;
/** Backticks, closers, stops and spaces: what the runaway in CUR-3302 is made of, and nothing else. */
const MARKUP_RUN_RE = /[`\])}.\s]{40,}/g;
/** Backticks and closers a run must hold, so a long ellipsis or blank lines never count. */
const MIN_RUN_MARKS = 12;
/** A fence opened and closed on lines of its own. An unclosed one is not masked: the runaway opens them. */
const CLOSED_FENCE_RE = /(?:^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?=\n|$)/g;
/** A fence opened on a line of its own that nothing has closed yet, to the end of the text. */
const OPEN_FENCE_RE = /(?:^|\n)[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]*)?$/;

/**
 * The text with code blanked out: closed fences, inline spans, and, while the answer is still streaming,
 * a fence still open. A tag shown as code, as in an answer explaining the Hermes format, is the answer's
 * content and stays (CUR-3302). A fence still open when the answer ends is the runaway's, so the final
 * trim leaves it unmasked. Runs are not checked against this, since the runaway pairs its own backticks.
 */
function blankCode(text: string, streaming: boolean): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	const closed = text.replace(CLOSED_FENCE_RE, blank);
	return (streaming ? closed.replace(OPEN_FENCE_RE, blank) : closed).replace(INLINE_CODE_RE, blank);
}

/**
 * Cut an answer at the first long run of backticks and closing brackets, mid-answer as well as at the
 * end, and drop any Hermes tool-call tag written into it (CUR-3302). A model can write the run, then prose
 * apologising for "formatting artifacts", then more runs and restarts, to the length limit. Everything
 * after the first run is that cascade, so the cut keeps only the answer before it, and only when that
 * answer holds a letter. stripTrailingCloserRun cannot see it: prose follows the run, and backticks
 * are not brackets. Code in a closed fence is masked, so a code block's closers never start a run.
 */
export function stripMarkupRunaway(text: string): { cleaned: string; flagged: boolean } {
	if (!text) return { cleaned: text, flagged: false };
	const code = blankCode(text, false);
	// HERMES_CALL_RE opens on `\s*`, which is retried from every position of a long blank run, so it
	// only runs on text that holds a tag at all (CUR-4006).
	let cleaned = !text.includes("<function=")
		? text
		: text.replace(HERMES_CALL_RE, (m, at: number) => {
				if (!code.slice(at, at + m.length).includes("<function=")) return m;
				return at === 0 || at + m.length === text.length ? "" : "\n\n";
			});
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	const masked = cleaned.replace(CLOSED_FENCE_RE, blank);
	for (const m of masked.matchAll(MARKUP_RUN_RE)) {
		const at = m.index ?? 0;
		const run = cleaned.slice(at, at + m[0].length);
		if (run !== m[0]) continue;
		if ((run.match(/[`\])}]/g) ?? []).length < MIN_RUN_MARKS) continue;
		const kept = cleaned.slice(0, at).trimEnd();
		if (!/[\p{L}\p{N}]/u.test(kept)) continue;
		// The answer's own full stop often opens the run (`**[4]**.```}```}`); it stays.
		cleaned = kept + (run.match(/^[ \t]*([.!?])/)?.[1] ?? "");
		break;
	}
	return { cleaned, flagged: cleaned !== text };
}

/**
 * Where a Hermes tag opens, before its closing tag has arrived, with the blank lines, `------` rule and
 * spaces in front of it. Found by indexOf and a walk back, not by `/\s*-*[ \t]*<function=/`: blankCode
 * turns a code block into one long blank run, and that regex retried `\s*` from every position of it,
 * so a 6 KB fence costs seconds of synchronous CPU per streamed chunk and freezes the whole instance
 * (CUR-4006).
 */
function hermesOpenAt(text: string): number | null {
	const tag = text.indexOf("<function=");
	if (tag < 0) return null;
	let at = tag;
	while (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
	while (at > 0 && text[at - 1] === "-") at--;
	while (at > 0 && /\s/.test(text[at - 1])) at--;
	return at;
}

/**
 * Where, in text still streaming, the runaway stripMarkupRunaway cuts begins: a Hermes tag's opening,
 * or the first qualifying run after some answer (CUR-3302). Null when neither is there yet. The
 * stream stops releasing at this point so the visitor never watches the cascade type out; the
 * end-of-stream trim then decides what of it survives.
 */
export function markupRunawayStart(text: string): number | null {
	let start = hermesOpenAt(blankCode(text, true));
	const masked = text.replace(CLOSED_FENCE_RE, (m) => m.replace(/[^\n]/g, " "));
	for (const m of masked.matchAll(MARKUP_RUN_RE)) {
		const at = m.index ?? 0;
		if (start !== null && at >= start) break;
		const run = text.slice(at, at + m[0].length);
		if (run !== m[0]) continue;
		if ((run.match(/[`\])}]/g) ?? []).length < MIN_RUN_MARKS) continue;
		if (!/[\p{L}\p{N}]/u.test(text.slice(0, at))) continue;
		start = at;
		break;
	}
	return start;
}
