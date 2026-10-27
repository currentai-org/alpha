// The prompt sentences behind the answer settings a person can change (answerPreferences.ts),
// each a pure string, so the fenced user turn (grounding.ts), the persona's {style} paragraph
// (persona.ts) and the `answer-style` section (promptSections.ts) say the same words. This module
// imports nothing from the prompt builders, so both of them can import it.
//
// A clause here renders only when the person set a non-default value. The default prompt on every path
// keeps today's bytes, which persona.spec.ts and the turnRequest snapshots pin. (CUR-3929)
import {
	type AnswerPreferences,
	fixedLanguage,
	type Format,
	languageName,
	type Length,
	type Tone,
} from "$lib/chat/answerPreferences";

/** Tone, as the appositive that follows "You are a machine and you sound like one:". The neutral
 *  wording is persona.ts's own `TONE_CLAUSE_NEUTRAL`; the two others are written to the same shape. */
const TONE_CLAUSE_PLAIN = `plain and friendly, in everyday words, the way a helpful colleague talks, never stiff`;
const TONE_CLAUSE_FORMAL = `formal, measured and precise, in the register of a professional report, with no slang, no chattiness and no exclamation marks`;

/** Plain language on: one sentence, in the persona's extras and in the `answer-style` section. */
export const PLAIN_LANGUAGE_CLAUSE = `Write in plain language: short sentences, everyday words, and no jargon; when a specialist term cannot be avoided, say what it means in a few words.`;

/**
 * Answer length, replacing the brevity sentence of the fenced turn. `normal` is that sentence as it
 * stands today and stays in grounding.ts with its measurements; these two are the other choices. Each
 * keeps the "asks for a specific length" escape, since a person who set Short still gets the
 * 1,500-word guide they asked for (CUR-1842).
 */
export const LENGTH_SENTENCES: Readonly<Record<Exclude<Length, "normal">, string>> = {
	short: `Keep the answer short: at most three sentences, or a list of at most three items, with no preamble and no closing summary. When your message asks for a specific length or a long document, write it at that length, in full.`,
	detailed: `Answer in detail: cover the main points fully, in several short paragraphs or a structured list, with the reasoning and the caveats a careful explainer would give, and do not cut a complex answer short. When your message asks for a specific length, write it at that length.`,
};

/**
 * The answer's format, replacing the fenced turn's bullets sentence ("Put each list item and
 * any section label on its own line, and prefer plain bullet points over numbered sections."), which
 * `auto` keeps in grounding.ts byte for byte. Each keeps the "asks for" escape: a person who set Prose
 * and then asks for a checklist gets the checklist. (CUR-549)
 */
export const FORMAT_SENTENCES: Readonly<Record<Exclude<Format, "auto">, string>> = {
	prose: `Write in prose: full sentences in short paragraphs, with no bullet points, numbered lists or section labels, unless your message asks for a list.`,
	bullets: `Shape the answer as a list: one point per line as a plain bullet, no numbered sections, with at most one short lead-in sentence, unless your message asks for a single sentence or a piece of text to use as it is.`,
};

/** Emojis "when they help". `never`, the default, adds no clause: today's prompt has no emoji (CUR-549)
 *  rule and the answer gets none. */
export const EMOJIS_HELPFUL_CLAUSE = `You may use an emoji where it carries meaning or warmth, at most one or two in an answer, never in a formal or technical passage.`;

/** Suggestions off. A safety referral is kept on purpose: crisis_referral.py measures it. */
export const NO_SUGGESTIONS_SENTENCE = `Answer the question and stop. Add no suggestions, no next steps, and no questions back, unless the message asks for advice. A safety referral is not a suggestion and stays.`;

/** A fixed answer language, replacing every "same language as the message" rule (plan rule 3.2). */
export function fixedLanguageSentence(name: string): string {
	return `Write your ENTIRE reply in ${name}, whatever language the message is written in — every sentence of it, including any sentence about who or what you are.`;
}

/** The tone clause for a non-default tone, or undefined for neutral. */
export function toneClauseFor(tone: Tone): string | undefined {
	return tone === "plain" ? TONE_CLAUSE_PLAIN : tone === "formal" ? TONE_CLAUSE_FORMAL : undefined;
}

