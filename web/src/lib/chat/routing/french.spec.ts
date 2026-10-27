/**
 * French builds everyday questions on la, de, est and un, which the Catalan and Spanish word lists
 * also count, so the word lists alone read short French as Catalan or Spanish and Auto sent it to
 * ALIA (CUR-4080). The first three are drafts that routed wrongly; the rest are 20 everyday French
 * questions.
 */
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { localClassifier } from './localClassifier';
import { route } from './router';

const SERVED = catalog.filter((m) => m.status === 'live').map((m) => m.gatewayId!);

const FRENCH = [
	"Peux-tu m'expliquer la différence entre la météo et le climat ?",
	'Quels fichiers de mon espace de travail peux-tu lire ?',
	"Quelle est la capitale de l'Australie ?",
	'Quelle est la capitale de la France ?',
	"Peux-tu m'expliquer la photosynthèse ?",
	"Quel temps fait-il à Paris aujourd'hui ?",
	'Comment faire une tarte aux pommes ?',
	'Qui a écrit Les Misérables ?',
	"Donne-moi une recette de soupe à l'oignon",
	'Quelle est la différence entre un virus et une bactérie ?',
	"Traduis cette phrase en anglais, s'il te plaît",
	'Combien de temps faut-il pour aller de Lyon à Marseille ?',
	'Explique-moi la théorie de la relativité simplement',
	'Quels sont les symptômes de la grippe ?',
	'Écris un poème sur la mer',
	"Résume l'histoire de la Révolution française",
	'Quelle est la population de la Suisse ?',
	"J'ai besoin d'aide pour mon CV",
	'Où se trouve la tour Eiffel ?',
	'Pourquoi le ciel est bleu ?',
	'Quelle heure est-il à Tokyo ?',
	"La capitale de l'Espagne, c'est quoi ?"
];

describe('local read, French', () => {
	it.each(FRENCH)('reads French, never Catalan, Spanish or Italian: %s', async (text) => {
		const { language } = await localClassifier(text);
		expect(language.value.split('-')[0]).toBe('fra');
	});

	it('never sends a French draft to ALIA, which serves Catalan and Spanish', async () => {
		for (const text of FRENCH) expect(route(await localClassifier(text), SERVED)?.model.family, text).not.toBe('ALIA');
	});
});
