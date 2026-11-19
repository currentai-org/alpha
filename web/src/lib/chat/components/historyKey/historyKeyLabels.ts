// The names this browser gives the ways in it adds to a history key. They are the person's
// own labels, kept inside the wrap where the server cannot read them.
import { describePlatform, suggestedPasskeyName } from '$lib/chat/utils/describePlatform';

/** "Chrome on macOS", or a plain fallback where the user agent says nothing useful. */
export function thisDeviceLabel(): string {
	return describePlatform(navigator.userAgent) ?? 'A browser';
}

export function newPasskeyLabel(): string {
	return suggestedPasskeyName(navigator.userAgent);
}

export function newRecoveryKeyLabel(now: Date = new Date()): string {
	return `Recovery key · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
