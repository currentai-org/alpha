import { onDestroy, onMount } from "svelte";
import { browser } from "$app/environment";
import { tap } from "$lib/chat/utils/haptics";

interface DialogChromeOptions {
	/** The element to focus when the dialog mounts (the dialog/panel itself). */
	focusTarget: () => HTMLElement | undefined;
	/** The backdrop element — a click landing directly on it (not a child) closes the dialog. */
	backdrop: () => HTMLElement | undefined;
	/** Dismiss the dialog (Escape or a qualifying backdrop click). */
	onclose: () => void;
	/** Gate for BOTH Escape and backdrop dismissal. When it returns false the dialog can't be
	 *  dismissed by the user (e.g. a wipe is in flight). Defaults to always-dismissable. */
	canClose?: () => boolean;
}

/**
 * Shared modal/dialog lifecycle used by both Modal and AnchoredModal: make the rest of the app
 * `inert` while open, focus the dialog, fire a haptic tap, and close on Escape (capture-phase so it
 * fires even when focus is outside the dialog) or a backdrop click. Escape and backdrop clicks are
 * gated by the same `canClose` predicate, so a modal that blocks backdrop dismissal (e.g. during a
 * GDPR data wipe) can't be aborted with Escape either.
 *
 * Extracted so a11y/focus/dismissal fixes land in one place instead of drifting between the two
 * dialog shells. Returns the handlers for the template to bind (onkeydown / onclick).
 */
export function setupDialogChrome(opts: DialogChromeOptions) {
	const canClose = opts.canClose ?? (() => true);

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		if (!canClose()) return;
		event.preventDefault();
		opts.onclose();
	}

	function handleBackdropClick(event: MouseEvent) {
		// Don't treat the mouse-up that ends a text selection (drag started inside the dialog) as a
		// dismiss click.
		if (window?.getSelection()?.toString()) return;
		if (event.target === opts.backdrop() && canClose()) opts.onclose();
	}

	onMount(() => {
		document.getElementById("app")?.setAttribute("inert", "true");
		opts.focusTarget()?.focus();
		tap();
		// Capture-phase so Escape closes even if focus isn't within the dialog.
		window.addEventListener("keydown", handleKeydown, { capture: true });
	});

	onDestroy(() => {
		if (!browser) return;
		document.getElementById("app")?.removeAttribute("inert");
		window.removeEventListener("keydown", handleKeydown, { capture: true });
	});

	return { handleKeydown, handleBackdropClick };
}
