// arXiv's export API answers in Atom. htmlparser2 parses it in XML mode (CUR-4068), which decodes the
// entities and unwraps CDATA, so a title or abstract reaches the grounding block as plain text.

import { parseDocument, DomUtils } from "htmlparser2";
import type { SearchCandidate } from "./openSearch";

/** Each `<entry>` as a search candidate: title, the abstract as the snippet, the abs URL, the published date. */
export function parseArxivAtom(xml: string): SearchCandidate[] {
	const doc = parseDocument(xml, { xmlMode: true, recognizeCDATA: true });
	return DomUtils.getElementsByTagName("entry", doc.children)
		.map((entry) => {
			const text = (tag: string): string => {
				const el = DomUtils.getElementsByTagName(tag, entry.children, false, 1)[0];
				return el ? DomUtils.textContent(el).replace(/\s+/g, " ").trim() : "";
			};
			const published = text("published");
			return {
				title: text("title"),
				// <id> is the canonical abs URL (e.g. http://arxiv.org/abs/2406.01234v1).
				url: text("id"),
				snippet: text("summary").slice(0, 360),
				engine: "arXiv" as const,
				...(published ? { asOf: published.slice(0, 10) } : {}),
			};
		})
		.filter((s) => s.title && s.url && s.snippet);
}
