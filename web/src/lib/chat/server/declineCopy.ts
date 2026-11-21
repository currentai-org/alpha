// A refusal reads in the language the person wrote in. rules.json holds the reviewed English
// copy; this file holds its translations, keyed by that English text, so an English edit in rules.json
// orphans its translations and the notice falls back to English until they are redone (declineCopy.spec.ts
// goes red on the orphan). The crisis-support copy is translated too: its translations are
// agent-written and await a native speaker's review of the helpline advice, tracked on that ticket.
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
	"I'm glad our conversations feel useful. I'm an AI, though, so I can't be a partner, a friend or a therapist the way a person can. If you're feeling lonely, talking with someone you trust can really help. I'm still happy to help with whatever's on your mind.":
		{
			es: "Me alegra que nuestras conversaciones te resulten útiles. Pero soy una IA, así que no puedo ser tu pareja, tu amigo ni tu terapeuta como lo sería una persona. Si te sientes solo o sola, hablar con alguien de confianza puede ayudarte mucho. Sigo aquí para ayudarte con lo que tengas en mente.",
			fr: "Ça me fait plaisir que nos conversations te soient utiles. Mais je suis une IA : je ne peux pas être un partenaire, un ami ou un thérapeute comme le serait une personne. Si tu te sens seul ou seule, parler à quelqu'un en qui tu as confiance peut vraiment aider. Je reste là pour t'aider avec ce qui te préoccupe.",
			pt: "Fico feliz que nossas conversas sejam úteis para você. Mas eu sou uma IA, então não posso ser seu parceiro, amigo ou terapeuta como uma pessoa seria. Se você estiver se sentindo sozinho ou sozinha, conversar com alguém de confiança pode ajudar muito. Continuo aqui para ajudar com o que você tiver em mente.",
			de: "Schön, dass dir unsere Gespräche nützen. Ich bin aber eine KI und kann kein Partner, kein Freund und kein Therapeut sein, so wie es ein Mensch kann. Wenn du dich einsam fühlst, kann ein Gespräch mit jemandem, dem du vertraust, wirklich helfen. Ich helfe dir weiterhin gern bei allem, was dich beschäftigt.",
			it: "Mi fa piacere che le nostre conversazioni ti siano utili. Però sono un'IA, quindi non posso essere un partner, un amico o un terapeuta come lo sarebbe una persona. Se ti senti solo o sola, parlare con qualcuno di cui ti fidi può aiutare davvero. Sono ancora qui per aiutarti con qualsiasi cosa tu abbia in mente.",
			ca: "M'alegra que les nostres converses et siguin útils. Però sóc una IA, així que no puc ser la teva parella, un amic ni un terapeuta com ho seria una persona. Si et sents sol o sola, parlar amb algú de confiança et pot ajudar molt. Continuo aquí per ajudar-te amb el que tinguis al cap.",
			ta: "நமது உரையாடல்கள் உங்களுக்குப் பயனுள்ளதாக இருப்பதில் மகிழ்ச்சி. ஆனால் நான் ஒரு AI, அதனால் ஒரு மனிதரைப் போல உங்கள் துணையாகவோ, நண்பராகவோ, சிகிச்சையாளராகவோ இருக்க முடியாது. நீங்கள் தனிமையாக உணர்ந்தால், நீங்கள் நம்பும் ஒருவரிடம் பேசுவது மிகவும் உதவும். உங்கள் மனதில் உள்ள எதற்கும் உதவ நான் இன்னும் இங்கே இருக்கிறேன்.",
		},
	// The crisis-support message every self-harm rule shares. The translations are agent-written
	// and await a native speaker's review per language, tracked on that ticket. Each keeps the
	// findahelpline link and 988, and names no emergency number: the support card above it holds that,
	// picked per country.
	"You might be going through something painful right now, and you don't have to face it alone. Trained people can help, free and confidentially: [findahelpline.com](https://findahelpline.com) lists crisis lines in your country. In the US, call or text 988. If you're in immediate danger, call your local emergency number. Reaching out to someone you trust can help too.":
		{
			es: "Puede que estés pasando por algo doloroso en este momento, y no tienes que afrontarlo a solas. Hay personas formadas que pueden ayudarte, de forma gratuita y confidencial: [findahelpline.com](https://findahelpline.com) reúne las líneas de crisis de tu país. En Estados Unidos, llama o envía un mensaje de texto al 988. Si estás en peligro inmediato, llama al número de emergencias local. Hablar con alguien de confianza también puede ayudar.",
			fr: "Tu traverses peut-être quelque chose de douloureux en ce moment, et tu n'as pas à affronter ça sans soutien. Des personnes formées peuvent t'aider, gratuitement et en toute confidentialité : [findahelpline.com](https://findahelpline.com) recense les lignes d'écoute de ton pays. Aux États-Unis, appelle le 988 ou envoie-lui un SMS. Si tu es en danger immédiat, appelle le numéro d'urgence local. En parler à une personne de confiance peut aussi aider.",
			pt: "Talvez você esteja passando por algo doloroso agora, e não precisa enfrentar isso sem apoio. Pessoas preparadas podem ajudar, de graça e com sigilo: [findahelpline.com](https://findahelpline.com) lista as linhas de apoio em crise do seu país. Nos EUA, ligue ou envie uma mensagem de texto para o 988. Se você estiver em perigo imediato, ligue para o número de emergência local. Conversar com alguém de confiança também pode ajudar.",
			de: "Vielleicht machst du gerade etwas Schmerzhaftes durch, und du musst das nicht allein durchstehen. Geschulte Menschen können dir helfen, kostenlos und vertraulich: [findahelpline.com](https://findahelpline.com) listet die Krisentelefone in deinem Land auf. In den USA ruf die 988 an oder schreib eine SMS an die 988. Wenn du in unmittelbarer Gefahr bist, ruf die örtliche Notrufnummer an. Mit jemandem zu sprechen, dem du vertraust, kann auch helfen.",
			it: "Forse stai attraversando un momento doloroso, e non devi affrontarlo in solitudine. Ci sono persone preparate che possono aiutarti, gratuitamente e in modo riservato: [findahelpline.com](https://findahelpline.com) elenca le linee di ascolto del tuo paese. Negli Stati Uniti chiama o invia un SMS al 988. Se sei in pericolo immediato, chiama il numero di emergenza locale. Parlarne con qualcuno di cui ti fidi può aiutare.",
			ca: "Potser estàs passant per alguna cosa dolorosa ara mateix, i no ho has d'afrontar a soles. Hi ha persones formades que et poden ajudar, de manera gratuïta i confidencial: [findahelpline.com](https://findahelpline.com) recull les línies d'ajuda en crisi del teu país. Als Estats Units, truca o envia un missatge de text al 988. Si estàs en perill immediat, truca al número d'emergències local. Parlar amb algú de confiança també et pot ajudar.",
			ta: "நீங்கள் இப்போது வலிமிகுந்த ஒன்றைக் கடந்து கொண்டிருக்கலாம்; இதை நீங்கள் தனியாக எதிர்கொள்ள வேண்டியதில்லை. பயிற்சி பெற்றவர்கள் இலவசமாகவும் ரகசியமாகவும் உதவ முடியும்: [findahelpline.com](https://findahelpline.com) உங்கள் நாட்டிலுள்ள நெருக்கடி உதவி எண்களைப் பட்டியலிடுகிறது. அமெரிக்காவில், 988 ஐ அழைக்கவும் அல்லது குறுஞ்செய்தி அனுப்பவும். நீங்கள் உடனடி ஆபத்தில் இருந்தால், உங்கள் உள்ளூர் அவசர எண்ணை அழைக்கவும். நீங்கள் நம்பும் ஒருவரிடம் பேசுவதும் உதவக்கூடும்.",
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
	// ruleLabel.ts MULTIPLE_RULES_LABEL: more than one rule blocked the turn.
	"Multiple Safety Rules": { es: "Varias reglas de seguridad", fr: "Plusieurs règles de sécurité", pt: "Várias regras de segurança", de: "Mehrere Sicherheitsregeln", it: "Più regole di sicurezza", ca: "Diverses normes de seguretat", ta: "பல பாதுகாப்பு விதிகள்" },
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

/** A rule's message alone, with no "who set this limit" line, in `lang` when it has a translation. */
export function declineMessage(message: string, lang: DeclineLanguage = "en"): string {
	return (lang === "en" ? undefined : MESSAGES[message]?.[lang]) ?? message;
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

/** How long a declined turn's second language read may take before its line logs without it. */
const DECLINE_SIGNAL_CAP_MS = 1000;

/**
 * Log `[turn] decline-language` for a declined turn: the locale its notice was picked in beside the
 * language the multilingual reader named for the same message. A French message whose notice is
 * `ca` or `es` is the misread the `decline-notice-language` verify query counts. The caller does not await
 * this, so a slow read never holds the turn: hand it to `runInBackground`. The read waits at most `capMs`,
 * then the line logs with `declineSignalLanguage: null`.
 */
export async function logDeclineLanguage(opts: {
	logger: { info: (o: object, m: string) => void };
	conversationId: string;
	noticeLanguage: Promise<DeclineLanguage>;
	signal: Promise<{ lang: string } | null>;
	capMs?: number;
}): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const signal = await Promise.race([
			opts.signal.catch(() => null),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), opts.capMs ?? DECLINE_SIGNAL_CAP_MS);
			}),
		]);
		opts.logger.info(
			{
				conversationId: opts.conversationId,
				declineLanguage: await opts.noticeLanguage.catch(() => "en" as const),
				declineSignalLanguage: signal?.lang || null,
			},
			"[turn] decline-language"
		);
	} finally {
		clearTimeout(timer);
	}
}
