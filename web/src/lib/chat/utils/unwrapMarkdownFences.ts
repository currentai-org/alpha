/**
 * Models sometimes wrap a whole formatted answer in a code fence labelled `markdown` (```markdown …),
 * which renders as a monospace code box full of literal `#` and `**`. A fence labelled
 * markdown/md is a request to SHOW markdown, not code, so we unwrap it and let the renderer format
 * it. Also unwrapped: a reply that is nothing but one unlabelled fence whose content opens with a
 * markdown heading — the same mistake without the label.
 *
 * Deliberately narrow: any other fence (a language, or unlabelled mid-answer) stays a code block, so
 * real code — including a README someone asked to see as source — is never reformatted. Works while
 * streaming: an unclosed ```markdown fence at the end is unwrapped up to the end of the text.
 */
const LABELLED = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)|$)/gi;
const WHOLE_UNLABELLED = /^\s*(`{3,}|~{3,})[ \t]*\r?\n(#{1,6}[ \t][\s\S]*?)(?:\r?\n\1[ \t]*)?\s*$/;

export function unwrapMarkdownFences(content: string): string {
	if (!content.includes('```') && !content.includes('~~~')) return content;
	let out = content.replace(LABELLED, (_m, lead: string, _fence: string, body: string) => `${lead}${body}`);
	const whole = out.match(WHOLE_UNLABELLED);
	if (whole && !/^(`{3,}|~{3,})/m.test(whole[2])) out = whole[2];
	return out;
}
