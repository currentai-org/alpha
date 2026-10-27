// A model built for a few languages (ALIA: Spanish, Catalan, Galician, Basque) answers in
// English under a persona that only says "reply in the user's language", and in the asked language
// once that language is named. The name comes from the visitor's browser, not from reading the
// message: the detector reads short Catalan as Spanish, and a wrong name sends the answer into the
// wrong language. The browser's language is fixed for the conversation, so the line never changes
// between turns and the cached prefix holds.
//
// Only a language the model is built for gets named. An English browser names nothing here, so a
// visitor writing Catalan on an English laptop is never told to answer in English; the message's own
// language is named instead (messageLanguageNote, below). (CUR-1713)
import { fromIso1, languageName } from "$lib/chat/routing/languages";
import { heuristicClassify } from "$lib/chat/routing/heuristic";

export function browserLanguageNote(
	browserLanguage: string | null | undefined,
	nativeLanguages: readonly string[]
): string | undefined {
	if (!browserLanguage || !nativeLanguages.includes(browserLanguage)) return undefined;
	const name = languageName(browserLanguage);
	return `The person's browser is set to ${name}. Write your whole answer in ${name}, unless they write to you in another language.`;
}

// On a browser in no language the model is built for, the message names its own. A model
// on an English laptop can answer Spanish and Catalan in English unless the message's language is
// named. The read is the one refusal notices use (declineCopy.ts), and only a
// language on the model's list gets named, so an English message, or one the detector can't place,
// gets today's prompt. Short Catalan can read as Spanish (a tie at 0.42 on "Ets una persona de
// veritat?"), which sends the answer into Spanish rather than English. (CUR-3898)
export type MessageLanguageRead = (text: string) => Promise<string | undefined>;

export async function messageLanguageNote(
	text: string,
	nativeLanguages: readonly string[],
	readLanguage: MessageLanguageRead
): Promise<{ language: string; note: string } | undefined> {
	const t = text.trim();
	if (!t || nativeLanguages.length === 0) return undefined;
	const tag = await readLanguage(t);
	const code = nativeLanguages.find((c) => tag !== undefined && fromIso1(c) === tag.split("-")[0]);
	if (!code) return undefined;
	const name = languageName(code);
	return { language: fromIso1(code), note: `The person wrote in ${name}. Write your whole answer in ${name}.` };
}

// A model can also ignore "the user's language" for one particular language, the way a model
// can answer Hausa in English. Here the name comes from the message, since the browser says nothing about
// Hausa, and only for a language on the model's measured-weak list. A script that names its language
// outright decides first; otherwise Clef, offered the weak languages, reads the message. When Clef
// can't be asked the turn names nothing (clefLanguageOf logs why), which is today's prompt. (CUR-2237)
const SURE_WORDS = 0.6;

export type ClefLanguageRead = (text: string, extra: readonly string[]) => Promise<string | null | undefined>;

export async function weakLanguageNote(
	text: string,
	weakLanguages: readonly string[],
	askClef: ClefLanguageRead
): Promise<{ language: string; note: string } | undefined> {
	const t = text.trim();
	if (!t || weakLanguages.length === 0) return undefined;
	const local = heuristicClassify(t).language;
	let code: string | null | undefined;
	if (local.signal === "script" && local.confidence >= 0.85) {
		code = local.value;
	} else if (local.signal === "words" && local.confidence >= SURE_WORDS && !weakLanguages.includes(local.value)) {
		// A sure word-list read of another language skips Clef's half second. It never reached 0.45 on
		// five Hausa test sentences (it reads them as Basque at 0.36–0.45), against 0.6–0.81 for
		// English, German, Spanish and Tagalog questions.
		code = null;
	} else {
		code = await askClef(t, weakLanguages);
	}
	if (!code || !weakLanguages.includes(code)) return undefined;
	const name = languageName(code);
	return {
		language: code,
		note: `The person wrote in ${name}. Write your whole answer in ${name}, including any lists, and do not switch to English.`,
	};
}
