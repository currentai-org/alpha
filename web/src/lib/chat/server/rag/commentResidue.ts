/**
 * Google Docs comment threads left in a document's text (CUR-2634).
 *
 * A Docs export with comments included appends each thread as `[a]…`, `[b]…`, and a mention inside
 * a thread reads `@name@domain`. A document ingested that way would serve
 * staff email addresses and an internal discussion to retrieval. These are
 * shapes the export generates, so they are matched literally; a plain contact address in the body
 * is allowed, since a public policy page can name one.
 */

/** `[a]` and `[b]` both present: one marker alone is too common in ordinary text to mean anything. */
const SEQUENTIAL_MARKERS = /\[a\][\s\S]*\[b\]/;
/** A Docs mention: `@` immediately before an email address. */
const EMAIL_MENTION = /(^|\s)@[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Why `text` can't enter the corpus as it stands, or undefined when it carries no comment residue. */
export function commentResidueReason(text: string): string | undefined {
	if (SEQUENTIAL_MARKERS.test(text))
		return "This text still has Google Docs comment threads ([a], [b] …) in it. Export the document without comments, or delete them, and upload again.";
	if (EMAIL_MENTION.test(text))
		return "This text has an @-mention of an email address, which is how Google Docs comments name people. Remove the comments and upload again.";
	return undefined;
}
