import { createFrameLeaveGuard } from "$lib/chat/utils/previewSrcdoc";

const HOOK_LIFECYCLE = new Set(["chatui.preview.ready", "chatui.preview.loaded", "chatui.preview.leaving"]);

/**
 * `left` turns true once a preview frame navigates away from its srcdoc, so the component
 * can show a notice in the frame's place. Construct it during component init: it resets when the frame
 * remounts (a fresh srcdoc load starts the count over) and when the previewed document changes. (CUR-3527)
 */
export class PreviewLeave {
	left = $state(false);
	#guard = createFrameLeaveGuard(() => (this.left = true));

	constructor(frame: () => HTMLIFrameElement | undefined, srcdoc: () => string | undefined) {
		$effect(() => {
			if (frame()) this.#guard.reset();
		});
		$effect(() => {
			void srcdoc();
			this.restart();
		});
	}

	/** The frame's `onload` handler. */
	onload = () => this.#guard.onload();

	/** Feeds one of the preview hook's lifecycle reports to the guard; false for any other message. */
	take(type: string | undefined): boolean {
		if (!type || !HOOK_LIFECYCLE.has(type)) return false;
		this.#guard.onMessage(type);
		return true;
	}

	/** Shows the frame again from a fresh load ("Run it again"). */
	restart = () => {
		this.#guard.reset();
		this.left = false;
	};
}
