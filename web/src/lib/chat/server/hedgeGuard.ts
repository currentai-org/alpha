import { parentLanguage } from "$lib/chat/routing/languages";
// Recency-hedge guard — the runtime "strip" half of the grounding-honesty enforcement.
//
// On a GROUNDED turn (the user searched the open web, or RAG/vault evidence was injected this
// turn), a recency disclaimer in the answer — "my knowledge may be out of date", "I can't access
// real-time information", "for the latest, consult recent sources" — is FALSE by construction:
// fresh sources were retrieved and shown for this exact turn. The honest currency signal already
// lives in the provenance chip ("looked it up · as of <date>"), so a prose hedge on a grounded
// turn is both redundant and wrong.
//
// Counter-instructions bolted onto the prompt wash out or backfire; the only thing that reliably
// enforces a "don't do X" is a deterministic runtime test + correction, OUT of the prompt — the same
// design as $lib/chat/server/nameGuard. So this module
// is the test (does this grounded answer carry a recency hedge?) and a precise, conservative strip
// (remove the offending sentences); the stream seam persists the cleaned text and the post-stream
// invalidate re-renders it honestly. The persona already DROPS the recency clause when grounded
// (persona.ts); this guard catches what the model volunteers anyway, which the prompt can't.
//
// Pure + side-effect-free so it is fully unit-testable and reusable by the eval harness.

export interface RecencyHedgeResult {
	/** the grounded answer contains a recency/real-time-access disclaimer */
	hedged: boolean;
	/** the text with isolated hedge sentences removed — or the ORIGINAL when a safe strip isn't
	 *  possible (stripping would gut the answer). Callers persist this; never an empty answer. */
	cleaned: string;
	/** the non-hedge sentences joined — the RAW strip result BEFORE the safe-strip floor bails to
	 *  `cleaned`. May be empty/tiny. Lets a caller tell "mostly useful, one hedge removed" from "the
	 *  answer WAS the hedge". */
	keptText: string;
	/** true when the answer minus its hedge sentences has NO substantive content left (no alphanumeric
	 *  survives) — i.e. the whole answer WAS the hedge/refusal. On a GROUNDED turn the caller replaces
	 *  such an answer with a deterministic honest pointer. A SHORT but complete non-hedge sentence
	 *  ("It passed in 2024.") is NOT bailed — it's useful residue the caller keeps via `keptText`. */
	bailedWholeAnswer: boolean;
}

// Sentence-level recency-disclaimer patterns. Each matches a sentence whose PURPOSE is to disclaim
// currency or live access — the thing a grounded turn must not say. Kept sentence-scoped (not
// substring) so we only ever remove a whole disclaiming sentence, never mangle a substantive one.
const RECENCY_ADVICE_HEDGE =
	/\bfor (?:\w+\s+){0,2}(?:latest|most recent|current|up[- ]to[- ]date|recent)\b[^.!?]*\b(?:consult|refer to|check|visit|go to|head to)\b[^.!?]*\b(?:research|sources?|journals?|literature|news|publications?|reports?|websites?|databases?|updates?|outlets?|announcements?|repositor(?:y|ies)|channels?|documentation|docs|feeds?|portals?|resources?|sites?)\b/i;