/**
 * The shape sentences a non-default row adds: length when not normal, the no-suggestions sentence when
 * suggestions are off, the format when not auto (CUR-549), the fixed-language sentence when the
 * language is fixed. Empty on the defaults.
 */
export function answerShapeFor(prefs: AnswerPreferences): string[] {
	const out: string[] = [];
	if (prefs.answerLength !== "normal") out.push(LENGTH_SENTENCES[prefs.answerLength]);
	if (!prefs.suggestions) out.push(NO_SUGGESTIONS_SENTENCE);
	if (prefs.answerFormat !== "auto") out.push(FORMAT_SENTENCES[prefs.answerFormat]);
	const fixed = fixedLanguage(prefs);
	if (fixed) out.push(fixedLanguageSentence(languageName(fixed)));
	return out;
}

/**
 * The whole-sentence voice clauses a non-default row adds after the tone: plain language and emojis
 * (CUR-549). The persona appends them as {style} extras; the guards-only and native
 * system prompts carry them through `answerVoiceFor`, so every path says the same words.
 */
export function voiceExtrasFor(prefs: AnswerPreferences): string[] {
	const out: string[] = [];
	if (prefs.plainLanguage) out.push(PLAIN_LANGUAGE_CLAUSE);
	if (prefs.emojis === "helpful") out.push(EMOJIS_HELPFUL_CLAUSE);
	return out;
}

/**
 * "How Alpha refers to itself", the person variant, as the appositive head that replaces
 * persona.ts's `SELF_REFERENCE_CLAUSE_MACHINE` ("You are a machine and you sound like one"). It asks for
 * a warmer conversational first-person register and nothing more: `IDENTITY_HONESTY_INVARIANT` follows
 * it on every path, so Alpha still never claims feelings, experiences or humanity.
 *
 * Wording approved by trust and safety (CUR-3930).
 */
export const SELF_REFERENCE_CLAUSE_PERSON = `You are a machine, and you talk the way a thoughtful person would: in a warm, conversational first-person voice ("I'd suggest", "I think the simplest route is"), never flat or clinical, while staying honest that you are an AI`;

/** The self-reference clause for a non-default row: the person head when set, undefined for machine. */
export function selfReferenceClauseFor(prefs: Pick<AnswerPreferences, "selfReferenceAsPerson">): string | undefined {
	return prefs.selfReferenceAsPerson ? SELF_REFERENCE_CLAUSE_PERSON : undefined;
}

/**
 * The voice sentences a non-default row adds, for the prompt paths that have no {style} paragraph
 * (the guards-only and native system prompts): the person self-reference as a sentence, the tone as a
 * sentence, then the extras. Empty on the defaults. The honesty invariant is its own section on
 * those paths (promptSections.ts `identity-honesty`), so it holds with the person clause as without.
 */
export function answerVoiceFor(prefs: AnswerPreferences): string[] {
	const out: string[] = [];
	const selfReference = selfReferenceClauseFor(prefs);
	if (selfReference) out.push(`${selfReference}.`);
	const tone = toneClauseFor(prefs.tone);
	if (tone) out.push(`Your tone is ${tone}.`);
	out.push(...voiceExtrasFor(prefs));
	return out;
}

/**
 * The voice sentences the scaffolded fenced user turn carries (grounding.ts guardFor): the tone as a
 * sentence, then plain language. Neither moves the answer from the system prompt alone (CUR-3929),
 * so the persona's {style} keeps them as well. Empty on the
 * defaults.
 */
export function fencedVoiceFor(prefs: AnswerPreferences): string[] {
	const out: string[] = [];
	const tone = toneClauseFor(prefs.tone);
	if (tone) out.push(`Your tone is ${tone}.`);
	if (prefs.plainLanguage) out.push(PLAIN_LANGUAGE_CLAUSE);
	return out;
}

/**
 * The digest rules (CUR-3929), one fixed rule per SET value of five settings.
 * The digest goes after the fence of the latest user turn (grounding.ts), the last text the model
 * reads. The formal rule has an impersonal voice (CUR-4287).
 * A default value has no rule. CUR-4288 adds the format rules (prose, bullets), beside the
 * FORMAT_SENTENCES carriers, which stay, the detailed rule, beside LENGTH_SENTENCES.detailed,
 * which stays, and the emojis rule, beside EMOJIS_HELPFUL_CLAUSE, which stays. Known gap: some
 * models read a tax answer as formal and add an emoji to "How does VAT work?".
 */
