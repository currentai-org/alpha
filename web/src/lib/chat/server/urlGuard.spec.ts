import { describe, it, expect } from "vitest";
import { detectFabricatedUrls, stripRawSourceUrls, UNVERIFIED_TITLE } from "./urlGuard";

// A flagged URL stays CLICKABLE (real href kept) but carries the sentinel as its markdown title:
//   [label](real-url "§unverified§")
const titled = (label: string, url: string) => `[${label}](${url} "${UNVERIFIED_TITLE}")`;

describe("detectFabricatedUrls", () => {
	it("flags a bare URL on an ungrounded turn but keeps it clickable, text intact", () => {
		const text =
			"You can refer to its GitHub repository at https://github.com/octo-org/example-repo for architecture details.";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(true);
		expect(r.urls).toContain("https://github.com/octo-org/example-repo");
		// kept clickable (real href present), scheme stripped from the readable label, sentinel title added
		expect(r.cleaned).toContain(
			titled("github.com/octo-org/example-repo", "https://github.com/octo-org/example-repo")
		);
		// the real, navigable URL is still there
		expect(r.cleaned).toContain("https://github.com/octo-org/example-repo");
		// surrounding prose preserved
		expect(r.cleaned).toContain("architecture details");
	});

	it("flags a markdown link but keeps the model's label AND the real href", () => {
		const text = "See [my GitHub repository](https://github.com/octo-org/example-repo) for usage.";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toContain(
			titled("my GitHub repository", "https://github.com/octo-org/example-repo")
		);
		// the real URL is preserved (clickable), not destroyed
		expect(r.cleaned).toContain("https://github.com/octo-org/example-repo");
	});

	it("keeps a static-allowlisted domain clean (huggingface.co) — no flag, no title", () => {
		const text = "The checkpoint is at https://huggingface.co/swiss-ai/Apertus-70B-Instruct-2509.";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("keeps a Wikipedia subdomain (host-suffix match)", () => {
		const text = "Background: https://en.wikipedia.org/wiki/Large_language_model explains it.";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("on a grounded turn, leaves a URL whose host matches a retrieved source untouched", () => {
		const text =
			"According to the report at https://www.europarl.europa.eu/news/en/ai-act it applies in phases.";
		const r = detectFabricatedUrls(text, {
			grounded: true,
			allowedUrls: ["https://www.europarl.europa.eu/news/en/some-article"],
		});
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("still flags a non-source host on a grounded turn (kept clickable, marked)", () => {
		const text = "More at https://totally-made-up-domain-xyz.example/page here.";
		const r = detectFabricatedUrls(text, {
			grounded: true,
			allowedUrls: ["https://en.wikipedia.org/wiki/Thing"],
		});
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toContain(`"${UNVERIFIED_TITLE}"`);
		// still navigable
		expect(r.cleaned).toContain("https://totally-made-up-domain-xyz.example/page");
	});

	it("leaves URL-free text untouched (fast path)", () => {
		const text =
			"I'm a machine and generate text from patterns. The capital of Switzerland is Bern.";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
		expect(r.urls).toEqual([]);
	});

	it("wraps a lone fabricated URL as a clickable, marked link without emptying the answer", () => {
		const text = "https://github.com/octo-org/example-repo";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe(
			titled("github.com/octo-org/example-repo", "https://github.com/octo-org/example-repo")
		);
		expect(r.cleaned.trim().length).toBeGreaterThan(0);
	});

	it("leaves trailing sentence punctuation OUTSIDE the flagged link", () => {
		const r = detectFabricatedUrls(
			"The repo is github.com/x/y is not... wait https://github.com/fairlearn/fairlearn.",
			{ grounded: false }
		);
		// the period stays as prose, not absorbed into the link
		expect(r.cleaned).toContain(
			`${titled("github.com/fairlearn/fairlearn", "https://github.com/fairlearn/fairlearn")}.`
		);
		expect(r.cleaned).not.toContain("fairlearn.](");
		expect(r.urls).toContain("https://github.com/fairlearn/fairlearn");
	});

	it("is idempotent — re-running over flagged text changes nothing", () => {
		const once = detectFabricatedUrls("See https://github.com/octo-org/example-repo here.", {
			grounded: false,
		});
		const twice = detectFabricatedUrls(once.cleaned, { grounded: false });
		expect(twice.flagged).toBe(false);
		expect(twice.cleaned).toBe(once.cleaned);
	});

	it("does NOT double-flag when the markdown label is itself a URL", () => {
		// `[https://github.com/x](https://github.com/x)` must produce ONE titled link, not a nested one.
		const text =
			"Repo: [https://github.com/fairlearn/fairlearn](https://github.com/fairlearn/fairlearn).";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(true);
		// exactly one sentinel title, one removed URL
		expect(r.cleaned.split(`"${UNVERIFIED_TITLE}"`).length - 1).toBe(1);
		expect(r.urls.length).toBe(1);
		expect(r.cleaned).toContain(
			titled("github.com/fairlearn/fairlearn", "https://github.com/fairlearn/fairlearn")
		);
		// the label's scheme was stripped (so pass 2 couldn't re-match it), but the href keeps its scheme
		expect(r.cleaned).not.toContain("[https://");
	});

	it("flags multiple unverified URLs in one answer, all kept clickable", () => {
		const text =
			"Try https://github.com/octo-org/example-repo and also [the docs](https://fake-docs.example/x) for more.";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(true);
		expect(r.urls.length).toBe(2);
		expect(r.cleaned).toContain(titled("the docs", "https://fake-docs.example/x"));
		expect(r.cleaned).toContain(
			titled("github.com/octo-org/example-repo", "https://github.com/octo-org/example-repo")
		);
	});

	// renderArtifacts() links a downloadable agent file with a same-origin RELATIVE href
	// (/chat/conversation/.../agent-artifact/...). MD_LINK hard-requires `https?://` inside the
	// parens, so this never matches — confirming a download link can't get caught by a guard built
	// for citation URLs and silently marked "unverified" (or, worse, stripped). (CUR-546)
	it("leaves a same-origin relative download link untouched — MD_LINK only matches http(s) URLs", () => {
		const text = "**[`notes.txt`](/chat/conversation/abc123/agent-artifact/notes.txt)** — 5 bytes";
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
		expect(r.urls).toEqual([]);
	});

	// The stream hands the guard one batch at a time, and a batch often ends on the "\n" between two
	// list items. Losing it put the next item on this line: "small teams.- **Start here**" (CUR-2567).
	it("keeps a flagged batch's leading and trailing whitespace, so the next list item stays on its own line", () => {
		const batch = "\n- Use the [playbook](https://airc.nist.gov/x) for small teams.\n";
		const r = detectFabricatedUrls(batch, { grounded: false });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe(`\n- Use the ${titled("playbook", "https://airc.nist.gov/x")} for small teams.\n`);
	});
});

describe("detectFabricatedUrls — self-referential / partner link resolution", () => {
	const APERTUS = "https://huggingface.co/swiss-ai/Apertus-70B-Instruct-2509";
	const SNAI = "https://huggingface.co/swiss-ai";

	it("rewrites a fabricated bare Apertus link to the canonical model card (clickable, no marker)", () => {
		const r = detectFabricatedUrls(
			"The code is at https://github.com/snai/apertus-70b if you want to dig in.",
			{ grounded: false }
		);
		expect(r.flagged).toBe(true); // the guard modified the text
		expect(r.cleaned).toContain(`(${APERTUS})`); // rewritten to the real, live model card
		expect(r.cleaned).not.toContain("github.com/snai/apertus-70b");
		expect(r.cleaned).not.toContain(UNVERIFIED_TITLE); // canonical, NOT "unverified"
		expect(r.urls).toEqual([]); // resolved, so not in the unverified notice
		expect(r.cleaned).toContain("if you want to dig in."); // prose intact
	});

	it("rewrites a fabricated markdown Apertus link, keeping the model's label", () => {
		const r = detectFabricatedUrls(
			"See [the Apertus model card](https://snai.ai/model-cards/Apertus-70B) for details.",
			{ grounded: false }
		);
		expect(r.cleaned).toContain(`[the Apertus model card](${APERTUS})`);
		expect(r.cleaned).not.toContain("snai.ai");
		expect(r.cleaned).not.toContain(UNVERIFIED_TITLE);
	});

	it("rewrites a SNAI (non-Apertus) link to the org page", () => {
		const r = detectFabricatedUrls("More about the team at https://snai.ai/about here.", {
			grounded: false,
		});
		expect(r.cleaned).toContain(`(${SNAI})`);
		expect(r.cleaned).not.toContain("snai.ai/about");
		expect(r.cleaned).not.toContain(UNVERIFIED_TITLE);
	});

	it("resolves Apertus ahead of SNAI when a URL names both", () => {
		const r = detectFabricatedUrls("https://snai.ai/model-cards/Apertus-70B", { grounded: false });
		expect(r.cleaned).toContain(APERTUS); // the model card, not the bare org page
		expect(r.cleaned).not.toBe(SNAI);
	});

	it("strips a fabricated own-project link but keeps the sentence (no canonical yet)", () => {
		const r = detectFabricatedUrls(
			"You can contribute at https://github.com/aipotluck/contribute today.",
			{ grounded: false }
		);
		expect(r.flagged).toBe(true);
		expect(r.cleaned).not.toContain("github.com/aipotluck/contribute");
		expect(r.cleaned).not.toContain(UNVERIFIED_TITLE); // stripped, NOT marked
		expect(r.urls).toEqual([]);
		expect(r.cleaned).toContain("You can contribute at"); // prose survives on both sides
		expect(r.cleaned).toContain("today.");
	});

	it("leaves a real allow-listed Apertus link (huggingface) untouched — no rewrite needed", () => {
		const text = `The model card is at ${APERTUS} for reference.`;
		const r = detectFabricatedUrls(text, { grounded: false });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});
});

describe("stripRawSourceUrls — the raw-URL dump the SourceStrip already renders", () => {
	// n=8 is a DIFFERENT host (bbc) so the reported "…decisions. [8] <espn> …" keeps [8] (it cites the
	// preceding sentence, not the first URL). espn/reddit/youtube/nbcnews are the dumped sources.
	const sources = [
		{ n: 8, url: "https://www.bbc.com/sport/football" },
		{ n: 1, url: "https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup" },
		{ n: 3, url: "https://www.reddit.com/r/askanything/comments/1u33ww2/is_there_another_world_cup/" },
		{ n: 4, url: "https://www.youtube.com/watch?v=PFUbmnl2g30" },
		{ n: 5, url: "https://www.nbcnews.com/world" },
	];

	it("strips a trailing run of bare source URLs with interleaved [n] markers (the reported bug)", () => {
		const text =
			"Technology plays a major role, with AI-assisted officiating being used to review key decisions. [8] " +
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup [1] " +
			"https://www.reddit.com/r/askanything/comments/1u33ww2/is_there_another_world_cup/ [3] " +
			"https://www.youtube.com/watch?v=PFUbmnl2g30 [4] " +
			"https://www.nbcnews.com/world For real-time updates, consult reputable outlets like BBC Sport.";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.removed.length).toBe(4);
		expect(r.cleaned).not.toMatch(/https?:\/\//); // no bare URL survives
		// the leading citation [8] (for the real sentence, a different host) is kept; interleaved [1][3][4] gone
		expect(r.cleaned).toContain("review key decisions. [8]");
		expect(r.cleaned).not.toMatch(/\[1\]|\[3\]|\[4\]/);
		// the closing prose sentence is preserved
		expect(r.cleaned).toContain("For real-time updates, consult reputable outlets like BBC Sport.");
		// no doubled space at the excision seam
		expect(r.cleaned).not.toMatch(/ {2,}/);
	});

	it("removes the URLs but conservatively KEEPS a same-line leading marker (indistinguishable from a sentence citation)", () => {
		// "references. [1] url [2] url": a same-line "[1]" after terminal punctuation is ALSO the shape of a
		// sentence-final citation, so it's left as a valid citation to source 1 rather than risk eating a
		// real one. Only the ugly URL wall is removed. (Own-line / Sources:-labelled forms fully strip —
		// see the tests below.)
		const text =
			"Here are the primary references for this tournament's coverage this season. " +
			"[1] https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup " +
			"[4] https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe(
			"Here are the primary references for this tournament's coverage this season. [1]"
		);
		expect(r.cleaned).not.toMatch(/https?:\/\//); // the URL wall is gone
	});

	it("fully strips a Sources:-labelled inline URL list, label and markers included", () => {
		const text =
			"The primary references for this week are collected together below. Sources: " +
			"[1] https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup " +
			"[4] https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe("The primary references for this week are collected together below.");
		expect(r.cleaned).not.toMatch(/Sources:|https?:\/\/|\[\d+\]/);
	});

	it("keeps a sentence-final citation before a same-host dump (. [1] does not start the list)", () => {
		// "…in 2024. [1] https://sameHost …": the period is ALSO a normal sentence-final citation boundary,
		// so [1] (which cites the sentence) is preserved even though source 1 shares the first URL's host.
		const text =
			"The EU AI Act entered into force in 2024. [1] " +
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup [4] " +
			"https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe("The EU AI Act entered into force in 2024. [1]");
		expect(r.cleaned).not.toMatch(/https?:\/\//);
	});

	it("does NOT absorb a trailing marker across a blank-line paragraph break", () => {
		const text =
			"The first paragraph cites source one and reads as a complete thought.\n\n" +
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup [1] " +
			"https://www.youtube.com/watch?v=PFUbmnl2g30\n\n" +
			"[4] The second paragraph cites source four and stands on its own.";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		// the second paragraph and its [4] citation survive intact
		expect(r.cleaned).toContain("[4] The second paragraph cites source four and stands on its own.");
		expect(r.cleaned).toContain(
			"The first paragraph cites source one and reads as a complete thought."
		);
		expect(r.cleaned).not.toMatch(/https?:\/\//);
	});

	it("strips a marker-AFTER dump with own-line (newline-separated) markers, no orphan", () => {
		const text =
			"Answer sentence is genuinely complete here.\n\n" +
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup\n[1]\n" +
			"https://www.youtube.com/watch?v=PFUbmnl2g30\n[4]";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe("Answer sentence is genuinely complete here.");
		expect(r.cleaned).not.toMatch(/\[\d+\]/);
	});

	it("strips a marker-BEFORE dump with own-line (newline-separated) markers, no orphan leading [n]", () => {
		const text =
			"Answer sentence is genuinely complete here.\n\n" +
			"[1]\nhttps://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup\n" +
			"[4]\nhttps://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe("Answer sentence is genuinely complete here.");
		expect(r.cleaned).not.toMatch(/\[\d+\]/);
	});

	it("keeps a preceding sentence's inline citation even when its source shares the first dumped URL's host", () => {
		// [1] cites "2024" (a bare word precedes it — no sentence boundary), and source 1's host happens to
		// equal the first dumped URL's host. It must NOT be absorbed as a list-item marker.
		const text =
			"The EU AI Act entered into force in 2024 [1] " +
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup [4] " +
			"https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe("The EU AI Act entered into force in 2024 [1]");
		expect(r.cleaned).not.toMatch(/https?:\/\//);
	});

	it("strips a Markdown angle-autolink dump (<https://…>), brackets and all", () => {
		const text =
			"Full match coverage and highlights are collected across the major outlets this week. " +
			"<https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup> " +
			"<https://www.youtube.com/watch?v=PFUbmnl2g30>";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe(
			"Full match coverage and highlights are collected across the major outlets this week."
		);
		expect(r.cleaned).not.toMatch(/[<>]/); // no orphaned angle bracket
	});

	it("strips a pure trailing URL dump (no closing prose)", () => {
		const text =
			"Morocco advanced past Belgium and Spain in a run of surprise results this tournament.\n\n" +
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup\n" +
			"https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(true);
		expect(r.cleaned).toBe(
			"Morocco advanced past Belgium and Spain in a run of surprise results this tournament."
		);
	});

	it("leaves a single inline source link alone (a dump is ≥2 URLs)", () => {
		const text =
			"The tournament schedule is published here: https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup and covers every group-stage match in detail.";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("does not chain two source URLs separated by prose (not one dump)", () => {
		const text =
			"ESPN covers the fixtures at https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup in depth, while highlights are on https://www.youtube.com/watch?v=PFUbmnl2g30 for quick recaps.";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("stands down on an ungrounded turn", () => {
		const text =
			"See https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup and https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: false });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("ignores bare URLs whose host is not a retrieved source (urlGuard owns those)", () => {
		const text =
			"Background reading is at https://example.com/a and https://example.org/b for context on the format.";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});

	it("never guts the answer — bails when the dump is essentially the whole message", () => {
		const text =
			"https://www.espn.com/soccer/story/_/id/49020473/2026-fifa-world-cup https://www.youtube.com/watch?v=PFUbmnl2g30";
		const r = stripRawSourceUrls(text, sources, { grounded: true });
		expect(r.flagged).toBe(false);
		expect(r.cleaned).toBe(text);
	});
});
