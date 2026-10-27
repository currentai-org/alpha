import WhereItWent from "./WhereItWent.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, afterEach } from "vitest";
import type { Message } from "$lib/chat/types/Message";

// "Where your last message went", read from the turn's own record. (CUR-4580)
const answer = (routerMetadata: Message["routerMetadata"]): Message => ({
	id: "a",
	from: "assistant",
	content: "Tokyo.",
	routerMetadata,
});

describe("WhereItWent", () => {
	afterEach(() => cleanup());

	it("a router.stg turn lists the router as location not published and names Mistral with its own link", async () => {
		await render(WhereItWent, {
			answer: answer({
				route: "",
				model: "mistral-large-2512",
				backend: "https://api.mistral.ai/v1",
				lane: "router.stg.aipotluck.org",
				appRegion: "fra1",
			}),
			storageRegion: "eu-central-1",
		});
		await expect.element(page.getByRole("heading", { name: "Where your last message went" })).toBeInTheDocument();
		const router = page.getByRole("listitem").filter({ hasText: "Router" });
		await expect.element(router).toHaveTextContent(/location not published/);
		await expect.element(page.getByRole("link", { name: "Mistral AI" })).toBeInTheDocument();
		await expect.element(page.getByRole("listitem").filter({ hasText: "App server" })).toHaveTextContent(/Frankfurt, Germany/);
		await expect.element(page.getByRole("listitem").filter({ hasText: "Stored in" })).toHaveTextContent(/Frankfurt, Germany/);
		expect(page.getByText("Outside Europe").elements()).toHaveLength(0);
	});

	it("tags each hop outside Europe, and says not recorded where the turn recorded nothing", async () => {
		await render(WhereItWent, {
			answer: answer({ route: "", model: "m", backend: "https://api.featherless.ai/v1" }),
			storageRegion: "us-east-1",
		});
		await expect.element(page.getByRole("listitem").filter({ hasText: "App server" })).toHaveTextContent(/not recorded/);
		expect(page.getByText("Outside Europe").elements()).toHaveLength(2);
	});
});
