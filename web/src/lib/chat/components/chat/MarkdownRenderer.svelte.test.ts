import MarkdownRenderer from "./MarkdownRenderer.svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";

import { describe, expect, it, beforeAll } from "vitest";
import { tick } from "svelte";

// KaTeX is a DYNAMIC import (utils/marked.ts) and its arrival does NOT itself trigger a re-render, so
// the FIRST latex on a cold page renders unstyled until something else re-renders it. In the app that
// is hidden by streaming (tokens re-render constantly); in a one-shot render it is visible, so a cold
// first render looks like a latex bug.
//
// Warming it here tests "does latex render", which is the contract these cases are about. The
// cold-first-paint behaviour is real but separate and not asserted by this suite.
beforeAll(async () => {
	const { processBlocks } = await import("$lib/chat/utils/marked");
	await processBlocks("$x^2$");
});

// `render` is ASYNC as of vitest-browser-svelte 3 (it returns Promise<RenderResult>), so every call
// here is awaited. Without the await, destructuring `baseElement` off the promise silently yields
// undefined and the assertion dies on `.querySelectorAll of undefined`. Calls that do not use the
// return value are awaited too: their `page.getBy*` locator assertions retry, so an un-awaited
// render can pass on timing luck, and a floating promise passing by coincidence is not the same as
// a test that holds.
describe("MarkdownRenderer", () => {
	it("renders", async () => {
		await render(MarkdownRenderer, { content: "Hello, world!" });
		expect(page.getByText("Hello, world!")).toBeInTheDocument();
	});
	it("renders headings", async () => {
		await render(MarkdownRenderer, { content: "# Hello, world!" });
		expect(page.getByRole("heading", { level: 1 })).toBeInTheDocument();
	});
	it("renders links", async () => {
		await render(MarkdownRenderer, { content: "[Hello, world!](https://example.com)" });
		const link = page.getByRole("link", { name: "Hello, world!" });
		expect(link).toBeInTheDocument();
		expect(link).toHaveAttribute("href", "https://example.com");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noreferrer");
	});
	it("renders inline codespans", async () => {
		await render(MarkdownRenderer, { content: "`foobar`" });
		expect(page.getByRole("code")).toHaveTextContent("foobar");
	});
	it("renders block codes", async () => {
		await render(MarkdownRenderer, { content: "```foobar```" });
		expect(page.getByRole("code")).toHaveTextContent("foobar");
	});
	it("doesnt render raw html directly", async () => {
		await render(MarkdownRenderer, { content: "<button>Click me</button>" });
		expect(page.getByRole("button").elements).toHaveLength(0);
		// Escaped by the MULTIMEDIA_HTML_REGEX gate (marked.ts:500), NOT by htmlparser2 — this
		// input carries no video/audio/source, so sanitizeHtmlForMultimedia returns before the
		// parser is ever called. See the header of marked.spec.ts for what does reach it.
		expect(page.getByRole("paragraph")).toHaveTextContent("<button>Click me</button>");
	});
	// KaTeX is a DYNAMIC import (utils/marked.ts) — nothing renders it on the first paint, so a
	// synchronous assertion here measures load order, not latex support. Poll instead.
	it("renders latex", async () => {
		const { baseElement } = await render(MarkdownRenderer, { content: "$(oo)^2$" });
		await expect.poll(() => baseElement.querySelectorAll(".katex").length).toBe(1);
	});
	it("does not render latex in code blocks", async () => {
		const { baseElement } = await render(MarkdownRenderer, { content: "```\n$(oo)^2$\n```" });
		expect(baseElement.querySelectorAll(".katex")).toHaveLength(0);
	});
	it("does not render latex in inline codes", async () => {
		const { baseElement } = await render(MarkdownRenderer, { content: "`$oo` and `$bar`" });
		expect(baseElement.querySelectorAll(".katex")).toHaveLength(0);
	});
	it("does not render latex across multiple lines", async () => {
		const { baseElement } = await render(MarkdownRenderer, { content: "* $oo \n* $aa" });
		expect(baseElement.querySelectorAll(".katex")).toHaveLength(0);
	});
	it("renders latex with some < and > symbols", async () => {
		const { baseElement } = await render(MarkdownRenderer, { content: "$foo < bar > baz$" });
		await expect.poll(() => baseElement.querySelectorAll(".katex").length).toBe(1);
	});
});

describe("MarkdownRenderer streaming", () => {
	it("renders an incomplete link as an inert anchor without href", async () => {
		const { baseElement } = await render(MarkdownRenderer, {
			content: "Check [the docs](https://exam",
			loading: true,
		});
		const anchor = baseElement.querySelector("a[data-incomplete-link]");
		expect(anchor).not.toBeNull();
		expect(anchor?.getAttribute("href")).toBeNull();
		expect(anchor?.textContent).toBe("the docs");
	});

	it("renders incomplete bold as bold while streaming", async () => {
		const { baseElement } = await render(MarkdownRenderer, {
			content: "Some **important tex",
			loading: true,
		});
		const strong = baseElement.querySelector("strong");
		expect(strong?.textContent).toBe("important tex");
	});

	it("does not flash a heading while a list item streams in", async () => {
		const { baseElement } = await render(MarkdownRenderer, {
			content: "Shopping list:\n-",
			loading: true,
		});
		expect(baseElement.querySelector("h2")).toBeNull();
	});

	it("does not merge paragraphs after a <br> into one block", async () => {
		const { baseElement } = await render(MarkdownRenderer, {
			content: "First paragraph.\n\n<br>\n\nSecond paragraph.\n\nThird paragraph.",
		});
		expect(baseElement.textContent).toContain("Second paragraph.");
		expect(baseElement.textContent).toContain("Third paragraph.");
	});

	// A drafted letter bracketed in --- rules, with the closing one right
	// under the signature, which CommonMark reads as a four-line setext heading. (CUR-3662)
	it("renders a signature followed directly by --- as plain lines and a rule, not a heading", async () => {
		const { baseElement } = await render(MarkdownRenderer, {
			content:
				"Here's a message you can send:\n\n---\nDear [Landlord's Name],\n\nThank you.\n\nBest regards,\n[Your Full Name]\n[Your Address]\n[Your Contact Information]\n---",
		});
		expect(baseElement.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
		expect(baseElement.querySelectorAll("hr")).toHaveLength(2);
		expect(baseElement.textContent).toContain("[Your Contact Information]");
	});

	it("renders a trailing setext heading in completed messages", async () => {
		// Streaming repairs must not apply when loading is false
		const { baseElement } = await render(MarkdownRenderer, { content: "Title\n-" });
		expect(baseElement.querySelector("h2")?.textContent).toBe("Title");
	});
	// The read-aloud player appears in the flush where the turn ends. If the text still
	// showed the worker's last streaming result there, the player sat over a half-written answer
	// until the worker answered. The final text has to be on the page in that same flush. (CUR-2048)
	it("shows the final text in the same render where streaming stops, not a worker round trip later", async () => {
		const { baseElement, rerender } = await render(MarkdownRenderer, {
			content: "Bread",
			loading: true,
		});
		// Let the worker answer for the streaming text, so its result is what is on screen.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await rerender({ content: "Bread is made from flour, water, yeast and salt.", loading: false });
		await tick();
		expect(baseElement.textContent).toContain("flour, water, yeast and salt.");
	});
});
