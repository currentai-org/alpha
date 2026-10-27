// Put a line someone in Europe can use ahead of the US 988 line in a distress answer (CUR-2136).
//
// WHY A GUARD AND NOT ONLY THE PROMPT. CRISIS_AND_VALUES_CLAUSE (persona.ts) already tells the model
// to name findahelpline.com first and 988 only for the US. A prompt line does not always hold (see
// crisis_referral.py): some answers open with a US-first list ("in the U.S., dial or text 988; in
// Canada, …") and reach findahelpline.com only at the end of the sentence or in a later paragraph.
// A prompt line that fires most of the time is the shape nameGuard already answers with a runtime
// guard.
//
// WHAT IT KEYS ON. Our own resource names, never the user's words: the first `988` in the answer, in a
// sentence that also says "crisis" (the line's own name is the 988 Suicide & Crisis Lifeline, and the model
// calls it a crisis line). It does not decide whether the user is in distress; the
// model already did that by writing a crisis line. A bare "call 988" with no "crisis" in its sentence is
// left alone, which is today's behaviour.
//
// WHAT IT DOES. Inserts one fixed sentence naming findahelpline.com and 112 immediately before the
// sentence that holds that 988, unless findahelpline or 112 has already been written. 988 stays where
// the model put it: for someone in the US it is still the right number, just no longer the first.
// One decision per answer: the first 988 decides, inserted or not, and nothing later is touched.

/**
 * PostHog kill switch, read at the call site in honestyStream.ts. DEFAULTS ON: the guard ships enabled and the flag exists to stop it without a deploy,
 * so an unreachable PostHog changes nothing. Deployment plane; set it to 0 or 100, never in between.
 */
import type { DeclineLanguage } from "$lib/chat/server/declineCopy";

export const CRISIS_REFERRAL_ORDER_FLAG = "crisis-referral-order";

/**
 * The sentence inserted ahead of a 988 line, in the language the person wrote in (CUR-4061).
 * findahelpline.com is on urlGuard's STATIC_ALLOW.
 */
const EUROPEAN_LINE_SENTENCE: Record<DeclineLanguage, string> = {
	en: "Wherever you are, [findahelpline.com](https://findahelpline.com) lists free, confidential crisis lines for your country, and anywhere in Europe you can call 112 in an emergency.",
	es: "Estés donde estés, [findahelpline.com](https://findahelpline.com) reúne líneas de crisis gratuitas y confidenciales de tu país, y en cualquier lugar de Europa puedes llamar al 112 en caso de emergencia.",
	fr: "Où que vous soyez, [findahelpline.com](https://findahelpline.com) répertorie des lignes d'écoute gratuites et confidentielles pour votre pays, et partout en Europe vous pouvez appeler le 112 en cas d'urgence.",
	pt: "Esteja onde estiver, [findahelpline.com](https://findahelpline.com) reúne linhas de apoio gratuitas e confidenciais para o seu país, e em qualquer lugar da Europa pode ligar para o 112 numa emergência.",
	de: "Wo auch immer Sie sind: [findahelpline.com](https://findahelpline.com) listet kostenlose, vertrauliche Krisentelefone für Ihr Land auf, und überall in Europa erreichen Sie im Notfall die 112.",
	it: "Ovunque tu sia, [findahelpline.com](https://findahelpline.com) elenca linee di ascolto gratuite e riservate per il tuo paese, e ovunque in Europa puoi chiamare il 112 in caso di emergenza.",
	ca: "Siguis on siguis, [findahelpline.com](https://findahelpline.com) recull línies d'ajuda gratuïtes i confidencials per al teu país, i a qualsevol lloc d'Europa pots trucar al 112 en cas d'emergència.",
	ta: "நீங்கள் எங்கிருந்தாலும், [findahelpline.com](https://findahelpline.com) உங்கள் நாட்டுக்கான இலவச, ரகசியமான நெருக்கடி உதவி எண்களைப் பட்டியலிடுகிறது; ஐரோப்பாவில் எங்கும் அவசர நிலையில் 112 ஐ அழைக்கலாம்.",
};

