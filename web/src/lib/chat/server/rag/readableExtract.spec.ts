import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { extractReadableHtml } from "./readableExtract";
import { extractTextFromHtml } from "./htmlExtract";
import { logger } from "$lib/chat/server/logger";

const para = (i: number) =>
	`<p>Paragraph ${i} of the article explains how open models are trained, evaluated and served, with enough prose that a reader-mode extractor scores this block as the page's main content.</p>`;

const ARTICLE = `<!doctype html><html><head><title>Open models, explained</title></head><body>
<nav><a href="/">Home</a> <a href="/news">News</a> <a href="/login">Sign in</a></nav>
<div class="cookie-banner">We use cookies. Accept all cookies to continue browsing.</div>
<article><h1>Open models, explained</h1>${Array.from({ length: 8 }, (_, i) => para(i + 1)).join("")}</article>
<footer>All rights reserved. Privacy policy. Follow us.</footer>
</body></html>`;

const TABLE_PAGE = `<!doctype html><html><head><title>Standings</title></head><body>
<p>Teams with identical records are listed in tiebreaker order.</p>
<table>${Array.from({ length: 30 }, (_, i) => `<tr><td>Team ${i}</td><td>${90 - i}</td><td>${60 + i}</td></tr>`).join("")}</table>
</body></html>`;

const outcomes = () =>
	vi.mocked(logger.info).mock.calls.map((c) => (c[0] as { outcome?: string }).outcome).filter(Boolean);

beforeEach(() => {
	vi.mocked(logger.info).mockClear();
});

describe("extractReadableHtml", () => {
	it("keeps the article and drops nav, cookie banner and footer", async () => {
		const { title, text } = await extractReadableHtml(ARTICLE, "upload");
		expect(title).toBe("Open models, explained");
		expect(text).toContain("Paragraph 1 of the article");
		expect(text).toContain("Paragraph 8 of the article");
		expect(text).not.toMatch(/cookie|Sign in|All rights reserved/i);
		// Block boundaries survive as newlines rather than running paragraphs together.
		expect(text.split("\n").filter((l) => l.startsWith("Paragraph")).length).toBe(8);
		expect(outcomes()).toEqual(["readability"]);
	});

	it("falls back to the regex text, logged as short-fallback, when Readability keeps under 600 chars of a table page", async () => {
		const { text } = await extractReadableHtml(TABLE_PAGE, "linked-page");
		expect(text).toContain("Team 29");
		expect(outcomes()).toEqual(["short-fallback"]);
	});

	it("skips Readability entirely, logged as too-large, above the 1.5 MB input cap", async () => {
		const big = ARTICLE.replace("</body>", `<div>${"x".repeat(1_500_001)}</div></body>`);
		expect(await extractReadableHtml(big, "admin-ingest")).toEqual(extractTextFromHtml(big));
		expect(outcomes()).toEqual(["too-large"]);
	});
});
