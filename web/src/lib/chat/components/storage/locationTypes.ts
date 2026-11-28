import { m } from '$lib/paraglide/messages.js';

// The location summary the server sends (registry.ts's LocationSummary), as the client sees it.
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
// only when there is more than one place.
export type LocationsState = {
	locations: LocationSummary[];
	defaultLocation: string;
	lastUsed: string;
	uploadsGoTo: string;
	connectAvailable: boolean;
};

/** The default value that asks on every upload instead of naming a place. */
export const ASK_EVERY_TIME = 'ask';
/** The default that follows the most recent upload, and the one an account starts on. */
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

/** A linked bucket's place, read from the `huggingface.co/<repo>[/<folder>]` detail registry.ts builds. */
function hfPlace(loc: LocationSummary): { owner: string; bucket: string; folder: string } | null {
	if (loc.kind !== 'hf-bucket') return null;
	const parts = loc.detail.replace(/^huggingface\.co\//, '').replace(/^buckets\//, '').split('/');
	if (parts.length < 2 || !parts[0] || !parts[1]) return null;
	return { owner: parts[0], bucket: parts[1], folder: parts.slice(2).join('/') };
}

export type LocationTabName = {
	/** What the tab shows: the part that tells this place from the others. */
	name: string;
	/** The place in full, for the tab's tooltip: its label and where it lives. */
	full: string[];
	/** Set for a Hugging Face bucket, whose tab carries the Hugging Face mark instead of the words. */
	provider: 'huggingface' | null;
};

// CUR-4441: Connect labels a bucket "<account>/<bucket> on Hugging Face", so every linked tab began with
// the same account and ended with the same provider, and clipping cut the bucket name, the only part
// that differed. A tab names the bucket (and folder) instead, keeps the account only when the linked
// buckets span more than one, and leaves a label the person typed as they typed it.
export function locationTabNames(locations: LocationSummary[]): Map<string, LocationTabName> {
	const places = new Map(locations.map((l) => [l.id, hfPlace(l)]));
	const owners = new Set([...places.values()].flatMap((p) => (p ? [p.owner.toLowerCase()] : [])));
	const names = new Map<string, LocationTabName>();
	for (const loc of locations) {
		const label = locationLabel(loc);
		const p = places.get(loc.id);
		if (!p) {
			names.set(loc.id, { name: label, full: [label, locationDetail(loc)].filter(Boolean), provider: null });
			continue;
		}
		const typed = label.replace(/ on Hugging Face$/, '');
		const where = p.folder ? `${p.bucket}/${p.folder}` : p.bucket;
		const generated = [p.owner, `${p.owner}/${p.bucket}`, `${p.owner}/${where}`].some(
			(g) => g.toLowerCase() === typed.toLowerCase(),
		);
		const name = !generated ? typed : owners.size > 1 ? `${p.owner}/${where}` : where;
		names.set(loc.id, { name, full: [label, loc.detail], provider: 'huggingface' });
	}
	// Two places that still read the same (a typed label repeated) show their full labels instead.
	const seen = new Map<string, number>();
	for (const n of names.values()) seen.set(n.name, (seen.get(n.name) ?? 0) + 1);
	for (const n of names.values()) if ((seen.get(n.name) ?? 0) > 1) n.name = n.full[0];
	return names;
}
