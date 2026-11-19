/**
 * How many sheets are open right now, app-wide. A `Sheet.Root` holds a count while it is open, so
 * something floating above the page (the guided tour's Resume chip) can step aside while a sheet
 * covers the bottom of the screen, rather than sitting over the sheet's last lines.
 */
import { untrack } from 'svelte';

let open = $state(0);

const sheetOpen = {
	get current(): boolean {
		return open > 0;
	}
};

/**
 * Reactive "is any sheet open?" — `.current` is true while at least one `Sheet.Root` is open. A
 * sheet is modal (its scroll lock stops pointer events on the rest of the page), so a floating
 * control outside it should hide until it closes.
 */
export function useSheetOpen(): { readonly current: boolean } {
	return sheetOpen;
}

/**
 * Counts one open sheet until the returned release is called. Called from `Sheet.Root`'s effect, so
 * the count is bumped untracked: `open += 1` reads `open`, and a tracked read would make the effect
 * depend on the count it writes and rerun without end.
 */
export function holdSheetOpen(): () => void {
	untrack(() => (open += 1));
	let released = false;
	return () => {
		if (released) return;
		released = true;
		untrack(() => (open -= 1));
	};
}
