import { describe, expect, it } from "vitest";
import { isoDay, pageDateFromMetadata } from "./pageDate";
import { buildWebEvidence } from "./webEvidence";

const NOW = Date.parse("2026-10-18T05:00:00Z");

// Metadata as Firecrawl's /v2/scrape returns it,
// trimmed to the date-bearing keys plus Firecrawl's own cachedAt.
const REAL = {
	govuk: {
		"govuk:public-updated-at": "2025-05-28T11:56:10+01:00",
		"govuk:updated-at": "2026-09-04T10:35:30+01:00",
		"govuk:first-published-at": "2025-03-27T00:00:00+00:00",
	},
	wikipedia: { "article:modified_time": "2026-09-23T02:33:32Z", "dc:modified": "2026-09-23T02:33:32Z" },
	reuters: { DateModified: "2026-10-17T09:15:02.848Z" },
	arxiv: { citation_online_date: "2023/11/22", citation_date: "2023/10/05" },
	saveTheChildren: { "video:release_date": "Wed, 10/09/2024 - 06:15", date: "Wed, 10/09/2024 - 06:15" },
	hfBlog: { "og:type": "article", cachedAt: "2026-10-18T05:14:00.000Z" },
};

describe("pageDateFromMetadata reads the date a fetched page states, published before modified", () => {
	it("takes gov.uk's first publication over its public update and ignores its internal updated-at", () => {
		expect(pageDateFromMetadata(REAL.govuk, NOW)).toBe("2025-03-27");
	});
	it("reads each site's own key, whatever its case or date format", () => {
		expect(pageDateFromMetadata(REAL.wikipedia, NOW)).toBe("2026-09-23");
		expect(pageDateFromMetadata(REAL.reuters, NOW)).toBe("2026-10-17");
		expect(pageDateFromMetadata(REAL.arxiv, NOW)).toBe("2023-10-05");
		expect(pageDateFromMetadata(REAL.saveTheChildren, NOW)).toBe("2024-10-09");
	});
	it("returns undefined for a page with no date of its own, never Firecrawl's fetch time", () => {
		expect(pageDateFromMetadata(REAL.hfBlog, NOW)).toBeUndefined();
		expect(pageDateFromMetadata(undefined, NOW)).toBeUndefined();
	});
	it("takes the first of a repeated meta tag", () => {
		expect(pageDateFromMetadata({ "article:published_time": ["2024-02-01", "2024-03-01"] }, NOW)).toBe("2024-02-01");
	});
	it("skips an unusable value and falls through to the next key", () => {
		expect(pageDateFromMetadata({ "article:published_time": "soon", "article:modified_time": "2024-05-06" }, NOW)).toBe(
			"2024-05-06"
		);
	});
});

describe("isoDay leaves a doubtful date undefined rather than guessing", () => {
	it("refuses a future date, a pre-1990 placeholder and an impossible day", () => {
		expect(isoDay("2026-12-01", NOW)).toBeUndefined();
		expect(isoDay("1970-01-01T00:00:00Z", NOW)).toBeUndefined();
		expect(isoDay("2024-02-30", NOW)).toBeUndefined();
	});
	it("refuses an all-number date whose day and month order it cannot know", () => {
		expect(isoDay("03/04/2024", NOW)).toBeUndefined();
	});
	it("reads a date whose month is written out", () => {
		expect(isoDay("Tue, 01 Oct 2024 10:00:00 GMT", NOW)).toBe("2024-10-01");
	});
	it("returns undefined for a non-string", () => {
		expect(isoDay(20240101, NOW)).toBeUndefined();
		expect(isoDay(undefined, NOW)).toBeUndefined();
	});
});

describe("buildWebEvidence gives every source a date or says it has none", () => {
	it("puts a dated source's day in its header and marks an undated one 'date unknown', never today", () => {
		const out = buildWebEvidence([
			{ n: 1, title: "HBAI", url: "https://gov.uk/x", snippet: "Figures.", engine: "Firecrawl", asOf: "2025-03-27" },
			{ n: 2, title: "Blog", url: "https://example.org/y", snippet: "Words.", engine: "Firecrawl" },
		]);
		expect(out).toContain("[1] HBAI (Firecrawl, 2025-03-27)");
		expect(out).toContain("[2] Blog (Firecrawl, date unknown)");
		expect(out).not.toContain(new Date().toISOString().slice(0, 10));
	});
});
