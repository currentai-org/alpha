// The starter prompts a visitor is actually offered (CUR-1003): the candidates in suggestions.ts,
// minus any without a passing live grade in starterRecord.json. The record is written by
// `pnpm --dir web probe:starters --write-record` (evals/inspect_tasks/starter_prompts.py), so
// re-grading is how a prompt joins or leaves the shelf; no edit here is needed either way.
//
// A tuning-panel override (chatShellData.ts) still replaces this pool wholesale. That is an
// operator's deliberate choice and is not filtered.
import { suggestions } from './suggestions';
import record from './starterRecord.json';

interface StarterRecord {
	graded_on: string;
	base: string;
	model: string;
	runs: number;
	pass_at: number;
	log: string;
	prompts: Record<string, { correct: number; runs: number }>;
}

/** Keeps only the candidates the record graded at or above its pass bar, in candidate order.
 *  A prompt the record never saw is dropped. */
export function gradedShelf(candidates: readonly string[], rec: StarterRecord): string[] {
	return candidates.filter((p) => {
		const r = rec.prompts[p];
		return r !== undefined && r.correct >= rec.pass_at;
	});
}

export const shelf: string[] = gradedShelf(suggestions, record);

// Every graded prompt is English (CUR-2323). A visitor whose browser asks for another language
// first would read English chips as "English is expected here", so the shelf offers nothing to
// them until prompts are graded in their language. A missing or wildcard header offers the shelf.
const SHELF_LANGUAGE = 'en';

/** The primary language subtag the visitor ranks highest in `Accept-Language`, or null. */
export function preferredLanguage(acceptLanguage: string | null | undefined): string | null {
	let best: { lang: string; q: number } | null = null;
	for (const part of (acceptLanguage ?? '').split(',')) {
		const [tag, ...params] = part.trim().split(';');
		const lang = tag.trim().split('-')[0].toLowerCase();
		if (!lang || lang === '*') continue;
		const qParam = params.find((p) => p.trim().startsWith('q='));
		const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
		if (Number.isFinite(q) && q > 0 && (!best || q > best.q)) best = { lang, q };
	}
	return best?.lang ?? null;
}

/** Whether this visitor should be offered the (English) starter shelf at all. */
export function offersShelf(acceptLanguage: string | null | undefined): boolean {
	const lang = preferredLanguage(acceptLanguage);
	return lang === null || lang === SHELF_LANGUAGE;
}
