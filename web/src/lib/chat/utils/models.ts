import type { Model } from "$lib/chat/types/Model";

// Returns undefined for an empty list (models[0] of an empty array), so callers guard the result
// ({#if currentModel} in ChatLanding.svelte and both routes/chat/**/+page.svelte call sites).
export const findCurrentModel = (models: Model[], id?: string): Model | undefined => {
	if (id) {
		const direct = models.find((m) => m.id === id);
		if (direct) return direct;
	}

	return models[0];
};
