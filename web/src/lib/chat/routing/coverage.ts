/**
 * Which languages the served models handle: for each of `tags`, the model Auto picks for a medium-size
 * draft in that language, split by `stillLearning`, the same test that raises the still-learning notice
 * for that pick, into languages handled well and languages still being learned.
 *
 * The pick is `route`'s own, so the panel can never name a model Auto would not send that draft to:
 * a model scoped to its own languages or to large tasks, or one that is busy, is out here exactly as it
 * is there.
 */
import type { CatalogModel } from './catalog';
import { draftIn } from './classifier';
import { route, stillLearning, type RouteOptions } from './router';

export interface LanguageCoverage {
	tag: string;
	name: string;
	/** The model Auto picks for a medium-size draft in this language. */
	model: CatalogModel;
	/** The picked model's support for this language, 0–1 above chance. */
	support: number;
	/** The picked model is still learning the language: the still-learning notice would show. */
	learning: boolean;
}

/** A language Auto can place no model for (nothing it may choose is served) is left out. */
export function languageCoverage(
	servedIds: string[],
	opts: RouteOptions,
	nameOf: (tag: string) => string,
	tags: readonly string[]
): { strong: LanguageCoverage[]; learning: LanguageCoverage[] } {
	const all = tags.flatMap((tag) => {
		const draft = draftIn(tag);
		const choice = route(draft, servedIds, opts);
		if (!choice) return [];
		const support = choice.scores.find((s) => s.model.id === choice.model.id)!.language;
		const learning = !!stillLearning(draft, choice.model.id, opts, choice.scores);
		return [{ tag, name: nameOf(tag), model: choice.model, support, learning }];
	});
	const byName = (a: LanguageCoverage, b: LanguageCoverage) => a.name.localeCompare(b.name);
	return {
		strong: all.filter((l) => !l.learning).sort(byName),
		learning: all.filter((l) => l.learning).sort(byName)
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
