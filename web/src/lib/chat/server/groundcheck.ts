// Groundcheck (CUR-2467, detector CUR-2554). The grounding prompt already forbids stating a project's
// country unless a source says so (ragGrounding.ts), and models break it anyway on fabrication-eval turns.
// A prompt rule cannot hold a fact the model believes it knows, so this checks the finished answer
// instead.
//
// Two steps, cheap one first. A span-level detector (lettucedect-v2-mmbert-base, the groundcheck/
// service on Fly) reads the sources and the answer and marks spans the sources do not support: 37 of
// 46 unsourced country mentions on the eval dump, ~320 ms round trip. Only a turn with a flagged span
// pays for the second step: one forced tool call on TASK_MODEL that proposes, per flagged sentence, the
// same sentence with the unsupported words deleted, or unchanged when the sources do support it.
//
// The model only PROPOSES. Code accepts a revision only when its words are an in-order subset of the
// original sentence's words (`isWordDeletion`), so nothing reaches the user that the output screen did
// not already pass, and no second screen is needed. Deleting words can still change meaning (dropping a
// "not"); the revise prompt asks for whole claims, and the log line counts accepted edits so a bad one
// is findable. A deletion that removes what the sources do state is refused too (`deletesSourcedWords`):
// on 20 known-good answers that refusal took wrong deletions from 4 to 0, at the cost of recall on the
// fabrication dump (47 unsourced countries cut to 11 rather than 9). Any failure, timeout or truncated
// context leaves the answer exactly as generated.
//
// Behind `groundcheck`, preview only. Production needs the privacy notice to name the processors
// (CUR-2063).

import type OpenAI from "openai";
import { Lexer, type Tokens } from "marked";
import type { DeclineLanguage } from "$lib/chat/server/declineCopy";
import type { GroundcheckOutcome } from "$lib/chat/types/Message";
import { config } from "$lib/chat/server/config";
import { forcedTaskModelToolCall } from "$lib/chat/server/taskModelClient";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger as defaultLogger } from "$lib/chat/server/logger";

export const GROUNDCHECK_FLAG = "groundcheck";

const DETECT_TIMEOUT_MS = 2_500;
const REVISE_TIMEOUT_MS = 6_000;
// More flagged sentences than this reads as the detector disagreeing with the whole answer (wrong
// sources passed, or a language it reads badly), not as a few stray claims. Leave such an answer alone.
export const MAX_FLAGGED_UNITS = 8;
// The revise call needs the sources to judge, but not all of them verbatim: the detector already read
// the full evidence, and the reviser only decides which words of a marked sentence to drop.
const REVISE_CONTEXT_CHARS = 12_000;

/** The detector's address, or "" — config, not a toggle. */
function groundcheckUrl(): string {
	return ((Reflect.get(config, "GROUNDCHECK_URL") as string | undefined) ?? "").trim().replace(/\/+$/, "");
}

function groundcheckToken(): string {
	return ((Reflect.get(config, "GROUNDCHECK_TOKEN") as string | undefined) ?? "").trim();
}

/** Should this turn be groundchecked? The flag decides; a flag that is on with no detector configured
 *  is a loud config error, never a silent off. */
export function groundcheckEnabled(log: { warn: (m: string) => void } = defaultLogger): boolean {
	if (!flagEnabledOr(GROUNDCHECK_FLAG, () => false)) return false;
	if (!groundcheckUrl() || !groundcheckToken()) {
		log.warn(
			"[groundcheck] flag is on but GROUNDCHECK_URL or GROUNDCHECK_TOKEN is unset — groundcheck withheld (config error, not a feature toggle)"
		);
		return false;
	}
	return true;
}

export type DetectSpan = { start: number; end: number; text: string; confidence: number };
type DetectResult = { spans: DetectSpan[]; truncated: boolean; modelMs?: number };
export type DetectCall = (
	input: { context: string[]; question: string; answer: string },
	signal: AbortSignal
) => Promise<DetectResult>;

/** One flagged sentence sent to the reviser, with the unsupported spans marked ⟦like this⟧. */
type ReviseItem = { id: number; marked: string };
export type ReviseCall = (
	input: { context: string; items: ReviseItem[] },
	signal: AbortSignal
) => Promise<Map<number, string> | null>;


/** `removed` counts the claims deleted, one per run of consecutive deleted words; set on `revised` and
 *  `emptied`. `items` counts the list items dropped whole, set when any was. */
export type GroundcheckResult = { text: string; outcome: GroundcheckOutcome; removed?: number; items?: number };

type MinimalLogger = { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };

/** A sentence-sized piece of the answer, by offset. List items and headings are one unit per line. */
type Unit = { start: number; end: number };

/** Lines, then sentences within a line, as offsets into `text`. Whitespace between sentences belongs to
 *  no unit, so deleting a unit never eats its neighbour's first character. */
