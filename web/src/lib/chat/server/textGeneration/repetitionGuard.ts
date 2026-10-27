// Detect a generation that got stuck echoing the same short clause over and over (CUR-1104).
//
// The shape: an answer echoes the user's question once, then loops on one 5-8 word clause 2-4 more
// times with only a leading connector word varying each pass. For example, from Yoruba input:
//
//   "Bawo ni, se o le ran mi lowo pelu nkankan?
//    Nkaa, ndi o le ran mi lowo pelu nkankan. Ndi o le ran mi lowo pelu nkankan, ndi o le ran mi
//    lowo pelu nkankan."
//
// `low-resource-language-fallback` (languageFallback.ts) cannot catch this on its own: it is a
// curated per-language word list, and casual-register Yoruba shares no vocabulary with the formal
// UDHR corpus that list is sourced from. Covering this failure shape language by language does not
// scale, as that file's own header documents. This module is deliberately LANGUAGE-AGNOSTIC instead:
// it measures word-sequence repetition structurally, the same way degeneration.ts measures
// markup-structural collapse rather than fitting a threshold to one case's symptom.
//
// ── WHY A WORD N-GRAM, NOT THE "REPEATED-SHINGLE RATIO" DEGENERATION.TS REJECTS ──────────────────
//
// degeneration.ts's header explains why a whole-answer repeated-shingle RATIO fails against real
// fixtures in the direction that matters: legitimate repetitive code scores HIGHER than a real
// collapsed answer. A ratio conflates "the whole answer is short
// and disciplined" with "the whole answer is one clause on a loop" — both produce a small number of
// distinct shingles relative to length.
//
// This measures something narrower and more specific: does the SAME CONSECUTIVE run of N words
// occur at least K times ANYWHERE in the answer, verbatim (case-insensitive). Real prose reusing a
// phrase for rhetorical effect (anaphora: "I have a dream that…") repeats a short lead-in and then
// diverges — the repeated span rarely holds for 6 consecutive words 3 times over. Loops like the one
// above repeat a 7-word span 3-4 times with nothing else in between. N=6/K=3 sits below the
// observed real failures and above ordinary rhetorical repetition; it has not been tuned against a
// large corpus of legitimate answers, so `repetitionGuardEnabled()` gates it off by default (see
// below) pending exactly that kind of live verification, same posture as CUR-742/CUR-958.
//
// ── WHAT THIS DOES NOT CATCH, STATED PLAINLY ─────────────────────────────────────────────────────
//
// A degeneration that never repeats the SAME 6-word span 3 times — a loop that rephrases itself
// slightly each pass, or one that only manages two repeats before the token budget runs out. Also:
// structural markup collapse (degeneration.ts's own case) is untouched here, and this module's own
// collapse case is untouched there. Two narrow, validated signals beat one broad, unvalidated one.

import type { DeclineLanguage } from "$lib/chat/server/declineCopy";
import { FENCE_RE, INLINE_CODE_RE } from "./degeneration";
import { flagEnabledOr } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. See CUR-1104. Default off — this REPLACES the live answer text
 *  outright on a hit (unlike degeneration.ts, which only observes), so it ships dark pending a live
 *  verification pass against real traffic, same posture as CUR-742/CUR-958. */
export const REPETITION_GUARD_FLAG = "repetition-guard";

export function repetitionGuardEnabled(): boolean {
	return flagEnabledOr(REPETITION_GUARD_FLAG, () => false);
}

/** Consecutive-word span length a repeat is measured over. See the header for why 6. */
export const REPETITION_NGRAM_WORDS = 6;

/** How many times that exact span must recur before this counts as degenerate. See the header. */
export const REPETITION_MIN_OCCURRENCES = 3;

/** The pre-stored, honest replacement — never generated, so a degenerate turn can't compound its own
 *  failure by trying to apologize for itself in the same broken register. Mirrors
 *  languageFallback.ts's lowResourceFallbackMessage: a fixed string beats asking the same model that
 *  just got stuck to now describe getting stuck. Callers take it through repetitionNotice.
 *  @internal exported for the specs */
export const DEGENERATE_REPETITION_FALLBACK_MESSAGE =
	"I got stuck repeating myself and couldn't produce a reliable answer here. Could you try " +
	"rephrasing the question, or asking in a different language?";

/** The same notice in the language the person wrote in (CUR-4052), from the languages a decline is
 *  translated into (declineCopy.ts), so a French turn that loops ends in French. */
const REPETITION_NOTICES: Record<Exclude<DeclineLanguage, "en">, string> = {
	es: "Me quedé atascado repitiéndome y no pude dar una respuesta fiable. ¿Podrías reformular la pregunta o hacerla en otro idioma?",
	fr: "Je me suis mis à me répéter et je n'ai pas pu donner de réponse fiable. Pourriez-vous reformuler la question, ou la poser dans une autre langue ?",
	pt: "Fiquei preso a repetir-me e não consegui dar uma resposta fiável. Pode reformular a pergunta, ou fazê-la noutra língua?",
	de: "Ich habe mich ständig wiederholt und konnte keine verlässliche Antwort geben. Könnten Sie die Frage umformulieren oder in einer anderen Sprache stellen?",
	it: "Mi sono bloccato a ripetermi e non sono riuscito a dare una risposta affidabile. Potresti riformulare la domanda, o farla in un'altra lingua?",
	ca: "M'he quedat encallat repetint-me i no he pogut donar una resposta fiable. Podries reformular la pregunta, o fer-la en una altra llengua?",
	ta: "நான் ஒரே விஷயத்தைத் திரும்பத் திரும்பச் சொல்லிக்கொண்டிருந்தேன், நம்பகமான பதிலைத் தர முடியவில்லை. கேள்வியை வேறு விதமாகக் கேட்கலாமா, அல்லது வேறு மொழியில் கேட்கலாமா?",
};

/** The loop notice in `lang`, or in English when it has no translation. */
export function repetitionNotice(lang: DeclineLanguage = "en"): string {
	return lang === "en" ? DEGENERATE_REPETITION_FALLBACK_MESSAGE : REPETITION_NOTICES[lang];
}

export interface RepetitionVerdict {
	/** true once any REPETITION_NGRAM_WORDS-word span recurs REPETITION_MIN_OCCURRENCES+ times */
	repeated: boolean;
	/** the offending span, space-joined lowercase words — null when repeated is false */
	ngram: string | null;
	/** how many times that span occurs — 0 when repeated is false */
	count: number;
}

const WORD_RE = /[\p{L}']+/gu;

/**
 * Score an answer for stuck-in-a-loop word repetition. Pure and allocation-cheap — this runs once
 * per turn on the FinalAnswer path, same call site as measureDegeneration.
 */
export function detectDegenerateRepetition(text: string): RepetitionVerdict {
	const prose = (text ?? "").replace(FENCE_RE, " ").replace(INLINE_CODE_RE, " ");
	const words = prose.toLowerCase().match(WORD_RE) ?? [];
	if (words.length < REPETITION_NGRAM_WORDS) {
		return { repeated: false, ngram: null, count: 0 };
	}

	const counts = new Map<string, number>();
	for (let i = 0; i <= words.length - REPETITION_NGRAM_WORDS; i++) {
		const gram = words.slice(i, i + REPETITION_NGRAM_WORDS).join(" ");
		const next = (counts.get(gram) ?? 0) + 1;
		counts.set(gram, next);
		if (next >= REPETITION_MIN_OCCURRENCES) {
			return { repeated: true, ngram: gram, count: next };
		}
	}
	return { repeated: false, ngram: null, count: 0 };
}
