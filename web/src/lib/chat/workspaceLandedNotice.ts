// When someone's current workspace is deleted, or they are removed from it, Settings →
// Workspace lands them in Personal with a line saying why. The line is kept for this tab so a reload
// still shows it, and it is dropped as soon as a team workspace is current again. (CUR-3089)
const KEY = 'workspace-landed-notice';

/** Remembers `notice` for this tab, or forgets it when `notice` is empty. */
export function keepLandedNotice(notice: string): void {
	try {
		if (notice) sessionStorage.setItem(KEY, notice);
		else sessionStorage.removeItem(KEY);
	} catch {
		// sessionStorage can throw (private mode, blocked storage); the line then lasts until a reload.
	}
}

/** The notice kept for this tab, or an empty string. */
export function keptLandedNotice(): string {
	try {
		return sessionStorage.getItem(KEY) ?? '';
	} catch {
		return '';
	}
}
