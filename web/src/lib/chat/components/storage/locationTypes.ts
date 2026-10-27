import { m } from '$lib/paraglide/messages.js';

// The location summary the server sends (registry.ts's LocationSummary), as the client sees it. (CUR-2930)
export type LocationSummary = {
	id: string;
	kind: 'alpha' | 'hf-bucket';
	label: string;
	detail: string;
	status: 'ok' | 'needs-reconnect';
	lastError: string | null;
	grant: 'alpha' | 'token' | 'oauth';
};

// registry.ts's LocationsSummary. `defaultLocation` is the saved choice ("last" when never chosen);
// `lastUsed` is where "Last used" points now; `uploadsGoTo` is where an unnamed upload goes, "ask"
// only when there is more than one place (CUR-3077).
export type LocationsState = {
	locations: LocationSummary[];
	defaultLocation: string;
	lastUsed: string;
	uploadsGoTo: string;
	connectAvailable: boolean;
};

/** The default value that asks on every upload instead of naming a place. */
export const ASK_EVERY_TIME = 'ask';
/** The default that follows the most recent upload (CUR-3077), and the one an account starts on. */
export const LAST_USED = 'last';
export const ALPHA_LOCATION_ID = 'alpha';

// Alpha's own storage is named in the browser rather than by the server's label, so the words come from
// the page's `m` and follow its language and copy edit mode. Linked buckets keep the label the person gave.
export function locationLabel(loc: LocationSummary): string {
	return loc.kind === 'alpha' ? m.storage_alphaLabel() : loc.label;
}

export function locationDetail(loc: LocationSummary): string {
	return loc.kind === 'alpha' ? m.storage_alphaDetail() : loc.detail;
}
