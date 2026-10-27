export type BackgroundGeneration = {
	id: string;
	startedAt: number;
};

/**
 * Maximum time an unpersisted client turn is tracked before we give up and let the normal
 * server reconcile resume. Shared by two consumers so they expire on the same clock:
 *   - BackgroundGenerationPoller: evict a tracked background generation that never reported terminal.
 *   - conversation/[id]/+page.svelte: release the client-only cache/early-failure veto so a turn
 *     that DID reach the server (but whose egress we never saw) can finally surface, instead of the
 *     optimistic-only turn being protected from reconcile forever.
 *
 * Derived from GENERATION_STALE_MS in the deadline ladder — eviction must stay BEHIND staleness or
 * the "dead generation" signal never reaches the UI. See $lib/chat/utils/deadlineLadder.
 */
export { MAX_TRACK_DURATION_MS } from "$lib/chat/utils/deadlineLadder";

export const backgroundGenerationEntries = $state<BackgroundGeneration[]>([]);

export function addBackgroundGeneration(entry: BackgroundGeneration) {
	const index = backgroundGenerationEntries.findIndex(({ id }) => id === entry.id);

	if (index === -1) {
		backgroundGenerationEntries.push(entry);
		return;
	}

	backgroundGenerationEntries[index] = entry;
}

export function removeBackgroundGeneration(id: string) {
	const index = backgroundGenerationEntries.findIndex((entry) => entry.id === id);
	if (index === -1) return;

	backgroundGenerationEntries.splice(index, 1);
}

export function clearBackgroundGenerations() {
	backgroundGenerationEntries.length = 0;
}

export function hasBackgroundGeneration(id: string) {
	return backgroundGenerationEntries.some((entry) => entry.id === id);
}