const HEDGE_PATTERNS: RegExp[] = [
	// "my knowledge/training (data) may be out of date / is not up to date / has a cutoff"
	/\b(?:my|the)\s+(?:knowledge|training)(?:\s+data)?\b[^.!?]*\b(?:out[- ]of[- ]date|outdated|not\s+(?:up[- ]to[- ]date|current)|cutoff|cut[- ]off|may\s+have\s+changed|limited)\b/i,
	// cutoff-DATE phrasing (no "out of date/cutoff" vocabulary): "(based on) my training data up until
	// June 2026", "my knowledge only goes up to 2024", "my training ends in 2023" — the model disclosing
	// its cutoff, the false hedge on a grounded turn. Requires a cutoff verb AND a 4-digit YEAR
	// within ~20 chars, so a benign "my training covers up to advanced topics" (no year) never matches.
	/\b(?:my|the)\s+(?:knowledge|training)(?:\s+data)?\b[^.!?]*\b(?:up\s+(?:until|to)|through|ends?|only\s+(?:goes|extends|covers))\b[^.!?]{0,20}\b\d{4}\b/i,
	// "as of / since my last update / training / knowledge" — e.g. "…as they may have changed since my
	// last update", where "they" (the points)
	// isn't "my knowledge", so the out-of-date pattern above doesn't fire; this anchor catches it.
	/\b(?:as of|since)\s+my\s+(?:last\s+)?(?:update|training|knowledge)\b/i,
	/\bknowledge cut[- ]?off\b/i,
	// capability disclaimers: "I can't / cannot / don't / do not + access/browse/search/provide
	// real-time / live / current / up-to-date information / the web / the internet"
	/\bI\s+(?:can(?:'?t|not)|do(?:\s+not|n'?t)|am\s+(?:un)?able|am\s+not\s+able)\b[^.!?]*\b(?:real[- ]time|live|current|up[- ]to[- ]date|latest|recent|internet|web|online|browse|search)\b/i,
	// "I don't have real-time / live / up-to-date / current / internet / web information or access"
	/\bI\s+do(?:\s+not|n'?t)\s+have\b[^.!?]*\b(?:real[- ]time|live|up[- ]to[- ]date|current|latest|internet|web|online)\b/i,
	// SELF-DESCRIPTOR capability denial: "I'm a machine / a text-based model / an AI … and cannot / can't /
	// don't have access … web / internet / search / browse / live". The I-anchored patterns above MISS
	// this because the denial modal follows "and"/the descriptor noun, not "I" — e.g. "I'm a machine AND
	// cannot perform live web searches" and "I'm a text-based model AND don't have access to the internet",
	// both of which the I-anchored patterns miss. Requires a self-descriptor
	// noun + a denial verb + a live/web noun in one sentence, so it only ever strips a self-disclaiming line.
	/\bI(?:'?m| am)\s+(?:a|an)\s+(?:[a-z-]+\s+){0,2}(?:machine|model|AI|LLM|assistant|bot|program|system)\b[^.!?]*\b(?:can(?:'?t|not)|cannot|do(?:\s+not|n'?t)|unable|not\s+able|no\s+access|without\s+access)\b[^.!?]*\b(?:real[- ]time|live|current|up[- ]to[- ]date|latest|recent|internet|web|online|browse|search)\b/i,
	// recency-advice hedge: "for the latest/most recent/current ..., consult/refer to/check/visit
	// recent research/sources/journals/news outlets/..." — telling the user to go research it themselves
	// AFTER we already searched. REQUIRES a generic research-target noun (not "see [n]") so it can never
	// strip a legitimate cited-source pointer like "for the latest figures, see [2]". The verb set covers
	// the soft "please visit a reliable news source" phrasing too.
	RECENCY_ADVICE_HEDGE,
];

const CITATION_MARKER = /\[\d+\]/;
const SOURCE_POINTER_VERB =
	/\b(?:see|check|consult|refer to|visit|use|sources?|references?|resources?|figures?|details?|documents?|reports?)\b/i;
const SOURCE_LIST_INTRO =
	/\b(?:check|consult|refer to|visit|use|start with|look at)\b[^.!?]*\b(?:these|the|following|official|primary|reliable)?\s*(?:sources?|references?|resources?|documents?|reports?|sites?)\s*:\s*$/i;

export const isSourceAnswerSentence = (s: string): boolean =>
	(CITATION_MARKER.test(s) && SOURCE_POINTER_VERB.test(s)) || SOURCE_LIST_INTRO.test(s);

// Exported so the semantic catch-all ($lib/chat/server/semanticHedge) reuses the SAME regex pass + sentence
// splitter + safe-strip floor — the embedding layer only adds recall on top, never forks the logic.
export const isHedgeSentence = (s: string): boolean =>
	HEDGE_PATTERNS.some((re) => {
		if (re === RECENCY_ADVICE_HEDGE && isSourceAnswerSentence(s)) return false;
		return re.test(s);
	});

// Split into sentences on terminal punctuation followed by whitespace, keeping the punctuation —
// AND on line breaks, so a list item / bullet WITHOUT trailing punctuation is its own unit. Without
// the newline boundary, "Key points:\n- I can't access real-time data\n- The Act took force in 2024."
// is ONE sentence: a hedge match on the middle bullet strips the heading and the factual bullet with
// it. Good enough for prose; abbreviations occasionally over-split but that only affects which
// boundary a strip lands on, never the kept text.
// Arabic/Urdu terminal marks (؟ ۔) split like their Latin twins, on following whitespace; CJK
// full-width marks (。！？) split with or without it, since Chinese and Japanese put no space after them.
export const splitSentences = (text: string): string[] =>
	text.split(/(?<=[.!?\u061F\u06D4])\s+|(?<=[\u3002\uFF01\uFF1F])\s*|\n+/).filter((s) => s.trim().length > 0);

/** Rejoin the sentences a strip kept: one space between them, none after a full-width mark (。！？),
 *  since Chinese and Japanese never put a space there. */
export const joinKeptSentences = (kept: string[]): string =>
	kept
		.join(" ")
		.replace(/\s{2,}/g, " ")
		.replace(/([\u3002\uFF01\uFF1F]) /g, "$1")
		.trim();

/** True when the text carries a letter or digit in ANY script once `[n]` citation markers are removed.
 *  Unicode-aware on purpose: an ASCII-only `[A-Za-z0-9]` test reads a whole Arabic, Chinese or Greek
 *  answer as empty and swaps the grounded-hedge replacement in over it (CUR-4356). */
export const hasSubstantiveText = (text: string): boolean =>
	/[\p{L}\p{N}]/u.test(text.replace(/\[\d+\]/g, ""));

// Don't return an empty or gutted answer — when the hedge sentence(s) were most of the message, a
// heavily-hedged answer is better KEPT (still honest-ish; the chip says "looked it up") than reduced
// to a fragment. Bail to the original when fewer than this many chars survive the strip. An ABSOLUTE
// floor (not a ratio): a legitimate short remainder like "It entered into force in 2024." must
// survive even if the dropped hedge sentence was longer than it. Conservative: precision over recall.
export const MIN_KEEP_CHARS = 24;

/**
 * Detect a recency hedge in a GROUNDED answer and return a cleaned copy with the disclaiming
 * sentences removed. The caller is responsible for only invoking this on grounded turns (a recency
 * hedge is honest on an ungrounded turn). Never returns an empty/gutted answer: when a safe strip
 * isn't possible, `cleaned` is the original text and the caller can leave the answer untouched while
 * still recording `hedged` for eval.
 */
export function detectRecencyHedge(text: string): RecencyHedgeResult {
	const original = text ?? "";
	if (!original.trim())
		return { hedged: false, cleaned: original, keptText: original, bailedWholeAnswer: false };

	const sentences = splitSentences(original);
	const kept: string[] = [];
	let removed = false;
	for (const s of sentences) {
		if (isHedgeSentence(s)) {
			removed = true;
			continue;
		}
		kept.push(s);
	}

	if (!removed)
		return { hedged: false, cleaned: original, keptText: original, bailedWholeAnswer: false };

	const keptText = joinKeptSentences(kept);
	// bailedWholeAnswer: the answer, minus its hedge sentences, has NO substantive content left — the
	// whole answer WAS the hedge. Keyed on "no alphanumeric survives", NOT a char-count: a SHORT but
	// complete non-hedge sentence ("It passed in 2024.") is useful residue to preserve (via keptText), not
	// a whole-answer refusal to replace.
	// Citation markers are stripped from this check FIRST: a bare "[1] [2]" kept-text (the model hedged,
	// then only tacked on citation numbers with no actual prose) DOES match a letter-or-digit test on the digits
	// inside the brackets, so without this the whole-answer bail never fires and the caller ships the
	// literal citation markers as the entire answer (a grounded turn would persist "[1] [2]" as its
	// full text). [n] is never substantive content on its own.
	const bailedWholeAnswer = !hasSubstantiveText(keptText);
	// `cleaned` keeps the conservative safe-strip floor (never persist a sub-MIN_KEEP_CHARS fragment as
	// THE answer); a caller that wants the useful-but-short residue reads `keptText` directly.
	const cleaned = keptText.length >= MIN_KEEP_CHARS ? keptText : original;
	return { hedged: true, cleaned, keptText, bailedWholeAnswer };
}

/** A source citable in the deterministic grounded-hedge replacement — just its citation number + title
 *  (the retrieved sources are already rendered in the provenance strip; the pointer only needs to name
 *  them). Both RAG and web sources carry `n` + `title`, so a caller maps either onto this. */
export type CitableSource = { n: number; title: string };

/** Deterministic honest replacement for a GROUNDED turn whose whole answer was a refusal/hedge
 *  (bailedWholeAnswer). We can't synthesize the answer (that needs the model), so we point the user to
 *  the sources that WERE retrieved and are already shown in the provenance strip. Falls back to a
 *  source-less line for a vault-synthesis-only turn (grounded, but no numbered citable sources). Pure +
 *  exported for testing. See conversation/[id]/+server.ts (the FinalAnswer chokepoint).
 *
 *  DESCRIBE, DON'T ASSERT — the copy must not open "I found sources relevant to this question", because
 *  relevance is the one thing this path cannot know. It fires precisely when the model looked at these
 *  sources and declined to answer from them, which is the strongest available evidence they were NOT
 *  relevant; that sentence over a YouTube link would be wrong (CUR-148). A guard whose whole job is to
 *  stop unbacked claims must not make one in its own replacement text. Any future wording here states
 *  what happened (retrieved, didn't answer) and never characterises the sources. */
export function buildGroundedHedgeReplacement(sources: CitableSource[], language?: string): string {
	const copy = HEDGE_REPLACEMENT_COPY[hedgeCopyKey(language)];
	if (sources.length === 0) {
		// Vault-synthesis-only grounded turn: there are NO numbered source chips to open, so don't claim any.
		return copy.none;
	}
	const list = sources
		.slice(0, 6)
		.map((s) => `[${s.n}] ${s.title}`)
		.join(copy.separator);
	return copy.some(list);
}

type HedgeCopy = { some: (list: string) => string; none: string; separator: string };

/** The replacement in the language the person wrote in (CUR-4339), keyed by 639-3 base tag. Same facts in
 *  each: retrieved, didn't answer, and the source list or that there is none. The Amharic and Arabic
 *  lines want a native speaker's review; until then they are checked only by blind back-translation
 *  from three models. The Amharic `none` line is two sentences so each reads on its own. */
const HEDGE_REPLACEMENT_COPY: Record<string, HedgeCopy> = {
	eng: {
		some: (l) => `I retrieved these sources but didn't write an answer from them this time: ${l}.`,
		none: "I retrieved reference material for this question but didn't write an answer from it this time, and there's no citable source list to point you to.",
		separator: ", ",
	},
	spa: {
		some: (l) => `Consulté estas fuentes, pero esta vez no redacté una respuesta a partir de ellas: ${l}.`,
		none: "Consulté material de referencia para esta pregunta, pero esta vez no redacté una respuesta a partir de él, y no hay una lista de fuentes citables que mostrarte.",
		separator: ", ",
	},
	fra: {
		some: (l) => `J'ai consulté ces sources, mais cette fois je n'en ai pas tiré de réponse : ${l}.`,
		none: "J'ai consulté des documents de référence pour cette question, mais cette fois je n'en ai pas tiré de réponse, et je n'ai pas de liste de sources citables à vous indiquer.",
		separator: ", ",
	},
	por: {
		some: (l) => `Consultei estas fontes, mas desta vez não escrevi uma resposta a partir delas: ${l}.`,
		none: "Consultei material de referência para esta pergunta, mas desta vez não escrevi uma resposta a partir dele, e não há uma lista de fontes citáveis para lhe indicar.",
		separator: ", ",
	},
	deu: {
		some: (l) => `Ich habe diese Quellen abgerufen, diesmal aber keine Antwort daraus geschrieben: ${l}.`,
		none: "Ich habe Referenzmaterial zu dieser Frage abgerufen, diesmal aber keine Antwort daraus geschrieben, und es gibt keine zitierbare Quellenliste, auf die ich verweisen kann.",
		separator: ", ",
	},
	ita: {
		some: (l) => `Ho consultato queste fonti, ma questa volta non ne ho tratto una risposta: ${l}.`,
		none: "Ho consultato materiale di riferimento per questa domanda, ma questa volta non ne ho tratto una risposta, e non c'è un elenco di fonti citabili da indicarti.",
		separator: ", ",
	},
	cat: {
		some: (l) => `He consultat aquestes fonts, però aquesta vegada no n'he redactat cap resposta: ${l}.`,
		none: "He consultat material de referència per a aquesta pregunta, però aquesta vegada no n'he redactat cap resposta, i no hi ha cap llista de fonts citables per indicar-te.",
		separator: ", ",
	},
	tam: {
		some: (l) => `இந்த ஆதாரங்களைத் தேடி எடுத்தேன், ஆனால் இந்த முறை அவற்றிலிருந்து பதில் எழுதவில்லை: ${l}.`,
		none: "இந்தக் கேள்விக்கான குறிப்புத் தகவல்களைத் தேடி எடுத்தேன், ஆனால் இந்த முறை அவற்றிலிருந்து பதில் எழுதவில்லை, மேலும் சுட்டிக்காட்ட மேற்கோள் காட்டக்கூடிய ஆதாரப் பட்டியல் எதுவும் இல்லை.",
		separator: ", ",
	},
	amh: {
		some: (l) => `እነዚህን ምንጮች አግኝቻለሁ፤ ነገር ግን በዚህ ጊዜ ከእነሱ መልስ አልጻፍኩም፦ ${l}።`,
		none: "ለዚህ ጥያቄ የማጣቀሻ መረጃ አግኝቻለሁ፤ ነገር ግን በዚህ ጊዜ ከመረጃው መልስ አልጻፍኩም። ልጠቅሰው የምችለው የምንጭ ዝርዝር የለም።",
		separator: "፣ ",
	},
	arb: {
		some: (l) => `استرجعتُ هذه المصادر لكنني لم أكتب إجابة منها هذه المرة: ${l}.`,
		none: "استرجعتُ مواد مرجعية لهذا السؤال لكنني لم أكتب إجابة منها هذه المرة، ولا توجد قائمة مصادر قابلة للاستشهاد لأرشدك إليها.",
		separator: "، ",
	},
};

/** The copy key for a detected tag: its base, its parent (a dialect such as `arz` reads as `arb`), or English. */
function hedgeCopyKey(language: string | undefined): string {
	if (!language) return "eng";
	const base = language.split("-")[0].toLowerCase();
	if (HEDGE_REPLACEMENT_COPY[base]) return base;
	const parent = parentLanguage(base);
	return parent && HEDGE_REPLACEMENT_COPY[parent] ? parent : "eng";
}
