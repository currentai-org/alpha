/**
 * Analysis → model. Every catalog model is scored on the routing criteria (criteria.ts) against what
 * the draft needs — support for its language, enough intelligence for its task size, and any skill
 * the benchmark table scores — and the best one the registry actually serves answers. The choice
 * comes with a plain-language reason for people who don't care about model names, and the full
 * score table for the routing lab.
 *
 * Scoring, per model:
 *   language fit      = support for the detected tag: its measured score rescaled above chance; the
 *                       median of the measured models when it wasn't measured but others were; else
 *                       the hand-set estimate (benchmarks.ts `languageSupport` has the order)
 *   intelligence fit  = its share of the strongest available model's intelligence (square root),
 *                       less a penalty per point below the task's floor (`intelligenceFit`)
 *   skill fit         = its score on that skill's benchmark (the median when it wasn't tested)
 *   total             = Σ share × fit, share = weight × relevance, normalised (criteria.ts),
 *                       less a capacity cost on a rate-limited model unless the task is large
 *                       (`capacityCostFor`)
 * Relevance is the classifier's confidence: an unsure language guess leans on intelligence instead,
 * and a skill benchmark only counts on drafts that need the skill.
 *
 * Only a model with a row in the benchmark table is ever Auto's pick: without one its numbers would
 * be guesses, so it stays a manual choice in the picker until it is benchmarked.
 *
 * Mid-conversation the model can change per turn. The model that answered last gets a continuity
 * bonus (`RoutingConfig.continuity`): it has the history in its own words, and a switch is only
 * worth suggesting when another model is clearly better for this message, not marginally.
 */
import { m } from '$lib/paraglide/messages.js';
import { getLocale } from '$lib/paraglide/runtime.js';
import { catalog, servedKey, type CatalogModel } from './catalog';
import {
	SHIPPED_BENCHMARKS,
	intelligenceOf,
	languageSupport,
	skillScoreOf,
	type BenchmarkTable,
	type SupportVia
} from './benchmarks';
import { DEFAULT_WEIGHTS, criteriaFor, sharesFor, type CriterionId } from './criteria';
import { SHIPPED_LANGUAGE_SCORES, type LanguageScores, type MeasuredScore } from './languageScores';
import { DIFFICULTY_LABEL, type Difficulty, type DraftAnalysis, type SkillId } from './classifier';
import { localLanguageName, parentLanguage, tagsFromIso1 } from './languages';

export interface RoutingConfig {
	/**
	 * Intelligence floor each task size wants, on the benchmark table's scale (the Artificial Analysis
	 * Intelligence Index). A model below it loses `underCost` of fit per point; nothing is lost above it.
	 */
	target: Record<Difficulty, number>;
	underCost: number;
	/**
	 * How much each criterion matters when it fully applies (criteria.ts). Relative numbers: only
	 * their ratios count. A skill criterion missing here uses DEFAULT_SKILL_WEIGHT.
	 */
	weights: Partial<Record<CriterionId, number>>;
	/** Below this best-available support a confidently detected language counts as a gap. */
	weakSupport: number;
	/** Language confidence needed before a gap is reported. */
	gapConfidence: number;
	/** Added to the total of the model that answered the previous turn. */
	continuity: number;
	/**
	 * Taken from the total of the scarcest available model on a draft not confidently large
	 * (`capacityCostFor`), so a model with a small request budget is spent on the tasks that need it.
	 */
	capacityCost: number;
}

export const DEFAULT_ROUTING: RoutingConfig = {
	target: { S: 0, M: 4, L: 8 },
	underCost: 0.04,
	weights: DEFAULT_WEIGHTS,
	weakSupport: 0.5,
	gapConfidence: 0.55,
	continuity: 0.06,
	capacityCost: 0.15
};

/**
 * The language Auto may name to the visitor: the detected tag once it clears `gapConfidence`, the
 * same bar the gap panel uses, and `und` below it. A short draft in a language the classifier has no
 * profile for still comes back with some tag (Welsh reads as Lithuanian), and saying "You're writing
 * in Lithuanian" states a guess as fact. Scoring still uses the raw guess, weighted by confidence.
 */
