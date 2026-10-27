import type { Message } from '$lib/chat/types/Message';
import type { RagEngine, RagSource } from '$lib/chat/types/Rag';
import type { SafetyRule } from '$lib/chat/types/SafetyRule';
import { extractCitedIndices } from '$lib/chat/utils/trace/citedIndices';
import { collapseCitations, renumberCited } from '$lib/chat/utils/collapseSources';

/**
 * The evidence behind an answer, written for someone who has never heard of a search engine or a
 * retrieval store. XRAY → "Step by step" shows these under the step that gathered them: the sources
 * with what they said, and the safety rules that were checked. Everything is read from what the turn
 * recorded, so nothing here can claim a check or a lookup that did not happen.
 */

/** One source, with where it came from in plain words and what the AI was given from it. */
export interface StepSource {
	/** The number the answer would cite it by, as in "[1]". */
	n: number;
	title: string;
	url?: string;
	/** Where it came from, in plain words. */
	from: string;
	/** What it said: the passage the AI was given, whitespace tidied. */
	excerpt?: string;
	/** ISO day the source was last changed or published, when the source says. */
	date?: string;
	/** Whether the answer points at it with [n]. Undefined when the answer cites no source at all. */
	cited?: boolean;
}

/** Each search engine as a person would name it, for a source's own line. */
const WEB_ORIGIN: Record<string, string> = {
	Wikipedia: 'Wikipedia',
	Wikinews: 'Wikinews',
	Firecrawl: 'The open web (quality varies)',
	OpenAlex: 'OpenAlex, an index of research papers',
	arXiv: 'arXiv, a library of research papers',
	'Hugging Face': 'Hugging Face',
	Direct: 'A page you linked'
};

/** The same engines inside a sentence ("read 3 pages from Wikipedia and the open web"). */
const WEB_SHORT: Record<string, string> = {
	Wikipedia: 'Wikipedia',
	Wikinews: 'Wikinews',
	Firecrawl: 'the open web',
	OpenAlex: 'OpenAlex',
	arXiv: 'arXiv',
	'Hugging Face': 'Hugging Face',
	Direct: 'the page you linked'
};

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The engines of a web search as a person would name them, in a sentence. */
export function webOrigins(engines: string[]): string {
	return joinNames(engines.map((e) => WEB_SHORT[e] ?? 'the open web'));
}

/** Where a knowledge-store source came from. Persisted messages can carry engines that no longer exist. */
export function ragOrigin(source: Pick<RagSource, 'engine' | 'sourceName'>): string {
	if (source.engine === 'Potluck') return 'AI Potluck’s knowledge library';
	if (source.engine === 'Potluck:Community') return 'A document the AI Potluck team uploaded';
	if (source.engine === 'PastChat') return 'One of your earlier chats';
	return source.sourceName ? `A partner’s data source (${source.sourceName})` : 'A partner’s data source';
}

/**
 * The day, in the reader's own language and calendar; pass a `timeZone` for a deterministic day. A
 * bare YYYY-MM-DD is a calendar day, which `Date` reads as UTC midnight, so it is formatted in UTC to
 * read the same day everywhere (CUR-4171). A timestamp follows the reader's zone.
 */
export function formatDay(iso: string, opts: { timeZone?: string; locale?: string } = {}): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
	return new Intl.DateTimeFormat(opts.locale, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? 'UTC' : opts.timeZone
	}).format(d);
}

/** Collapse whitespace so a retrieved passage reads as prose; undefined when nothing is left. */
export function tidyExcerpt(text?: string): string | undefined {
	const t = (text ?? '').replace(/\s+/g, ' ').trim();
	return t || undefined;
}

/**
 * The [n] numbers the answer cites, as the entry numbers the answer shows (a page retrieved as several
 * passages is one entry, CUR-888), or undefined when it cites none (so no row is called "not cited").
 */
function citedNumbers(message: Message): Set<number> | undefined {
	const cited = extractCitedIndices(message.content ?? '');
	return cited.size ? renumberCited(cited, message) : undefined;
}

