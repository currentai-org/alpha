/**
 * Which languages the served models handle: for each of `tags`, the model Auto picks for a medium-size
 * draft in that language, split at the router's dependable line (`weakSupport`, the same threshold that
 * raises the language-gap pill) into languages handled well and languages still being learned.
 *
 * The pick is `route()`'s own, so the panel can never name a model Auto would not send that draft to:
 * a model scoped to its own languages or to large tasks, or one that is busy, is out here exactly as it
 * is there (CUR-4692).
 */
import type { CatalogModel } from './catalog';
import type { DraftAnalysis } from './classifier';
import { DEFAULT_ROUTING, route, type RouteOptions } from './router';

export interface LanguageCoverage {
	tag: string;
	name: string;
	/** The model Auto picks for a medium-size draft in this language. */
	model: CatalogModel;
	/** The best support, 0–1, among the models Auto may choose for this language. */
	support: number;
}

/** A medium-size draft Auto reads, surely, as written in `tag`. */
const draftIn = (tag: string): DraftAnalysis => ({
	language: { value: tag, confidence: 1, alternatives: [], signal: 'words' },
	difficulty: { value: 'M', confidence: 1 },
	skills: [],
	source: 'manual'
});

/** A language Auto can place no model for (nothing it may choose is served) is left out. */
export function languageCoverage(
	servedIds: string[],
	opts: RouteOptions,
	nameOf: (tag: string) => string,
	tags: readonly string[]
): { strong: LanguageCoverage[]; learning: LanguageCoverage[] } {
	const weakSupport = (opts.config ?? DEFAULT_ROUTING).weakSupport;
	const all = tags.flatMap((tag) => {
		const choice = route(draftIn(tag), servedIds, opts);
		if (!choice) return [];
		const choosable = choice.scores.filter((s) => s.available && s.benchmarked);
		return [{ tag, name: nameOf(tag), model: choice.model, support: Math.max(...choosable.map((s) => s.language)) }];
	});
	const byName = (a: LanguageCoverage, b: LanguageCoverage) => a.name.localeCompare(b.name);
	return {
		strong: all.filter((l) => l.support >= weakSupport).sort(byName),
		learning: all.filter((l) => l.support < weakSupport).sort(byName)
	};
}

/**
 * The well-handled languages grouped by the model Auto picks for them, most languages first, and an
 * order that takes turns across those models (each one's strongest language first), so a display
 * cycling through it moves from model to model instead of dwelling on the one that leads most.
 */
export function specialists(strong: LanguageCoverage[]): {
	byModel: { model: CatalogModel; count: number }[];
	cycle: LanguageCoverage[];
} {
	const groups = new Map<string, LanguageCoverage[]>();
	for (const lang of strong) groups.set(lang.model.id, [...(groups.get(lang.model.id) ?? []), lang]);
	const ordered = [...groups.values()]
		.map((langs) => [...langs].sort((a, b) => b.support - a.support || a.name.localeCompare(b.name)))
		.sort((a, b) => b.length - a.length || a[0].model.name.localeCompare(b[0].model.name));
	const cycle: LanguageCoverage[] = [];
	for (let round = 0; cycle.length < strong.length; round++) {
		for (const langs of ordered) if (langs[round]) cycle.push(langs[round]);
	}
	return { byModel: ordered.map((langs) => ({ model: langs[0].model, count: langs.length })), cycle };
}
