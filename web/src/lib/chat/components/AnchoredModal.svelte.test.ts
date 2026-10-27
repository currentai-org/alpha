import AnchoredModal from "./AnchoredModal.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

// The panel must never cap its height at the space left under its trigger. The account
// page's "Delete account" sits near the foot of the viewport, where such a cap leaves the deletion
// confirmation a sliver a person could confirm without reading it. These pin the contract that matters: the whole panel is on screen and at its natural height, wherever the
// trigger sits. (CUR-1990)

const CONTENT_PX = 240;

const content = createRawSnippet(() => ({
	render: () => `<div data-testid="content" style="height:${CONTENT_PX}px">What will be deleted.</div>`,
}));

let trigger: HTMLButtonElement | undefined;

function placeTrigger(position: "top" | "bottom" | "offscreen") {
	trigger = document.createElement("button");
	trigger.textContent = "Delete account";
	trigger.style.position = "fixed";
	trigger.style.left = "20px";
	trigger.style.height = "30px";
	if (position === "offscreen") trigger.style.top = `${window.innerHeight + 40}px`;
	else trigger.style[position] = "20px";
	document.body.appendChild(trigger);
	return trigger;
}

// The panel flies in 6px from above, so read it only once the entrance transition has settled.
async function panelRect() {
	const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
	await expect.poll(() => dialog() !== null, { message: "the panel never rendered" }).toBe(true);
	await expect.poll(() => getComputedStyle(dialog()!).transform).toBe("none");
	return dialog()!.getBoundingClientRect();
}

afterEach(() => {
	cleanup();
	trigger?.remove();
	trigger = undefined;
});

describe("AnchoredModal placement", () => {
	it("opens fully on screen, at its natural height and above the trigger, when the trigger is near the bottom of the viewport", async () => {
		const anchor = placeTrigger("bottom");
		await render(AnchoredModal, { props: { anchor, children: content } });
		const panel = await panelRect();
		const a = anchor.getBoundingClientRect();

		expect(panel.top).toBeGreaterThanOrEqual(0);
		expect(panel.bottom).toBeLessThanOrEqual(window.innerHeight);
		expect(panel.height).toBeGreaterThanOrEqual(CONTENT_PX);
		// Still attached: its bottom edge meets the trigger's top edge.
		expect(Math.abs(panel.bottom - a.top)).toBeLessThanOrEqual(1);
	});

	it("still opens below the trigger when there is room there", async () => {
		const anchor = placeTrigger("top");
		await render(AnchoredModal, { props: { anchor, children: content } });
		const panel = await panelRect();
		const a = anchor.getBoundingClientRect();

		expect(Math.abs(panel.top - a.bottom)).toBeLessThanOrEqual(1);
		expect(panel.height).toBeGreaterThanOrEqual(CONTENT_PX);
	});

	it("stays fully on screen when its trigger is below the viewport, so its buttons can be reached", async () => {
		const anchor = placeTrigger("offscreen");
		await render(AnchoredModal, { props: { anchor, children: content } });
		const panel = await panelRect();

		expect(panel.top).toBeGreaterThanOrEqual(0);
		expect(panel.bottom).toBeLessThanOrEqual(window.innerHeight);
		expect(panel.height).toBeGreaterThanOrEqual(CONTENT_PX);
	});
});
