/**
 * Benchmark run rows → the app's language scores. A run row is what belebele_gen.py writes (one JSON
 * line per model × language × benchmark version), whoever ran it: CIP or the team. This keeps the
 * app's layer small — a raw score per model and language, plus one entry per benchmark run — and
 * leaves everything else about the run in the row files.
 *
 * Pure, so `scripts/import-language-scores.ts` is only file I/O around it and the rules are tested.
 */
import { catalog, catalogByGatewayId } from './catalog';
import type { LanguageBenchmark, LanguageScores } from './languageScores';

/** The fields of a belebele_gen.py result row the import reads. Extra fields are ignored. */
export interface RunRow {
	benchmark: string;
	benchmarkVersion: string;
	datasetUrl?: string;
	/** Belebele config name: `vie_Latn`. */
	language: string;
	/** The model id as the router lists it. */
	modelId: string;
	promptCondition: string;
	questionsExpected: number;
	questionsScored: number;
	accuracy: number | null;
	status: 'complete' | 'incomplete';
	finishedAt: string;
}

/**
 * Belebele config → Alpha's language tag, for the 26 launch languages (languages.json in the
 * evaluation data). Mandarin is `cmn` in Alpha, as its language detector reports it. Other scripts
 * of the same language (`hin_Latn`) are a different measurement and stay out until added here.
 */
export const BELEBELE_TO_TAG: Record<string, string> = {
	eng_Latn: 'eng',
	spa_Latn: 'spa',
	por_Latn: 'por',
	fra_Latn: 'fra',
	deu_Latn: 'deu',
	ita_Latn: 'ita',
	cat_Latn: 'cat',
	eus_Latn: 'eus',
	pol_Latn: 'pol',
	ukr_Cyrl: 'ukr',
	ell_Grek: 'ell',
	ron_Latn: 'ron',
	arb_Arab: 'arb',
	hin_Deva: 'hin',
	ben_Beng: 'ben',
	urd_Arab: 'urd',
	tam_Taml: 'tam',
	ind_Latn: 'ind',
	vie_Latn: 'vie',
	tgl_Latn: 'tgl',
	zho_Hans: 'cmn',
	pbt_Arab: 'pbt',
	swh_Latn: 'swh',
	amh_Ethi: 'amh',
	yor_Latn: 'yor',
	hau_Latn: 'hau'
};

/** What the app says about each benchmark it knows. A new benchmark gets its entry here first. */
export const KNOWN_BENCHMARKS: Record<string, Pick<LanguageBenchmark, 'name' | 'chance' | 'url' | 'measures' | 'doesNotMeasure'> & { codes: Record<string, string> }> = {
	belebele: {
		name: 'Belebele',
		chance: 0.25,
		url: 'https://huggingface.co/datasets/facebook/belebele',
		measures:
			'Belebele checks whether a model understands a short text in this language well enough to answer multiple-choice questions about it.',
		doesNotMeasure:
			'It doesn’t measure how well the model writes in the language, whether it gets everyday tasks right, or whether its answers are culturally appropriate or safe, which is why we also ask people who speak the language to rate answers.',
		codes: BELEBELE_TO_TAG
	}
};

export interface ImportResult {
	/** Benchmark id → its entry and its scores, ready to merge into the scores file. */
	runs: Record<string, { benchmark: LanguageBenchmark; scores: Record<string, Record<string, number>> }>;
	/** Rows left out, each with why. */
	skipped: string[];
	/** Catalog models that got scores but have no row in the routing table, so Auto can't pick them yet. */
	notRouted: string[];
}

export interface ImportOptions {
	/** Which prompt condition to import when the rows hold more than one (`bare` or `persona`). */
	prompt?: string;
	/** Catalog ids that have a routing-table row (benchmarks.json). */
	routedModels?: string[];
}

export class ImportError extends Error {}

