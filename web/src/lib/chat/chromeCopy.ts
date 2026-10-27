// The chat's chrome in the visitor's language: the live request log while an answer is being made
// (CUR-1575), and the open-gap card and "How this was made" link under a finished one (CUR-2394).
//
// The language is the one the visitor's browser asks for first (`Accept-Language`, read once in the
// chat layout's server load), not the language of any one message, which is how the big chat apps
// split it: the answer is written in the question's language and the interface in the person's. Keying the
// chrome to each message would switch buttons and status lines between languages whenever someone
// changes language mid-conversation, and the status line shows before any answer exists to read.
//
// A language with no table here gets English, and so does a browser that asks for none. Only the
// strings above are covered here; the rest of the interface is in the Paraglide catalogs
// (`messages/*.json`).

const CHROME_LANGUAGES = ["en", "fr", "es", "de", "it", "pt", "nl"] as const;
type ChromeLanguage = (typeof CHROME_LANGUAGES)[number];

interface ChromeCopy {
	// Under a finished answer.
	gapLabel: string;
	gapAria: string;
	gapTitle: string;
	/** The sentence around the gap's ask, for a gap with no line of its own in `gapLines`. */
	gapNeeds: (ask: string) => string;
	gapAction: string;
	howMade: string;
	/** The caption under a reply the server wrote as a fixed string, with no model (CUR-1579). */
	fixedNotice: string;
	/** The button under the low-resource notice, and the message it sends for the visitor. (CUR-1841) */
	tryAnyway: string;
	tryAnywayMessage: string;
	/** The caption under a finished answer nothing reported a model for (CUR-1606). */
	noProvenance: string;
	/** The empty composer. */
	placeholder: string;
	/** The card's sentence for a gap, keyed by its stack-map node id, written for the person who asked
	 *  rather than for a contributor: "The open stack still needs a Google-scale open web search index"
	 *  read as roadmap copy under an answer about a mountain (CUR-2885). */
	gapLines: Record<string, string>;
	// The live request log (liveRequestLabels.ts).
	theModel: string;
	preparing: string;
	fixedReply: string;
	audio: string;
	generating: (model: string) => string;
	screening: string;
	screeningDocuments: string;
	screeningWeb: string;
	screeningDocumentsWeb: string;
	/** Which part of a long input the safety screen is on, shown after the screening line. (CUR-3749) */
	screeningPart: (part: number, parts: number) => string;
	searching: string;
	/** A native turn's search_catalog call, alone or beside web_search. (CUR-2275) */
	searchingDocuments: string;
	searchingDocumentsWeb: string;
	/** A new code sandbox is waiting for a free slot on a full host. (CUR-4584) */
	waitingSandbox: string;
	thinking: (model: string) => string;
	writing: (model: string) => string;
	retrieved: (from: string, count: number) => string;
	declined: string;
	failover: (from: string, to: string, skipped: boolean) => string;
}

const EN: ChromeCopy = {
	gapLabel: "Open gap",
	gapAria: "An open gap in the stack",
	gapTitle:
		"This answer runs up against a gap in the open source stack — a place the public stack isn't built out yet. You can see it on the live-stack map and help close it.",
	gapNeeds: (ask) => `The open stack still needs ${ask}.`,
	gapAction: "Help build it",
	howMade: "How this was made",
	fixedNotice: "No model wrote this reply. It is a fixed notice from Alpha.",
	tryAnyway: "Try anyway",
	tryAnywayMessage: "Please try anyway.",
	noProvenance: "No provenance for this answer — nothing reported which model served it.",
	placeholder: "Ask anything.",
	gapLines: { websearch: "No open search index covers the whole web yet." },
	theModel: "The model",
	preparing: "Working on it…",
	fixedReply: "Replying with a fixed notice…",
	audio: "Making the audio…",
	generating: (m) => `${m} is generating…`,
	screening: "Checking safety…",
	screeningPart: (p, n) => `part ${p} of ${n}`,
	screeningDocuments: "Checking safety & searching our documents…",
	screeningWeb: "Checking safety & searching the web…",
	screeningDocumentsWeb: "Checking safety & searching our documents and the web…",
	searching: "Searching the web…",
	searchingDocuments: "Searching our documents…",
	searchingDocumentsWeb: "Searching our documents and the web…",
	waitingSandbox: "Waiting for a free sandbox…",
	thinking: (m) => `${m} is computing…`,
	writing: (m) => `${m} is writing the reply…`,
	retrieved: (from, n) => `Retrieved from ${from} · ${n} source${n === 1 ? "" : "s"}`,
	declined: "Declined by the safety screen",
	failover: (from, to, skipped) => `${from} ${skipped ? "was skipped" : "didn't answer"} · switched to ${to} (backup)`,
};