export type DigestRule =
	| "formal"
	| "plainTone"
	| "plainLanguage"
	| "short"
	| "detailed"
	| "noSuggestions"
	| "prose"
	| "bullets"
	| "emojis";

export const DIGEST_RULES: Readonly<Record<DigestRule, string>> = {
	formal: `Write this answer in a formal register, as in a professional report: no contractions (write "here is", not "here's"), no exclamation marks, no casual phrases, and complete sentences. Use an impersonal, measured voice: no "you", "we" or "our" where "the reader", "one" or the passive works, and no rhetorical questions or colloquial openers. Use what the person told you earlier in this conversation.`,
	plainTone: `Write this answer the way a friendly colleague chats: warm, relaxed and personal, not flat like a reference page. Use contractions ("it's", "you'll"), speak to the person as "you", use everyday words, and add a friendly touch. Do not use formal phrases such as "it is important to note" or "in summary".`,
	plainLanguage: `Keep every sentence to 15 words or fewer. Put one idea in each sentence. Use common words. When you need a technical term, say what it means in the same sentence.`,
	short: `Answer in three sentences or fewer. Do not add a list, a heading, an introduction or a summary. When the message asks for a document or a longer piece of writing, write it in full. Use what the person told you earlier in this conversation.`,
	detailed: `Write a full answer: cover each main point, explain the reasoning behind it, and name the main cases or exceptions that change the answer. When you answer in paragraphs, write four or more. When the answer is a set of items, such as a packing list, give a full list and explain the items that need it. Do not add an introduction, a summary or repeated points. When the message asks for a single fact, give only that fact, in one sentence. When it asks for a specific length or a document, write it in full at that length, and do not go past that length. Use what the person told you earlier in this conversation.`,
	noSuggestions: `Reply only to what the message says or asks. Do not add tips, offers, next steps or a question at the end. A safety referral is not a suggestion and stays.`,
	prose: `Write this answer as prose: full sentences in paragraphs, with no bullet points, no numbered list and no headings. When the answer has steps or several items, describe them in connected sentences instead of a list. When the message asks for a list, a table or a document with sections, give that shape.`,
	bullets: `Write this answer as a bulleted list: one point per line, each line starting with "- ", and no paragraphs of prose. You may open with one short sentence. When the message asks for a single sentence, a message to send or a document to use as it is, write that text instead.`,
	emojis: `Add one or two emojis to this answer where they carry meaning or warmth, such as beside a key point. A tax, legal or technical explanation gets them too, and a closing legal or safety note does not make the answer formal: put the emojis above that note, never in or after it. Use no emoji at all, not even in a sign-off, when the message asks for a document, a draft, a guide or code, when the answer is long (it has headings or runs past about 400 words), or when a formal register is asked for. Never use more than three.`,
};

/**
 * The digest for a person's preferences: the rules of their set values in a fixed order (tone, plain
 * language, length, suggestions, format, emojis), one per line, with no heading. A rule in `omit` (the model's
 * harnessProfiles.ts `digestOmit`) is left out.
 *
 * @returns undefined when no rule applies, so a default turn keeps today's bytes
 */
export function answerDigestFor(prefs: AnswerPreferences, omit?: ReadonlySet<DigestRule>): string | undefined {
	const rules: DigestRule[] = [];
	if (prefs.tone === "formal") rules.push("formal");
	if (prefs.tone === "plain") rules.push("plainTone");
	if (prefs.plainLanguage) rules.push("plainLanguage");
	if (prefs.answerLength === "short") rules.push("short");
	if (prefs.answerLength === "detailed") rules.push("detailed");
	if (!prefs.suggestions) rules.push("noSuggestions");
	if (prefs.answerFormat === "prose") rules.push("prose");
	if (prefs.answerFormat === "bullets") rules.push("bullets");
	if (prefs.emojis === "helpful") rules.push("emojis");
	const kept = rules.filter((r) => !omit?.has(r)).map((r) => DIGEST_RULES[r]);
	return kept.length ? kept.join("\n") : undefined;
}
