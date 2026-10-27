import { describe, expect, it } from 'vitest';
import { MODEL_HOSTS, catalog, catalogByGatewayId, orgs } from './catalog';
import { HF_PROVIDER_PIN } from '../server/hfProviderPin';
import { detectLanguage, detectSkills, estimateDifficulty, heuristicClassify } from './heuristic';
import type { DraftAnalysis, Difficulty } from './classifier';
import { languageName, parentLanguage } from './languages';
import { SHIPPED_BENCHMARKS, languageSupport, parseBenchmarkTable, type BenchmarkTable } from './benchmarks';
import { localClassifier } from './localClassifier';
import { DEFAULT_ROUTING, intelligenceFit, route, scoreModels, shownLanguage } from './router';
import { AUTO, pickerChoice } from './choice';
import { PICKER, pickerSites } from '../../../../config/picker';

const ALL_LIVE = catalog.filter((m) => m.status === 'live').map((m) => m.gatewayId!);
const APERTUS_ONLY = ['swiss-ai/apertus-v1.5-70b'];
/** No measured scores, so routing runs on the hand-set estimates in the benchmark table alone. */
const NO_SCORES = { version: 1 as const, benchmarks: {}, scores: {} };
/** Everything live except GLM-5.2. */
const PROD_SHAPED = ALL_LIVE.filter((id) => id !== 'zai-org/GLM-5.2');

/** The hard draft `e2e/scenarios/auto-route-xray.spec.ts` sends (CUR-4574); keep the two in step. */
const HARD_DRAFT =
	'Compare the tradeoffs between event sourcing and a plain relational schema for an invoicing system with about two million invoices a year. Explain why each choice affects auditing, corrections and reporting, evaluate which one a small team should pick, and design a migration from the relational schema if they later need event sourcing. What breaks first? What would you measure? How would you roll it back?';

const analysis = (lang: string, size: Difficulty, conf = 0.9): DraftAnalysis => ({
	language: { value: lang, confidence: conf, alternatives: [], signal: 'words' },
	difficulty: { value: size, confidence: 0.8 },
	skills: [],
	source: 'manual'
});

describe('catalog', () => {
	it('references only known orgs, and every live model has a gateway id', () => {
		for (const m of catalog) {
			expect(orgs[m.maker], m.id).toBeDefined();
			if (m.provider) expect(orgs[m.provider], m.id).toBeDefined();
			if (m.status === 'live') expect(m.gatewayId, m.id).toBeTruthy();
		}
	});

	it('credits every inference provider the product names', () => {
		const providers = new Set(catalog.map((m) => m.provider));
		for (const id of ['infomaniak', 'nextbit', 'ai-singapore', 'plgrid', 'mistral', 'scaleway']) {
			expect(providers, id).toContain(id);
		}
	});

	// CUR-3872. A live model with no host leaves the picker and X-ray with no "where it runs" line.
	it('names a known host for every live model, so none ships without a "where it runs" line', () => {
		for (const m of catalog.filter((m) => m.status === 'live')) {
			expect(MODEL_HOSTS[m.id], m.id).toBeDefined();
			expect(orgs[MODEL_HOSTS[m.id]], m.id).toBeDefined();
		}
	});

	// One answer to "who runs it" (CUR-4587): a model the Hugging Face router pins to one provider takes
	// that provider's org, so re-pinning moves X-ray's line with it, and Apertus 70B names the gateway's
	// one provider for it (CUR-4403).
	it('takes a pinned model\'s host from its Hugging Face provider pin, and names Phoeniqs for Apertus 70B', () => {
		const glm = catalog.find((m) => m.id === 'glm-5.2')!;
		expect(HF_PROVIDER_PIN[glm.gatewayId!.toLowerCase()]).toBe('scaleway');
		expect(MODEL_HOSTS['glm-5.2']).toBe('scaleway');
		expect(MODEL_HOSTS['apertus-70b']).toBe('phoeniqs');
		expect(orgs[MODEL_HOSTS['apertus-70b']].region).toBe('Switzerland');
	});

	it('resolves a served gateway id case-insensitively, and nothing for an unknown one', () => {
		expect(catalogByGatewayId('SWISS-AI/Apertus-v1.5-70b')?.family).toBe('Apertus');
		expect(catalogByGatewayId('someone/else')).toBeUndefined();
		expect(catalogByGatewayId(undefined)).toBeUndefined();
	});

	// CUR-3313. X-ray must not read "Not in Alpha's catalogue yet" for a turn Large 3's backup answered on an event instance.
	it("knows the direct lane's backup, so X-ray can name the model that answered in Large 3's place", () => {
		expect(catalogByGatewayId('mistral-medium-2604')?.name).toBe('Mistral Medium 3.5');
		expect(catalogByGatewayId('mistral-medium-2604')?.provider).toBe('mistral');
	});

	// CUR-3313, again on www: Scaleway serves the same weights under its own name.
	it("names Mistral Medium 3.5 when Scaleway's copy answered under Scaleway's name", () => {
		expect(catalogByGatewayId('mistral-medium-3.5-128b')?.name).toBe('Mistral Medium 3.5');
		expect(catalogByGatewayId('mistralai/Mistral-Medium-3.5-128B')?.name).toBe('Mistral Medium 3.5');
		expect(catalogByGatewayId('mistral-medium-3.5-999b')).toBeUndefined();
	});
});