export function shownLanguage(analysis: DraftAnalysis, config: RoutingConfig = DEFAULT_ROUTING): string {
	const tag = analysis.language.value;
	return tag !== 'und' && analysis.language.confidence >= config.gapConfidence ? tag : 'und';
}

export interface ModelScore {
	model: CatalogModel;
	/** Live and served by the registry right now — the only models that can answer. */
	available: boolean;
	/** Served, but busy right now (CUR-4043); Auto skips it while another model is available. */
	busy: boolean;
	/** Has a row in the benchmark table. Auto only picks a model that is available AND benchmarked. */
	benchmarked: boolean;
	language: number;
	languageVia: SupportVia;
	/** The benchmark result behind `language` when it was measured. */
	measured?: MeasuredScore;
	intelligence: number;
	/** 0–1: its intelligence against the strongest available model's, less any shortfall below the task's floor. */
	intelligenceFit: number;
	/** Every criterion's 0–1 fit, by criterion id. */
	fits: Partial<Record<CriterionId, number>>;
	/** Continuity bonus included in `total` (the model that answered last turn), else 0. */
	continuity: number;
	/** Capacity cost taken from `total` (a rate-limited model on a task that isn't large), else 0. */
	capacity: number;
	total: number;
}

/** A language Alpha can detect but none of its models serve well. Drives the dataset CTA. */
export interface LanguageGap {
	tag: string;
	name: string;
	/** Best support among the models Alpha serves now. */
	bestAvailable: number;
	/** Best support among every catalog model, served or not. */
	bestAnywhere: number;
}

export interface RouteChoice {
	/** The model that will answer — always a served, benchmarked one. */
	model: CatalogModel;
	/** The benchmarked model that would suit best, when it differs from `model` because it isn't available. */
	ideal?: CatalogModel;
	/** The best served model Auto skipped because it is busy right now (CUR-4043), when it outscores `model`. */
	busy?: CatalogModel;
	/** Short reason chips: "Catalan", "Medium task". */
	reasons: string[];
	/** One or two plain sentences: how we got here. */
	explanation: string;
	/** Every catalog model, best first. */
	scores: ModelScore[];
	/** Intelligence the task needed, after confidence blending. */
	target: number;
	/** Language's share of the score for this draft. */
	languageWeight: number;
	/** Every criterion's share of the score for this draft (they sum to 1). */
	shares: Partial<Record<CriterionId, number>>;
	gap?: LanguageGap;
	/** Continuity alone kept the previous turn's model: without it another model would answer. */
	keptForContinuity?: boolean;
}

export interface RouteOptions {
	benchmarks?: BenchmarkTable;
	/** Measured language scores; the shipped file by default. */
	languageScores?: LanguageScores;
	config?: RoutingConfig;
	/** Catalog id of the model that answered the previous turn, when the chat has started. */
	stickTo?: string;
	/**
	 * Gateway ids of served models that are busy right now (CUR-4043): Auto skips them while any other
	 * model is available, and keeps its normal pick when every one is busy.
	 */
	busy?: string[];
}

/** The intelligence a task needs; an unsure size is pulled toward the medium target. */
export function targetFor(analysis: DraftAnalysis, config: RoutingConfig = DEFAULT_ROUTING): number {
	const mid = config.target.M;
	const t = config.target[analysis.difficulty.value];
	return Math.round(mid + (t - mid) * analysis.difficulty.confidence);
}

/**
 * Auto leans toward the most capable model it can use: the strongest available model scores 1 and the
 * rest by the square root of their share of its intelligence — steep enough that the strongest model
 * wins any language it handles well, gentle enough that a specialist with a clear edge in its own
 * language (ALIA for Catalan, Bielik for Polish) still does. Being stronger than a task needs costs nothing; being
 * weaker than its floor costs `underCost` per point.
 *
 * @param strongest intelligence of the strongest available model (the scale's ceiling when none).
 */
export function intelligenceFit(
	intelligence: number,
	target: number,
	strongest: number,
	config: RoutingConfig = DEFAULT_ROUTING
): number {
	const relative = strongest > 0 ? Math.sqrt(intelligence / strongest) : 1;
	return clamp01(relative - Math.max(0, target - intelligence) * config.underCost);
}

