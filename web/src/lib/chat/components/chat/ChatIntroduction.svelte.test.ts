import ChatIntroduction from "./ChatIntroduction.svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model } from "$lib/chat/types/Model";
import { AUTO, modelChoice } from "$lib/chat/routing/choice";
import { createRawSnippet } from "svelte";

// The Auto line reads the `auto-routing` flag off the layout data (autoRoutingEnabled).
const appState = vi.hoisted(() => ({ page: { data: {} as { autoRoutingEnabled?: boolean } } }));
vi.mock("$app/state", () => appState);

beforeEach(() => {
	appState.page.data = {};
	modelChoice.set(AUTO);
});

function fakeModel(id: string): Model {
	return { id, name: id, displayName: id } as Model;
}

// Before a turn, where a catalog model runs is a forecast that pooling and fallbacks make
// wrong, so the greeting names no host for one and points at the answer's own record instead. (CUR-2364)
// A local model's turns never leave the user's own server, so that one is stated. (CUR-1194)
describe("ChatIntroduction's serving line states only what config can't get wrong (CUR-2364, CUR-1194)", () => {
	it("names no host for a catalog model and points at X-ray's per-answer record", async () => {
		await render(ChatIntroduction, {
			currentModel: fakeModel("swiss-ai/apertus-v1.5-70b"),
		});
		const line = page.getByText(/^Running on /);
		await expect.element(line).toHaveTextContent(/X-ray on each answer shows where it ran\./);
		await expect.element(line).not.toHaveTextContent(/served/i);
	});

	it("names the user's own local server for a local: model id", async () => {
		await render(ChatIntroduction, {
			currentModel: fakeModel("local:20a5be97fcb02afb7ef902d2:llama3.2:latest"),
		});
		const line = page.getByText(/^Running on /);
		await expect.element(line).toHaveTextContent(/, served from your own local inference server\./);
		await expect.element(line).not.toHaveTextContent(/X-ray on each answer/);
	});

	it("names no model while Auto is chosen, since Auto picks one per message", async () => {
		await render(ChatIntroduction, {
			currentModel: fakeModel("mistralai/Mistral-Large-3"),
			auto: true,
		});
		const line = page.getByText(/^Alpha picks a model for each message\./);
		await expect.element(line).toBeVisible();
		await expect.element(line).not.toHaveTextContent(/Mistral/);
	});

	it("follows the model passed in when the composer's pick changes", async () => {
		const view = await render(ChatIntroduction, {
			currentModel: fakeModel("swiss-ai/apertus-v1.5-70b"),
			auto: true,
		});
		await view.rerender({ currentModel: fakeModel("swiss-ai/apertus-v1.5-70b"), auto: false });
		await expect.element(page.getByText(/^Running on /)).toHaveTextContent(/Apertus/);
	});
});

// With Auto on and left on Auto, the model is chosen per message once the person types, so the
// greeting must not name a model ("Running on Apertus 1.5 70B") that the first answer usually won't be.
describe("ChatIntroduction names no model while Auto is choosing", () => {
	it("says Alpha picks per message, and names no model, when auto-routing is on and the choice is Auto", async () => {
		appState.page.data = { autoRoutingEnabled: true };
		await render(ChatIntroduction, { currentModel: fakeModel("swiss-ai/apertus-v1.5-70b") });
		await expect.element(page.getByText(/^Alpha picks a model for each message\./)).toBeVisible();
		await expect.element(page.getByText(/Running on/)).not.toBeInTheDocument();
	});

	it("still names the model picked by hand while auto-routing is on", async () => {
		appState.page.data = { autoRoutingEnabled: true };
		modelChoice.set("apertus-70b");
		await render(ChatIntroduction, { currentModel: fakeModel("swiss-ai/apertus-v1.5-70b") });
		await expect.element(page.getByText(/^Running on /)).toBeVisible();
	});
});

// The picked model's measured weak spot is one quiet line on the empty state, since its
// Settings page is developer-only. Nothing is shown for a model with none, or while Auto is choosing. (CUR-3911)
describe("ChatIntroduction shows the picked model's known weak spot, and only that model's (CUR-3911)", () => {
	const weakSpot = "Often answers in Spanish when asked in Catalan.";

	it("shows the weak-spot line for a picked model that has one", async () => {
		await render(ChatIntroduction, {
			currentModel: { ...fakeModel("BSC-LT/ALIA-40b-instruct"), knownWeakSpot: weakSpot },
		});
		await expect.element(page.getByText(weakSpot)).toBeVisible();
	});

	it("shows no weak-spot line for a model with none on record", async () => {
		const { container } = await render(ChatIntroduction, {
			currentModel: fakeModel("mistral-large-2512"),
		});
		expect(container.querySelector("[data-known-weak-spot]")).toBeNull();
	});

	it("shows no weak-spot line while Auto is choosing, because no model is named yet", async () => {
		appState.page.data = { autoRoutingEnabled: true };
		const { container } = await render(ChatIntroduction, {
			currentModel: { ...fakeModel("BSC-LT/ALIA-40b-instruct"), knownWeakSpot: weakSpot },
		});
		expect(container.querySelector("[data-known-weak-spot]")).toBeNull();
	});
});

// Potluck Run is found through five quick clicks on the empty state's mark. The game covers the
// window without unmounting the chat under it, so the composer (ChatIntroduction's children) keeps
// what was typed, and focus goes back to the mark on the way out. The game's own screens are in
// src/lib/potluck-run/PotluckRun.svelte.test.ts (SOL-206).
// e2e-moved: scenarios/potluck-run.spec.ts › five clicks open a start screen that waits for Start; the run then moves, and Back to chat returns with the draft intact
// e2e-moved: scenarios/potluck-run.spec.ts › on the start screen, the sound toggle and Back to chat answer clicks, not just Start
describe("ChatIntroduction opens Potluck Run on five clicks of the mark", () => {
	it("five clicks open the game's start screen, and Back to chat returns to the draft with the mark focused", async () => {
		localStorage.setItem("alpha.potluckRun.muted", "1");
		const composer = createRawSnippet(() => ({
			render: () => `<textarea aria-label="Message AI Potluck"></textarea>`,
		}));
		await render(ChatIntroduction, { currentModel: fakeModel("swiss-ai/apertus-v1.5-70b"), children: composer });
		const draft = page.getByLabelText("Message AI Potluck");
		await draft.fill("a draft that should survive the game");

		const mark = page.getByRole("button", { name: "AI Potluck" });
		for (let i = 0; i < 4; i++) await mark.click({ force: true });
		const game = page.getByRole("dialog", { name: "Potluck Run, a hidden game" });
		expect(game.query(), "four clicks already opened the game").toBeNull();
		await mark.click({ force: true });
		await expect
			.element(game.getByRole("button", { name: "Start" }), {
				timeout: 20_000,
				message: "the fifth click did not open the start screen",
			})
			.toBeVisible();

		await game.getByRole("button", { name: "Back to chat" }).click();
		await expect
			.element(game, { timeout: 10_000, message: "Back to chat left the game on screen" })
			.not.toBeInTheDocument();
		await expect
			.element(draft, { message: "the draft typed before the game was lost on the way back" })
			.toHaveValue("a draft that should survive the game");
		await expect
			.element(mark, { message: "focus did not return to the mark the game was opened from" })
			.toHaveFocus();
	});
});
