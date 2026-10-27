/**
 * Benchmark data the router ranks models on:
 *
 *   - intelligence     0–100, the Artificial Analysis Intelligence Index (one composite score; open
 *                      models sit far below 100 — the strongest in the catalog is in the thirties);
 *   - language support 0–1 per language tag, the probability the model answers well in it;
 *   - skills           optional, 0–1 per skill (`code`, `math`, …). Any skill a model is scored on
 *                      becomes a criterion Auto weighs on drafts that need that skill (criteria.ts).
 *
 * `data/benchmarks.json` holds the table. While its `status` is `placeholder` the language numbers
 * are hand-set estimates from each model's stated focus, and every surface that shows them says so.
 * Measured language scores live apart, in `data/language-scores.json` (languageScores.ts), and win
 * over these: a language with any measurement never falls back to an estimate. The routing lab
 * (Settings → Model routing) edits a copy of this table per device to try numbers out.
 */
import raw from './data/benchmarks.json';
import { SKILL_LABEL, type SkillId } from './classifier';
import { parentLanguage } from './languages';
import { SHIPPED_LANGUAGE_SCORES, measuredScore, neutralSupport, type LanguageScores, type MeasuredScore } from './languageScores';

export interface ModelBenchmark {
	/** 0–100. */
	intelligence: number;
	/** 0–1: support for a language the table has no row for. */
	defaultSupport: number;
	/** Language tag → 0–1. */
	languages: Record<string, number>;
	/** Skill → 0–1, from a benchmark of that skill. Optional; a model without one gets the median. */
	skills?: Partial<Record<SkillId, number>>;
	/** How each number was found. The shipped table carries it on every row; a lab table may omit it. */
	basis?: RowBasis;
	/** Where the numbers came from: every page a number was read from, with the date it was read. */
	sources?: BenchmarkSource[];
}

/**
 * - `measured`   this model's own published score;
 * - `base-model` the published score of the model it was fine-tuned from;
 * - `copied`     another catalog model's row, until this one is rated;
 * - `estimate`   hand-set, informed by the cited sources but not read off one.
 */
type ScoreBasis = 'measured' | 'base-model' | 'copied' | 'estimate';
const SCORE_BASES: readonly ScoreBasis[] = ['measured', 'base-model', 'copied', 'estimate'];

interface RowBasis {
	intelligence: ScoreBasis;
	/** One basis for every language number, or one per language tag. */
	languages: ScoreBasis | Record<string, ScoreBasis>;
}

interface BenchmarkSource {
	url: string;
	/** What was read there: "Artificial Analysis Intelligence Index v4.3.2, Mistral Large 3 page". */
	title: string;
	/** YYYY-MM-DD the page was read. */
	read: string;
	covers: 'intelligence' | 'languages' | 'both';
}

export interface BenchmarkTable {
	version: 1;
	status: 'placeholder' | 'measured';
	/** Where the numbers come from, in a sentence. */
	source?: string;
	/** ISO date. */
	updated?: string;
	/** Catalog id → scores. */
	models: Record<string, ModelBenchmark>;
}

/**
 * How a support number was found:
 *   - `measured`  this model, this language, on a benchmark (rescaled above chance);
 *   - `neutral`   not measured, while other models were: the lowest of theirs, so a missing test
 *                 neither pushes the model away nor lifts it past a tested one;
 *   - `exact`     the hand-set estimate for the language, used only where nobody was measured;
 *   - `parent`    a variety borrowing its parent language's number (measured or estimated), discounted;
 *   - `default`   the model's estimate for languages without a row;
 *   - `unbenchmarked` no row in the table at all.
 */
export type SupportVia = 'measured' | 'neutral' | 'exact' | 'parent' | 'default' | 'unbenchmarked';

export interface Support {
	value: number;
	via: SupportVia;
	/** The benchmark result behind a `measured` (or measured `parent`) number. */
	measured?: MeasuredScore;
}