describe('language tags', () => {
	it('names low-resource languages and varieties that Intl leaves as bare codes', () => {
		expect(languageName('quz')).toBe('Quechua');
		expect(languageName('yua')).toBe('Yucatec Maya');
		expect(languageName('cat-valencia')).toBe('Valencian');
		expect(languageName('gsw')).toBe('Swiss German');
		expect(languageName('deu')).toBe('German');
	});

	it('knows each variety’s parent, and that a plain language has none', () => {
		expect(parentLanguage('cat-valencia')).toBe('cat');
		expect(parentLanguage('gsw')).toBe('deu');
		expect(parentLanguage('quy')).toBe('quz');
		expect(parentLanguage('eng')).toBeUndefined();
	});
});

describe('heuristic classifier', () => {
	it.each([
		['What is the capital of Switzerland and why?', 'eng'],
		['¿Cómo puedo aprender a programar en Python?', 'spa'],
		['Què és el millor per aprendre amb els nens?', 'cat'],
		['Wie kann ich das nicht einfach ändern?', 'deu'],
		['Comment est-ce que je peux faire une tarte pour vous?', 'fra'],
		['Czy możesz mi pomóc z tym? Nie jest to łatwe.', 'pol'],
		['Bagaimana cara saya membuat nasi goreng yang enak dan tidak berminyak?', 'ind'],
		['สวัสดีครับ วันนี้อากาศเป็นอย่างไร', 'tha'],
		['東京で一番おいしいラーメンはどこですか', 'jpn'],
		['请解释一下量子计算', 'cmn']
	])('detects %s as %s', (text, lang) => {
		expect(detectLanguage(text).value).toBe(lang);
	});

	it.each([
		['Grüezi mitenand, chasch mer säge wie ich zum Bahnhof chum?', 'gsw'],
		['Hui volem eixir amb els xiquets, què podem fer?', 'cat-valencia'],
		['Oi, você pode me ajudar a escolher um celular pra minha mãe?', 'por-BR'],
		['Che, vos sabés cómo llegar al centro? Tenés tiempo?', 'spa-AR'],
		['你今日食咗飯未？我哋去邊度好？', 'yue']
	])('reports the variety, not just the language: %s → %s', (text, tag) => {
		const d = detectLanguage(text);
		expect(d.value).toBe(tag);
		expect(d.signal).toBe('dialect');
		expect(d.alternatives[0].value).toBe(parentLanguage(tag));
	});

	it('says "und" with zero confidence (not a guess) for text too short to tell', () => {
		expect(detectLanguage('ok')).toMatchObject({ value: 'und', confidence: 0 });
	});

	it('keeps every confidence inside [0, 1]', () => {
		for (const t of ['a', 'the the the the the the', 'hola', 'explain '.repeat(100)]) {
			const d = heuristicClassify(t);
			for (const c of [d.language.confidence, d.difficulty.confidence, ...d.skills.map((s) => s.confidence)]) {
				expect(c).toBeGreaterThanOrEqual(0);
				expect(c).toBeLessThanOrEqual(1);
			}
		}
	});

	it('sizes tasks S/M/L: greetings are small, analysis and code are large, everyday asks are medium', () => {
		expect(estimateDifficulty('hi there').value).toBe('S');
		expect(
			estimateDifficulty('Can you compare the trade-offs between renting and buying a home in Zurich for a young family?').value
		).toBe('L');
		expect(estimateDifficulty('```js\nconst a = 1;\n```\nwhy does this fail').value).toBe('L');
		expect(estimateDifficulty('Suggest a good name for my new bakery in the old town').value).toBe('M');
	});

	it('surfaces web search for a recent-events ask, code for code, and nothing for small talk', () => {
		const skills = (t: string) => detectSkills(t, estimateDifficulty(t)).map((s) => s.id);
		expect(skills('What is the latest news on the Swiss election results today?')).toContain('web-search');
		expect(skills('```py\nprint(1)\n```\nwhy does this fail')).toContain('code');
		expect(skills('What is 17 * 23?')).toContain('math');
		expect(skills('Translate "good morning" into Catalan')).toContain('translation');
		expect(skills('hello there')).toEqual([]);
	});
});

describe('local classifier (franc + the low-resource detector)', () => {
	it.each([
		// A Quechua sentence the word lists alone miss (CUR-1841).
		['Allinllachu? Imaynatam kashanki, yanapawankiman?', 'quz'],
		['Mikä on Suomen pääkaupunki ja miksi se on juuri siellä, eikä jossain muualla?', 'fin'],
		['Habari yako rafiki? Naomba msaada kuhusu jinsi ya kupika chakula cha jioni kwa familia yangu.', 'swh']
	])('detects %s as %s', async (text, lang) => {
		expect((await localClassifier(text)).language.value).toBe(lang);
	});

	it('keeps the function-word answer on short text where franc guesses a rare language', async () => {
		// franc alone ranks Wolof first for this Portuguese sentence.
		const a = await localClassifier('Olá, você pode me ajudar com meu currículo?');
		expect(['por', 'por-BR']).toContain(a.language.value);
	});

	it('names no language for a short draft it only guessed at (Welsh has no profile and reads as Lithuanian)', async () => {
		const a = await localClassifier('Beth yw prifddinas Cymru a pham?');
		expect(a.language.confidence).toBeLessThan(DEFAULT_ROUTING.gapConfidence);
		expect(shownLanguage(a)).toBe('und');
		const choice = route(a, ALL_LIVE)!;
		expect(choice.explanation).not.toMatch(/writing in/);
		expect(choice.explanation).not.toMatch(new RegExp(languageName(a.language.value)));
		expect(choice.reasons).toEqual([expect.stringMatching(/task/i)]);
		expect(choice.gap).toBeUndefined();
	});

	it('still names a language it is confident about', async () => {
		const a = await localClassifier('¿Cuál es la capital de Francia y por qué es tan importante para Europa?');
		expect(shownLanguage(a)).not.toBe('und');
		expect(route(a, ALL_LIVE)!.explanation).toMatch(/writing in Spanish/);
	});

	it('reports what it measured and that it ran locally', async () => {
		const a = await localClassifier('Wie kann ich zu Hause Energie sparen?');
		expect(a.source).toBe('local');
		expect(a.elapsedMs).toBeGreaterThanOrEqual(0);
	});
});

