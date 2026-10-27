// Main-text extraction with Mozilla Readability, behind the `readable-extract` flag (CUR-2152).
//
// htmlExtract.ts strips tags and keeps everything else, so nav, cookie banners and footers ride along
// into an uploaded file's text, an admin-ingested page, and (when Firecrawl can't read it) a linked
// page. On pages the search path retrieves, Readability keeps more main-text paragraphs than the
// regex and far fewer junk hits.
// It loses two shapes: Q&A/help pages, where it keeps one block, and data pages (a bracket, a
// standings table), where it keeps a disclaimer and drops the table. The second shape comes back
// short, so under SHORT_CHARS the regex text is used instead and logged as its own outcome, which is
// how often Readability loses gets counted rather than guessed.
//
// Readability's cleaned HTML goes back through extractTextFromHtml rather than using its
// `textContent`, which runs adjacent blocks together with no separator; the regex pass supplies the
// block newlines and entity decoding the rest of the pipeline already expects.
//
// Readability and linkedom load on first use, so a deployment with the flag off never pays their
// ~25 ms import.

import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { extractTextFromHtml } from "./htmlExtract";

/** PostHog flag key. Owner: chat. See CUR-2152. */
export const READABLE_EXTRACT_FLAG = "readable-extract";

/** Default off: a new extractor for every upload and ingest is a rollout, not a fix to a live defect. */
export function readableExtractEnabled(): boolean {
	return flagEnabledOr(READABLE_EXTRACT_FLAG, () => false);
}

/** Under this, Readability found a fragment (a disclaimer, one heading) and the page's text is elsewhere. */
const SHORT_CHARS = 600;
/** Parse cost grows with the document: 15–290 ms on ordinary pages, 2 s on a 2.2 MB one. */
const MAX_READABLE_BYTES = 1_500_000;

export type ReadableCaller = "upload" | "admin-ingest" | "linked-page";
type Outcome = "readability" | "short-fallback" | "too-large" | "null-fallback" | "error-fallback";

/** `{ title, text }` from an HTML string: Readability's main text when the flag is on and it finds
 *  enough of it, the regex extractor's text otherwise. Never throws. Readability's text also carries
 *  `publishedTime`, the page's own date when it states one (CUR-4147). */
export async function extractReadableHtml(
	html: string,
	caller: ReadableCaller
): Promise<{ title: string; text: string; publishedTime?: string }> {
	const regex = () => extractTextFromHtml(html);
	if (!readableExtractEnabled()) return regex();

	const t0 = Date.now();
	const log = (outcome: Outcome, readableChars?: number) =>
		logger.info(
			{ leg: "readable-extract", caller, outcome, ms: Date.now() - t0, htmlBytes: html.length, readableChars },
			"[rag] readable extraction outcome"
		);

	if (html.length > MAX_READABLE_BYTES) {
		log("too-large");
		return regex();
	}
	try {
		const [{ Readability }, { parseHTML }] = await Promise.all([
			import("@mozilla/readability"),
			import("linkedom"),
		]);
		const { document } = parseHTML(html);
		const article = new Readability(document as unknown as Document).parse();
		if (!article?.content) {
			log("null-fallback");
			return regex();
		}
		const inner = extractTextFromHtml(article.content);
		if (inner.text.length < SHORT_CHARS) {
			log("short-fallback", inner.text.length);
			return regex();
		}
		log("readability", inner.text.length);
		const title = article.title?.trim() || regex().title;
		return { title, text: inner.text, ...(article.publishedTime ? { publishedTime: article.publishedTime } : {}) };
	} catch (err) {
		logger.warn({ leg: "readable-extract", caller, err: (err as Error)?.name }, "[rag] readable extraction failed");
		log("error-fallback");
		return regex();
	}
}
