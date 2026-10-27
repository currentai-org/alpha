import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

// Web search starts on auto for everyone who never chose, a stored "off" under the old key (a
// default the store once wrote back on every load) moves to auto, and a choice made at the
// control survives a reload. Each test loads the store fresh, as a page load does, over the browser
// storage it would find. resolveInitialWebSearchMode's rules are in webSearchMode.spec.ts; this is the
// live store in a real browser, writing and re-reading localStorage. The captions check is in
// composerTools.spec.ts.
// e2e-moved: scenarios/web-search-default.spec.ts › a visitor whose only record is the old written-back "off" moves to auto
// e2e-moved: scenarios/web-search-default.spec.ts › off chosen at the control survives a reload

async function loadStore() {
	vi.resetModules();
	return import("./webSearchMode");
}

beforeEach(() => {
	localStorage.removeItem("ap:webSearchMode");
	localStorage.removeItem("ap:webSearchChoice");
	localStorage.removeItem("ap:webSearchAllowed");
});
afterEach(() => {
	localStorage.removeItem("ap:webSearchMode");
	localStorage.removeItem("ap:webSearchChoice");
});

describe("web search mode on page load (CUR-2030)", () => {
	it("a new visitor starts on auto, and loading the page writes nothing that would later read as a choice", async () => {
		const { webSearchMode } = await loadStore();
		expect(get(webSearchMode)).toBe("auto");
		expect(localStorage.getItem("ap:webSearchChoice"), "the starting default was written as a choice").toBeNull();
		expect(localStorage.getItem("ap:webSearchMode"), "the starting default was written back").toBeNull();
	});

	it('a visitor whose only record is the old written-back "off" starts on auto', async () => {
		localStorage.setItem("ap:webSearchMode", "off");
		const { webSearchMode } = await loadStore();
		expect(
			get(webSearchMode),
			'a stored default "off" still wins, so every returning visitor stays on the old default'
		).toBe("auto");
	});

	it("off chosen at the control is stored as a choice and survives a reload", async () => {
		const first = await loadStore();
		first.webSearchMode.set("off");
		expect(localStorage.getItem("ap:webSearchChoice")).toBe("off");

		const reloaded = await loadStore();
		expect(get(reloaded.webSearchMode), "off chosen at the control was not kept across a reload").toBe("off");
	});
});