export function segmentUnits(text: string): Unit[] {
	const units: Unit[] = [];
	let lineStart = 0;
	for (const line of text.split("\n")) {
		const boundaries = [0];
		for (const m of line.matchAll(/(?<=[.!?])\s+/g)) boundaries.push(m.index, m.index + m[0].length);
		boundaries.push(line.length);
		for (let i = 0; i < boundaries.length; i += 2) {
			const a = boundaries[i];
			const b = boundaries[i + 1];
			const lead = line.slice(a, b).length - line.slice(a, b).trimStart().length;
			const s = a + lead;
			const e = a + line.slice(a, b).trimEnd().length;
			if (e > s) units.push({ start: lineStart + s, end: lineStart + e });
		}
		lineStart += line.length + 1;
	}
	return units;
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// A whitespace token with its outer brackets, quotes, emphasis and trailing sentence punctuation
// removed. An apostrophe is not stripped from the end, so a word cut at its possessive stays visible.
const core = (token: string) => token.replace(/^[("“‘*_[]+/u, "").replace(/[)"”*_\].,;:!?]+$/u, "");

/** The words of `original` that `revised` drops, grouped into contiguous runs, or null when `revised` is
 *  not an in-order subset. */
function deletedRuns(original: string, revised: string): string[][] | null {
	const o = words(original);
	const r = words(revised);
	if (r.length >= o.length) return null;
	const runs: string[][] = [];
	let run: string[] = [];
	let i = 0;
	const close = () => {
		if (run.length) runs.push(run);
		run = [];
	};
	for (const w of r) {
		while (i < o.length && o[i] !== w) run.push(o[i++]);
		if (i === o.length) return null;
		close();
		i++;
	}
	run.push(...o.slice(i));
	close();
	return runs;
}

/** True when `revised` keeps an in-order subset of `original`'s words and drops at least one.
 *  Separators may change; words may not appear, and every remaining token must have stood whole in
 *  the original ("Institute's" cut to "AI'" fails here, since only the letters were compared). */
export function isWordDeletion(original: string, revised: string): boolean {
	if (!deletedRuns(original, revised)) return false;
	const kept = new Set(original.split(/\s+/).map(core));
	return revised
		.split(/\s+/)
		.map(core)
		.every((t) => !t || kept.has(t) || !/[\p{L}\p{N}]/u.test(t));
}

// A number of two or more digits. A model size ("7b") or the "1" of "1.5" is not a quantity the sources
// assert, and a single digit matches every [n] citation marker in the evidence.
const quantity = (w: string) => /^\p{N}{2,}$/u.test(w);
// A word long enough to carry a claim, or a quantity.
const contentWord = (w: string) => quantity(w) || /\p{L}{4,}/u.test(w);

/** The words of the evidence, with our own [n] citation markers left out. */
const sourceWordsOf = (context: string[]) => new Set(words(context.join("\n").replace(/\[\d+\]/g, " ")));

/**
 * True when a deletion removes what the sources do state: any number they contain, or a run of deleted
 * words at least half of whose content words they contain. The reviser deletes supported words
 * alongside unsupported ones, and on 20 known-good answers every wrong deletion was of this kind ("15
 * trillion tokens" cut to "tokens" with the source saying 15 trillion), while every correct one removed
 * words absent from the sources. Each run is judged alone, because one edit can bundle a correct clause
 * with two sourced ones and a whole-sentence count lets the first outvote the others.
 */
export function deletesSourcedWords(original: string, revised: string, sourceWords: Set<string>): boolean {
	return (deletedRuns(original, revised) ?? []).some((run) => {
		const content = run.filter(contentWord);
		if (content.some((w) => quantity(w) && sourceWords.has(w))) return true;
		const sourced = content.filter((w) => sourceWords.has(w)).length;
		return content.length > 0 && sourced * 2 >= content.length;
	});
}

// Punctuation the model wrote between two words, which a sentence can end on cleanly.
const clauseBreak = /[,;:—–()]/u;

/**
 * True when a deletion cuts the end off a sentence in the middle of a clause, leaving a fragment
 * (CUR-2594): "A potluck is a gathering where each participant contributes a dish to share." cut to
 * "A potluck is a gathering where." A cut is allowed where the original already broke the sentence
 * with a comma, dash, colon, semicolon or bracket ("- EuroLLM — France" to "- EuroLLM —"), and when
 * it removes the whole sentence. Deletions inside the sentence are not judged here. Our own [n]
 * markers are ignored, since the model writes one after the clause it cites.
 *
 * @remarks Precision over recall, as with `deletesSourcedWords`: "Built in France." can no longer
 * become "Built.", and that unsourced country stays.
 */
export function cutsMidClause(original: string, revised: string): boolean {
	const plain = original.replace(/\s*\[\d+\]/g, "");
	const kept = words(revised.replace(/\s*\[\d+\]/g, ""));
	const all = [...plain.matchAll(/[\p{L}\p{N}]+/gu)];
	if (kept.length === 0 || kept.length >= all.length) return false;
	// The original index of the last kept word, matching in order the way `deletedRuns` does.
	let i = -1;
	for (const w of kept) {
		i++;
		while (i < all.length && all[i][0].toLowerCase() !== w) i++;
		if (i === all.length) return false;
	}
	if (i === all.length - 1) return false;
	const gap = plain.slice(all[i].index + all[i][0].length, all[i + 1].index);
	return !clauseBreak.test(gap);
}

/**
 * True when a deletion inside a sentence removes only numbers and leaves the words around them joined
 * (CUR-2874): "the capital of Japan in 1868 during the Meiji Restoration" cut to "in during". A number
 * is nearly always what the word before it needs, so the remainder reads broken. A cut bounded by a
 * comma, dash, colon, semicolon or bracket on either side is allowed, as in `cutsMidClause`. A cut that
 * also removes a word is not judged here: "A French lab" cut to "A lab" still reads.
 *
 * @remarks Precision over recall again: "has 300 staff" can no longer become "has staff", and that
 * unsourced figure stays.
 */
export function cutsLoneNumber(original: string, revised: string): boolean {
	const plain = original.replace(/\s*\[\d+\]/g, "");
	const kept = words(revised.replace(/\s*\[\d+\]/g, ""));
	const all = [...plain.matchAll(/[\p{L}\p{N}]+/gu)];
	if (kept.length === 0) return false;
	// Which original words survive, matched in order the way `deletedRuns` does.
	const keeps = all.map(() => false);
	let i = 0;
	for (const w of kept) {
		while (i < all.length && all[i][0].toLowerCase() !== w) i++;
		if (i === all.length) return false;
		keeps[i++] = true;
	}
	for (let s = 0; s < all.length; ) {
		if (keeps[s]) {
			s++;
			continue;
		}
		let e = s;
		while (e < all.length && !keeps[e]) e++;
		const interior = s > 0 && e < all.length;
		if (interior && all.slice(s, e).every((m) => /^\p{N}+$/u.test(m[0]))) {
			const before = plain.slice(all[s - 1].index + all[s - 1][0].length, all[s].index);
			const after = plain.slice(all[e - 1].index + all[e - 1][0].length, all[e].index);
			if (!clauseBreak.test(before) && !clauseBreak.test(after)) return true;
		}
		s = e;
	}
	return false;
}

const markers = (s: string): string[] => s.match(/\[\d+\]/g) ?? [];

/**
 * True when a revision keeps words but drops a `[n]` citation marker the original carried (CUR-2682).
 * `words()` reads a marker as one more word, so `isWordDeletion` lets the reviser delete it with the
 * claim next to it, and the sentence that stays reads as unsourced. The reviser can do that to
 * "AI Potluck, based in Switzerland, assembles … Alpha [1]."
 */
export function dropsCitation(original: string, revised: string): boolean {
	if (words(revised.replace(/\[\d+\]/g, " ")).length === 0) return false;
	const kept = markers(revised);
	return markers(original).some((m) => !kept.includes(m));
}

/**
 * `revised` with the original's closing `[n]` markers put back, when every marker it dropped sat at
 * the end of the sentence; null when a dropped marker sat mid-sentence. A closing marker cites the
 * whole sentence, including the part the deletion leaves. The reviser drops it whenever it
 * deletes a clause from a cited sentence ("AI Potluck, based in Belgium, is … assistants [1]." on 20
 * of 20 live runs, CUR-2692), and refusing the revision for that kept the unsourced country.
 */
export function restoreClosingMarkers(original: string, revised: string): string | null {
	const closing = original.match(/((?:\s*\[\d+\])+)\s*[.!?]*\s*$/u)?.[1] ?? "";
	const kept = markers(revised);
	const dropped = markers(original).filter((m) => !kept.includes(m));
	if (dropped.some((m) => !markers(closing).includes(m))) return null;
	return revised.replace(/\s*([.!?]*)\s*$/u, `${closing}$1`);
}

/**
 * True when a deletion removes a content word more than two tokens from any word a detector span
 * touches. The detector marks what
 * the sources do not support; a word it left unmarked is one it read as supported or as a claim it
 * does not judge. With sources about AI Potluck, the detector marked only "where each participant
 * contributes a dish to share" of "A potluck is a gathering where …", the reviser empties the whole
 * sentence, and a fragment guard then has nothing to refuse (CUR-2692).
 * Refusing it leaves the sentence whole, since cutting just the marked clause is a mid-clause cut.
 *
 * @remarks Prose only, for the reason `emptiesUnrelatedSentence` gives: on a list line the reviser
 * may take the whole item.
 */
export function deletesUnmarkedWords(answer: string, unit: Unit, revised: string, spans: DetectSpan[]): boolean {
	const tokens = [...answer.slice(unit.start, unit.end).matchAll(/[\p{L}\p{N}]+/gu)];
	const keptAt = new Set<number>();
	let i = 0;
	for (const w of words(revised)) {
		while (i < tokens.length && tokens[i][0].toLowerCase() !== w) i++;
		if (i === tokens.length) return false;
		keptAt.add(i++);
	}
	const marked = tokens.map((t) => {
		const a = unit.start + t.index;
		const b = a + t[0].length;
		return spans.some((s) => s.start < b && s.end > a);
	});
	// The words that connect a claim sit beside it ("from France", "based in Belgium"), and the
	// detector often marks only the claim itself, so a word within two tokens of a marked one goes too.
	const nearMarked = (j: number) => marked.slice(Math.max(0, j - 2), j + 3).some(Boolean);
	return tokens.some((t, j) => !keptAt.has(j) && contentWord(t[0].toLowerCase()) && !nearMarked(j));
}

/**
 * A list item with its last separated part cut, when that part is a claim the sources do not give:
 * the detector marked it, none of its words appear in the sources, and it carries no `[n]` marker.
 * "- Hugging Face — France" becomes "- Hugging Face". null when there is no such part.
 *
 * Groundcheck tries this only after the reviser's own revision of a list item was refused. The reviser
 * does not produce it by itself: it can write "Hug Face" when the detector marks "ging", or empty
 * "- OpenMined — Norway" though OpenMined is a source's name, leaving both countries (CUR-2692).
 * The cut still passes every guard the reviser's revisions do.
 */
export function unsourcedTail(answer: string, unit: Unit, spans: DetectSpan[], sourceWords: Set<string>): string | null {
	const text = answer.slice(unit.start, unit.end);
	const sep = [...text.matchAll(/\s*[—–,:;]\s*/gu)].at(-1);
	if (!sep) return null;
	const head = text.slice(0, sep.index);
	const tailAt = sep.index + sep[0].length;
	const tail = text.slice(tailAt);
	if (markers(tail).length || words(head).length === 0) return null;
	const tailWords = words(tail);
	if (!tailWords.some(contentWord) || tailWords.some((w) => sourceWords.has(w))) return null;
	const a = unit.start + tailAt;
	return spans.some((s) => s.start < unit.end && s.end > a) ? head : null;
}

// A markdown list item: a bullet or a number, then a space.
const listLine = /^\s*(?:[-*+]|\d+[.)])\s/u;