// Already pointed somewhere a person in Europe can call: the country finder or the EU emergency number.
const EUROPEAN = /findahelpline|(?<![\d-])\b112\b(?![\d-])/i;
// 988 as a number of its own: not 1-988-…, not 9880, not 988.5.
const LINE_988 = /(?<![\d.,-])\b988\b(?![\d-]|[.,]\d)/;
const CRISIS = /\bcris[ie]s\b/i;
// A list item's marker, so the inserted line can join the list instead of breaking it.
const LIST_MARKER = /^([ \t]*)([-*+]|\d+[.)])[ \t]+/;

export interface CrisisReferralOrderResult {
	/** the first 988 was seen in this text, so the per-answer decision is now made */
	decided: boolean;
	/** the European line was inserted */
	inserted: boolean;
	/** the text with the line inserted; the ORIGINAL when nothing was */
	cleaned: string;
}

// Start of the sentence (or line) that holds `idx`. A period counts as a boundary only when the next
// word starts upper-case, so "in the U.S. call 988" stays one sentence.
function sentenceStart(text: string, idx: number): number {
	for (let i = idx - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === "\n") return i + 1;
		if ((ch === "." || ch === "!" || ch === "?") && /\s/.test(text[i + 1] ?? "")) {
			const rest = text.slice(i + 1);
			const next = rest.match(/^\s+(\S)/);
			if (ch !== "." || (next && /[A-Z*_[("'“]/.test(next[1]))) {
				return i + 1 + (rest.match(/^\s+/)?.[0].length ?? 0);
			}
		}
	}
	return 0;
}

function sentenceEnd(text: string, idx: number): number {
	const m = text.slice(idx).match(/[.!?](?=\s|$)|\n/);
	return m && m.index !== undefined ? idx + m.index + 1 : text.length;
}

/**
 * Insert EUROPEAN_LINE_SENTENCE in `lang` ahead of the first crisis-line 988 in `text`, given everything already
 * released before it. Returns `decided: false` while no 988 has appeared, so the caller keeps asking.
 */
export function leadWithEuropeanLine(
	text: string,
	releasedBefore: string,
	lang: DeclineLanguage = "en"
): CrisisReferralOrderResult {
	const m = LINE_988.exec(text);
	if (!m) return { decided: false, inserted: false, cleaned: text };
	const idx = m.index;
	const start = sentenceStart(text, idx);
	const sentence = text.slice(start, sentenceEnd(text, idx));
	if (EUROPEAN.test(releasedBefore) || EUROPEAN.test(text.slice(0, idx)) || !CRISIS.test(sentence)) {
		return { decided: true, inserted: false, cleaned: text };
	}
	const line = text.slice(start).split("\n", 1)[0];
	const marker = line.match(LIST_MARKER);
	const insertion = marker
		? `${marker[1]}${marker[2]} ${EUROPEAN_LINE_SENTENCE[lang]}\n`
		: `${EUROPEAN_LINE_SENTENCE[lang]} `;
	return { decided: true, inserted: true, cleaned: text.slice(0, start) + insertion + text.slice(start) };
}

// GFM autolinks only `www.` and scheme URLs, so when the model writes findahelpline.com as a bare domain
// a person in distress has to copy it into a
// browser (CUR-3909). Skipped after a scheme, `www.`, `/`, `@` or `[`, and before a path or `]`: those
// are already a link, part of one, or a longer URL we should not split.
const BARE_HELPLINE = /(?<![\w./:@[-])findahelpline\.com(?![\w/\]-]|\.\w)/i;

/** Link every bare findahelpline.com in `text`; returns the ORIGINAL when there is none. */
export function linkBareHelpline(text: string): { linked: boolean; cleaned: string } {
	if (!BARE_HELPLINE.test(text)) return { linked: false, cleaned: text };
	const all = new RegExp(BARE_HELPLINE.source, "gi");
	return { linked: true, cleaned: text.replace(all, "[findahelpline.com](https://findahelpline.com)") };
}
