import AiDisclosureBanner from "./AiDisclosureBanner.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

// CUR-996 item 3: WelcomeModal is gated on `messages.length === 0`, a condition a shared
// conversation almost never meets, so it can never fire on that path. This banner is the Art. 50
// first-interaction disclosure for shared views instead. These tests pin the two things that
// actually matter: it renders by default, and dismissal persists across a remount in the same tab.
describe("AiDisclosureBanner", () => {
	beforeEach(() => {
		sessionStorage.removeItem("ap:aiDisclosureSeen");
	});

	afterEach(() => {
		cleanup();
		sessionStorage.removeItem("ap:aiDisclosureSeen");
	});

	it("shows the AI disclosure line by default", async () => {
		await render(AiDisclosureBanner);
		expect(page.getByText(/talking to Alpha, an AI system/i)).toBeInTheDocument();
	});

	it("hides after dismissal and stays hidden across a remount in the same tab session", async () => {
		const screen = await render(AiDisclosureBanner);
		await screen.getByRole("button", { name: "Dismiss" }).click();
		await expect.element(screen.getByText(/talking to Alpha, an AI system/i)).not.toBeInTheDocument();

		cleanup();
		await render(AiDisclosureBanner);
		expect(page.getByText(/talking to Alpha, an AI system/i)).not.toBeInTheDocument();
	});

	it("does not render at all when a prior tab session already recorded it as seen", async () => {
		sessionStorage.setItem("ap:aiDisclosureSeen", "1");
		await render(AiDisclosureBanner);
		expect(page.getByText(/talking to Alpha, an AI system/i)).not.toBeInTheDocument();
	});
});
