// A refusal reads in the language the person wrote in (CUR-4051). rules.json holds the reviewed English
// copy; this file holds its translations, keyed by that English text, so an English edit in rules.json
// orphans its translations and the notice falls back to English until they are redone (declineCopy.spec.ts
// goes red on the orphan). The crisis-support copy is not translated here: it carries helpline advice that
// wants a native speaker's review before any visitor reads it.
import { heuristicClassify } from "$lib/chat/routing/heuristic";
import { loadDetectors, refineLanguage } from "$lib/chat/routing/localClassifier";
import { parentLanguage } from "$lib/chat/routing/languages";

/** The languages a decline is translated into. @internal exported for its unit tests */
export const DECLINE_LANGUAGES = ["es", "fr", "pt", "de", "it", "ca", "ta"] as const;
export type DeclineLanguage = "en" | (typeof DECLINE_LANGUAGES)[number];
type Translations = Record<Exclude<DeclineLanguage, "en">, string>;

/** Detected 639-3 base tag → the decline language that covers it. */
const FROM_TAG: Record<string, DeclineLanguage> = {
	spa: "es",
	fra: "fr",
	por: "pt",
	deu: "de",
	ita: "it",
	cat: "ca",
	tam: "ta",
};

/** rules.json `message` (English, exact) → its translations. */
const MESSAGES: Record<string, Translations> = {
	"This request was declined because it goes against our content policy.": {
		es: "Esta solicitud se rechazó porque va en contra de nuestra política de contenido.",
		fr: "Cette demande a été refusée car elle va à l'encontre de notre politique de contenu.",
		pt: "Este pedido foi recusado porque vai contra a nossa política de conteúdo.",
		de: "Diese Anfrage wurde abgelehnt, weil sie gegen unsere Inhaltsrichtlinie verstößt.",
		it: "Questa richiesta è stata rifiutata perché va contro la nostra politica sui contenuti.",
		ca: "Aquesta sol·licitud s'ha rebutjat perquè va en contra de la nostra política de contingut.",
		ta: "இந்தக் கோரிக்கை எங்கள் உள்ளடக்கக் கொள்கைக்கு எதிராக இருப்பதால் நிராகரிக்கப்பட்டது.",
	},
	"This chatbot is not able to help with requests that involve finding, sharing, or exposing someone's personal or private information.":
		{
			es: "Este chatbot no puede ayudar con solicitudes que implican buscar, compartir o exponer información personal o privada de alguien.",
			fr: "Ce chatbot ne peut pas aider avec des demandes qui consistent à trouver, partager ou exposer des informations personnelles ou privées sur quelqu'un.",
			pt: "Este chatbot não pode ajudar com pedidos que envolvam encontrar, compartilhar ou expor informações pessoais ou privadas de alguém.",
			de: "Dieser Chatbot kann nicht bei Anfragen helfen, bei denen es darum geht, persönliche oder private Informationen über jemanden zu finden, weiterzugeben oder offenzulegen.",
			it: "Questo chatbot non può aiutare con richieste che riguardano trovare, condividere o esporre informazioni personali o private di qualcuno.",
			ca: "Aquest xatbot no pot ajudar amb sol·licituds que impliquin trobar, compartir o exposar informació personal o privada d'algú.",
			ta: "ஒருவரின் தனிப்பட்ட அல்லது அந்தரங்கத் தகவல்களைக் கண்டறிதல், பகிர்தல் அல்லது வெளிப்படுத்துதல் தொடர்பான கோரிக்கைகளுக்கு இந்த சாட்பாட்டால் உதவ முடியாது.",
		},
};

