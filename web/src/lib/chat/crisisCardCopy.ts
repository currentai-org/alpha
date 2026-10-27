// The support card in Catalan, Italian and Portuguese, which the support classifier names
// (`lang`) but the UI catalogs (paraglide: en, es, fr, de) do not carry. These are card-only: adding
// ca/it/pt as UI locales would put an untranslated app around a translated card.
//
// These translations have not yet been reviewed by a native speaker of each language (CUR-4103).
// Portuguese uses the European tu.

/** Every string the card shows, by its catalog key. */
export type CrisisCardKey =
	| "chat_crisis_label"
	| "chat_crisis_intro"
	| "chat_crisis_helplinesIn"
	| "chat_crisis_helplinesNote"
	| "chat_crisis_dangerNumber"
	| "chat_crisis_dangerLocal"
	| "chat_crisis_dangerGeneric"
	| "chat_crisis_automatic"
	| "chat_crisis_europe"
	| "chat_crisis_europeNote"
	| "chat_crisis_findNote"
	| "chat_crisis_usNote";

type CardOnlyLang = "ca" | "it" | "pt";

const CARD_ONLY_COPY: Record<CardOnlyLang, Record<CrisisCardKey, string>> = {
	ca: {
		chat_crisis_label: "Recursos de suport",
		chat_crisis_intro:
			"Si tot se’t fa massa feixuc, no ho has d’afrontar a soles. Aquests serveis et posen en contacte amb persones formades, de manera gratuïta i confidencial:",
		chat_crisis_helplinesIn: "Línies d’ajuda: {country}",
		chat_crisis_helplinesNote: "— recollides per findahelpline.com, amb com trucar, escriure o xatejar",
		chat_crisis_dangerNumber: "Si estàs en perill immediat, truca al {number}.",
		chat_crisis_dangerLocal: "Si estàs en perill immediat, truca al número d’emergències local.",
		chat_crisis_dangerGeneric: "Si estàs en perill immediat, truca al 112 o al número d’emergències local.",
		chat_crisis_automatic:
			"Aquesta nota apareix automàticament: t’orienta cap a persones reals que et poden ajudar, i no és un diagnòstic.",
		chat_crisis_europe: "Europa",
		chat_crisis_europeNote: "— truca al 112 (emergències), a qualsevol país de la UE",
		chat_crisis_findNote: "— línies gratuïtes i confidencials al teu país",
		chat_crisis_usNote: "— EUA: truca o envia un missatge al 988",
	},
	it: {
		chat_crisis_label: "Risorse di supporto",
		chat_crisis_intro:
			"Se ti sembra tutto troppo, non devi affrontarlo in solitudine. Questi servizi ti mettono in contatto con persone preparate, in modo gratuito e riservato:",
		chat_crisis_helplinesIn: "Linee di aiuto: {country}",
		chat_crisis_helplinesNote: "— raccolte da findahelpline.com, con le indicazioni per chiamare, scrivere o chattare",
		chat_crisis_dangerNumber: "Se sei in pericolo immediato, chiama il {number}.",
		chat_crisis_dangerLocal: "Se sei in pericolo immediato, chiama il numero di emergenza locale.",
		chat_crisis_dangerGeneric: "Se sei in pericolo immediato, chiama il 112 o il numero di emergenza locale.",
		chat_crisis_automatic:
			"Questa nota compare automaticamente: ti indica persone reali che possono aiutarti, e non è una diagnosi.",
		chat_crisis_europe: "Europa",
		chat_crisis_europeNote: "— chiama il 112 (emergenze), in qualsiasi paese dell’UE",
		chat_crisis_findNote: "— linee gratuite e riservate nel tuo paese",
		chat_crisis_usNote: "— USA: chiama o scrivi al 988",
	},
	pt: {
		chat_crisis_label: "Recursos de apoio",
		chat_crisis_intro:
			"Se tudo te parece demasiado, não tens de passar por isto sem apoio. Estes serviços põem-te em contacto com pessoas com formação, de forma gratuita e confidencial:",
		chat_crisis_helplinesIn: "Linhas de apoio: {country}",
		chat_crisis_helplinesNote: "— reunidas por findahelpline.com, com indicações para ligar, enviar mensagem ou conversar por chat",
		chat_crisis_dangerNumber: "Se estiveres em perigo imediato, liga para o {number}.",
		chat_crisis_dangerLocal: "Se estiveres em perigo imediato, liga para o número de emergência local.",
		chat_crisis_dangerGeneric: "Se estiveres em perigo imediato, liga para o 112 ou para o número de emergência local.",
		chat_crisis_automatic:
			"Esta nota aparece automaticamente: indica-te pessoas reais que te podem ajudar, e não é um diagnóstico.",
		chat_crisis_europe: "Europa",
		chat_crisis_europeNote: "— liga para o 112 (emergência), em qualquer país da UE",
		chat_crisis_findNote: "— linhas gratuitas e confidenciais no teu país",
		chat_crisis_usNote: "— EUA: liga ou envia mensagem para o 988",
	},
};

type CardCopy = { kind: "catalog"; locale: string } | { kind: "card"; lang: CardOnlyLang };

/**
 * Where the card's copy comes from. The language the person wrote in (`lang`, from the support
 * classifier) wins: a UI catalog that carries it, else this table. A language neither carries gets
 * the English catalog, never the UI's language. With no `lang`, the UI's language.
 */
export function pickCardCopy(lang: string | undefined, catalogLocales: readonly string[], uiLocale: string): CardCopy {
	if (!lang) return { kind: "catalog", locale: uiLocale };
	if (catalogLocales.includes(lang)) return { kind: "catalog", locale: lang };
	if (Object.hasOwn(CARD_ONLY_COPY, lang)) return { kind: "card", lang: lang as CardOnlyLang };
	return { kind: "catalog", locale: "en" };
}

/** A table string with its `{name}` slots filled. */
export function cardText(lang: CardOnlyLang, key: CrisisCardKey, params: Record<string, string> = {}): string {
	let s = CARD_ONLY_COPY[lang][key];
	for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);
	return s;
}
