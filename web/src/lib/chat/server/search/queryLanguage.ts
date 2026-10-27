// On the native path the model writes the web search query itself, and it can write a Catalan
// question's search in Spanish, which retrieves different pages than the Catalan query does. Firecrawl
// takes no language, so the query's language decides the results'. A query in a different non-English
// language from the person's message is sent back for a rewrite. An English query passes: for a
// technical question it is often the better search, and it is not the drift this check targets.

import { languageName } from "$lib/chat/routing/languages";

export const SEARCH_QUERY_LANGUAGE_FLAG = "search-query-language";

/** Reads a 639-3 tag from text, or undefined when it can't tell (readMessageLanguage). */
export type LanguageRead = (text: string) => Promise<string | undefined>;

const baseOf = (tag: string) => tag.split("-")[0];

/** The person's language when the query reads as a different non-English one; undefined when the query
 *  may run as written. */
export async function queryLanguageMismatch(
	asked: string | undefined,
	query: string,
	read: LanguageRead
): Promise<string | undefined> {
	if (!asked || baseOf(asked) === "eng") return undefined;
	const written = await read(query);
	if (!written || baseOf(written) === "eng" || baseOf(written) === baseOf(asked)) return undefined;
	return asked;
}

/** The tool result that sends the query back. No search ran, so it carries no sources. */
export function rewriteQueryNote(asked: string): string {
	const name = languageName(baseOf(asked));
	return `No search was run: this query is not in ${name}, the language the person wrote in. Call web_search again with the query written in ${name}.`;
}