const COPY: Record<ChromeLanguage, ChromeCopy> = {
	en: EN,
	fr: {
		gapLabel: "Manque ouvert",
		gapAria: "Un manque dans la pile open source",
		gapTitle:
			"Cette réponse bute sur un manque de la pile open source : une brique publique qui n'existe pas encore. Tu peux la voir sur la carte et aider à la construire.",
		gapNeeds: (ask) => `Il manque encore à l'IA open source ${ask}.`,
		gapAction: "Aider à la construire",
		howMade: "Comment cette réponse a été produite",
		fixedNotice: "Aucun modèle n'a écrit cette réponse. C'est un message fixe d'Alpha.",
		tryAnyway: "Essayer quand même",
		tryAnywayMessage: "Essaie quand même, s’il te plaît.",
		noProvenance: "Aucune provenance pour cette réponse : rien n'a indiqué quel modèle l'a produite.",
		placeholder: "Pose ta question.",
		gapLines: { websearch: "Aucun index de recherche ouvert ne couvre encore tout le web." },
		theModel: "Le modèle",
		preparing: "Préparation de la réponse…",
		fixedReply: "Réponse par un message fixe…",
		audio: "Création de l'audio…",
		generating: (m) => `${m} rédige…`,
		screening: "Vérification de sécurité…",
		screeningPart: (p, n) => `partie ${p} sur ${n}`,
		screeningDocuments: "Vérification de sécurité et recherche dans nos documents…",
		screeningWeb: "Vérification de sécurité et recherche sur le web…",
		screeningDocumentsWeb: "Vérification de sécurité et recherche dans nos documents et sur le web…",
		searching: "Recherche sur le web…",
		searchingDocuments: "Recherche dans nos documents…",
		searchingDocumentsWeb: "Recherche dans nos documents et sur le web…",
		waitingSandbox: "En attente d’un bac à sable libre…",
		thinking: (m) => `${m} réfléchit…`,
		writing: (m) => `${m} rédige la réponse…`,
		retrieved: (from, n) => `Trouvé dans ${from} · ${n} source${n === 1 ? "" : "s"}`,
		declined: "Refusé par le filtre de sécurité",
		failover: (from, to, skipped) =>
			`${from} ${skipped ? "a été ignoré" : "n'a pas répondu"} · relais par ${to} (secours)`,
	},
	es: {
		gapLabel: "Hueco abierto",
		gapAria: "Un hueco en la pila de código abierto",
		gapTitle:
			"Esta respuesta choca con un hueco de la pila de código abierto: una pieza pública que aún no existe. Puedes verla en el mapa y ayudar a construirla.",
		gapNeeds: (ask) => `A la IA abierta aún le falta ${ask}.`,
		gapAction: "Ayuda a construirlo",
		howMade: "Cómo se hizo esta respuesta",
		fixedNotice: "Ningún modelo escribió esta respuesta. Es un aviso fijo de Alpha.",
		tryAnyway: "Intentarlo de todos modos",
		tryAnywayMessage: "Inténtalo de todos modos, por favor.",
		noProvenance: "Sin procedencia para esta respuesta: nada indicó qué modelo la generó.",
		placeholder: "Pregunta lo que quieras.",
		gapLines: { websearch: "Todavía ningún índice de búsqueda abierto cubre toda la web." },
		theModel: "El modelo",
		preparing: "Preparando la respuesta…",
		fixedReply: "Respondiendo con un aviso fijo…",
		audio: "Generando el audio…",
		generating: (m) => `${m} está escribiendo…`,
		screening: "Comprobando la seguridad…",
		screeningPart: (p, n) => `parte ${p} de ${n}`,
		screeningDocuments: "Comprobando la seguridad y buscando en nuestros documentos…",
		screeningWeb: "Comprobando la seguridad y buscando en la web…",
		screeningDocumentsWeb: "Comprobando la seguridad y buscando en nuestros documentos y en la web…",
		searching: "Buscando en la web…",
		searchingDocuments: "Buscando en nuestros documentos…",
		searchingDocumentsWeb: "Buscando en nuestros documentos y en la web…",
		waitingSandbox: "Esperando un entorno aislado libre…",
		thinking: (m) => `${m} está pensando…`,
		writing: (m) => `${m} está redactando la respuesta…`,
		retrieved: (from, n) => `Encontrado en ${from} · ${n} fuente${n === 1 ? "" : "s"}`,
		declined: "Rechazado por el filtro de seguridad",
		failover: (from, to, skipped) =>
			`${from} ${skipped ? "se omitió" : "no respondió"} · cambio a ${to} (respaldo)`,
	},
	de: {
		gapLabel: "Offene Lücke",
		gapAria: "Eine Lücke im offenen Stack",
		gapTitle:
			"Diese Antwort stößt an eine Lücke im offenen KI-Stack: ein öffentlicher Baustein, den es noch nicht gibt. Du kannst sie auf der Karte sehen und helfen, sie zu schließen.",
		gapNeeds: (ask) => `Der offenen KI fehlt noch ${ask}.`,
		gapAction: "Mitbauen",
		howMade: "Wie diese Antwort entstand",
		fixedNotice: "Kein Modell hat diese Antwort geschrieben. Es ist ein fester Hinweis von Alpha.",
		tryAnyway: "Trotzdem versuchen",
		tryAnywayMessage: "Bitte versuch es trotzdem.",
		noProvenance: "Keine Herkunft für diese Antwort – nichts hat gemeldet, welches Modell sie erzeugt hat.",
		placeholder: "Frag, was du möchtest.",
		gapLines: { websearch: "Noch deckt kein offener Suchindex das ganze Web ab." },
		theModel: "Das Modell",
		preparing: "Antwort wird vorbereitet…",
		fixedReply: "Antwort mit einem festen Hinweis…",
		audio: "Audio wird erstellt…",
		generating: (m) => `${m} schreibt…`,
		screening: "Sicherheitsprüfung…",
		screeningPart: (p, n) => `Teil ${p} von ${n}`,
		screeningDocuments: "Sicherheitsprüfung und Suche in unseren Dokumenten…",
		screeningWeb: "Sicherheitsprüfung und Suche im Web…",
		screeningDocumentsWeb: "Sicherheitsprüfung und Suche in unseren Dokumenten und im Web…",
		searching: "Suche im Web…",
		searchingDocuments: "Suche in unseren Dokumenten…",
		searchingDocumentsWeb: "Suche in unseren Dokumenten und im Web…",
		waitingSandbox: "Warte auf eine freie Sandbox…",
		thinking: (m) => `${m} denkt nach…`,
		writing: (m) => `${m} schreibt die Antwort…`,
		retrieved: (from, n) => `Gefunden in ${from} · ${n} Quelle${n === 1 ? "" : "n"}`,
		declined: "Von der Sicherheitsprüfung abgelehnt",
		failover: (from, to, skipped) =>
			`${from} ${skipped ? "wurde übersprungen" : "hat nicht geantwortet"} · gewechselt zu ${to} (Ersatz)`,
	},
	it: {
		gapLabel: "Lacuna aperta",
		gapAria: "Una lacuna nello stack open source",
		gapTitle:
			"Questa risposta si scontra con una lacuna dello stack open source: un tassello pubblico che ancora non esiste. Puoi vederla sulla mappa e aiutare a colmarla.",
		gapNeeds: (ask) => `All'IA aperta manca ancora ${ask}.`,
		gapAction: "Aiuta a costruirlo",
		howMade: "Come è stata prodotta questa risposta",
		fixedNotice: "Nessun modello ha scritto questa risposta. È un avviso fisso di Alpha.",
		tryAnyway: "Prova comunque",
		tryAnywayMessage: "Prova comunque, per favore.",
		noProvenance: "Nessuna provenienza per questa risposta: nulla ha indicato quale modello l’ha prodotta.",
		placeholder: "Chiedi qualsiasi cosa.",
		gapLines: { websearch: "Nessun indice di ricerca aperto copre ancora tutto il web." },
		theModel: "Il modello",
		preparing: "Preparazione della risposta…",
		fixedReply: "Risposta con un avviso fisso…",
		audio: "Creazione dell'audio…",
		generating: (m) => `${m} sta scrivendo…`,
		screening: "Controllo di sicurezza…",
		screeningPart: (p, n) => `parte ${p} di ${n}`,
		screeningDocuments: "Controllo di sicurezza e ricerca nei nostri documenti…",
		screeningWeb: "Controllo di sicurezza e ricerca sul web…",
		screeningDocumentsWeb: "Controllo di sicurezza e ricerca nei nostri documenti e sul web…",
		searching: "Ricerca sul web…",
		searchingDocuments: "Ricerca nei nostri documenti…",
		searchingDocumentsWeb: "Ricerca nei nostri documenti e sul web…",
		waitingSandbox: "In attesa di una sandbox libera…",
		thinking: (m) => `${m} sta ragionando…`,
		writing: (m) => `${m} sta scrivendo la risposta…`,
		retrieved: (from, n) => `Trovato in ${from} · ${n} font${n === 1 ? "e" : "i"}`,
		declined: "Rifiutato dal filtro di sicurezza",
		failover: (from, to, skipped) =>
			`${from} ${skipped ? "è stato saltato" : "non ha risposto"} · passato a ${to} (riserva)`,
	},
	pt: {
		gapLabel: "Lacuna em aberto",
		gapAria: "Uma lacuna na pilha de código aberto",
		gapTitle:
			"Esta resposta esbarra numa lacuna da pilha de código aberto: uma peça pública que ainda não existe. Pode vê-la no mapa e ajudar a construí-la.",
		gapNeeds: (ask) => `Ainda falta à IA aberta ${ask}.`,
		gapAction: "Ajude a construir",
		howMade: "Como esta resposta foi feita",
		fixedNotice: "Nenhum modelo escreveu esta resposta. É um aviso fixo do Alpha.",
		tryAnyway: "Tentar mesmo assim",
		tryAnywayMessage: "Tente mesmo assim, por favor.",
		noProvenance: "Sem proveniência para esta resposta: nada indicou que modelo a produziu.",
		placeholder: "Pergunte o que quiser.",
		gapLines: { websearch: "Ainda nenhum índice de pesquisa aberto cobre toda a web." },
		theModel: "O modelo",
		preparing: "Preparando a resposta…",
		fixedReply: "Respondendo com um aviso fixo…",
		audio: "Gerando o áudio…",
		generating: (m) => `${m} está escrevendo…`,
		screening: "Verificando a segurança…",
		screeningPart: (p, n) => `parte ${p} de ${n}`,
		screeningDocuments: "Verificando a segurança e pesquisando nos nossos documentos…",
		screeningWeb: "Verificando a segurança e pesquisando na web…",
		screeningDocumentsWeb: "Verificando a segurança e pesquisando nos nossos documentos e na web…",
		searching: "Pesquisando na web…",
		searchingDocuments: "Pesquisando nos nossos documentos…",
		searchingDocumentsWeb: "Pesquisando nos nossos documentos e na web…",
		waitingSandbox: "Aguardando uma sandbox livre…",
		thinking: (m) => `${m} está pensando…`,
		writing: (m) => `${m} está escrevendo a resposta…`,
		retrieved: (from, n) => `Encontrado em ${from} · ${n} fonte${n === 1 ? "" : "s"}`,
		declined: "Recusado pelo filtro de segurança",
		failover: (from, to, skipped) =>
			`${from} ${skipped ? "foi ignorado" : "não respondeu"} · trocado para ${to} (reserva)`,
	},
	nl: {
		gapLabel: "Open gat",
		gapAria: "Een gat in de open stack",
		gapTitle:
			"Dit antwoord loopt tegen een gat in de open stack aan: een publiek onderdeel dat nog niet bestaat. Je kunt het op de kaart zien en helpen het te dichten.",
		gapNeeds: (ask) => `Open source AI mist nog ${ask}.`,
		gapAction: "Help het bouwen",
		howMade: "Hoe dit antwoord tot stand kwam",
		fixedNotice: "Geen model heeft dit antwoord geschreven. Het is een vaste melding van Alpha.",
		tryAnyway: "Toch proberen",
		tryAnywayMessage: "Probeer het toch, alsjeblieft.",
		noProvenance: "Geen herkomst voor dit antwoord: niets meldde welk model het heeft gemaakt.",
		placeholder: "Stel je vraag.",
		gapLines: { websearch: "Nog geen enkele open zoekindex dekt het hele web." },
		theModel: "Het model",
		preparing: "Antwoord wordt voorbereid…",
		fixedReply: "Antwoord met een vaste melding…",
		audio: "Audio wordt gemaakt…",
		generating: (m) => `${m} schrijft…`,
		screening: "Veiligheidscontrole…",
		screeningPart: (p, n) => `deel ${p} van ${n}`,
		screeningDocuments: "Veiligheidscontrole en zoeken in onze documenten…",
		screeningWeb: "Veiligheidscontrole en zoeken op het web…",
		screeningDocumentsWeb: "Veiligheidscontrole en zoeken in onze documenten en op het web…",
		searching: "Zoeken op het web…",
		searchingDocuments: "Zoeken in onze documenten…",
		searchingDocumentsWeb: "Zoeken in onze documenten en op het web…",
		waitingSandbox: "Wachten op een vrije sandbox…",
		thinking: (m) => `${m} denkt na…`,
		writing: (m) => `${m} schrijft het antwoord…`,
		retrieved: (from, n) => `Gevonden in ${from} · ${n} bron${n === 1 ? "" : "nen"}`,
		declined: "Geweigerd door de veiligheidscontrole",
		failover: (from, to, skipped) =>
			`${from} ${skipped ? "is overgeslagen" : "gaf geen antwoord"} · overgeschakeld naar ${to} (reserve)`,
	},
};

/** The chrome language for a browser's first-choice language subtag: one with a table, else "en". */
export function chromeLanguage(preferred: string | null | undefined): ChromeLanguage {
	return (CHROME_LANGUAGES as readonly string[]).includes(preferred ?? "") ? (preferred as ChromeLanguage) : "en";
}

export function chromeCopy(lang: string | null | undefined): ChromeCopy {
	return COPY[chromeLanguage(lang)];
}

/** The copy for a gap card and its sentence: the visitor's language when the gap has a line in it, else
 *  English, so a card is never half translated. A gap with no line anywhere falls back to `gapNeeds`. */
export function gapCardCopy(
	lang: string | null | undefined,
	node: string,
	ask: string
): { copy: ChromeCopy; line: string } {
	const copy = chromeCopy(lang);
	const line = copy.gapLines[node];
	if (line) return { copy, line };
	return { copy: EN, line: EN.gapLines[node] ?? EN.gapNeeds(ask) };
}

export type { ChromeCopy };
