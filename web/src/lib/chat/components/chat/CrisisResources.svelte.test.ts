import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

const appState = vi.hoisted(() => ({ page: { data: { visitorCountry: null as string | null } } }));
vi.mock('$app/state', () => appState);

import CrisisResources from './CrisisResources.svelte';

// The card reads in the language the
// support classifier returns, when the catalogs carry it, and in English for one they don't. (CUR-4094)
const INTRO = {
	en: "If things feel overwhelming, you don't have to face it alone.",
	de: 'Wenn dir alles zu viel wird, musst du das nicht allein durchstehen.',
	es: 'Si todo te parece demasiado, no tienes que afrontarlo a solas.',
	fr: 'Si tout te semble trop lourd, tu n’as pas à affronter ça sans soutien.'
};
const LABEL = { en: 'Support resources', de: 'Hilfsangebote', es: 'Recursos de apoyo', fr: 'Ressources d’aide' };

async function card(lang: string | undefined, country: string | null = null) {
	appState.page.data.visitorCountry = country;
	const { container } = await render(CrisisResources, { lang });
	return container.querySelector('[role="note"]') as HTMLElement;
}

describe('the support card', () => {
	for (const lang of ['en', 'de', 'es', 'fr'] as const) {
		it(`reads in ${lang} when the message was written in ${lang}`, async () => {
			const note = await card(lang);
			expect(note.textContent).toContain(INTRO[lang]);
			expect(note.getAttribute('aria-label')).toBe(LABEL[lang]);
			expect(note.getAttribute('lang')).toBe(lang);
		});
	}

	it('reads in English, not the UI language, for a language the catalogs do not carry (Hausa)', async () => {
		const note = await card('ha');
		expect(note.textContent).toContain(INTRO.en);
		expect(note.getAttribute('lang')).toBe('en');
	});

	it('names the visitor’s country and its emergency number in the message language', async () => {
		const note = await card('de', 'fr');
		expect(note.querySelector('a')?.textContent).toBe('Hilfetelefone: Frankreich');
		expect(note.querySelector('a')?.getAttribute('href')).toBe('https://findahelpline.com/countries/fr');
		expect(note.textContent).toContain('Wenn du in akuter Gefahr bist, ruf die 112 an.');
	});

	it('keeps findahelpline.com and 112 in the generic card, translated around them', async () => {
		const note = await card('es');
		expect(note.textContent).toContain('Si estás en peligro inmediato, llama al 112 o al número de emergencias local.');
		expect(note.querySelector('a[href="https://findahelpline.com"]')).not.toBeNull();
	});
});

// Catalan, Italian and Portuguese come from the card-only table, not a UI catalog. (CUR-4103)
describe('the support card in a language only the card carries', () => {
	it('reads in Catalan, with lang="ca" on its root and the country named in Catalan', async () => {
		const note = await card('ca', 'es');
		expect(note.getAttribute('lang')).toBe('ca');
		expect(note.getAttribute('aria-label')).toBe('Recursos de suport');
		expect(note.textContent).toContain('no ho has d’afrontar a soles');
		expect(note.querySelector('a')?.textContent).toBe('Línies d’ajuda: Espanya');
		expect(note.textContent).toContain('Si estàs en perill immediat, truca al 112.');
	});

	it('reads in Italian and Portuguese in the generic card, keeping 112 and findahelpline.com', async () => {
		const it_ = await card('it');
		expect(it_.getAttribute('lang')).toBe('it');
		expect(it_.textContent).toContain('chiama il 112 o il numero di emergenza locale');
		const pt = await card('pt');
		expect(pt.getAttribute('lang')).toBe('pt');
		expect(pt.textContent).toContain('liga para o 112 ou para o número de emergência local');
		expect(pt.querySelector('a[href="https://findahelpline.com"]')).not.toBeNull();
	});
});

// The country the
// message names wins over the IP country (a question about France from a connection in Taiwan); with none named, the IP country stands. (CUR-4488)
describe('the support card follows the country the message names', () => {
	it('shows France, not the Taiwan IP country, when the classifier read France from the message', async () => {
		appState.page.data.visitorCountry = 'TW';
		const { container } = await render(CrisisResources, { lang: 'fr', country: 'fr' });
		const note = container.querySelector('[role="note"]') as HTMLElement;
		expect(note.getAttribute('data-crisis-country')).toBe('fr');
		expect(note.querySelector('a[href="https://findahelpline.com/countries/fr"]')).not.toBeNull();
		expect(note.querySelector('a[href*="/countries/tw"]')).toBeNull();
	});

	it('keeps the IP country when the message names none', async () => {
		const note = await card('fr', 'TW');
		expect(note.getAttribute('data-crisis-country')).toBe('tw');
	});
});