/**
 * What a model's request budget costs it on this draft. Following RouteLLM's rule (send a query to
 * the stronger, scarcer model only when it is predicted to need it), a model pays `capacityCost` in
 * proportion to how far its requests-a-minute fall short of the roomiest available model's, on a log
 * scale, and the cost fades as the classifier grows sure the task is large. Large 3's 150 a minute
 * against Medium's 4,000 is the case this exists for (CUR-4035, CUR-4574). A model with no known budget, or
 * none to compare against, pays nothing.
 *
 * @param roomiest the highest requests-a-minute among served models that have a figure.
 */
function capacityCostFor(
	model: CatalogModel,
	analysis: DraftAnalysis,
	roomiest: number,
	config: RoutingConfig = DEFAULT_ROUTING
): number {
	const rpm = model.requestsPerMinute;
	if (!rpm || roomiest <= 1 || rpm >= roomiest) return 0;
	const shortfall = 1 - Math.log(rpm) / Math.log(roomiest);
	const surelyLarge = analysis.difficulty.value === 'L' ? analysis.difficulty.confidence : 0;
	return config.capacityCost * shortfall * (1 - surelyLarge);
}

/** Each criterion's share of the score for this draft. */
function sharesForDraft(
	analysis: DraftAnalysis,
	table: BenchmarkTable = SHIPPED_BENCHMARKS,
	config: RoutingConfig = DEFAULT_ROUTING
): Partial<Record<CriterionId, number>> {
	return sharesFor(criteriaFor(table), analysis, config.weights);
}

export function scoreModels(analysis: DraftAnalysis, servedIds: string[], opts: RouteOptions = {}): ModelScore[] {
	const table = opts.benchmarks ?? SHIPPED_BENCHMARKS;
	const config = opts.config ?? DEFAULT_ROUTING;
	const served = new Set(servedIds.map(servedKey));
	const busy = new Set((opts.busy ?? []).map(servedKey));
	const target = targetFor(analysis, config);
	const criteria = criteriaFor(table);
	const shares = sharesFor(criteria, analysis, config.weights);
	const tag = analysis.language.value;

	// A model offered only for picking by hand is never one Auto can choose, one scoped to its own
	// languages is out for any other draft, and one scoped to large tasks is out for a draft the
	// classifier doesn't read as large, `strongest` included each time (CatalogModel.autoPick).
	const ownLanguage = (model: CatalogModel) => {
		const base = parentLanguage(tag) ?? tag;
		return tagsFromIso1(model.languages).some((t) => t === tag || t === base);
	};
	const isServed = (model: CatalogModel) =>
		model.status === 'live' &&
		model.autoPick !== false &&
		(model.autoPick !== 'own-languages' || ownLanguage(model)) &&
		(model.autoPick !== 'large-tasks' || analysis.difficulty.value === 'L') &&
		!!model.gatewayId &&
		served.has(servedKey(model.gatewayId));
	const isBenchmarked = (model: CatalogModel) => model.id in table.models;
	const isBusy = (model: CatalogModel) => !!model.gatewayId && busy.has(servedKey(model.gatewayId));
	// A busy model drops out only while something else can answer: when every one is busy, Auto keeps
	// its normal pick rather than having nothing to choose.
	const skipBusy = catalog.some((m) => isServed(m) && isBenchmarked(m) && !isBusy(m));
	const isAvailable = (model: CatalogModel) => isServed(model) && !(skipBusy && isBusy(model));
	const strongest = Math.max(
		0,
		// Served, busy or not: a busy mark changes who may answer, never the scores.
		...catalog.filter((m) => isServed(m) && isBenchmarked(m)).map((m) => intelligenceOf(table, m.id))
	);
	const roomiest = Math.max(
		0,
		// Served, busy or not, like `strongest`.
		...catalog.filter((m) => isServed(m) && isBenchmarked(m)).map((m) => m.requestsPerMinute ?? 0)
	);

	return catalog
		.map((model) => {
			const support =
				tag === 'und'
					? { value: 1, via: 'exact' as const, measured: undefined }
					: languageSupport(table, model.id, tag, opts.languageScores ?? SHIPPED_LANGUAGE_SCORES);
			const intelligence = intelligenceOf(table, model.id);
			const fit = intelligenceFit(intelligence, target, strongest, config);
			const benchmarked = isBenchmarked(model);
			const continuity = model.id === opts.stickTo ? config.continuity : 0;
			const capacity = round(capacityCostFor(model, analysis, roomiest, config));
			const fits: Partial<Record<CriterionId, number>> = { language: support.value, intelligence: fit };
			for (const c of criteria) {
				if (c.id.startsWith('skill:')) fits[c.id] = skillScoreOf(table, model.id, c.id.slice(6) as SkillId);
			}
			const weighted = criteria.reduce((sum, c) => sum + (shares[c.id] ?? 0) * (fits[c.id] ?? 0), 0);
			return {
				model,
				available: isAvailable(model),
				busy: isServed(model) && isBusy(model),
				benchmarked,
				language: support.value,
				languageVia: benchmarked || support.measured ? support.via : ('unbenchmarked' as const),
				measured: support.measured,
				intelligence,
				intelligenceFit: round(fit),
				fits,
				continuity,
				capacity,
				total: round(weighted + continuity - capacity)
			};
		})
		.sort((a, b) => b.total - a.total);
}

