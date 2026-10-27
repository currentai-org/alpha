/**
 * What Auto weighs when it picks a model: a list of criteria, each with a weight (how much it matters
 * when it fully applies) and a relevance (how much it applies to this draft, 0–1). For a draft, each
 * criterion's share of the score is
 *
 *   share = weight × relevance ÷ Σ (weight × relevance)
 *
 * and a model's total is Σ share × fit, where fit is that model's 0–1 score on the criterion
 * (router.ts). Relevance is what keeps a criterion out of drafts it has nothing to say about: an
 * unclear language weighs nothing, a coding benchmark weighs only on a draft that looks like code.
 *
 * Language and intelligence are always present. Every skill (classifier.ts `SkillId`) that the
 * benchmark table scores becomes a criterion too, with the skill's detected confidence as its
 * relevance: adding `"skills": { "code": 0.8 }` to models in benchmarks.json is all it takes for
 * Auto to weigh a coding benchmark on code drafts. Weights are edited in the routing lab
 * (Settings → Model routing) and persist per device.
 */
import { m } from '$lib/paraglide/messages.js';
import { benchmarkedSkills, type BenchmarkTable } from './benchmarks';
import { SKILL_LABEL, type DraftAnalysis, type SkillId } from './classifier';

export type CriterionId = 'language' | 'intelligence' | `skill:${SkillId}`;

export interface Criterion {
	id: CriterionId;
	label: string;
	/** What the fit measures, for the routing lab. */
	description: string;
	/** How much this criterion applies to the draft, 0–1. */
	relevance: (analysis: DraftAnalysis) => number;
}

const LANGUAGE_CRITERION: Criterion = {
	id: 'language',
	get label() {
		return m.routing_criterionLanguage();
	},
	get description() {
		return m.routing_criterionLanguageHelp();
	},
	relevance: (a) => (a.language.value === 'und' ? 0 : a.language.confidence)
};

const INTELLIGENCE_CRITERION: Criterion = {
	id: 'intelligence',
	get label() {
		return m.routing_criterionIntelligence();
	},
	get description() {
		return m.routing_criterionIntelligenceHelp();
	},
	relevance: () => 1
};

function skillCriterion(skill: SkillId): Criterion {
	return {
		id: `skill:${skill}`,
		get label() {
			return m.routing_criterionSkill({ skill: SKILL_LABEL[skill] });
		},
		get description() {
			return m.routing_criterionSkillHelp({ skill: SKILL_LABEL[skill].toLowerCase() });
		},
		relevance: (a) => a.skills.find((s) => s.id === skill)?.confidence ?? 0
	};
}

/** Every criterion the table has numbers for: language and intelligence, then one per scored skill. */
export function criteriaFor(table: BenchmarkTable): Criterion[] {
	return [LANGUAGE_CRITERION, INTELLIGENCE_CRITERION, ...benchmarkedSkills(table).map(skillCriterion)];
}

/**
 * Default weights. Language 7 to intelligence 3 gives language 70% of the score when the language is
 * certain, falling toward 0 as the detection gets less sure. A newly scored skill starts at
 * DEFAULT_SKILL_WEIGHT until someone sets it.
 */
export const DEFAULT_WEIGHTS: Partial<Record<CriterionId, number>> = { language: 7, intelligence: 3 };
const DEFAULT_SKILL_WEIGHT = 3;

export function weightOf(weights: Partial<Record<CriterionId, number>>, id: CriterionId): number {
	return weights[id] ?? DEFAULT_WEIGHTS[id] ?? (id.startsWith('skill:') ? DEFAULT_SKILL_WEIGHT : 0);
}

/**
 * Each criterion's share of the score for this draft (they sum to 1). With every weight × relevance
 * at zero, intelligence decides alone.
 */
export function sharesFor(
	criteria: Criterion[],
	analysis: DraftAnalysis,
	weights: Partial<Record<CriterionId, number>>
): Partial<Record<CriterionId, number>> {
	const raw = criteria.map((c) => [c.id, Math.max(0, weightOf(weights, c.id)) * c.relevance(analysis)] as const);
	const sum = raw.reduce((s, [, v]) => s + v, 0);
	if (sum <= 0) return { intelligence: 1 };
	return Object.fromEntries(raw.map(([id, v]) => [id, v / sum]));
}

/** Shares when every criterion fully applies: what the weights mean, for the routing lab. */
export function fullShares(
	criteria: Criterion[],
	weights: Partial<Record<CriterionId, number>>
): Partial<Record<CriterionId, number>> {
	const sum = criteria.reduce((s, c) => s + Math.max(0, weightOf(weights, c.id)), 0);
	return Object.fromEntries(criteria.map((c) => [c.id, sum > 0 ? Math.max(0, weightOf(weights, c.id)) / sum : 0]));
}
