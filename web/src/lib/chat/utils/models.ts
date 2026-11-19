// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Model } from "$lib/chat/types/Model";

// Returns undefined for an empty list (models[0] of an empty array), so callers guard the result
// ({#if currentModel} in ChatLanding.svelte and both routes/chat/**/+page.svelte call sites).
// The fallback is for what a page SHOWS. A turn sends to `servedPick` instead: models[0] stands in
// for a picked model only on screen, never as the model that answers.
export const findCurrentModel = (models: Model[], id?: string): Model | undefined => {
	if (id) {
		const direct = models.find((m) => m.id === id);
		if (direct) return direct;
	}

	return models[0];
};

/**
 * The model a turn sends to when a person picked `pickedId`: that id while the registry serves it,
 * otherwise undefined, so the caller stops the send and says so. A picked model is answered only by
 * itself. A link to `/chat/models/<id>` opened while the registry briefly lacked that model
 * used to send to `findCurrentModel`'s models[0], so a hand-picked ALIA turn was answered by Mistral
 * under the ALIA link.
 */
export function servedPick(models: ReadonlyArray<Pick<Model, "id">>, pickedId: string): string | undefined {
	return models.some((m) => m.id === pickedId) ? pickedId : undefined;
}