/** rules.json `label` (English, exact) → its translations, for the "who set this limit" line. */
const LABELS: Record<string, Translations> = {
	"Violent content": { es: "Contenido violento", fr: "Contenu violent", pt: "Conteúdo violento", de: "Gewaltinhalte", it: "Contenuti violenti", ca: "Contingut violent", ta: "வன்முறை உள்ளடக்கம்" },
	"Sexual content": { es: "Contenido sexual", fr: "Contenu sexuel", pt: "Conteúdo sexual", de: "Sexuelle Inhalte", it: "Contenuti sessuali", ca: "Contingut sexual", ta: "பாலியல் உள்ளடக்கம்" },
	"Emotional attachment": { es: "Apego emocional", fr: "Attachement émotionnel", pt: "Apego emocional", de: "Emotionale Bindung", it: "Attaccamento emotivo", ca: "Vincle emocional", ta: "உணர்ச்சிப் பிணைப்பு" },
	"Drug content": { es: "Contenido sobre drogas", fr: "Contenu lié aux drogues", pt: "Conteúdo sobre drogas", de: "Drogeninhalte", it: "Contenuti sulle droghe", ca: "Contingut sobre drogues", ta: "போதைப்பொருள் உள்ளடக்கம்" },
	"Respectful communication": { es: "Comunicación respetuosa", fr: "Communication respectueuse", pt: "Comunicação respeitosa", de: "Respektvolle Kommunikation", it: "Comunicazione rispettosa", ca: "Comunicació respectuosa", ta: "மரியாதையான தொடர்பு" },
	Privacy: { es: "Privacidad", fr: "Vie privée", pt: "Privacidade", de: "Privatsphäre", it: "Privacy", ca: "Privacitat", ta: "தனியுரிமை" },
	"Illegal activity": { es: "Actividad ilegal", fr: "Activité illégale", pt: "Atividade ilegal", de: "Illegale Aktivitäten", it: "Attività illegali", ca: "Activitat il·legal", ta: "சட்டவிரோத செயல்பாடு" },
	"Child safety": { es: "Seguridad infantil", fr: "Protection de l'enfance", pt: "Segurança infantil", de: "Kinderschutz", it: "Tutela dei minori", ca: "Seguretat infantil", ta: "குழந்தைப் பாதுகாப்பு" },
};

const ATTRIBUTION: Record<DeclineLanguage, (label: string) => string> = {
	en: (label) => `Current AI set this limit (rule: ${label}).`,
	es: (label) => `Current AI estableció este límite (regla: ${label}).`,
	fr: (label) => `Current AI a fixé cette limite (règle : ${label}).`,
	pt: (label) => `A Current AI definiu este limite (regra: ${label}).`,
	de: (label) => `Current AI hat diese Grenze festgelegt (Regel: ${label}).`,
	it: (label) => `Current AI ha stabilito questo limite (regola: ${label}).`,
	ca: (label) => `Current AI ha establert aquest límit (norma: ${label}).`,
	ta: (label) => `இந்த வரம்பை Current AI அமைத்துள்ளது (விதி: ${label}).`,
};

/** The policy decline for one rule: its message, then who set the limit, in `lang` when both the message
 *  and the label have a translation, else wholly in English. */
export function declineNotice(message: string, label: string, lang: DeclineLanguage = "en"): string {
	const translated = lang === "en" ? undefined : { message: MESSAGES[message]?.[lang], label: LABELS[label]?.[lang] };
	if (translated?.message && translated.label) {
		return `${translated.message}\n\n${ATTRIBUTION[lang](translated.label)}`;
	}
	return `${message}\n\n${ATTRIBUTION.en(label)}`;
}

/** Whether `message` and `label` have a translation in `lang` (the coverage spec's check).
 *  @internal exported for its unit tests */
export function hasTranslation(message: string, label: string, lang: Exclude<DeclineLanguage, "en">): boolean {
	return !!MESSAGES[message]?.[lang] && !!LABELS[label]?.[lang];
}

/** The language the person wrote in, as a 639-3 tag, by the detectors the composer and read-aloud use;
 *  undefined when they can't be loaded. */
export async function readMessageLanguage(text: string): Promise<string | undefined> {
	const t = text.trim();
	if (!t) return undefined;
	try {
		return refineLanguage(t, heuristicClassify(t).language, await loadDetectors()).value;
	} catch {
		return undefined;
	}
}

/** The decline language for a tag readMessageLanguage returned. Anything undetected, too short, or in a
 *  language with no translation reads in English. */
export function declineLanguageFromTag(tag: string | undefined): DeclineLanguage {
	if (!tag) return "en";
	const base = tag.split("-")[0];
	return FROM_TAG[base] ?? FROM_TAG[parentLanguage(tag) ?? ""] ?? "en";
}

/** The decline language for what the person wrote, for a caller that has no tag read already. */
export async function declineLanguageOf(text: string): Promise<DeclineLanguage> {
	return declineLanguageFromTag(await readMessageLanguage(text));
}