describe('benchmarks', () => {
	it('the shipped table parses, and says it is placeholder data until measured numbers replace it', () => {
		expect(SHIPPED_BENCHMARKS.status).toBe('placeholder');
	});

	// A catalog model may have no row (it is then a manual pick only, see the router); a row for an id
	// the catalog lacks is a typo or a retired model, and would sit there scoring nothing.
	it('has rows only for catalog models', () => {
		const ids = new Set(catalog.map((m) => m.id));
		for (const id of Object.keys(SHIPPED_BENCHMARKS.models)) expect(ids, id).toContain(id);
	});

	// Each row says whether a number is an estimate or a measurement. (CUR-4294)
	it('every shipped row says how each number was found and cites a dated source for it (a row with no source fails)', () => {
		for (const [id, row] of Object.entries(SHIPPED_BENCHMARKS.models)) {
			expect(row.basis, `${id}.basis`).toBeDefined();
			expect(row.sources?.length ?? 0, `${id}.sources`).toBeGreaterThan(0);
			const covered = new Set(row.sources!.flatMap((s) => (s.covers === 'both' ? ['intelligence', 'languages'] : [s.covers])));
			if (row.basis!.intelligence !== 'estimate') expect(covered, `${id}: a source for intelligence`).toContain('intelligence');
			const langBases = typeof row.basis!.languages === 'string' ? [row.basis!.languages] : Object.values(row.basis!.languages);
			if (langBases.some((b) => b !== 'estimate')) expect(covered, `${id}: a source for languages`).toContain('languages');
		}
	});

	it('keeps a row’s basis and sources through parsing, and refuses an unknown basis or an undated source', () => {
		const row = {
			intelligence: 30,
			defaultSupport: 0.3,
			languages: { eng: 0.9 },
			basis: { intelligence: 'measured', languages: { eng: 'estimate' } },
			sources: [{ url: 'https://example.org/a', title: 'Index page', read: '2026-10-20', covers: 'intelligence' }]
		};
		const parsed = parseBenchmarkTable({ version: 1, status: 'placeholder', models: { x: row } });
		expect(parsed.models.x.basis).toEqual(row.basis);
		expect(parsed.models.x.sources).toEqual(row.sources);
		expect(() => parseBenchmarkTable({ version: 1, status: 'placeholder', models: { x: { ...row, basis: { intelligence: 'guess', languages: 'estimate' } } } })).toThrow(
			/models\.x\.basis\.intelligence/
		);
		expect(() =>
			parseBenchmarkTable({ version: 1, status: 'placeholder', models: { x: { ...row, sources: [{ ...row.sources[0], read: 'Sept' }] } } })
		).toThrow(/models\.x\.sources\[0\]\.read/);
	});

	it('rejects an out-of-range score, naming the field (never accepts a half-valid table)', () => {
		const bad = { version: 1, status: 'measured', models: { x: { intelligence: 50, defaultSupport: 0.3, languages: { eng: 1.4 } } } };
		expect(() => parseBenchmarkTable(bad)).toThrow(/models\.x\.languages\.eng/);
		expect(() => parseBenchmarkTable({ version: 2, status: 'measured', models: {} })).toThrow(/version/);
	});

	it('a variety with no row inherits its parent’s support at a discount, then falls back to the default', () => {
		expect(languageSupport(SHIPPED_BENCHMARKS, 'bielik-11b', 'pol', NO_SCORES).via).toBe('exact');
		const gsw = languageSupport(SHIPPED_BENCHMARKS, 'mistral-large', 'gsw', NO_SCORES);
		expect(gsw.via).toBe('parent');
		expect(gsw.value).toBeLessThan(SHIPPED_BENCHMARKS.models['mistral-large'].languages.deu);
		expect(languageSupport(SHIPPED_BENCHMARKS, 'bielik-11b', 'tha', NO_SCORES)).toEqual({ value: 0.15, via: 'default' });
	});
});

