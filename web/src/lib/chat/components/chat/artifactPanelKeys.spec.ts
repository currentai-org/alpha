import { describe, expect, it } from "vitest";
import { shouldCloseArtifactPanel, type ArtifactPanelKeyState } from "./artifactPanelKeys";

const state = (over: Partial<ArtifactPanelKeyState> = {}): ArtifactPanelKeyState => ({
	key: "Escape",
	defaultPrevented: false,
	panelOpen: true,
	fullscreenOpen: false,
	...over,
});

describe("artifact panel Escape handling", () => {
	// The condition this function is allowed to depend on, stated as a closed set. Whether a turn is
	// still streaming is deliberately not an input: it would make Escape do nothing for exactly
	// as long as the panel is worth having open (CUR-1405). Pinning the input SHAPE is what a unit test can
	// honestly guarantee here: re-consulting streaming state has to widen this interface, which is a
	// visible edit, where `&& !loading` inside the component was not. What it cannot guarantee is the
	// component still calling this; that belongs to e2e.
	it("depends on exactly four inputs, and streaming state is not one of them", () => {
		expect(Object.keys(state()).sort()).toEqual([
			"defaultPrevented",
			"fullscreenOpen",
			"key",
			"panelOpen",
		]);
	});

	it("closes on Escape while the panel is open", () => {
		expect(shouldCloseArtifactPanel(state())).toBe(true);
	});

	it("leaves Escape to the fullscreen preview while that is up, so one press closes one thing", () => {
		expect(shouldCloseArtifactPanel(state({ fullscreenOpen: true }))).toBe(false);
	});

	it("does not act on an Escape a nested modal already consumed", () => {
		expect(shouldCloseArtifactPanel(state({ defaultPrevented: true }))).toBe(false);
	});

	it("ignores keys that are not Escape, and does nothing when the panel is already closed", () => {
		expect(shouldCloseArtifactPanel(state({ key: "Enter" }))).toBe(false);
		expect(shouldCloseArtifactPanel(state({ panelOpen: false }))).toBe(false);
	});
});
