import LiveRequestLog from "./LiveRequestLog.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import { repickWait } from "$lib/chat/stores/repickWait";

// A turn with no tokens yet: the active line reads "Working on it…" (chromeCopy's `preparing`).
const waiting: Message = { from: "assistant", id: "22222222-2222-4222-8222-222222222222", content: "" };

describe("LiveRequestLog's active line while an answer is coming", () => {
	afterEach(() => cleanup());

	// With a slow model (~40 s), one still grey line reads as stuck. The closing "…"
	// fills in a dot at a time. The specs that record live lines (language-response, sign-in) read the
	// line's text, so it must stay exactly as written.
	it("animates the closing ellipsis and keeps the line's text exactly as written", async () => {
		const { container } = await render(LiveRequestLog, { message: waiting });
		const line = container.querySelector<HTMLElement>("[data-live-line]")!;
		expect(line.textContent).toBe("Working on it…");
		const dots = line.querySelector<HTMLElement>(".live-ellipsis.animated span")!;
		// Svelte scopes keyframe names (svelte-<hash>-live-ellipsis).
		expect(getComputedStyle(dots).animationName).toMatch(/live-ellipsis$/);
		expect(getComputedStyle(dots).animationIterationCount).toBe("infinite");
	});
});

describe("LiveRequestLog's slow-to-start line", () => {
	afterEach(() => {
		repickWait.set(null);
		cleanup();
	});
	// A wait of 0 ms is past its half at once, so the line's only gate left is whether the model started.
	const waitOn = (message: Message) => repickWait.set({ answerId: message.id, model: "alia-40b", waitMs: 0 });

	it("still says the model is slow to start after a screen's provenance frame that names no model", async () => {
		const message = { ...waiting, routerMetadata: { route: "", model: "" } } as Message;
		waitOn(message);
		const { container } = await render(LiveRequestLog, { message });
		await expect.poll(() => container.querySelector('[data-testid="live-slow-start"]')).not.toBeNull();
	});

	it("never promises a re-pick once the model has named itself in a provenance frame", async () => {
		const message = { ...waiting, routerMetadata: { route: "", model: "mistral-large-2610" } } as Message;
		waitOn(message);
		const { container } = await render(LiveRequestLog, { message });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(container.querySelector('[data-testid="live-slow-start"]')).toBeNull();
	});
});

describe("LiveRequestLog's search rows", () => {
	afterEach(() => cleanup());
	const QUERY = "a query the visitor typed";
	const searching = {
		...waiting,
		// The turn's own stamp carries the query and sources; the rows must show neither.
		webSearch: { query: QUERY, sources: [{ title: "First page", link: "https://example.org/a" }], asOf: "2026-10-29" },
		updates: [
			{ type: MessageUpdateType.SearchProgress, n: 1, sources: 4 },
			{ type: MessageUpdateType.SearchProgress, n: 2 },
		],
	} as unknown as Message;
	const rows = (container: HTMLElement) =>
		[...container.querySelectorAll<HTMLElement>('[data-testid="live-search-row"]')].map((r) => r.textContent);

	it("shows each search by number, the one that came back with its count, and never the query or a source", async () => {
		const { container } = await render(LiveRequestLog, { message: searching });
		expect(rows(container)).toEqual(["Web search 1 · 4 sources", "Web search 2…"]);
		expect(container.textContent).not.toContain(QUERY);
		expect(container.textContent).not.toContain("First page");
		expect(container.textContent).not.toContain("example.org");
	});

	it("keeps the active line's own text, so its seconds count does not restart with each search", async () => {
		const { container } = await render(LiveRequestLog, { message: searching });
		expect(container.querySelector("[data-live-line]")?.textContent).toBe("Working on it…");
	});

	it("drops the rows once the answer is streaming", async () => {
		const { container } = await render(LiveRequestLog, { message: { ...searching, content: "The act" } as Message });
		expect(rows(container)).toEqual([]);
	});
});