describe('router', () => {
	// CUR-392. Catalan is measured for other models and not for ALIA, so ALIA is held to the lowest
	// measured Catalan score, and its hand-set estimate does not count.
	it('sends a confident Catalan message to Medium, not ALIA, while ALIA is unmeasured in Catalan', () => {
		const withAlia = [...PICKER.production];
		expect(withAlia).toContain('BSC-LT/ALIA-40b-instruct');
		expect(route(analysis('cat', 'M'), withAlia)?.model.id).toBe('mistral-medium');
		expect(route(analysis('cat-valencia', 'M'), withAlia)?.model.id).not.toBe('alia-40b');
	});

	// CUR-392. Bielik's measured Polish (0.90) is barely above Apertus's (0.87), the lowest measured, which
	// unmeasured Medium inherits; Medium's higher intelligence rating then decides.
	it('sends Polish to Medium while Medium is unmeasured in Polish and Bielik leads the measured by little', () => {
		expect(route(analysis('pol', 'M'), [...PICKER.production])?.model.id).toBe('mistral-medium');
		expect(route(analysis('pol', 'M'), [...PICKER.production], { languageScores: NO_SCORES })?.model.id).toBe('bielik-11b');
	});

	// CUR-4035. Medium is open to Auto and Large 3 does not score a full intelligence mark on every draft,
	// so Auto does not send nearly every turn to the model with the lowest request budget.
	it('sends small and medium English drafts to Medium and a large one to Large 4 (CUR-4574)', () => {
		expect(route(analysis('eng', 'S'), PROD_SHAPED)?.model.id).toBe('mistral-medium');
		expect(route(analysis('eng', 'M'), PROD_SHAPED)?.model.id).toBe('mistral-medium');
		expect(route(analysis('fra', 'S'), PROD_SHAPED)?.model.id).toBe('mistral-medium');
		expect(route(analysis('eng', 'L'), PROD_SHAPED)?.model.id).toBe('mistral-large-4');
		// GLM 5.2 is stronger still, but Auto picks it for Chinese only (CUR-392).
		expect(route(analysis('eng', 'S'), ALL_LIVE)?.model.id).toBe('mistral-medium');
	});

	// CUR-4283. v4.8 is the only SEA-LION on any picker, and Auto offers it for Indonesian, Thai and
	// Vietnamese drafts rather than sending them to Mistral. Indonesian is measured for Large 4 and not for
	// SEA-LION, so a large Indonesian draft goes to Large 4 (CUR-392).
	it('sends an Indonesian, Malay, Thai, Vietnamese or Tagalog draft to SEA-LION v4.8 on every site, but a large Indonesian one to Large 4', () => {
		for (const site of pickerSites) {
			for (const lang of ['ind', 'zlm', 'tha', 'vie', 'tgl']) {
				for (const size of ['S', 'M', 'L'] as const) {
					expect(route(analysis(lang, size), [...PICKER[site]])?.model.id, `${site} ${lang} ${size}`).toBe(
						lang === 'ind' && size === 'L' ? 'mistral-large-4' : 'sea-lion-nemotron-120b'
					);
				}
			}
		}
	});

	// CUR-4283. v4.8 is rated 13 from its base model, above Medium's 8, so unscoped it took every English
	// draft. It may answer only its own languages, and for any other draft its rating rescales no one.
	it('never auto-routes an English, French, Catalan or Polish draft to SEA-LION v4.8, nor lets its rating move their fit', () => {
		for (const lang of ['eng', 'fra', 'cat', 'pol', 'deu']) {
			for (const size of ['S', 'M', 'L'] as const) {
				expect(route(analysis(lang, size), [...PICKER.production])?.model.id, `${lang} ${size}`).not.toBe(
					'sea-lion-nemotron-120b'
				);
			}
		}
		const v48 = 'aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B';
		const fit = (ids: string[]) =>
			Object.fromEntries(scoreModels(analysis('pol', 'L'), ids).map((s) => [s.model.id, s.intelligenceFit]));
		const without = fit(PICKER.production.filter((id) => id !== v48));
		const withIt = fit([...PICKER.production]);
		expect(PICKER.production).toContain(v48);
		for (const [id, value] of Object.entries(without)) expect(withIt[id], id).toBe(value);
	});

	// CUR-4294, CUR-4574. Large 4 is rated 38, far above every other Auto-eligible model, so unscoped Auto
	// would send it every draft and Medium would stop being the default. Auto gives it the drafts it reads
	// as large and nothing else, and on any other draft its rating must not rescale the others' fit either.
	it('sends Large 4 only a draft read as large, and on any other its rating moves no model’s intelligence fit', () => {
		const withLarge4 = [...ALL_LIVE, 'mistral-large-2610'];
		expect(withLarge4).toContain('mistral-large-2610');
		for (const lang of ['eng', 'fra', 'deu', 'ind', 'arb']) {
			for (const size of ['S', 'M'] as const) {
				expect(route(analysis(lang, size), withLarge4)?.model.id, `${lang} ${size}`).not.toBe('mistral-large-4');
			}
		}
		for (const lang of ['eng', 'fra', 'deu']) {
			expect(route(analysis(lang, 'L'), withLarge4)?.model.id, `${lang} L`).toBe('mistral-large-4');
		}
		const fit = (ids: string[]) =>
			Object.fromEntries(scoreModels(analysis('eng', 'M'), ids).map((s) => [s.model.id, s.intelligenceFit]));
		const without = fit(ALL_LIVE.filter((id) => id !== 'mistral-large-2610'));
		const withIt = fit(withLarge4);
		for (const [id, value] of Object.entries(without)) expect(withIt[id], id).toBe(value);
	});

	// CUR-392. Large 3 is offered by hand only, so while Large 4 is busy a large draft goes to Medium.
	it('sends a large draft to Medium while Large 4 is busy, never to Large 3, and a medium one to Medium either way', () => {
		const busy = { busy: ['mistral-large-2610'] };
		expect(route(analysis('eng', 'L'), PROD_SHAPED, busy)?.model.id).toBe('mistral-medium');
		expect(route(analysis('eng', 'L'), PROD_SHAPED, busy)?.busy?.id).toBe('mistral-large-4');
		expect(route(analysis('eng', 'M'), PROD_SHAPED, busy)?.model.id).toBe('mistral-medium');
	});

	// Large 4 is left out so the case stays about Large 3's request budget. At Large 3's measured 150 a minute
	// (CUR-4574) the cost does not outweigh Large 3's lead on an unsure large draft; it still fades with
	// confidence, so a sure one pays less of it.
	it('Large 3’s capacity cost is higher on an unsure "large" guess than a sure one', () => {
		const noLarge4 = PROD_SHAPED.filter((id) => id !== 'mistral-large-2610');
		const unsure: DraftAnalysis = { ...analysis('eng', 'L'), difficulty: { value: 'L', confidence: 0.5 } };
		const large = scoreModels(unsure, noLarge4).find((s) => s.model.id === 'mistral-large')!;
		const sure = scoreModels(analysis('eng', 'L'), noLarge4).find((s) => s.model.id === 'mistral-large')!;
		expect(large.capacity).toBeGreaterThan(sure.capacity);
	});

	it('charges no capacity cost when the scarce model is the only one with a known budget', () => {
		const pair = ['swiss-ai/apertus-v1.5-70b', 'mistral-medium-2604'];
		const medium = scoreModels(analysis('eng', 'S'), pair).find((s) => s.model.id === 'mistral-medium')!;
		expect(medium.capacity).toBe(0);
		expect(route(analysis('eng', 'S'), pair)?.model.id).toBe('mistral-medium');
	});

	it('never auto-routes to a served model with no benchmark row; it stays available to pick by hand', () => {
		// SEA-LION is served and built for Thai; without its rows Auto cannot judge it.
		const noSeaLion: BenchmarkTable = structuredClone(SHIPPED_BENCHMARKS);
		delete noSeaLion.models['sea-lion-qwen-32b'];
		delete noSeaLion.models['sea-lion-gemma-27b'];
		delete noSeaLion.models['sea-lion-nemotron-120b'];
		const choice = route(analysis('tha', 'L'), ALL_LIVE, { benchmarks: noSeaLion })!;
		expect(choice.model.family).not.toBe('SEA-LION');
		expect(choice.ideal?.family).not.toBe('SEA-LION');
		const seaLion = choice.scores.find((s) => s.model.id === 'sea-lion-qwen-32b')!;
		expect(seaLion).toMatchObject({ available: true, benchmarked: false, languageVia: 'unbenchmarked' });

		// Removing a specialist's row takes it out of Auto even where it would otherwise win.
		const edited: BenchmarkTable = structuredClone(SHIPPED_BENCHMARKS);
		delete edited.models['alia-40b'];
		expect(route(analysis('cat', 'M'), ALL_LIVE, { benchmarks: edited })?.model.id).not.toBe('alia-40b');
	});

	it('returns undefined (caller keeps its default) when only unbenchmarked models are served', () => {
		const noSeaLion: BenchmarkTable = structuredClone(SHIPPED_BENCHMARKS);
		delete noSeaLion.models['sea-lion-qwen-32b'];
		expect(
			route(analysis('tha', 'L'), ['aisingapore/Qwen-SEA-LION-v4-32B-IT'], { benchmarks: noSeaLion })
		).toBeUndefined();
	});

	it('intelligence fit: the strongest available model scores 1, a weaker one less, and nothing is lost above the floor', () => {
		expect(intelligenceFit(9, 0, 9)).toBe(1);
		expect(intelligenceFit(5, 0, 9)).toBeLessThan(intelligenceFit(7, 0, 9));
		expect(intelligenceFit(9, 4, 9)).toBe(1);
		expect(intelligenceFit(3, 4, 9)).toBeLessThan(intelligenceFit(3, 0, 9));
	});

	it('never selects a model the registry does not serve — falls back and says the ideal is unavailable', () => {
		const choice = route(analysis('vie', 'M'), APERTUS_ONLY)!;
		expect(choice.model.gatewayId).toBe('swiss-ai/apertus-v1.5-70b');
		expect(choice.ideal?.id).toBe('sea-lion-nemotron-120b');
		expect(choice.explanation).toMatch(/isn’t available in Alpha yet/);
	});

	it('names the better model itself when it shares a family with the pick, never "Mistral would suit this" under a Mistral answer', () => {
		const choice = route(analysis('eng', 'L'), ['mistral-medium-2604'], { languageScores: NO_SCORES })!;
		expect(choice.model.gatewayId).toBe('mistral-medium-2604');
		expect(choice.ideal, 'a stronger model this site does not serve').toBeDefined();
		expect(choice.ideal!.family).toBe('Mistral');
		expect(choice.explanation).toContain(`${choice.ideal!.name} would suit this even better`);
		expect(choice.explanation).not.toMatch(/(^|\. )Mistral would suit/);
	});

	it('says a better model Auto skips can be picked by hand when the picker offers it, never "isn’t available in Alpha yet"', () => {
		// Large 4 is Auto's own pick on a large draft now (CUR-4574), so the case takes GLM, the one served
		// model Auto never picks, rated a clear step above Medium in English.
		const table: BenchmarkTable = structuredClone(SHIPPED_BENCHMARKS);
		delete table.models['mistral-large-4'];
		table.models['glm-5.2'].languages.eng = 1;
		const choice = route(analysis('eng', 'L'), ['mistral-medium-2604', 'zai-org/GLM-5.2'], {
			benchmarks: table,
			languageScores: NO_SCORES
		})!;
		expect(choice.model.gatewayId, 'GLM 5.2 is hand-pick only, so Auto still answers with Medium').toBe(
			'mistral-medium-2604'
		);
		expect(choice.ideal?.id).toBe('glm-5.2');
		expect(choice.explanation).toContain('GLM 5.2 would suit this even better');
		expect(choice.explanation).toContain('you can pick it yourself');
		expect(choice.explanation).not.toMatch(/isn’t available in Alpha yet/);
	});

	// CUR-4574. The draft auto-route-xray.spec.ts sends: the classifier reads it as large, so Auto picks Large 4,
	// and the e2e run then checks the answer on a real preview.
	it('reads the e2e spec’s hard draft as large and sends it to Large 4', () => {
		const draft = heuristicClassify(HARD_DRAFT);
		expect(draft.difficulty.value).toBe('L');
		expect(route(draft, PROD_SHAPED)?.model.id).toBe('mistral-large-4');
	});

	// CUR-4574. Medium answering a short question is Auto's choice, so the note must not offer Large 4 for it.
	it('never suggests Large 4 for a draft Auto does not read as large', () => {
		for (const size of ['S', 'M'] as const) {
			const choice = route(analysis('eng', size), ['mistral-medium-2604', 'mistral-large-2610'])!;
			expect(choice.model.gatewayId, size).toBe('mistral-medium-2604');
			expect(choice.ideal?.id, size).not.toBe('mistral-large-4');
			expect(choice.explanation, size).not.toContain('Large 4');
		}
	});

	// CUR-4035. A Yucatec draft sent the instant it is typed is read by the heuristic as Tagalog (0.45), and
	// Apertus, with a hand-set Tagalog estimate, would outscore both Mistrals. With Apertus off the picker
	// (WITHDRAWN) that draft goes to a model whose lane is up. That is SEA-LION v4.8, the Tagalog
	// specialist (CUR-4283): the misread itself is the defect, and neither it nor Medium knows Yucatec.
	it('sends a Yucatec draft the heuristic misreads as Tagalog to a model on the develop picker, never to withdrawn Apertus', () => {
		const draft = heuristicClassify("Ba'ax ka wa'alik? In k'áat in ts'íibt juntúul carta ti' u láak' in múuch'kabil.");
		expect(draft.language.value).toBe('tgl');
		const choice = route(draft, [...PICKER.develop])!;
		expect(choice.model.family).not.toBe('Apertus');
		expect(PICKER.develop).toContain(choice.model.gatewayId);
		expect(choice.model.id).toBe('sea-lion-nemotron-120b');
	});

	// CUR-4043. A model answering 429 is still served, so only a busy mark keeps Auto off it.
	it('skips a busy model while another can answer, and names it as the busy better fit', () => {
		const normal = route(analysis('eng', 'S'), PROD_SHAPED)!;
		const busyId = normal.model.gatewayId!;
		const choice = route(analysis('eng', 'S'), PROD_SHAPED, { busy: [busyId] })!;
		expect(choice.model.gatewayId).not.toBe(busyId);
		expect(choice.busy?.gatewayId).toBe(busyId);
		expect(choice.explanation).toMatch(/busy right now/);
		expect(choice.scores.find((s) => s.model.gatewayId === busyId)).toMatchObject({ busy: true, available: false });
	});

	// CUR-4541. The busy model is also the top scorer, so the "Auto doesn't choose it yet" sentence must
	// not follow the busy one and contradict it.
	it('names a busy SEA-LION once, as busy, under a Vietnamese draft, and never says Auto does not choose it', () => {
		const seaLion = 'aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B';
		const choice = route(analysis('vie', 'M'), [...PICKER.develop], { busy: [seaLion] })!;
		expect(choice.model.gatewayId).not.toBe(seaLion);
		expect(choice.busy?.gatewayId).toBe(seaLion);
		expect(choice.explanation).toMatch(/SEA-LION v4\.8 \(Nemotron\) 120B would suit this better, but it’s busy right now\./);
		expect(choice.explanation.match(/SEA-LION/g)).toHaveLength(1);
		expect(choice.explanation).not.toMatch(/doesn’t choose it/);
	});

	it('keeps the normal pick when every served model is busy', () => {
		const normal = route(analysis('arb', 'M'), PROD_SHAPED)!;
		const choice = route(analysis('arb', 'M'), PROD_SHAPED, { busy: PROD_SHAPED })!;
		expect(choice.model.id).toBe(normal.model.id);
		expect(choice.busy).toBeUndefined();
	});

	it('a busy mark on a model nobody serves changes nothing', () => {
		const normal = route(analysis('arb', 'M'), PROD_SHAPED)!;
		expect(route(analysis('arb', 'M'), PROD_SHAPED, { busy: ['someone/else'] })!.model.id).toBe(normal.model.id);
	});

	it('returns undefined (caller keeps its default) when nothing in the catalog is served', () => {
		expect(route(analysis('eng', 'S'), ['someone/else'])).toBeUndefined();
	});

	it('explains in plain words, naming language and task size — not the model id', () => {
		const choice = route(analysis('spa', 'S'), ALL_LIVE)!;
		expect(choice.reasons).toEqual(['Spanish', 'Small task']);
		expect(choice.explanation).toMatch(/Spanish/);
		expect(choice.explanation).not.toMatch(/\//);
	});

	it('reads as whole sentences: no "answers:" fragment, and no catalog tagline after a reason (CUR-4354)', () => {
		for (const [tag, size] of [['eng', 'S'], ['spa', 'S'], ['eng', 'M'], ['eng', 'L']] as const) {
			const choice = route(analysis(tag, size), PROD_SHAPED)!;
			expect(choice.explanation).not.toMatch(/answers:/);
			expect(choice.explanation).not.toContain(choice.model.strength);
			// Every sentence after the first starts with a capital: a fragment glued on after a full stop doesn't.
			for (const s of choice.explanation.split(/(?<=\.) /).slice(1)) expect(s).toMatch(/^[A-Z]/);
		}
		expect(route(analysis('eng', 'S'), PROD_SHAPED)!.explanation).toMatch(/\. [A-Z].*? answers because it’s /);
	});

	it('names the model, not just "Mistral", when another model of its family is on offer (CUR-4354)', () => {
		const choice = route(analysis('eng', 'L'), PROD_SHAPED)!;
		expect(choice.scores.filter((s) => s.available && s.model.family === choice.model.family).length).toBeGreaterThan(1);
		expect(choice.explanation).toContain(`${choice.model.name} answers because`);
	});

	// Large 3 is off Auto (CUR-392), so on a short draft Medium is the only Mistral Auto may choose, while
	// Large 3 and Large 4 still sit in the picker beside it.
	it('names Medium on a short English draft, though it is the only Mistral Auto may choose there, since the picker offers the others (CUR-4354)', () => {
		const choice = route(analysis('eng', 'S'), [...PICKER.production])!;
		expect(choice.model.id).toBe('mistral-medium');
		expect(choice.scores.filter((s) => s.available && s.model.family === 'Mistral')).toHaveLength(1);
		expect(choice.explanation).toContain('Mistral Medium 3.5 answers because');
	});

	it('names only the family when no other model of it is in the picker (CUR-4354)', () => {
		const choice = route(analysis('eng', 'S'), ['mistral-medium-2604', 'swiss-ai/apertus-v1.5-70b'])!;
		expect(choice.model.id).toBe('mistral-medium');
		expect(choice.explanation).toMatch(/\bMistral answers because/);
	});

	// CUR-392. auto-route-xray.spec.ts moves a chat mid-way from Spanish (Medium) to Chinese, now that
	// Catalan stays on Medium; keep the two in step.
	it('moves a chat Medium answered to GLM 5.2 for a short Chinese message on develop', () => {
		const choice = route(analysis('cmn', 'S'), [...PICKER.develop], { stickTo: 'mistral-medium' })!;
		expect(route(analysis('spa', 'S'), [...PICKER.develop])!.model.id).toBe('mistral-medium');
		expect(choice.model.id).toBe('glm-5.2');
		expect(choice.keptForContinuity).toBe(false);
	});

	it('scores every catalog model on both axes, available ones marked, best first', () => {
		const scores = scoreModels(analysis('cat', 'M'), ALL_LIVE);
		expect(scores).toHaveLength(catalog.length);
		expect(scores.map((s) => s.total)).toEqual([...scores.map((s) => s.total)].sort((a, b) => b - a));
		expect(scores.find((s) => s.model.id === 'alia-40b')?.available).toBe(true);
		expect(scoreModels(analysis('cat', 'M'), APERTUS_ONLY).find((s) => s.model.id === 'alia-40b')?.available).toBe(false);
	});

	it('never lets Auto pick a model offered for picking by hand, even served and strongest on the task (CUR-1683)', () => {
		const served = [...APERTUS_ONLY, 'mistral-large-2512'];
		for (const tag of ['cmn', 'eng'] as const) {
			expect(route(analysis(tag, 'L'), served)!.model.id).not.toBe('mistral-large');
		}
		expect(scoreModels(analysis('eng', 'L'), served).find((s) => s.model.id === 'mistral-large')?.available).toBe(false);
	});

	// CUR-392. GLM's measured Chinese (0.92) leads every other Chinese score but SEA-LION's, and SEA-LION
	// is Auto's pick only for Southeast Asian languages.
	it('sends a Chinese draft of every size to GLM 5.2 on www, and no other language', () => {
		for (const size of ['S', 'M', 'L'] as const) {
			expect(route(analysis('cmn', size), [...PICKER.production])?.model.id).toBe('glm-5.2');
			for (const tag of ['eng', 'fra', 'arb', 'vie'] as const) {
				expect(route(analysis(tag, size), [...PICKER.production])?.model.id).not.toBe('glm-5.2');
			}
		}
	});

	it('reports a language gap (the dataset CTA) when a confidently detected language has weak support', () => {
		const choice = route(analysis('quz', 'M', 0.8), ALL_LIVE)!;
		expect(choice.gap).toMatchObject({ tag: 'quz', name: 'Quechua' });
		expect(choice.gap!.bestAvailable).toBeLessThan(DEFAULT_ROUTING.weakSupport);
	});

	it('reports NO gap for an unsure language guess, even when support for it is weak', () => {
		expect(route(analysis('quz', 'M', 0.3), ALL_LIVE)!.gap).toBeUndefined();
	});

	it('reports no gap for a well-supported language', () => {
		expect(route(analysis('eng', 'M'), ALL_LIVE)!.gap).toBeUndefined();
	});

	it('uses an edited benchmark table (the routing lab) instead of the shipped one', () => {
		// Thai is measured for no model, so its hand-set estimates decide.
		const edited: BenchmarkTable = structuredClone(SHIPPED_BENCHMARKS);
		edited.models['sea-lion-nemotron-120b'].languages.tha = 0.1;
		expect(route(analysis('tha', 'M'), [...PICKER.production])?.model.id).toBe('sea-lion-nemotron-120b');
		expect(route(analysis('tha', 'M'), [...PICKER.production], { benchmarks: edited })?.model.id).not.toBe(
			'sea-lion-nemotron-120b'
		);
	});
});

describe('per-turn switching', () => {
	it('keeps the model that answered last when another is only marginally better, and says why', () => {
		// Apertus 70B edges Mistral Medium on a large Amharic question; not by enough to switch mid-chat.
		const pair = ['swiss-ai/apertus-v1.5-70b', 'mistral-medium-2604'];
		expect(route(analysis('amh', 'L'), pair)?.model.id).toBe('apertus-70b');
		const choice = route(analysis('amh', 'L'), pair, { stickTo: 'mistral-medium' })!;
		expect(choice.model.id).toBe('mistral-medium');
		expect(choice.keptForContinuity).toBe(true);
		expect(choice.explanation).toMatch(/answered earlier in this chat/);
	});

	it('moves to another model mid-chat when it is clearly better for this message', () => {
		const choice = route(analysis('vie', 'M'), ALL_LIVE, { stickTo: 'mistral-medium' })!;
		expect(choice.model.id).toBe('sea-lion-nemotron-120b');
		expect(choice.keptForContinuity).toBe(false);
	});

	it('an automatic choice applies only to the draft it judged; a choice the person made applies to any message', async () => {
		const { nextTurnModel, turnModelFor } = await import('./state');
		nextTurnModel.set({ text: 'hola amics', modelId: 'BSC-LT/ALIA-40b-instruct' });
		expect(turnModelFor(' hola amics ')).toBe('BSC-LT/ALIA-40b-instruct');
		expect(turnModelFor('hola amics, què tal?')).toBeUndefined();
		nextTurnModel.set({ modelId: 'speakleash/Bielik-11B-v3.0-Instruct' });
		expect(turnModelFor('anything at all')).toBe('speakleash/Bielik-11B-v3.0-Instruct');
		nextTurnModel.set(null);
		expect(turnModelFor('anything')).toBeUndefined();
	});
});

describe('resolveModel', async () => {
	const { resolveModel } = await import('./choice');

	it('Auto returns a served id in the registry’s own casing', () => {
		const seaLion = 'aisingapore/nemotron-sea-lion-v4.8-120b-a12b';
		const r = resolveModel('auto', 'Bạn có thể tóm tắt những gì cư dân yêu cầu về công viên mới không?', [seaLion, ...APERTUS_ONLY]);
		expect(r.modelId).toBe(seaLion);
		expect(r.analysis?.language.value).toBe('vie');
	});

	it('Auto uses the composer’s finished analysis when given one, rather than re-classifying', () => {
		const r = resolveModel('auto', 'hello', ALL_LIVE, { analysis: analysis('vie', 'M') });
		expect(r.route?.model.id).toBe('sea-lion-nemotron-120b');
	});

	// The caller must not fall back to its default here, or the answer comes from another model. (CUR-4073)
	it('an unserved manual pick never resolves to another model: no id, and the pick named as unavailable', () => {
		const alia = catalog.find((m) => m.id === 'alia-40b')!;
		expect(resolveModel('alia-40b', 'hola', APERTUS_ONLY)).toEqual({ unavailable: alia.name });
		expect(resolveModel('glm-5.2', 'hello', APERTUS_ONLY).modelId).toBeUndefined();
		expect(resolveModel('glm-5.2', 'hello', APERTUS_ONLY).unavailable).toBeTruthy();
	});

	it('a manual pick that is served resolves to it', () => {
		expect(resolveModel('apertus-70b', 'hi', APERTUS_ONLY).modelId).toBe('swiss-ai/apertus-v1.5-70b');
	});

	// A local model is outside the catalog and is picked by its served id. It must not be named
	// unavailable, or no message could reach a person's own server (CUR-4073).
	it('a served local model pick (outside the catalog) resolves to its own id, not unavailable', () => {
		const local = 'local:318905fb1314687f0e847de7:unsloth/Llama-3.2-3B-Instruct-GGUF:Q4_K_S';
		expect(resolveModel(local, 'hi', [...APERTUS_ONLY, local])).toEqual({ modelId: local });
	});

	it('a local model pick whose server is no longer listed is still named unavailable', () => {
		const local = 'local:318905fb1314687f0e847de7:unsloth/Llama-3.2-3B-Instruct-GGUF:Q4_K_S';
		expect(resolveModel(local, 'hi', APERTUS_ONLY)).toEqual({ unavailable: local });
	});
});

describe('pickerChoice', () => {
	it('with Auto on, shows the device’s own choice, Auto included', () => {
		expect(pickerChoice(true, AUTO, 'apertus-70b')).toBe(AUTO);
		expect(pickerChoice(true, 'mistral-large', 'apertus-70b')).toBe('mistral-large');
	});

	it('with Auto off, ignores what this device stored and shows the model chosen in settings', () => {
		expect(pickerChoice(false, AUTO, 'apertus-70b')).toBe('apertus-70b');
		expect(pickerChoice(false, 'mistral-large', 'apertus-70b')).toBe('apertus-70b');
	});

	it('with Auto off and a settings model outside the catalog, shows nothing as chosen rather than Auto', () => {
		expect(pickerChoice(false, AUTO, undefined)).toBe('');
	});
});

describe('servedKey', () => {
	it('matches a catalog entry whichever lane names it, with or without the publisher prefix', async () => {
		const { catalogByGatewayId } = await import('./catalog');
		expect(catalogByGatewayId('mistralai/mistral-large-2512')?.name).toBe('Mistral Large 3');
		expect(catalogByGatewayId('mistral-large-2512')?.name).toBe('Mistral Large 3');
		expect(catalogByGatewayId('mistralai/mistral-large-2610')?.name).toBe('Mistral Large 4');
		expect(catalogByGatewayId('swiss-ai/apertus-v1.5-70b')?.id).toBe(catalogByGatewayId('apertus-v1.5-70b')?.id);
	});
	it('counts a model the router serves under a prefixed id as available', () => {
		const scores = scoreModels(heuristicClassify('Bonjour, explique-moi la photosynthèse en détail.'), [
			'mistralai/mistral-medium-2604',
			'swiss-ai/apertus-v1.5-70b'
		]);
		expect(scores.find((s) => s.model.id === 'mistral-medium')?.available).toBe(true);
	});
});