/**
 * @param servedIds gateway ids the registry serves right now (`page.data.models[].id`).
 * @returns undefined when no benchmarked catalog model is served — the caller keeps its own default.
 */
export function route(analysis: DraftAnalysis, servedIds: string[], opts: RouteOptions = {}): RouteChoice | undefined {
	const config = opts.config ?? DEFAULT_ROUTING;
	const scores = scoreModels(analysis, servedIds, opts);
	const shares = sharesForDraft(analysis, opts.benchmarks ?? SHIPPED_BENCHMARKS, config);
	// What Auto chooses among: served, and benchmarked so the scores mean something.
	const available = scores.filter((s) => s.available && s.benchmarked);
	const pick = available[0];
	if (!pick) return undefined;

	const tag = analysis.language.value;
	const name = localLanguageName(tag, getLocale());
	const size = analysis.difficulty.value;
	const target = targetFor(analysis, config);

	// A model scoped to large tasks is no better fit for a smaller one: Medium answering a short question is the
	// choice, not a compromise, so the note never suggests Large 4 for it (CUR-4574).
	const outOfScope = (model: CatalogModel) => model.autoPick === 'large-tasks' && size !== 'L';
	const top = scores.find((s) => s.benchmarked && !outOfScope(s.model)) ?? pick;
	const ideal = top.model.id !== pick.model.id && top.total > pick.total ? top.model : undefined;
	const busy = scores.find((s) => s.busy && !s.available && s.benchmarked && s.total > pick.total)?.model;
	// Served but not Auto's to choose: the picker offers it, so the person can pick it themselves.
	const idealPickable =
		!!ideal?.gatewayId &&
		ideal.status === 'live' &&
		servedIds.some((id) => servedKey(id) === servedKey(ideal.gatewayId!));

	const shown = shownLanguage(analysis, config);
	let gap: LanguageGap | undefined;
	if (shown !== 'und') {
		const bestAvailable = Math.max(...available.map((s) => s.language));
		if (bestAvailable < config.weakSupport) {
			const benchmarked = scores.filter((s) => s.benchmarked);
			gap = { tag, name, bestAvailable, bestAnywhere: Math.max(...benchmarked.map((s) => s.language)) };
		}
	}

	// Another model of the pick's family in the picker, Auto's to choose or not: Large 3 and Large 4 sit beside
	// Medium on every site, so "Mistral answers" would not say which of the three did (CUR-4354, CUR-392).
	const familyShared = catalog.some(
		(m) =>
			m.id !== pick.model.id &&
			m.family === pick.model.family &&
			m.status === 'live' &&
			m.offered !== false &&
			!!m.gatewayId &&
			servedIds.some((id) => servedKey(id) === servedKey(m.gatewayId!))
	);

	const runnerUp = available[1];
	const keptForContinuity = pick.continuity > 0 && !!runnerUp && pick.total - pick.continuity < runnerUp.total;

	const reasons = shown === 'und' ? [DIFFICULTY_LABEL[size]] : [name, DIFFICULTY_LABEL[size]];
	return {
		model: pick.model,
		ideal,
		busy,
		reasons,
		explanation: keptForContinuity
			? m.routing_keptForContinuity({ family: pick.model.family })
			: explain(analysis, shown, pick, available, target, ideal, gap, busy, idealPickable, familyShared),
		scores,
		target,
		languageWeight: round(shares.language ?? 0),
		shares,
		gap,
		keptForContinuity
	};
}