/** The pages the web search read, one entry per page, with what each said. */
export function webSources(message: Message): StepSource[] {
	const cited = citedNumbers(message);
	return (collapseCitations(message).webSearch?.sources ?? []).map((s) => ({
		n: s.n,
		title: s.title,
		url: s.url,
		from: WEB_ORIGIN[s.engine] ?? 'The open web',
		excerpt: tidyExcerpt(s.snippet),
		date: s.asOf,
		cited: cited ? cited.has(s.n) : undefined
	}));
}

/** The passages a knowledge store returned, optionally only one store's. */
export function ragSources(message: Message, engine?: RagEngine): StepSource[] {
	const cited = citedNumbers(message);
	return (collapseCitations(message).rag?.sources ?? [])
		.filter((s) => !engine || s.engine === engine)
		.map((s) => ({
			n: s.n,
			title: s.title,
			url: s.url,
			from: ragOrigin(s),
			excerpt: tidyExcerpt(s.snippet),
			date: s.sourceDate,
			cited: cited ? cited.has(s.n) : undefined
		}));
}

export type RuleState = 'triggered' | 'clear' | 'not-checked';
export interface RuleRow {
	label: string;
	state: RuleState;
}

/**
 * Each named safety rule as this turn left it. Only for a turn whose screen actually ran: a rule that
 * fired is "triggered"; when the turn was blocked the rest are "not checked", since the screen stopped
 * there; otherwise the rest are "clear". A distress rule fires without blocking (CUR-3915), so its turn
 * shows that rule triggered and the others clear.
 */
export function classifyRules(
	rules: SafetyRule[],
	turn: { triggeredLabel?: string | null; blocked?: boolean }
): RuleRow[] {
	const stopped = Boolean(turn.blocked);
	return rules.map((rule) => {
		if (turn.triggeredLabel && turn.triggeredLabel === rule.label) {
			return { label: rule.label, state: 'triggered' };
		}
		return { label: rule.label, state: stopped ? 'not-checked' : 'clear' };
	});
}

/**
 * When the input safety screen ran relative to the model, from what the turn measured. Turns saved while
 * generation could overlap the screen carry `speculativeEvents`, the number of tokens
 * held until the verdict; 0 or absent means the screen ran first, which every new turn does.
 */
export function screenOrder(timings?: {
	speculativeEvents?: number;
	speculativeDiscarded?: boolean;
}): 'first' | 'alongside' | 'alongside-discarded' {
	if (!timings?.speculativeEvents) return 'first';
	return timings.speculativeDiscarded ? 'alongside-discarded' : 'alongside';
}

/**
 * What a revised answer lost, with the count when the stamp carries one; an answer stamped
 * before the count existed says no number. The request trace reads the same phrase. (CUR-2927)
 */
export function removedClaimsPhrase(removed?: number): string {
	if (removed && removed > 0) return `removed ${removed} claim${removed === 1 ? '' : 's'} no source supports`;
	return 'removed claims no source supports';
}

/**
 * The "Fact check" step, from the outcome groundcheck stamped on the answer. A revised answer
 * says how many claims were removed when the stamp carries the count; one stamped before the count
 * existed says only that claims were removed. The removed words are never shown again. (CUR-2927)
 */
export function factCheckStep(notice: NonNullable<Message['groundcheckNotice']>): {
	what: string;
	tone: 'ok' | 'note';
} {
	switch (notice.outcome) {
		case 'revised': {
			const phrase = removedClaimsPhrase(notice.removed);
			return { what: `${phrase[0].toUpperCase()}${phrase.slice(1)}.`, tone: 'note' };
		}
		case 'emptied':
			return {
				what: 'No claim in the answer was backed by its sources, so Alpha replaced it with a pointer to them.',
				tone: 'note'
			};
		case 'clean':
		case 'kept':
			return { what: 'Checked each claim against the sources. Nothing needed removing.', tone: 'ok' };
		case 'stood-down':
			return {
				what: 'Not checked: the numbers came from a calculation, or another check had already rewritten the answer.',
				tone: 'ok'
			};
		case 'truncated':
		case 'too-many':
		case 'detect-failed':
		case 'revise-failed':
			return { what: 'The fact check couldn’t finish, so the answer is shown as written.', tone: 'note' };
	}
}