export function importRuns(rows: RunRow[], opts: ImportOptions = {}): ImportResult {
	const skipped: string[] = [];
	const conditions = new Set(rows.map((r) => r.promptCondition));
	if (conditions.size > 1 && !opts.prompt) {
		throw new ImportError(
			`the rows mix prompt conditions (${[...conditions].join(', ')}); pass --prompt with the one Alpha should show`
		);
	}
	const prompt = opts.prompt ?? [...conditions][0];

	type Kept = { row: RunRow; tag: string; model: string; key: string };
	const latest = new Map<string, Kept>();
	for (const row of rows) {
		const where = `${row.modelId} ${row.language} (${row.benchmark} ${row.benchmarkVersion})`;
		if (row.promptCondition !== prompt) continue;
		if (row.status !== 'complete' || row.accuracy === null || row.questionsScored < row.questionsExpected) {
			skipped.push(`${where}: incomplete run (${row.questionsScored}/${row.questionsExpected} questions)`);
			continue;
		}
		const known = KNOWN_BENCHMARKS[row.benchmark];
		if (!known) throw new ImportError(`${where}: unknown benchmark "${row.benchmark}"; add it to KNOWN_BENCHMARKS first`);
		const tag = known.codes[row.language];
		if (!tag) {
			throw new ImportError(`${where}: no Alpha language tag for "${row.language}"; add it to BELEBELE_TO_TAG if it should count`);
		}
		const model = catalogByGatewayId(row.modelId)?.id ?? catalog.find((m) => m.id === row.modelId)?.id;
		if (!model) throw new ImportError(`${where}: "${row.modelId}" matches no catalog model's gatewayId`);
		if (!(row.accuracy >= 0 && row.accuracy <= 1)) throw new ImportError(`${where}: accuracy must be 0–1`);

		const key = `${row.benchmark}@${row.benchmarkVersion}|${model}|${tag}`;
		const prev = latest.get(key);
		if (prev && prev.row.finishedAt >= row.finishedAt) {
			skipped.push(`${where}: an earlier run of a pair measured again later`);
			continue;
		}
		if (prev) skipped.push(`${prev.row.modelId} ${prev.row.language}: an earlier run of a pair measured again later`);
		latest.set(key, { row, tag, model, key });
	}

	const runs: ImportResult['runs'] = {};
	const byRun = new Map<string, Kept[]>();
	for (const kept of latest.values()) {
		const run = `${kept.row.benchmark}@${kept.row.benchmarkVersion}`;
		byRun.set(run, [...(byRun.get(run) ?? []), kept]);
	}
	for (const kept of byRun.values()) {
		const first = kept[0].row;
		const known = KNOWN_BENCHMARKS[first.benchmark];
		const ran = kept.map((k) => k.row.finishedAt.slice(0, 10)).sort().at(-1)!;
		const id = `${first.benchmark}-${ran}`;
		const scores: Record<string, Record<string, number>> = {};
		for (const k of kept) (scores[k.model] ??= {})[k.tag] = Math.round(k.row.accuracy! * 1000) / 1000;
		runs[id] = {
			benchmark: {
				name: known.name,
				version: first.benchmarkVersion,
				ran,
				questions: Math.max(...kept.map((k) => k.row.questionsExpected)),
				chance: known.chance,
				url: first.datasetUrl || known.url,
				measures: known.measures,
				doesNotMeasure: known.doesNotMeasure
			},
			scores
		};
	}

	const routed = new Set(opts.routedModels ?? []);
	const notRouted = opts.routedModels
		? [...new Set([...latest.values()].map((k) => k.model))].filter((m) => !routed.has(m))
		: [];
	return { runs, skipped, notRouted };
}

/**
 * Merge imported runs into a scores file. A run with the same id replaces the old one wholesale, and
 * a pair measured again on the same benchmark drops out of its older run, so a re-run supersedes
 * rather than averages with the result it replaces. A run left with no scores goes too.
 */
export function mergeRuns(current: LanguageScores, result: ImportResult): LanguageScores {
	const next: LanguageScores = structuredClone(current);
	for (const [id, run] of Object.entries(result.runs)) {
		for (const [oldId, old] of Object.entries(next.benchmarks)) {
			if (oldId === id || old.name !== run.benchmark.name) continue;
			for (const [model, byTag] of Object.entries(run.scores)) {
				for (const tag of Object.keys(byTag)) delete next.scores[oldId]?.[model]?.[tag];
				if (next.scores[oldId]?.[model] && !Object.keys(next.scores[oldId][model]).length) delete next.scores[oldId][model];
			}
			if (!Object.keys(next.scores[oldId] ?? {}).length) {
				delete next.scores[oldId];
				delete next.benchmarks[oldId];
			}
		}
		next.benchmarks[id] = run.benchmark;
		next.scores[id] = run.scores;
	}
	return next;
}
