import StepByStep from "./StepByStep.svelte";
import { render } from "vitest-browser-svelte";
import { readable } from "svelte/store";
import { describe, expect, it } from "vitest";
import type { Message } from "$lib/chat/types/Message";

// "Show the model and host" off must keep every model and host out of the step text, not just
// the write step: a calculation or a helper record that still named one would undo the setting. (CUR-549)
const answer = (): Message =>
	({
		id: "m1",
		from: "assistant",
		content: "It is 12.",
		updates: [],
		children: [],
		ancestors: [],
		routerMetadata: {
			model: "mistral-large-2512",
			route: "",
			backend: "https://api.mistral.ai/v1",
			provider: "mistral",
			assistedBy: [
				{ role: "math-route", model: "mistral-small-2603", backend: "https://api.mistral.ai/v1", provider: "mistral" }
			]
		},
		calculations: [{ expression: "5 + 7", result: "12" }]
	}) as unknown as Message;

const stepText = (container: HTMLElement) =>
	[...container.querySelectorAll("[data-step-id]")].map((el) => el.textContent ?? "").join("\n");

const renderWith = (showServing: boolean) =>
	render(StepByStep, {
		props: { message: answer() },
		context: new Map([["settings", readable({ showServing })]])
	});

describe("X-ray's step by step with the serving switch", () => {
	it("names the model and host in the calculator and helper steps when the switch is on", async () => {
		const { container } = await renderWith(true);
		const calc = container.querySelector('[data-step-id="calculator"]')?.textContent ?? "";
		const helper = container.querySelector('[data-step-id="assist-math-route"]')?.textContent ?? "";
		expect(calc).toContain("Mistral Large 3");
		// A helper step names its model and host by display name, as the receipt does. (CUR-3563)
		expect(helper).toContain("Mistral Small 4");
		expect(helper).toContain("running on Mistral AI");
	});

	it("names no model and no host in any step when the switch is off, and keeps the calculation and the helper's job", async () => {
		const { container } = await renderWith(false);
		const text = stepText(container);
		expect(text).toContain("5 + 7 = 12");
		expect(container.querySelector('[data-step-id="assist-math-route"]')?.textContent).toContain(
			"checked whether your message asks for a number"
		);
		expect(text).not.toMatch(/mistral|small|large|api\./i);
	});

	it("says a stopped answer was stopped, and names no model, when the switch is off", async () => {
		const { container } = await render(StepByStep, {
			props: { message: { ...answer(), interrupted: true } as Message },
			context: new Map([["settings", readable({ showServing: false })]])
		});
		const write = container.querySelector('[data-step-id="write"]')?.textContent ?? "";
		expect(write).toContain("stopped before it finished");
		expect(write).not.toMatch(/mistral|small|large|api\./i);
	});
});
