/**
 * Whether an Escape keypress should close the artifact side panel.
 *
 * Split out of `ArtifactPanel.svelte` so the condition can be tested for the states it has to survive
 * rather than read for them. It must not carry a `!loading` clause: that would make Escape do
 * nothing for as long as a turn is generating — the exact window in which someone opens the panel to
 * watch a file being written, and then cannot get out of it (CUR-1405).
 *
 * Whether a turn is streaming is absent from the input on purpose, not merely unused: closing a side
 * panel does not touch the generation, so there is no state for that clause to protect, and leaving
 * the field out means re-consulting it has to change this signature rather than slip into a boolean.
 */
export interface ArtifactPanelKeyState {
	key: string;
	/** Already consumed by a nested modal (external-link confirm, fullscreen preview). */
	defaultPrevented: boolean;
	panelOpen: boolean;
	/** The fullscreen preview owns Escape while it is up; it closes, the panel behind it does not. */
	fullscreenOpen: boolean;
}

export function shouldCloseArtifactPanel(s: ArtifactPanelKeyState): boolean {
	if (s.defaultPrevented) return false;
	return s.key === "Escape" && s.panelOpen && !s.fullscreenOpen;
}