// A line that names a person, place, organisation or product: a capitalised word after its first.
// The first word is skipped because it is capitalised for being first. Emphasis and brackets around
// a word are ignored, so "**Falcon** — France" still counts France.
const namesSomething = (line: string) =>
	line
		.replace(listLine, "")
		.trim()
		.split(/\s+/)
		.slice(1)
		.some((t) => /^\p{Lu}/u.test(core(t)));

/**
 * True when a revision deletes a whole prose sentence that names nothing the sources mention: no
 * content word of it appears in them (CUR-2680). Such a sentence is general knowledge set beside the
 * sourced answer ("Paris is the capital of France."), not a detail about anything the sources cover.
 * The reviser deletes such a sentence even when a prompt tells it not to.
 *
 * A list line that names something is left to the reviser: an item the sources never name
 * ("- Falcon — France") is the fabrication this check exists for. A list line that names nothing,
 * with no capitalised word after its first, is kept like a prose sentence: a recipe's ingredient and
 * step lines are general knowledge the sources rarely list, and the reviser can delete every
 * ingredient line of a dough recipe whose source was a blog post's introduction.
 *
 * @remarks Precision over recall: an invented prose sentence that names nothing from the sources
 * ("It was founded in 2019.") is kept too.
 */
export function emptiesUnrelatedSentence(
	original: string,
	revised: string,
	sourceWords: Set<string>,
	line: string
): boolean {
	if (listLine.test(line) && namesSomething(line)) return false;
	if (words(revised.replace(/\[\d+\]/g, " ")).length > 0) return false;
	return !words(original.replace(/\[\d+\]/g, " "))
		.filter(contentWord)
		.some((w) => sourceWords.has(w));
}

