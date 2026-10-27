import { describe, expect, it } from "vitest";
import { parseArxivAtom } from "./arxivAtom";

const entry = (inner: string) => `<entry>${inner}</entry>`;
const feed = (...entries: string[]) =>
	`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title><id>http://arxiv.org/api/q</id>${entries.join("")}</feed>`;

// The feed is parsed as XML, so an entity, a CDATA block or a nested element in an entry comes
// out as plain text, and the feed's own <title> and <id> never pass for an entry's. (CUR-4068)
describe("parseArxivAtom", () => {
	it("reads each entry's title, abstract, abs URL and published date", () => {
		const [c] = parseArxivAtom(
			feed(
				entry(
					"<id>http://arxiv.org/abs/2406.01234v1</id><published>2024-06-03T17:59:59Z</published><title>Open\n  Models</title><summary>An abstract.</summary>"
				)
			)
		);
		expect(c).toEqual({
			title: "Open Models",
			url: "http://arxiv.org/abs/2406.01234v1",
			snippet: "An abstract.",
			engine: "arXiv",
			asOf: "2024-06-03",
		});
	});

	it("decodes a numeric entity, unwraps CDATA and flattens nested elements", () => {
		const [c] = parseArxivAtom(
			feed(
				entry(
					"<id>http://arxiv.org/abs/1</id><title>Caf&#233; &amp; <b>bistro</b></title><summary><![CDATA[x < y & z]]> and <i>more</i></summary>"
				)
			)
		);
		expect(c.title).toBe("Café & bistro");
		expect(c.snippet).toBe("x < y & z and more");
	});

	it("drops an entry without a title, URL or abstract, and the feed's own title never becomes one", () => {
		const out = parseArxivAtom(
			feed(entry("<id>http://arxiv.org/abs/2</id><title>No abstract</title>"), entry("<title>No id</title><summary>s</summary>"))
		);
		expect(out).toEqual([]);
	});

	it("caps the snippet at 360 characters and returns nothing for an empty or broken feed", () => {
		const [c] = parseArxivAtom(feed(entry(`<id>u</id><title>t</title><summary>${"a".repeat(500)}</summary>`)));
		expect(c.snippet).toHaveLength(360);
		expect(parseArxivAtom("")).toEqual([]);
		expect(parseArxivAtom("<html>rate limited</html>")).toEqual([]);
	});
});