/** A variety inherits its parent's support at this discount when it has no row of its own. */
export const PARENT_DISCOUNT = 0.9;
/** Scores for a catalog model with no row at all: low, and flagged as such. */
export const UNBENCHMARKED: ModelBenchmark = { intelligence: 3, defaultSupport: 0.3, languages: {} };

export function languageSupport(
	table: BenchmarkTable,
	modelId: string,
	tag: string,
	scores: LanguageScores = SHIPPED_LANGUAGE_SCORES
): Support {
	const measured = measuredScore(scores, modelId, tag);
	if (measured) return { value: measured.value, via: 'measured', measured };
	const parentTag = parentLanguage(tag);
	const parentMeasured = parentTag ? measuredScore(scores, modelId, parentTag) : undefined;
	if (parentMeasured) {
		return { value: round(parentMeasured.value * PARENT_DISCOUNT), via: 'parent', measured: parentMeasured };
	}
	const neutral = neutralSupport(scores, tag);
	if (neutral !== undefined) return { value: neutral, via: 'neutral' };

	const row = table.models[modelId];
	if (!row) return { value: UNBENCHMARKED.defaultSupport, via: 'unbenchmarked' };
	if (tag in row.languages) return { value: row.languages[tag], via: 'exact' };
	const parent = parentLanguage(tag);
	if (parent && parent in row.languages) {
		return { value: round(row.languages[parent] * PARENT_DISCOUNT), via: 'parent' };
	}
	return { value: row.defaultSupport, via: 'default' };
}

export function intelligenceOf(table: BenchmarkTable, modelId: string): number {
	return table.models[modelId]?.intelligence ?? UNBENCHMARKED.intelligence;
}

/** Skills at least one model in the table is scored on, in SKILL_LABEL order. */
export function benchmarkedSkills(table: BenchmarkTable): SkillId[] {
	const scored = new Set(Object.values(table.models).flatMap((m) => Object.keys(m.skills ?? {})));
	return (Object.keys(SKILL_LABEL) as SkillId[]).filter((s) => scored.has(s));
}

/**
 * A model's 0–1 score on a skill benchmark. A model the benchmark didn't cover gets the median of
 * those it did, so a missing test neither pushes the model away nor favours it.
 */
export function skillScoreOf(table: BenchmarkTable, modelId: string, skill: SkillId): number {
	const own = table.models[modelId]?.skills?.[skill];
	if (own !== undefined) return own;
	const others = Object.values(table.models)
		.map((m) => m.skills?.[skill])
		.filter((v): v is number => v !== undefined)
		.sort((a, b) => a - b);
	if (!others.length) return 0;
	const mid = others.length >> 1;
	return round(others.length % 2 ? others[mid] : (others[mid - 1] + others[mid]) / 2);
}

/** Every language tag any model has a row for, sorted — the routing lab's language list. */
export function benchmarkedLanguages(table: BenchmarkTable): string[] {
	const all = new Set<string>();
	for (const row of Object.values(table.models)) for (const tag of Object.keys(row.languages)) all.add(tag);
	return [...all].sort();
}

const isUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Validate anything claiming to be a benchmark table (a pasted JSON file, localStorage). Throws an
 * Error naming the first bad field, so the lab can show it; never returns a half-valid table.
 */
