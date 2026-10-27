import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The "Reasoning effort" switch on the per-model settings page promises a Low / Medium / High
// selector in the chat footer for this model. `reasoningEffortOverrides`, the value the server
// forwards as `reasoning_effort`, needs a writer, or the toggle changes nothing reachable outside
// its own boolean (CUR-458, CUR-680). This test stops the footer control and the value it's supposed
// to write from drifting apart.
const CHAT_WINDOW = "src/lib/chat/components/chat/ChatWindow.svelte";

function anchor(src: string, marker: string, label: string): number {
	const i = src.indexOf(marker);
	expect(i, `could not find "${marker}" in ${label} — re-point this test rather than deleting it`).toBeGreaterThan(
		-1
	);
	return i;
}

describe("the reasoning-effort footer selector stays wired to reasoningEffortOverrides", () => {
	it("ChatWindow shows the selector from the SAME store field the settings-page switch writes", () => {
		const src = readFileSync(CHAT_WINDOW, "utf8");
		const i = anchor(src, "let showReasoningEffort = $derived(", CHAT_WINDOW);
		const block = src.slice(i, src.indexOf(");", i));
		expect(
			block.includes("$settings.reasoningOverrides?.[currentModel.id]"),
			"showReasoningEffort must derive from reasoningOverrides — the same field the settings " +
				"page's switch writes. A local/duplicated flag here can silently disagree with it."
		).toBe(true);
	});

	it("ChatWindow's setter writes reasoningEffortOverrides, not a decoy field", () => {
		const src = readFileSync(CHAT_WINDOW, "utf8");
		const i = anchor(src, "function setReasoningEffort(", CHAT_WINDOW);
		const block = src.slice(i, src.indexOf("}", src.indexOf("}", i) + 1) + 1);
		expect(
			block.includes("reasoningEffortOverrides: { ...s.reasoningEffortOverrides, [currentModel.id]: v }"),
			"setReasoningEffort must write reasoningEffortOverrides[currentModel.id] — that's the exact " +
				"field conversation/[id]/+server.ts reads to build reasoningEffort for the model request"
		).toBe(true);
	});

	it("the ChatInput prop is bound with a real getter/setter pair, not a plain local default", () => {
		const src = readFileSync(CHAT_WINDOW, "utf8");
		anchor(src, "bind:reasoningEffort={getReasoningEffort, setReasoningEffort}", CHAT_WINDOW);
	});

	// ChatInput's half (the control is offered with the override on, and choosing a level writes the
	// bindable value) is behaviour-tested in composerTools.spec.ts since the Tools-menu refactor.
});