// Each sentence is whole per task size, so a language can agree its words with "task" in its own way.
const LEAD: Record<Difficulty, () => string> = { S: m.routing_leadS, M: m.routing_leadM, L: m.routing_leadL };
const LEAD_LANGUAGE: Record<Difficulty, (p: { language: string }) => string> = {
	S: m.routing_leadLanguageS,
	M: m.routing_leadLanguageM,
	L: m.routing_leadLanguageL
};
const ENOUGH_REASONING: Record<Difficulty, () => string> = {
	S: m.routing_enoughReasoningS,
	M: m.routing_enoughReasoningM,
	L: m.routing_enoughReasoningL
};

function explain(
	analysis: DraftAnalysis,
	tag: string,
	pick: ModelScore,
	available: ModelScore[],
	target: number,
	ideal: CatalogModel | undefined,
	gap: LanguageGap | undefined,
	busy: CatalogModel | undefined,
	idealPickable: boolean,
	familyShared: boolean
): string {
	const name = localLanguageName(tag, getLocale());
	const size = analysis.difficulty.value;
	// With a second model of the same family on offer, the family alone ("Mistral answers") doesn't say
	// which one answered; the reason that follows says which one did (CUR-4354).
	const family = familyShared ? pick.model.name : pick.model.family;

	const lead = tag === 'und' ? LEAD[size]() : LEAD_LANGUAGE[size]({ language: name });

	const strongestAtLanguage = tag !== 'und' && available.every((s) => s.language <= pick.language);
	const meetsTarget = pick.intelligence >= target - 5;
	// "Light" only when there was a heavier option and this one isn't far past what the task needs.
	const light =
		available.some((s) => s.intelligence > pick.intelligence) && pick.intelligence <= target + 10;
	const mostCapable = available.every((s) => s.intelligence <= pick.intelligence);

	const clauses: string[] = [];
	if (strongestAtLanguage && !gap) clauses.push(m.routing_strongestAt({ language: name }));
	if (meetsTarget) {
		clauses.push(size === 'S' && light ? m.routing_quickAndLight() : ENOUGH_REASONING[size]());
	} else if (mostCapable) {
		clauses.push(m.routing_mostCapable());
	}

	// The model's catalog tagline only stands in when there is no reason to give; after one it repeats
	// it ("quick and light … The mid-sized Mistral: quick, …") and reads as a second, disjointed sentence.
	let text: string = clauses.length
		? m.routing_soAnswersBecause({ lead, family, reasons: clauses.join(m.routing_clauseJoin()) })
		: `${m.routing_soAnswers({ lead, family })} ${pick.model.strength}`;
	if (gap) text += ` ${m.routing_gap({ language: name })}`;
	if (busy) text += ` ${m.routing_busy({ model: busy.name })}`;
	// Two models of one family need the model's own name, or the sentence reads "Mistral would suit this
	// even better" under an answer Mistral just gave.
	// A busy ideal already has its sentence: Auto does choose it, just not while it is busy (CUR-4541).
	if (ideal && ideal.id !== busy?.id) {
		const named = ideal.family === pick.model.family ? ideal.name : ideal.family;
		// A model in the picker that Auto doesn't choose (autoPick false) is available to pick by hand, so
		// "isn't available in Alpha yet" would be wrong beside the menu that lists it (CUR-4354).
		text += ` ${idealPickable ? m.routing_idealPickable({ model: ideal.name }) : m.routing_ideal({ family: named })}`;
	}
	return text;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 100) / 100;