export function parseBenchmarkTable(input: unknown): BenchmarkTable {
	const fail = (msg: string): never => {
		throw new Error(msg);
	};
	if (!input || typeof input !== 'object') fail('Expected a JSON object.');
	const t = input as Record<string, unknown>;
	if (t.version !== 1) fail('`version` must be 1.');
	if (t.status !== 'placeholder' && t.status !== 'measured') fail('`status` must be "placeholder" or "measured".');
	if (!t.models || typeof t.models !== 'object') fail('`models` must be an object keyed by catalog id.');
	const models: Record<string, ModelBenchmark> = {};
	for (const [id, value] of Object.entries(t.models as Record<string, unknown>)) {
		const m = value as Record<string, unknown>;
		if (!m || typeof m !== 'object') fail(`models.${id} must be an object.`);
		const intelligence = m.intelligence;
		if (typeof intelligence !== 'number' || !(intelligence >= 0 && intelligence <= 100)) {
			fail(`models.${id}.intelligence must be a number from 0 to 100.`);
		}
		if (!isUnit(m.defaultSupport)) fail(`models.${id}.defaultSupport must be a number from 0 to 1.`);
		const languages: Record<string, number> = {};
		for (const [tag, v] of Object.entries((m.languages ?? {}) as Record<string, unknown>)) {
			if (!isUnit(v)) fail(`models.${id}.languages.${tag} must be a number from 0 to 1.`);
			languages[tag] = v as number;
		}
		const skills: Partial<Record<SkillId, number>> = {};
		for (const [skill, v] of Object.entries((m.skills ?? {}) as Record<string, unknown>)) {
			if (!(skill in SKILL_LABEL)) fail(`models.${id}.skills.${skill} is not a known skill (${Object.keys(SKILL_LABEL).join(', ')}).`);
			if (!isUnit(v)) fail(`models.${id}.skills.${skill} must be a number from 0 to 1.`);
			skills[skill as SkillId] = v as number;
		}
		const basis = m.basis === undefined ? undefined : parseBasis(m.basis, `models.${id}.basis`, fail);
		const sources = m.sources === undefined ? undefined : parseSources(m.sources, `models.${id}.sources`, fail);
		models[id] = {
			intelligence: intelligence as number,
			defaultSupport: m.defaultSupport as number,
			languages,
			...(Object.keys(skills).length ? { skills } : {}),
			...(basis ? { basis } : {}),
			...(sources ? { sources } : {})
		};
	}
	return {
		version: 1,
		status: t.status as BenchmarkTable['status'],
		source: typeof t.source === 'string' ? t.source : undefined,
		updated: typeof t.updated === 'string' ? t.updated : undefined,
		models
	};
}

const isBasis = (v: unknown): v is ScoreBasis => SCORE_BASES.includes(v as ScoreBasis);

function parseBasis(input: unknown, at: string, fail: (msg: string) => never): RowBasis {
	const b = input as Record<string, unknown>;
	if (!b || typeof b !== 'object') fail(`${at} must be an object.`);
	if (!isBasis(b.intelligence)) fail(`${at}.intelligence must be one of ${SCORE_BASES.join(', ')}.`);
	let languages: RowBasis['languages'];
	if (isBasis(b.languages)) languages = b.languages;
	else if (b.languages && typeof b.languages === 'object') {
		languages = {};
		for (const [tag, v] of Object.entries(b.languages as Record<string, unknown>)) {
			if (!isBasis(v)) fail(`${at}.languages.${tag} must be one of ${SCORE_BASES.join(', ')}.`);
			languages[tag] = v as ScoreBasis;
		}
	} else languages = fail(`${at}.languages must be one of ${SCORE_BASES.join(', ')}, or one per language tag.`);
	return { intelligence: b.intelligence as ScoreBasis, languages };
}

function parseSources(input: unknown, at: string, fail: (msg: string) => never): BenchmarkSource[] {
	if (!Array.isArray(input)) fail(`${at} must be a list.`);
	return (input as unknown[]).map((value, i) => {
		const s = value as Record<string, unknown>;
		if (!s || typeof s !== 'object') fail(`${at}[${i}] must be an object.`);
		if (typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) fail(`${at}[${i}].url must be an https URL.`);
		if (typeof s.title !== 'string' || !s.title) fail(`${at}[${i}].title must say what was read there.`);
		if (typeof s.read !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.read)) fail(`${at}[${i}].read must be a YYYY-MM-DD date.`);
		if (s.covers !== 'intelligence' && s.covers !== 'languages' && s.covers !== 'both') {
			fail(`${at}[${i}].covers must be intelligence, languages or both.`);
		}
		return { url: s.url as string, title: s.title as string, read: s.read as string, covers: s.covers as BenchmarkSource['covers'] };
	});
}

/** The table shipped with the app. Parsed once at load, so a malformed file fails loudly in tests. */
export const SHIPPED_BENCHMARKS: BenchmarkTable = parseBenchmarkTable(raw);

const round = (n: number) => Math.round(n * 100) / 100;