// A span of one or two characters ("a", a stray "1") is detector noise and carries no claim.
const meaningful = (s: DetectSpan) => (s.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3;

function markUnit(text: string, u: Unit, spans: DetectSpan[]): string {
	let out = "";
	let at = u.start;
	for (const s of spans) {
		const a = Math.max(s.start, u.start);
		const b = Math.min(s.end, u.end);
		if (b <= a || a < at) continue;
		out += text.slice(at, a) + "⟦" + text.slice(a, b) + "⟧";
		at = b;
	}
	return out + text.slice(at, u.end);
}

// A deletion can leave the separator that introduced the claim: "- EuroLLM — France" becomes
// "- EuroLLM —". Separators are punctuation the model already wrote, so trimming one adds nothing.
// A trailing colon stays, since it usually introduces the list below it.
const tidyLine = (line: string) =>
	line
		.replace(/ {2,}/g, " ")
		.replace(/\s*[—–;,(-]+\s*$/u, "")
		.trimEnd();

// A line left holding only a list marker or heading hashes after its one sentence was deleted.
const emptyLine = (line: string) => !/[\p{L}\p{N}]/u.test(line.replace(/^\s*(?:[-*+]|#{1,6}|\d+[.)])\s*/u, ""));

/** A list of the answer by line index: each item's marker line and last line, and the paragraph that
 *  introduces the list when one comes straight before it. */
type ListBlock = {
	ordered: boolean;
	start: number;
	items: { first: number; last: number }[];
	intro: { first: number; last: number } | null;
};

/**
 * The answer's top-level lists, with item boundaries from marked's lexer, the one the chat renders
 * with: an item is its marker line plus every continuation line under it, nested lists included.
 * A token whose text cannot be found back in the answer is skipped, so an answer marked reads
 * differently from how we index it keeps the line-by-line handling.
 *
 * @internal exported for its unit tests
 */
export function listBlocks(answer: string): ListBlock[] {
	const lineOf = (offset: number) => answer.slice(0, offset).split("\n").length - 1;
	const span = (at: number, raw: string) => ({ first: lineOf(at), last: lineOf(at + raw.trimEnd().length) });
	const blocks: ListBlock[] = [];
	let at = 0;
	let para: { first: number; last: number } | null = null;
	for (const tok of new Lexer().lex(answer)) {
		const start = answer.indexOf(tok.raw, at);
		if (start < 0) continue;
		at = start + tok.raw.length;
		if (tok.type === "space") continue;
		if (tok.type === "list") {
			const list = tok as Tokens.List;
			const items: { first: number; last: number }[] = [];
			let itemAt = start;
			for (const item of list.items) {
				const s = answer.indexOf(item.raw, itemAt);
				if (s < 0) break;
				itemAt = s + item.raw.length;
				items.push(span(s, item.raw));
			}
			if (items.length === list.items.length) {
				blocks.push({ ordered: list.ordered, start: typeof list.start === "number" ? list.start : 1, items, intro: para });
			}
		}
		para = tok.type === "paragraph" ? span(start, tok.raw) : null;
	}
	return blocks;
}

// The list marker at the start of an item's first line, with no text needed after it.
const itemMarker = /^\s*(?:[-*+]|\d+[.)])(?=\s|$)/u;

// A whole number standing alone: not part of a longer number, a decimal, a year, a [n] citation, or
// an ordinal or grade with letters attached ("5e", "3rd", "2º").
const loneNumeral = /(?<![\p{N}.,[])\p{N}+(?![\p{N}\p{L}\]]|[.,]\p{N})/gu;

/**
 * A list item goes whole or stays whole (CUR-4489). When a revision empties an item's title (the first
 * unit on its marker line with text after the marker) or its whole marker line, every line of the item
 * joins `drop`. Deleting only the title would leave "5. Um mistério envolvente…", and descriptions
 * with no title under them. An ordered list that lost items is renumbered from its start, and a numeral
 * in the intro that counted the original items is set to the count left ("Aqui tens 5 sugestões" over
 * three). A list that lost every item takes a one-line intro ending in a colon with it, since it
 * introduces nothing. Edits `lines` and `drop` in place and returns the number of items dropped.
 *
 * @remarks The numbers are the only words groundcheck writes rather than deletes. Both restate the
 * list's own shape, so nothing the answer did not already say reaches the reader.
 */
function reshapeLists(answer: string, emptied: Set<number>, lines: string[], drop: Set<number>): number {
	const lineOf = (offset: number) => answer.slice(0, offset).split("\n").length - 1;
	const titles = new Map<number, number>();
	for (const u of segmentUnits(answer)) {
		const line = lineOf(u.start);
		if (!titles.has(line) && /[\p{L}\p{N}]/u.test(answer.slice(u.start, u.end).replace(itemMarker, ""))) {
			titles.set(line, u.start);
		}
	}
	let dropped = 0;
	for (const block of listBlocks(answer)) {
		const goes = (first: number) => drop.has(first) || emptied.has(titles.get(first) ?? -1);
		const kept = block.items.filter((it) => !goes(it.first));
		if (kept.length === block.items.length) continue;
		dropped += block.items.length - kept.length;
		for (const it of block.items) {
			if (goes(it.first)) for (let i = it.first; i <= it.last; i++) drop.add(i);
		}
		if (block.ordered) {
			kept.forEach((it, k) => {
				lines[it.first] = lines[it.first].replace(/^(\s*)\p{N}+(?=[.)])/u, (_, lead: string) => `${lead}${block.start + k}`);
			});
		}
		const intro = block.intro;
		if (!intro) continue;
		if (kept.length === 0) {
			if (intro.first === intro.last && /[:：]\s*$/u.test(lines[intro.first])) drop.add(intro.first);
			continue;
		}
		// "1 sugestões" would need the noun made singular, a word we would be writing; the items-removed
		// line under the answer says what happened instead.
		if (kept.length === 1) continue;
		const count = String(block.items.length);
		const at: number[] = [];
		for (let i = intro.first; i <= intro.last; i++) {
			for (const m of lines[i].matchAll(loneNumeral)) if (m[0] === count) at.push(i);
		}
		// Two numerals that both read as the count leave which one counts the items to a guess.
		if (at.length === 1) {
			lines[at[0]] = lines[at[0]].replace(loneNumeral, (m) => (m === count ? String(kept.length) : m));
		}
	}
	return dropped;
}

/**
 * The evidence a grounded answer is checked against: what was retrieved, plus the text of every
 * attached file the model received. Without the files, an answer read from an attachment on a turn
 * that also searched the web has nothing to stand on, and every sentence of it is deleted.
 *
 * @remarks Empty when nothing was retrieved, so an attachment alone never turns the check on.
 */
export function groundcheckEvidence(input: {
	retrieved: (string | undefined)[];
	attached?: { messages: Map<string, { finalText: string }> };
}): string[] {
	const retrieved = input.retrieved.filter((e): e is string => !!e);
	if (retrieved.length === 0) return [];
	const attached = [...(input.attached?.messages.values() ?? [])].map((m) => m.finalText).filter(Boolean);
	return [...retrieved, ...attached];
}

/**
 * Checks a grounded answer against the evidence it was generated from, and deletes the claims the
 * sources do not support. Never throws; on any failure returns the answer unchanged. Logs one line
 * with the outcome and timings, never the text.
 */
export async function groundcheckAnswer(
	input: { answer: string; context: string[]; question: string },
	deps: { detect?: DetectCall; revise?: ReviseCall; logger?: MinimalLogger; now?: () => number } = {}
): Promise<GroundcheckResult> {
	const log = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => performance.now());
	const { answer } = input;
	const t0 = now();
	const ms: Record<string, number> = {};
	const stats = { spans: 0, units: 0, accepted: 0, rejected: 0, sourced: 0, fragment: 0, unrelated: 0, citation: 0, restored: 0, unmarked: 0, tail: 0 };
	let removed = 0;
	let droppedItems = 0;
	const done = (outcome: GroundcheckOutcome, text = answer): GroundcheckResult => {
		ms.total = Math.round(now() - t0);
		log.info({ outcome, ...stats, removed, items: droppedItems, ms, chars: answer.length }, "[groundcheck] answer");
		if (outcome !== "revised" && outcome !== "emptied") return { text, outcome };
		return droppedItems > 0 ? { text, outcome, removed, items: droppedItems } : { text, outcome, removed };
	};

	let detected: DetectResult;
	try {
		detected = await (deps.detect ?? detectRemote)(
			{ context: input.context, question: input.question, answer },
			AbortSignal.timeout(DETECT_TIMEOUT_MS)
		);
	} catch (err) {
		ms.detect = Math.round(now() - t0);
		// The status or timeout is the one thing that says whether the detector is down, refusing us
		// (a 401 or 429 on its token), or just slow; the outcome line alone cannot tell them apart.
		// The error never holds answer text: detectRemote's messages carry only the status.
		const e = err instanceof Error ? err : new Error(String(err));
		log.warn({ error: e.message, name: e.name, ms: ms.detect }, "[groundcheck] detector call failed");
		return done("detect-failed");
	}
	ms.detect = Math.round(now() - t0);
	if (detected.modelMs !== undefined) ms.detectModel = detected.modelMs;
	const spans = detected.spans.filter(meaningful).sort((a, b) => a.start - b.start);
	stats.spans = spans.length;
	if (spans.length === 0) return done("clean");
	// A span may be flagged only because its support was cut to fit the detector's window. Observe only.
	if (detected.truncated) return done("truncated");

	const flagged = segmentUnits(answer).filter((u) => spans.some((s) => s.start < u.end && s.end > u.start));
	stats.units = flagged.length;
	if (flagged.length > MAX_FLAGGED_UNITS) return done("too-many");

	const items = flagged.map((u, id) => ({ id, marked: markUnit(answer, u, spans) }));
	const t1 = now();
	let revisions: Map<number, string> | null;
	try {
		revisions = await (deps.revise ?? reviseOnTaskModel)(
			{ context: input.context.join("\n\n").slice(0, REVISE_CONTEXT_CHARS), items },
			AbortSignal.timeout(REVISE_TIMEOUT_MS)
		);
	} catch {
		revisions = null;
	}
	ms.revise = Math.round(now() - t1);
	if (!revisions) return done("revise-failed");

	// Apply from the end so earlier offsets stay valid.
	let text = answer;
	const touchedLines = new Set<number>();
	// The start offsets of the units an accepted revision emptied.
	const emptied = new Set<number>();
	const sourceWords = sourceWordsOf(input.context);
	for (const [id, u] of [...flagged.entries()].reverse()) {
		const original = answer.slice(u.start, u.end);
		const proposed = revisions.get(id);
		if (proposed === undefined || words(proposed).join(" ") === words(original).join(" ")) continue;
		const lineStart = answer.lastIndexOf("\n", u.start - 1) + 1;
		const lineEnd = answer.indexOf("\n", u.start);
		const line = answer.slice(lineStart, lineEnd === -1 ? answer.length : lineEnd);
		// The revision as it would ship, or the stat that names the guard refusing it.
		const judge = (revised: string): { text: string } | { refused: keyof typeof stats } => {
			if (!isWordDeletion(original, revised)) return { refused: "rejected" };
			if (dropsCitation(original, revised)) {
				const restored = restoreClosingMarkers(original, revised);
				if (restored === null) return { refused: "citation" };
				revised = restored;
			}
			if (deletesSourcedWords(original, revised, sourceWords)) return { refused: "sourced" };
			if (cutsMidClause(original, revised) || cutsLoneNumber(original, revised)) return { refused: "fragment" };
			if (emptiesUnrelatedSentence(original, revised, sourceWords, line)) return { refused: "unrelated" };
			if (!listLine.test(line) && deletesUnmarkedWords(answer, u, revised, spans)) return { refused: "unmarked" };
			return { text: revised };
		};
		let verdict = judge(proposed);
		if ("refused" in verdict && listLine.test(line)) {
			const tail = unsourcedTail(answer, u, spans, sourceWords);
			const fallback = tail === null ? null : judge(tail);
			if (fallback && "text" in fallback) {
				verdict = fallback;
				stats.tail++;
			}
		}
		if ("refused" in verdict) {
			stats[verdict.refused]++;
			continue;
		}
		const revised = verdict.text;
		if (markers(revised).length > markers(proposed).length) stats.restored++;
		stats.accepted++;
		// An accepted revision is a word deletion, so it has at least one deleted run.
		removed += Math.max(1, deletedRuns(original, revised)?.length ?? 1);
		const replacement = revised.replace(/\s+/g, " ").trim();
		// A deleted sentence takes the spaces after it, so the next one does not start with a gap.
		let end = u.end;
		if (!replacement) {
			while (text[end] === " " || text[end] === "\t") end++;
			emptied.add(u.start);
		}
		text = text.slice(0, u.start) + replacement + text.slice(end);
		touchedLines.add(answer.slice(0, u.start).split("\n").length - 1);
	}
	if (stats.accepted === 0) return done("kept");

	// Units never span a newline, so line i here is line i of the answer.
	const lines = text.split("\n").map((line, i) => (touchedLines.has(i) ? tidyLine(line) : line));
	const drop = new Set(lines.flatMap((line, i) => (touchedLines.has(i) && emptyLine(line) ? [i] : [])));
	droppedItems = reshapeLists(answer, emptied, lines, drop);
	// Lines dropped from between two blank lines leave one blank line, not two.
	const kept: string[] = [];
	let gap = false;
	lines.forEach((line, i) => {
		if (drop.has(i)) {
			gap = true;
			return;
		}
		const blank = !line.trim();
		if (blank && gap && (kept.length === 0 || !kept[kept.length - 1].trim())) return;
		if (!blank) gap = false;
		kept.push(line);
	});
	text = kept.join("\n");
	// Nothing the sources support survived. The caller replaces the answer rather than ship it empty.
	if (words(text).length === 0) return done("emptied", "");
	return done("revised", text);
}

/**
 * What replaces an answer groundcheck emptied: what happened, and the sources that were retrieved.
 * Each title once, in plain text, with no `[n]` markers (CUR-2614): the chat renders a marker for a
 * source with no url as `[<title>]` (marked.ts), so "[1] About AI Potluck" read the name twice, and
 * two chunks of one document listed it twice more. The links stay in the sources list under the answer.
 */
export function groundcheckEmptiedText(sources: { n: number; title: string }[]): string {
	const head = "The sources I retrieved don't support what I wrote, so I've left it out.";
	const titles = [...new Set(sources.map((s) => s.title.trim()).filter(Boolean))].slice(0, 6);
	if (titles.length === 0) return head;
	return `${head} They were: ${titles.join(", ")}.`;
}

// The line under an answer that lost list items (CUR-4489), by the decline languages (declineCopy.ts),
// so it reads in the language the answer is in. Tamil falls back to English until a native speaker
// writes it, as the crisis copy does.
const ITEMS_REMOVED: { en: (n: number) => string } & Partial<Record<DeclineLanguage, (n: number) => string>> = {
	en: (n) => (n === 1 ? "1 item was removed because no source supported it." : `${n} items were removed because no source supported them.`),
	es: (n) => (n === 1 ? "Se quitó 1 elemento porque ninguna fuente lo respaldaba." : `Se quitaron ${n} elementos porque ninguna fuente los respaldaba.`),
	fr: (n) => (n === 1 ? "1 élément a été retiré car aucune source ne le confirmait." : `${n} éléments ont été retirés car aucune source ne les confirmait.`),
	pt: (n) => (n === 1 ? "1 item foi removido porque nenhuma fonte o confirmava." : `${n} itens foram removidos porque nenhuma fonte os confirmava.`),
	de: (n) => (n === 1 ? "1 Eintrag wurde entfernt, weil keine Quelle ihn belegte." : `${n} Einträge wurden entfernt, weil keine Quelle sie belegte.`),
	it: (n) => (n === 1 ? "1 elemento è stato rimosso perché nessuna fonte lo confermava." : `${n} elementi sono stati rimossi perché nessuna fonte li confermava.`),
	ca: (n) => (n === 1 ? "S'ha tret 1 element perquè cap font no el confirmava." : `S'han tret ${n} elements perquè cap font no els confirmava.`),
};

/** The line that tells the reader groundcheck dropped `n` list items, in `lang` where translated. */
export function groundcheckItemsRemovedText(n: number, lang: DeclineLanguage = "en"): string {
	return `_${(ITEMS_REMOVED[lang] ?? ITEMS_REMOVED.en)(n)}_`;
}

/** The default detector call: POST /detect on the groundcheck service. Throws on any failure. */
const detectRemote: DetectCall = async (input, signal) => {
	const res = await fetch(`${groundcheckUrl()}/detect`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${groundcheckToken()}` },
		body: JSON.stringify(input),
		signal,
	});
	if (!res.ok) throw new Error(`groundcheck detect ${res.status}`);
	const out = (await res.json()) as { spans?: DetectSpan[]; truncated?: boolean; ms?: { model?: number } };
	if (!Array.isArray(out.spans)) throw new Error("groundcheck detect: no spans");
	return { spans: out.spans, truncated: out.truncated === true, modelMs: out.ms?.model };
};

// The identical prefix of every revise call is this system message plus REVISE_TOOL. The gateway is
// OpenAI-compatible with no cache_control field; the static prefix comes first so a provider-side
// prefix cache can hit, and the variable sources and sentences ride in the user message after it.
const REVISE_SYSTEM =
	"You check sentences from an answer against the sources it was written from. Each sentence has the " +
	"parts a checker thinks the sources do not support marked ⟦like this⟧.\n\n" +
	"For each sentence, return it with every claim the sources do not state deleted: a country, an " +
	"organisation, an author, a date or a number that no source gives. Delete whole claims, including " +
	"the words that only connect them (\"based in\", \"from\", a dash or comma). Copy every remaining word " +
	"exactly. Never add, reword or reorder words, and never remove a negation on its own.\n\n" +
	"If the sources do say what a marked part says, return the sentence unchanged. If nothing the " +
	"sources support is left, return an empty string. Remove the ⟦ ⟧ marks.";

export const REVISE_TOOL_NAME = "revise_sentences";
const REVISE_TOOL: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: REVISE_TOOL_NAME,
		description: "Record each sentence with its unsupported claims deleted.",
		parameters: {
			type: "object",
			properties: {
				revisions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "integer", description: "the sentence's id" },
							text: {
								type: "string",
								description: "the sentence with unsupported claims deleted, unchanged, or empty",
							},
						},
						required: ["id", "text"],
					},
				},
			},
			required: ["revisions"],
		},
	},
};

/** `revisions` from the tool call as id → text, or null when the call is missing or malformed. */
export function parseReviseArgs(toolCall: unknown): Map<number, string> | null {
	const fn = (toolCall as { function?: { name?: string; arguments?: string } } | undefined)?.function;
	if (fn?.name !== REVISE_TOOL_NAME || typeof fn.arguments !== "string") return null;
	try {
		const list = (JSON.parse(fn.arguments) as { revisions?: unknown }).revisions;
		if (!Array.isArray(list)) return null;
		const out = new Map<number, string>();
		for (const r of list as { id?: unknown; text?: unknown }[]) {
			if (Number.isInteger(r?.id) && typeof r.text === "string") out.set(r.id as number, r.text);
		}
		return out;
	} catch {
		return null;
	}
}

/** The default reviser: one forced `revise_sentences` call on TASK_MODEL's own registered lane. null
 *  when TASK_MODEL is unset or unregistered; throws on a transport failure. */
const reviseOnTaskModel: ReviseCall = async ({ context, items }, signal) => {
	const call = await forcedTaskModelToolCall({
		system: REVISE_SYSTEM,
		user: `Sources:\n${context}\n\nSentences:\n` + items.map((i) => `[${i.id}] ${i.marked}`).join("\n"),
		tool: REVISE_TOOL,
		maxTokens: 1_200,
		timeoutMs: REVISE_TIMEOUT_MS,
		signal,
	});
	return call === null ? null : parseReviseArgs(call);
};

/** What `groundcheck_removes_claim` checks a turn against: a source that never calls the reply canned. */
export const GROUNDCHECK_FAULT_EVIDENCE = ["A fixed reply stands in for a model's answer in specs that check the chat."];

/**
 * The check `groundcheck_removes_claim` runs in place of the remote detector and the task-model
 * reviser. It flags the word "canned" in `canned_reply`'s text and deletes it, then lets the real
 * acceptance guards and count run, so a spec reads the removed-claim count a real revision stamps. (CUR-2927)
 */
export function groundcheckFaultCheck(input: { answer: string; context: string[]; question: string }) {
	return groundcheckAnswer(input, {
		detect: async ({ answer }) => {
			const start = answer.indexOf("canned");
			return { spans: start < 0 ? [] : [{ start, end: start + 6, text: "canned", confidence: 0.99 }], truncated: false };
		},
		revise: async ({ items }) => new Map(items.map((it) => [it.id, it.marked.replace("⟦canned⟧ ", "").replace(/[⟦⟧]/g, "")])),
	});
}
