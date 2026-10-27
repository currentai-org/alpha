import { describe, expect, it } from "vitest";
import {
	classifyHost,
	screenSources,
	thinEvidenceNote,
} from "./sourceCredibility";
import { buildWebEvidence } from "$lib/chat/server/search/webEvidence";
import type { SearchSource } from "$lib/chat/types/Search";

describe("classifyHost", () => {
	it("calls forum and social hosts user-posted, including subdomains and www", () => {
		expect(classifyHost("https://www.reddit.com/r/energy/comments/x")).toBe("user-posted");
		expect(classifyHost("https://old.reddit.com/r/x")).toBe("user-posted");
		expect(classifyHost("https://m.youtube.com/watch?v=1")).toBe("user-posted");
		expect(classifyHost("https://someone.blogspot.com/2024/post")).toBe("user-posted");
	});

	it("calls WP:RSP-deprecated and Iffy-listed hosts low-credibility", () => {
		expect(classifyHost("https://www.dailymail.co.uk/news/a")).toBe("low-credibility");
		expect(classifyHost("https://www.infowars.com/x")).toBe("low-credibility");
		expect(classifyHost("https://www.naturalnews.com/x")).toBe("low-credibility");
	});

	it("never screens the hosts our own engines query, whatever WP:RSP says about citing them on Wikipedia", () => {
		for (const u of [
			"https://en.wikipedia.org/wiki/Kenya",
			"https://arxiv.org/abs/2401.00001",
			"https://api.openalex.org/works/W1",
			"https://huggingface.co/datasets/x",
			"https://en.wikinews.org/wiki/x",
		]) {
			expect(classifyHost(u)).toBe("web");
		}
	});

	it("labels government and intergovernmental hosts official", () => {
		for (const u of [
			"https://www.epa.gov/plastics",
			"https://www.gov.uk/private-renting/evictions",
			"https://www.treasury.go.ke/x",
			"https://www.economie.gouv.fr/x",
			"https://www.who.int/news",
			"https://ec.europa.eu/eurostat",
			"https://www150.statcan.gc.ca/x",
		]) {
			expect(classifyHost(u)).toBe("official");
		}
	});

	it("labels universities academic", () => {
		expect(classifyHost("https://news.mit.edu/2024/x")).toBe("academic");
		expect(classifyHost("https://www.ox.ac.uk/research")).toBe("academic");
	});

	it("does not read a lookalike suffix as official: go.com and gov.example.com are plain web", () => {
		expect(classifyHost("https://abcnews.go.com/x")).toBe("web");
		expect(classifyHost("https://gov.example.com/x")).toBe("web");
	});

	it("lets the lists win over the suffix: an RSP-rated state outlet on a .gob.ve host is low-credibility", () => {
		expect(classifyHost("https://www.correodelorinoco.gob.ve/x")).toBe("low-credibility");
	});

	it("returns web for an unparseable url instead of throwing", () => {
		expect(classifyHost("not a url")).toBe("web");
	});
});

describe("screenSources", () => {
	it("drops user-posted and low-credibility candidates and counts them", () => {
		const { kept, screen } = screenSources([
			{ url: "https://www.reddit.com/r/x" },
			{ url: "https://www.bbc.co.uk/news/x" },
			{ url: "https://www.infowars.com/x" },
			{ url: "https://www.gov.uk/x" },
		]);
		expect(kept.map((k) => k.url)).toEqual(["https://www.bbc.co.uk/news/x", "https://www.gov.uk/x"]);
		expect(screen).toEqual({ kept: 2, dropped: 2 });
	});
});

describe("thinEvidenceNote", () => {
	it("warns when the screen dropped something and fewer than the threshold remain", () => {
		expect(thinEvidenceNote({ kept: 1, dropped: 4 }, 1)).toMatch(/only 1 source below/);
	});
	it("stays silent when nothing was dropped, even with one source", () => {
		expect(thinEvidenceNote({ kept: 1, dropped: 0 }, 1)).toBeUndefined();
	});
	it("stays silent at the threshold and with zero sources (zero answers ungrounded, with no evidence block)", () => {
		expect(thinEvidenceNote({ kept: 9, dropped: 2 }, 3)).toBeUndefined();
		expect(thinEvidenceNote({ kept: 0, dropped: 5 }, 0)).toBeUndefined();
	});
});

describe("buildWebEvidence annotations", () => {
	const src = (n: number, url: string): SearchSource => ({
		n,
		title: `t${n}`,
		url,
		snippet: "s",
		engine: "Firecrawl",
	});

	it("is byte-identical to the old format with no annotations (flag off)", () => {
		expect(buildWebEvidence([src(1, "https://www.gov.uk/x")])).toBe("[1] t1 (Firecrawl, date unknown)\ns\nhttps://www.gov.uk/x");
	});

	it("adds the type to the tag and puts the note above the sources", () => {
		const out = buildWebEvidence([src(1, "https://www.gov.uk/x")], {
			sourceType: () => "official",
			note: "Note: thin.",
		});
		expect(out).toBe("Note: thin.\n\n[1] t1 (Firecrawl, date unknown, official source)\ns\nhttps://www.gov.uk/x");
	});
});
