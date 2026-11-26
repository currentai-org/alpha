import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { on } from "svelte/events";
import type { PageData } from "./$types";

// The Google callback lands here as `?google=connected`. An enhanced form leaves the URL as it was,
// so the page itself must stop reporting the callback once the person acts on the page.
vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost/chat/settings/connectors?google=connected"), state: {} },
}));
// A bare mount has no router: run the page's submit callback the way SvelteKit's enhance would.
vi.mock("$app/forms", () => ({
	enhance: (form: HTMLFormElement, submit?: () => unknown) => {
		const off = on(form, "submit", (e) => {
			e.preventDefault();
			submit?.();
		});
		return { destroy: off };
	},
}));

const { default: Page } = await import("./+page.svelte");

const data = {
	signedIn: true,
	google: { available: true, email: "person@example.org" },
	mcpServers: [],
	servers: [],
	policies: {},
};

afterEach(() => cleanup());

describe("Settings → Connectors, the Google callback's note", () => {
	it("says Google is connected on return from Google, and stops saying it once the person presses Disconnect", async () => {
		render(Page, { props: { data: data as unknown as PageData, form: null } });
		const note = page.getByRole("status").filter({ hasText: "Google is connected." });
		await expect.element(note).toBeInTheDocument();
		await page.getByRole("button", { name: "Disconnect" }).click();
		await expect.element(note).not.toBeInTheDocument();
	});
});
