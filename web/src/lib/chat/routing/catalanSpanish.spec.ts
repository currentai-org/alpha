/**
 * Catalan and Spanish share most of their short words (el, la, de, que), so a function-word count
 * alone reads Catalan as Spanish and Auto routes it on Spanish's scores. These are everyday first messages in
 * each language. The Clef confidences are `clef` (27B) answers recorded on the staging router.
 */
import { describe, expect, it } from 'vitest';
import type { DraftAnalysis } from './classifier';
import { mergeClef, type ClefVerdict } from './clef';
import { catalog } from './catalog';
import { localClassifier } from './localClassifier';
import { route } from './router';

const SERVED = catalog.filter((m) => m.status === 'live').map((m) => m.gatewayId!);

const CATALAN = [
	'Hola, què tal?',
	'Com puc fer una paella per a sis persones?',
	'Vull saber la història de Barcelona',
	'Em pots explicar la diferència entre un virus i un bacteri?',
	'Quina és la capital de França?',
	'Necessito ajuda amb el meu currículum',
	'On és la parada de metro més propera a la Sagrada Família?',
	'Fes-me un resum de la novel·la Mecanoscrit del segon origen',
	'Quan va començar la guerra civil espanyola i per què?',
	'Tinc un problema amb el codi, no funciona la funció de login',
	'Bon dia! Quins llibres em recomanes llegir aquest estiu?',
	'Expliqueu-me com funciona la fotosíntesi de manera senzilla',
	'Hi ha alguna manera de reduir el consum elèctric a casa?',
	'Puc demanar la beca si encara no he acabat el grau?',
	'Vull aprendre a programar, per on començo?',
	'Ens podeu dir quins són els requisits per obrir un negoci a Girona?',
	'Mira, la meua filla vol estudiar medicina a València, què li recomanes?',
	'Traduïx este text al castellà, per favor',
	'La reunió és demà a les deu',
	'Els nens volen anar al parc aquesta tarda',
	'El preu de l’habitatge puja cada any'
];

const SPANISH = [
	'Hola, ¿qué tal?',
	'¿Cómo puedo hacer una paella para seis personas?',
	'Quiero saber la historia de Barcelona',
	'¿Me puedes explicar la diferencia entre un virus y una bacteria?',
	'Escríbeme un poema sobre el otoño',
	'Tengo un problema con el código, no funciona la función de login',
	'Quiero aprender a programar, ¿por dónde empiezo?',
	'La reunión es mañana a las diez',
	'Hay alguna manera de reducir el consumo eléctrico en casa?',
	'Me gustaría saber cuál es la mejor manera de aprender inglés',
	'Hay que entregar el informe antes del viernes',
	'Dime los mejores restaurantes de Madrid',
	'El precio de la vivienda sube cada año',
	'Los niños quieren ir al parque esta tarde',
	'Mi hermano vive en Valencia desde hace tres años'
];

describe('local read, Catalan vs Spanish', () => {
	it.each(CATALAN)('reads Catalan (or Valencian), never Spanish: %s', async (text) => {
		const { language } = await localClassifier(text);
		expect(language.value.split('-')[0]).toBe('cat');
	});

	it.each(SPANISH)('reads Spanish, never Catalan: %s', async (text) => {
		const { language } = await localClassifier(text);
		expect(language.value.split('-')[0]).toBe('spa');
	});

	it('routes the Catalan drafts on Catalan’s scores and the Spanish ones on Spanish’s', async () => {
		for (const text of CATALAN) expect(route(await localClassifier(text), SERVED)?.reasons, text).not.toContain('Spanish');
		for (const text of SPANISH) expect(route(await localClassifier(text), SERVED)?.reasons, text).not.toContain('Catalan');
	});

	// No accent, no elision, only words both languages use, and franc names neither: the local read
	// can't tell, so it must be unsure enough to leave the answer to Clef.
	it('leaves a Catalan draft with nothing but shared words to Clef', async () => {
		const text = 'Escriu-me un poema sobre la tardor';
		const local = await localClassifier(text);
		expect(local.language.confidence).toBeLessThan(0.5);
		expect(mergeClef(text, local, verdict('cat', 0.55)).language.value).toBe('cat');
	});
});

const verdict = (value: string, confidence: number): ClefVerdict => ({
	language: { value, confidence },
	difficulty: { value: 'M', confidence: 0.6 },
	skills: { 'web-search': 0, code: 0, math: 0, translation: 0, research: 0, reasoning: 0 },
	model: 'clef',
	elapsedMs: 900
});

const wordsRead = (value: string, confidence: number): DraftAnalysis => ({
	language: { value, confidence, alternatives: [], signal: 'words' },
	difficulty: { value: 'M', confidence: 0.6 },
	skills: [],
	source: 'local'
});

describe('Clef over the local read, Catalan vs Spanish', () => {
	// The local confidences are what the word lists alone gave these drafts: wrong, and higher than Clef's.
	it.each([
		['On és la parada de metro més propera a la Sagrada Família?', 0.76, 0.57],
		['Fes-me un resum de la novel·la Mecanoscrit del segon origen', 0.66, 0.6],
		['Tinc un problema amb el codi, no funciona la funció de login', 0.66, 0.45],
		['Puc demanar la beca si encara no he acabat el grau?', 0.6, 0.52]
	])('takes Clef’s Catalan over a word-list Spanish read it disagrees with: %s', (text, localConf, clefConf) => {
		const merged = mergeClef(text, wordsRead('spa', localConf), verdict('cat', clefConf));
		expect(merged.language.value).toBe('cat');
		expect(merged.language.alternatives[0]).toEqual({ value: 'spa', confidence: localConf });
	});

	it('keeps the local read when Clef disagrees but is unsure (clef-flash once answered Spanish at 0.25)', () => {
		const text = 'Quan va començar la guerra civil espanyola i per què?';
		expect(mergeClef(text, wordsRead('cat', 0.61), verdict('spa', 0.25)).language.value).toBe('cat');
	});
});
