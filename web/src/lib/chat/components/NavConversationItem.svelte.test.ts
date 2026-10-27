import Harness from "./NavConversationItem.harness.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, afterEach } from "vitest";
import type { ConvSidebar } from "$lib/chat/types/ConvSidebar";

// The sidebar marks a conversation answered on the person's own machine. The gate is the
// conversation's OWN model, which layoutData already projects onto every sidebar row — so this is a
// read of existing data, not a new lookup, and these tests pin that it reads the right thing.
//
// `local:{24-hex endpointId}:{servedModelId}` is localModels.ts's own id shape. (CUR-3037)
const LOCAL_MODEL = `local:${"a".repeat(24)}:llama3.2:latest`;

function conv(model?: string): ConvSidebar {
	return { id: "c1", title: "A conversation", updatedAt: new Date(), model };
}

// The chip carries no text — the incognito glyph is the whole mark — so it is found by the
// accessible name it exposes instead. That is also the thing worth asserting on: an icon with no
// name would be invisible to a screen reader, which for a privacy marker is the same as absent.
const tag = () => page.getByRole("img", { name: /answered on your own computer/i });

describe("NavConversationItem — the Local marker", () => {
	afterEach(cleanup);

	it("marks a conversation its own model says was answered locally", async () => {
		await render(Harness, { conv: conv(LOCAL_MODEL) });
		await expect.element(tag()).toBeVisible();
	});

	it("does not mark a conversation served from the cloud", async () => {
		// The direction that matters. The chip is a privacy claim: putting it on a conversation that
		// went to a hosted provider would tell someone their messages stayed on their machine when
		// they did not, which is worse than not marking anything at all.
		await render(Harness, { conv: conv("swiss-ai/apertus-v1.5-70b") });
		await expect.poll(() => tag().elements().length).toBe(0);
	});

	it("does not mark a conversation with no model recorded", async () => {
		await render(Harness, { conv: conv(undefined) });
		await expect.poll(() => tag().elements().length).toBe(0);
	});

	it("exposes an accessible name, since the glyph alone says nothing to a screen reader", async () => {
		await render(Harness, { conv: conv(LOCAL_MODEL) });
		await expect.element(tag()).toBeVisible();
		// The icon itself must stay hidden, or the name is announced twice.
		const svg = tag().element().querySelector("svg");
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
	});

	it("stays visible without hovering the row", async () => {
		// The whole reason this needed a new Sidebar.Item slot rather than reusing `trailing`: that
		// one is opacity-0 until hover, which is right for row actions and useless for a status the
		// person is meant to be able to scan down the list for.
		await render(Harness, { conv: conv(LOCAL_MODEL) });

		const el = tag().element();
		const wrapper = el.closest("div");
		expect(wrapper && getComputedStyle(wrapper).opacity).toBe("1");
		await expect.element(tag()).toBeVisible();
	});

	it("keeps the conversation title readable beside the marker", async () => {
		// A permanent chip overlays the title, so the label has to reserve room for it; without that
		// a long title runs underneath and the row reads as gibberish.
		await render(Harness, {
			conv: { ...conv(LOCAL_MODEL), title: "A very long conversation title that would overflow" },
		});

		const label = tag().element().closest("li")?.querySelector("span.truncate");
		expect(label, "the sidebar label element").toBeTruthy();
		expect(getComputedStyle(label as Element).paddingRight).not.toBe("0px");
	});
});
