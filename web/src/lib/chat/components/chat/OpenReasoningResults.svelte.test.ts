import OpenReasoningResults from "./OpenReasoningResults.svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";

import { describe, expect, it } from "vitest";

const LONG_REASONING = Array.from(
	{ length: 20 },
	(_, i) => `Paragraph ${i + 1}: thinking about something here that goes on for a bit.`
).join("\n\n");

describe("OpenReasoningResults", () => {
	it("renders the streaming viewport when loading", async () => {
		// awaited: render returns a promise as of vitest-browser-svelte 3
		const { baseElement } = await render(OpenReasoningResults, {
			content: LONG_REASONING,
			loading: true,
		});

		const viewport = baseElement.querySelector(".thinking-viewport") as HTMLElement | null;
		if (!viewport) throw new Error("expected .thinking-viewport to be rendered");
		// The fade mask is scoped to .thinking-viewport.has-overflow, and that class is bound to
		// `contentHeight > viewportHeight` — a ResizeObserver measurement that has NOT happened on the
		// first paint. Asserting synchronously measured layout timing, not whether the fade works.
		await expect
			.poll(() => {
				const style = getComputedStyle(viewport);
				return (
					style.maskImage?.includes("linear-gradient") ||
					(style as unknown as { webkitMaskImage?: string }).webkitMaskImage?.includes(
						"linear-gradient"
					)
				);
			})
			.toBe(true);

		// Full content is in the DOM (CSS clipping handles the visual cropping)
		expect(page.getByText("Paragraph 20:", { exact: false })).toBeInTheDocument();
		expect(page.getByText("Paragraph 1:", { exact: false })).toBeInTheDocument();
	});

	it("renders the full text view when not loading", async () => {
		const { baseElement } = await render(OpenReasoningResults, {
			content: LONG_REASONING,
			loading: false,
		});

		// After streaming, default state is collapsed; expand it
		const toggle = baseElement.querySelector("button");
		if (!toggle) throw new Error("expected toggle button to be rendered");
		toggle.click();

		// No streaming viewport when not loading
		await new Promise((r) => setTimeout(r, 0));
		expect(baseElement.querySelector(".thinking-viewport")).toBeNull();
	});

	// ── CUR-1341 ─────────────────────────────────────────────────────────────────────────────────────
	// The header must not be `loading ? "Computing…" : "Computed"` — whether the block finished STREAMING.
	// On a turn whose answer opens "This turn wrote files but never ran anything, so any output shown
	// below is predicted rather than measured", that would render "Computed" one line above the sentence
	// denying it, and the header is what a reader who never expands the block walks away with.
	//
	// These assert on the rendered header text rather than on a class or an internal, because the text IS
	// the claim being made to the user. A refactor that keeps the prop and stops rendering it fails here,
	// which is the point — the ticket's proof line is "a wrote-files-never-ran turn must not render
	// 'Computed'", not "a flag reaches the component".

	it("does not render Computed on a wrote-files-never-ran turn", async () => {
		const { baseElement } = await render(OpenReasoningResults, {
			content: "Considered the sieve.",
			loading: false,
			unrunReason: "wrote-not-run",
		});
		const header = baseElement.querySelector("button")?.textContent ?? "";
		expect(header).toContain("Predicted");
		expect(header).not.toContain("Computed");
	});

	it("says the run did not finish for a structural failure, not that the output was predicted", async () => {
		// A structural failure is a different claim from the four overclaim reasons — the run tried and
		// did not finish, rather than the agent overclaiming what it did — and the answer prefix already
		// splits them (STRUCTURAL_FAILURE_NOTICE vs UNRUN_CODE_NOTICE). The header follows that split.
		const { baseElement } = await render(OpenReasoningResults, {
			content: "Got partway.",
			loading: false,
			unrunReason: "service-verdict-structural",
		});
		const header = baseElement.querySelector("button")?.textContent ?? "";
		expect(header).toContain("Did not finish");
		expect(header).not.toContain("Computed");
		expect(header).not.toContain("Predicted");
	});

	it("says Working on an ordinary turn, and never Computed, since nothing here knows a tool ran (CUR-3940)", async () => {
		// The fix must not make every turn hedge. Absence of unrunReason is NOT a claim that nothing ran
		// (that ambiguity is CUR-234's, and asserting a negative from it is the bug next door) — it means
		// the server's unrun check did not fire. Every reasoning model's think block lands here too, so a
		// plain capital-city question read "Computed" over a panel where nothing was calculated. the
		// panel's label (CUR-2079) is "Working", which claims no computation either way.
		const { baseElement } = await render(OpenReasoningResults, {
			content: "Considered the sieve.",
			loading: false,
		});
		const header = baseElement.querySelector("button")?.textContent ?? "";
		expect(header).toContain("Working");
		expect(header).not.toContain("Computed");
	});

	it("shows the streaming label while loading, whatever the unrun verdict turns out to be", async () => {
		// The verdict is only known at `done`, so a mid-stream header must not pre-announce it. Guards
		// against a future refactor that reads the prop before the turn has finished.
		const { baseElement } = await render(OpenReasoningResults, {
			content: "Thinking.",
			loading: true,
			unrunReason: "wrote-not-run",
		});
		const header = baseElement.querySelector("button")?.textContent ?? "";
		expect(header).toContain("Working…");
		expect(header).not.toContain("Computing");
		expect(header).not.toContain("Predicted");
	});

	// ALIA narrates the injection fence by its nonce; the panel shows the sentence without it. (CUR-3164)
	it("shows ALIA's reasoning without the fence nonce, streaming and finished", async () => {
		const said = "The user has provided a message inside the <Q_33024de9> tags. Reply ready.";
		const { baseElement } = await render(OpenReasoningResults, { content: said, loading: true });
		await expect.poll(() => baseElement.textContent ?? "").toContain("inside the tags");
		expect(baseElement.textContent).not.toMatch(/Q_[0-9a-f]{8}/);

		const done = await render(OpenReasoningResults, { content: said, loading: false });
		done.baseElement.querySelectorAll("button").forEach((b) => b.click());
		await expect.poll(() => done.baseElement.textContent ?? "").toContain("Reply ready.");
		expect(done.baseElement.textContent).not.toMatch(/Q_[0-9a-f]{8}/);
	});

	// A model can restate our fence preamble and then paraphrase the rest of it. Every line of that reasoning is our prompt plumbing, so a finished turn shows no
	// panel at all rather than an empty "Working" header. (CUR-3945)
	it("renders no panel once a finished turn's reasoning was only its restatement of the fence preamble", async () => {
		const said =
			"The user's message is wrapped in markers. I need to answer the question inside those tags. " +
			"I should not mention the tags or the wrapper.\n";
		const { baseElement } = await render(OpenReasoningResults, { content: said, loading: false });
		expect(baseElement.querySelector("button")).toBeNull();
		expect(baseElement.textContent).not.toContain("wrapped in");
		expect(baseElement.textContent).not.toContain("Working");
	});

	it("keeps the lines around a restating line, and keeps the panel", async () => {
		const said = "Recall the date.\nThe user's message is wrapped in markers. Inside those tags.\nIt is Tuesday.";
		const { baseElement } = await render(OpenReasoningResults, { content: said, loading: false });
		baseElement.querySelectorAll("button").forEach((b) => b.click());
		await expect.poll(() => baseElement.textContent ?? "").toContain("It is Tuesday.");
		expect(baseElement.textContent).toContain("Recall the date.");
		expect(baseElement.textContent).not.toContain("wrapped in");
		expect(baseElement.textContent).not.toContain("those tags");
	});
});
